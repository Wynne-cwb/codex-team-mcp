import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendActionResult,
  ExecutionBackendDescription,
  ExecutionBackendReconcileResult,
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import type {
  PaneBackendMetadata,
  PaneBackendRegistry,
  PaneLaunchResult,
  PaneReconcileResult
} from "../src/adapters/paneBackend.js";
import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { MessageService } from "../src/services/messageService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  TABLE_NAMES
} from "../src/state/schema.js";

const tempRoots: string[] = [];
const SECRET_PANE_VISIBILITY_PROMPT = "SECRET_PANE_VISIBILITY_PROMPT";
const REAL_THREAD_ID = "thread-real-1";

interface ScheduledAgentLike {
  status: string;
  run_id: string;
  debug: { internal_member_id: string };
}

// A real one-shot codex-like backend: starts/resumes with a durable thread_id
// and finishes the synchronous turn (member -> idle), carrying NO pane metadata.
class FakeRealExecutionBackend implements ExecutionBackend {
  readonly startCalls: ExecutionRunContext[] = [];
  readonly resumeCalls: Array<{
    context: ExecutionRunContext;
    trigger: ExecutionTrigger;
  }> = [];

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "codex_cli_exec",
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true
      }
    };
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    this.startCalls.push(context);
    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend: "codex_cli_exec",
      backend_status: RUN_BACKEND_STATUSES.idle,
      backend_run_id: REAL_THREAD_ID,
      thread_id: REAL_THREAD_ID,
      process_id: "pid-real-1",
      started_at: "2026-06-10T00:00:00.000Z",
      ended_at: "2026-06-10T00:00:01.000Z",
      turn_completed: true,
      final_backend_status: RUN_BACKEND_STATUSES.idle
    };
  }

  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    this.resumeCalls.push({ context, trigger });
    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: "codex_cli_exec",
      backend_status: RUN_BACKEND_STATUSES.idle,
      backend_run_id: REAL_THREAD_ID,
      thread_id: REAL_THREAD_ID,
      started_at: "2026-06-10T00:00:02.000Z",
      ended_at: "2026-06-10T00:00:03.000Z",
      turn_completed: true,
      final_backend_status: RUN_BACKEND_STATUSES.idle
    };
  }

  reconcileRun(_context: ExecutionRunContext): ExecutionBackendReconcileResult {
    return {
      status: "idle",
      backend: "codex_cli_exec",
      backend_status: RUN_BACKEND_STATUSES.idle,
      thread_id: REAL_THREAD_ID
    };
  }
}

// Fully featured fake pane backend with an available terminal.
class FakeAvailablePaneBackend implements PaneBackendRegistry {
  readonly createCalls: ExecutionRunContext[] = [];
  readonly resumeCalls: ExecutionRunContext[] = [];
  readonly reconcileCalls: ExecutionRunContext[] = [];

  constructor(private readonly pane: PaneBackendMetadata) {}

  describeAvailability(): PaneBackendMetadata {
    return { mode: "pane", backend_type: this.pane.backend_type, availability_status: "available" };
  }

  createPane(context: ExecutionRunContext): PaneLaunchResult {
    this.createCalls.push(context);
    return { ok: true, pane: this.pane };
  }

  resumePane(context: ExecutionRunContext): PaneLaunchResult {
    this.resumeCalls.push(context);
    return { ok: true, pane: this.pane };
  }

  reconcilePane(context: ExecutionRunContext): PaneReconcileResult {
    this.reconcileCalls.push(context);
    return { status: "active", pane: this.pane, deleted: false };
  }
}

// Unavailable terminal backend (PANE-02 degrade path).
class FakeUnavailablePaneBackend implements PaneBackendRegistry {
  describeAvailability(): PaneBackendMetadata {
    return {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "unavailable",
      degradation_reason: "tmux command unavailable"
    };
  }

  createPane(): PaneLaunchResult {
    throw new Error("createPane must not be called when terminal is unavailable");
  }

  resumePane(): PaneLaunchResult {
    throw new Error("resumePane must not be called when terminal is unavailable");
  }

  reconcilePane(context: ExecutionRunContext): PaneReconcileResult {
    return {
      status: "unsupported",
      pane: this.describeAvailability(),
      deleted: false
    };
  }
}

// Terminal reports available, but createPane throws (PANE-02 error path).
class FakeThrowingPaneBackend implements PaneBackendRegistry {
  describeAvailability(): PaneBackendMetadata {
    return { mode: "pane", backend_type: "tmux", availability_status: "available" };
  }

  createPane(): PaneLaunchResult {
    throw new Error("boom: tmux new-session failed");
  }

  resumePane(): PaneLaunchResult {
    throw new Error("boom: tmux resume failed");
  }

  reconcilePane(context: ExecutionRunContext): PaneReconcileResult {
    return {
      status: "unknown",
      pane: this.describeAvailability(),
      deleted: false
    };
  }
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-pane-visibility-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function buildIdentity(workspaceRoot: string) {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata({ sessionId: "session-1", clientName: "codex" })
  });
}

interface RunRow {
  status: string;
  backend_status: string | null;
  backend_thread_id: string | null;
  metadata_json: string;
}

function readRunRow(db: ReturnType<DurableStateAdapter["getDatabase"]>): RunRow {
  return db
    .prepare(
      `SELECT status, backend_status, backend_thread_id, metadata_json
       FROM ${TABLE_NAMES.runs} LIMIT 1`
    )
    .get() as RunRow;
}

function readPaneFromRun(run: RunRow): Record<string, unknown> | null {
  const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;
  const backendMetadata = metadata.backend_metadata as
    | Record<string, unknown>
    | undefined;
  const pane = backendMetadata?.pane;
  return pane && typeof pane === "object" ? (pane as Record<string, unknown>) : null;
}

function readCounts(
  db: ReturnType<DurableStateAdapter["getDatabase"]>
): Record<string, number> {
  const tables = ["teams", "members", "runs", "messages", "tasks", "events"];
  return Object.fromEntries(
    tables.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }).count
    ])
  );
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("lifecycle pane visibility overlay", () => {
  it("auto-creates and persists an attach-able pane over a real started run (PANE-01 / D-01)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%55",
      session_name: "codex-team-alpha-team",
      window_name: "teammates",
      socket_name: "codex-team-alpha-team-run",
      attach_command:
        "tmux -L codex-team-alpha-team-run attach-session -t codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane visibility team",
        identity
      });
      const result = new AgentService({
        db,
        statePath,
        executionBackend: new FakeRealExecutionBackend(),
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).createAgent({
        name: "Builder",
        teamName: "alpha-team",
        mode: "read",
        prompt: SECRET_PANE_VISIBILITY_PROMPT,
        description: "Pane visibility Builder",
        identity
      }) as unknown as ScheduledAgentLike;

      // The visible pane was created exactly once over the real run.
      expect(fakePane.createCalls).toHaveLength(1);
      // The real run finished its one-shot turn (idle) with the durable thread_id.
      expect(result.status).toBe(MEMBER_STATUSES.idle);

      const run = readRunRow(db);
      expect(run.backend_thread_id).toBe(REAL_THREAD_ID);
      const pane = readPaneFromRun(run);
      expect(pane).toMatchObject({
        availability_status: "available",
        pane_id: "%55",
        session_name: "codex-team-alpha-team"
      });
    } finally {
      adapter.close();
    }

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      paneMode: { enabled: true }
    });
    const builder = payload.teammates.find(
      (teammate) => teammate.teammate_id === "builder@alpha-team"
    );

    expect(builder?.attached).toBe(true);
    expect(payload.paneSummary.total).toBe(1);
    expect(payload.paneSummary.attachable).toBeGreaterThanOrEqual(1);
  });

  it("preserves pane attach metadata across a SendMessage resume", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);
    const fakeExec = new FakeRealExecutionBackend();
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%77",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane visibility resume team",
        identity
      });
      new AgentService({
        db,
        statePath,
        executionBackend: fakeExec,
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).createAgent({
        name: "Builder",
        teamName: "alpha-team",
        mode: "read",
        prompt: SECRET_PANE_VISIBILITY_PROMPT,
        description: "Pane visibility resume Builder",
        identity
      });

      new MessageService({
        db,
        statePath,
        executionBackend: fakeExec,
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).sendMessage({
        teamName: "alpha-team",
        to: "Builder",
        message: "Please continue your work",
        summary: "follow-up",
        identity
      });

      // Resume happened and refreshed the visible pane (best-effort, additive).
      expect(fakeExec.resumeCalls).toHaveLength(1);
      const run = readRunRow(db);
      const pane = readPaneFromRun(run);
      expect(pane).toMatchObject({
        availability_status: "available",
        pane_id: "%77"
      });
      // Resume keeps the durable thread id untouched.
      expect(run.backend_thread_id).toBe(REAL_THREAD_ID);
    } finally {
      adapter.close();
    }
  });

  it("degrades to an unavailable pane marker without altering the core run or durable state (PANE-02)", () => {
    const workspaceRoot = "/workspace/pane-visibility";

    const runWithBackend = (
      paneBackend: PaneBackendRegistry | undefined,
      paneModeEnabled: boolean
    ): { run: RunRow; counts: Record<string, number> } => {
      const stateRoot = createTempStateRoot();
      const identity = buildIdentity(workspaceRoot);
      const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
      try {
        const db = adapter.getDatabase();
        const statePath = adapter.describeStateRoot().stateRoot;
        new TeamService({ db, statePath }).createTeam({
          teamName: "Alpha Team",
          description: "Pane visibility degrade team",
          identity
        });
        new AgentService({
          db,
          statePath,
          executionBackend: new FakeRealExecutionBackend(),
          ...(paneModeEnabled ? { paneMode: { enabled: true } } : {}),
          ...(paneBackend ? { paneBackend } : {})
        }).createAgent({
          name: "Builder",
          teamName: "alpha-team",
          mode: "read",
          prompt: SECRET_PANE_VISIBILITY_PROMPT,
          description: "Pane visibility degrade Builder",
          identity
        });
        return { run: readRunRow(db), counts: readCounts(db) };
      } finally {
        adapter.close();
      }
    };

    const baseline = runWithBackend(undefined, false);
    const degraded = runWithBackend(new FakeUnavailablePaneBackend(), true);

    // PANE-02: the core run is identical to the no-pane baseline.
    expect(degraded.run.status).toBe(baseline.run.status);
    expect(degraded.run.backend_status).toBe(baseline.run.backend_status);
    expect(degraded.run.backend_thread_id).toBe(baseline.run.backend_thread_id);
    // Durable team/message/task/event counts are untouched by the overlay.
    expect(degraded.counts).toEqual(baseline.counts);

    // The only difference: an explicit unavailable pane marker.
    const pane = readPaneFromRun(degraded.run);
    expect(pane).toMatchObject({ availability_status: "unavailable" });
    expect(typeof pane?.degradation_reason).toBe("string");
    // The baseline (no pane mode) records no pane metadata at all.
    expect(readPaneFromRun(baseline.run)).toBeNull();
  });

  it("never throws to the caller when createPane fails and marks the pane degraded (PANE-02)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane visibility throw team",
        identity
      });

      let result: ScheduledAgentLike | undefined;
      const create = () => {
        result = new AgentService({
          db,
          statePath,
          executionBackend: new FakeRealExecutionBackend(),
          paneMode: { enabled: true },
          paneBackend: new FakeThrowingPaneBackend()
        }).createAgent({
          name: "Builder",
          teamName: "alpha-team",
          mode: "read",
          prompt: SECRET_PANE_VISIBILITY_PROMPT,
          description: "Pane visibility throw Builder",
          identity
        }) as unknown as ScheduledAgentLike;
      };

      // The thrown createPane is caught internally; the caller never sees it.
      expect(create).not.toThrow();
      // The real run still lands in a normal terminal state (idle).
      expect(result?.status).toBe(MEMBER_STATUSES.idle);

      const run = readRunRow(db);
      expect(run.backend_thread_id).toBe(REAL_THREAD_ID);
      const pane = readPaneFromRun(run);
      expect(pane).toMatchObject({ availability_status: "degraded" });
      expect(typeof pane?.degradation_reason).toBe("string");
    } finally {
      adapter.close();
    }
  });

  it("keeps the pane open after the run goes idle and never destroys it (D-04 / I-05)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%99",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane visibility keep-open team",
        identity
      });
      const result = new AgentService({
        db,
        statePath,
        executionBackend: new FakeRealExecutionBackend(),
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).createAgent({
        name: "Builder",
        teamName: "alpha-team",
        mode: "read",
        prompt: SECRET_PANE_VISIBILITY_PROMPT,
        description: "Pane visibility keep-open Builder",
        identity
      }) as unknown as ScheduledAgentLike;

      // One-shot turn completed -> member idle, yet the pane remains.
      expect(result.status).toBe(MEMBER_STATUSES.idle);
      const run = readRunRow(db);
      expect(run.status).toBe(MEMBER_STATUSES.idle);
      const pane = readPaneFromRun(run);
      expect(pane).toMatchObject({
        availability_status: "available",
        pane_id: "%99"
      });
      // No destroy/kill path exists on the registry and none was invoked; the
      // pane was only ever created (kept open on idle, D-04).
      expect(fakePane.createCalls).toHaveLength(1);
      expect("destroyPane" in fakePane).toBe(false);
    } finally {
      adapter.close();
    }
  });

  it("sanitizes pane metadata and prompt sentinels in storage and diagnostics", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%42",
      session_name: "SECRET_PANE_SESSION_TOKEN"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane visibility sanitize team",
        identity
      });
      new AgentService({
        db,
        statePath,
        executionBackend: new FakeRealExecutionBackend(),
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).createAgent({
        name: "Builder",
        teamName: "alpha-team",
        mode: "read",
        prompt: SECRET_PANE_VISIBILITY_PROMPT,
        description: "Pane visibility sanitize Builder",
        identity
      });

      const run = readRunRow(db);
      const pane = readPaneFromRun(run);
      // The SECRET session token is redacted in the persisted backend metadata.
      expect(JSON.stringify(pane)).not.toContain("SECRET_PANE_SESSION_TOKEN");
    } finally {
      adapter.close();
    }

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      paneMode: { enabled: true },
      includeDebug: true
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(SECRET_PANE_VISIBILITY_PROMPT);
    expect(serialized).not.toContain("SECRET_PANE_SESSION_TOKEN");
  });
});
