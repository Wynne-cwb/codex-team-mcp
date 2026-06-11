import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import { PaneExecutionBackend } from "../src/adapters/paneExecutionBackend.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { LifecycleService } from "../src/services/lifecycleService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";

const CODEX_SESSION_METADATA_UNAVAILABLE = "codex_session_metadata_unavailable";

const tempRoots: string[] = [];

const readOnlyContext: ExecutionRunContext = {
  run_id: "run:repro:builder",
  team_id: "team-repro",
  member_id: "teammate:team-repro:builder",
  teammate_id: "builder@repro-team",
  team_name: "repro-team",
  workspace_root: "/workspace",
  prompt_present: true,
  work_classification: "read_only",
  isolation_kind: "none",
  workspace_path: null,
  metadata: {
    // No durable Codex thread_id is bound to the run: this is the missing
    // metadata source the failure documents.
    prompt_present: true
  }
};

// A deterministic fake tmux registry that reports an AVAILABLE pane backend, so
// the reproduction isolates the conservative-default execution claim — not pane
// unavailability — as the cause of codex_session_metadata_unavailable.
function createAvailableTmuxRegistry() {
  const metadata = {
    mode: "pane",
    backend_type: "tmux",
    availability_status: "available",
    pane_id: "%7",
    session_name: "codex-team-repro-team",
    window_name: "teammates",
    socket_name: "codex-team-repro-team-run",
    attach_command: "tmux -L codex-team-repro-team-run attach-session -t codex-team-repro-team",
    is_native: false
  };

  return {
    describeAvailability() {
      return metadata;
    },
    createPane(_context: ExecutionRunContext, _command: string[]) {
      // attach_status_only never reaches a durable thread_id; model an attach
      // launch with no durable Codex id available.
      return { ok: true, pane: metadata };
    },
    resumePane(_context: ExecutionRunContext, _trigger: ExecutionTrigger, _command: string[]) {
      return { ok: true, pane: metadata };
    },
    reconcilePane(_context: ExecutionRunContext) {
      return { status: "active", pane: metadata, deleted: false };
    },
    closePane(_pane: unknown) {
      return { ok: true, pane_id: metadata.pane_id };
    }
  };
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-repro-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("codex_session_metadata_unavailable reproduction", () => {
  it("reproduces codex_session_metadata_unavailable from the default PaneExecutionBackend claim", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createAvailableTmuxRegistry()
    });

    const description = backend.describeBackend();

    // The pane backend is available, yet the conservative DEFAULT execution
    // claim (attach_status_only) reports the durable Codex metadata as missing.
    expect(description).toMatchObject({
      status: "unavailable",
      teammateExecutionImplemented: false,
      backend: "tmux",
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: true,
        // worktree-runnable (gate (1)) is still modeled true; the gap is the
        // durable id (gate (2)) not being captured, not workspace support.
        supportsWorkspaces: true
      },
      limitation: CODEX_SESSION_METADATA_UNAVAILABLE
    });
  });

  it("startRun returns backend_unavailable with codex_session_metadata_unavailable for read-only work", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createAvailableTmuxRegistry()
    });

    const result = backend.startRun(readOnlyContext);
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable",
      backend: "tmux",
      backend_status: "not_started",
      last_error: CODEX_SESSION_METADATA_UNAVAILABLE,
      metadata: {
        pane: {
          mode: "pane",
          availability_status: "degraded",
          degradation_reason: CODEX_SESSION_METADATA_UNAVAILABLE
        }
      }
    });
    // No fabricated durable identifiers: the failure never invents a thread_id
    // or backend_run_id.
    expect(result).not.toHaveProperty("thread_id");
    expect(result).not.toHaveProperty("backend_run_id");
    expect(result).not.toHaveProperty("process_id");
    expect(serialized).not.toContain("backend_start_attempted");
  });

  it("resumeRun is not_resumable with codex_session_metadata_unavailable under the default claim", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createAvailableTmuxRegistry()
    });

    const result = backend.resumeRun(readOnlyContext, {
      kind: "message",
      message_id: "message:repro:1"
    });

    expect(result).toMatchObject({
      status: "not_resumable",
      delivery_status: "backend_unavailable",
      backend: "tmux",
      backend_status: "not_started",
      last_error: CODEX_SESSION_METADATA_UNAVAILABLE
    });
    expect(result).not.toHaveProperty("thread_id");
    expect(result).not.toHaveProperty("backend_run_id");
  });

  it("documents observed vs missing metadata keys", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createAvailableTmuxRegistry()
    });

    const description = backend.describeBackend();
    const startResult = backend.startRun(readOnlyContext);
    const observedPane = (startResult.metadata as { pane?: Record<string, unknown> }).pane ?? {};

    // OBSERVED keys: pane/backend attach metadata is present.
    expect(description.backend).toBe("tmux");
    expect(description.backend_status).toBe("not_started");
    expect(observedPane).toHaveProperty("mode", "pane");
    expect(observedPane).toHaveProperty("availability_status");

    // MISSING source: durable Codex thread_id / session_id / run_id are absent.
    // The gap is a conservative default claim + un-wired capture, NOT an absence
    // of discoverable ids.
    expect(observedPane).not.toHaveProperty("thread_id");
    expect(observedPane).not.toHaveProperty("session_id");
    expect(observedPane).not.toHaveProperty("run_id");
    expect(description.limitation).toBe(CODEX_SESSION_METADATA_UNAVAILABLE);
  });

  it("propagates codex_session_metadata_unavailable through LifecycleService.startScheduledRun", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/repro";
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot,
      caller: normalizeCallerMetadata({ sessionId: "session-repro", clientName: "codex" })
    });
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });

    try {
      const statePath = adapter.describeStateRoot().stateRoot;
      const backend = new PaneExecutionBackend({
        paneBackend: createAvailableTmuxRegistry()
      });

      new TeamService({ db: adapter.getDatabase(), statePath }).createTeam({
        teamName: "Repro Team",
        description: "Reproduction lifecycle team",
        identity
      });

      // createAgent schedules a run, then drives LifecycleService.startScheduledRun
      // with the default PaneExecutionBackend (canStart === false), so the
      // codex_session_metadata_unavailable limitation surfaces as backend_unavailable.
      const agentResult = new AgentService({
        db: adapter.getDatabase(),
        statePath,
        executionBackend: backend
      }).createAgent({
        name: "Builder",
        teamName: "repro-team",
        mode: "read",
        prompt: "Read-only: summarize the current status",
        description: "Reproduction read-only teammate",
        identity
      });

      expect(agentResult).toMatchObject({
        status: "scheduled",
        delivery_status: "backend_unavailable",
        error_code: "backend_unavailable",
        backend: {
          backend: "tmux",
          execution_available: false,
          teammate_execution_implemented: false,
          last_error: CODEX_SESSION_METADATA_UNAVAILABLE
        }
      });

      // Pin the propagation directly through LifecycleService.startScheduledRun
      // on the scheduled run row created above.
      const direct = new LifecycleService({
        db: adapter.getDatabase(),
        statePath,
        executionBackend: backend
      }).startScheduledRun({
        team_id: String(agentResult.debug?.team_id),
        team_name: "repro-team",
        member_id: String(agentResult.debug?.internal_member_id),
        run_id: String(agentResult.run_id),
        teammate_id: String(agentResult.teammate_id),
        prompt_present: false,
        mode: "read",
        identity
      });

      expect(direct).toMatchObject({
        status: "scheduled",
        delivery_status: "backend_unavailable",
        error_code: "backend_unavailable",
        backend: {
          last_error: CODEX_SESSION_METADATA_UNAVAILABLE
        }
      });
    } finally {
      adapter.close();
    }
  });
});
