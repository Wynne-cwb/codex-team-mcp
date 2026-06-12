import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  PaneBackendCloseResult,
  PaneBackendMetadata,
  PaneBackendRegistry,
  PaneLaunchRequest,
  PaneLaunchResult,
  PaneReconcileResult
} from "../src/adapters/paneBackend.js";
import { LifecycleService } from "../src/services/lifecycleService.js";
import {
  WorkspaceSafetyService,
  type WorkspaceInspectionInput,
  type WorkspaceInspectionResult
} from "../src/services/workspaceSafetyService.js";
import { createTeamDeleteHandler } from "../src/tools/teamHandlers.js";
import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { MessageService } from "../src/services/messageService.js";
import { ReconciliationService } from "../src/services/reconciliationService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  EVENT_TYPES,
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

// Like FakeRealExecutionBackend, but the started run advertises the per-run codex
// exec log path in its metadata — exactly as the real codex_cli_exec backend does.
class FakeExecBackendWithLog extends FakeRealExecutionBackend {
  constructor(private readonly execLogPath: string) {
    super();
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    const base = super.startRun(context);
    return {
      ...base,
      metadata: { ...(base.metadata ?? {}), exec_log_path: this.execLogPath }
    };
  }
}

// A PANE-HOSTED execution backend (like the real PaneExecutionBackend): startRun
// opens the teammate pane itself and returns pane metadata + a durable thread_id,
// staying `running` (the async TUI turn finalizes on a later reconcile). Records
// the start context so tests can assert the lifecycle threaded the DB-derived
// layout anchors (previousTeammatePaneIds) in BEFORE startRun.
class FakePaneHostedExecutionBackend implements ExecutionBackend {
  readonly startCalls: Array<
    ExecutionRunContext & { previousTeammatePaneIds?: readonly string[] }
  > = [];

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "iterm2",
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true,
        supportsOsSandbox: true
      }
    };
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    this.startCalls.push(context);
    const paneId = `iterm-pane-${this.startCalls.length}`;
    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend: "iterm2",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: REAL_THREAD_ID,
      thread_id: REAL_THREAD_ID,
      process_id: paneId,
      started_at: "2026-06-10T00:00:00.000Z",
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: paneId,
          session_name: "w0t0p0:session"
        }
      }
    };
  }

  resumeRun(
    _context: ExecutionRunContext,
    _trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: "iterm2",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: REAL_THREAD_ID,
      thread_id: REAL_THREAD_ID
    };
  }

  reconcileRun(_context: ExecutionRunContext): ExecutionBackendReconcileResult {
    return {
      status: "active",
      backend: "iterm2",
      backend_status: RUN_BACKEND_STATUSES.running,
      thread_id: REAL_THREAD_ID
    };
  }
}

// Fully featured fake pane backend with an available terminal. `closeBehavior`
// controls closePane: "ok" -> success, "fail" -> ok:false, "throw" -> throws (to
// exercise the best-effort teardown guard).
class FakeAvailablePaneBackend implements PaneBackendRegistry {
  readonly createCalls: ExecutionRunContext[] = [];
  readonly createCommands: Array<readonly string[] | undefined> = [];
  // Records the DB-derived anchor list each createPane received (layout fix).
  readonly createPreviousIds: Array<readonly string[] | undefined> = [];
  readonly resumeCalls: ExecutionRunContext[] = [];
  readonly reconcileCalls: ExecutionRunContext[] = [];
  readonly closeCalls: PaneBackendMetadata[] = [];

  constructor(
    private readonly pane: PaneBackendMetadata,
    private readonly closeBehavior: "ok" | "fail" | "throw" = "ok"
  ) {}

  describeAvailability(): PaneBackendMetadata {
    return { mode: "pane", backend_type: this.pane.backend_type, availability_status: "available" };
  }

  createPane(
    context: PaneLaunchRequest,
    command?: readonly string[]
  ): PaneLaunchResult {
    this.createCalls.push(context);
    this.createCommands.push(command);
    this.createPreviousIds.push(context.previousTeammatePaneIds);
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

  closePane(pane: PaneBackendMetadata): PaneBackendCloseResult {
    this.closeCalls.push(pane);
    if (this.closeBehavior === "throw") {
      throw new Error("boom: it2 session close failed");
    }
    return {
      ok: this.closeBehavior === "ok",
      pane_id: pane.pane_id,
      reason:
        this.closeBehavior === "ok"
          ? undefined
          : "iterm2 session close failed"
    };
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

  closePane(): PaneBackendCloseResult {
    return { ok: false, reason: "close_unsupported" };
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

  closePane(): PaneBackendCloseResult {
    throw new Error("boom: tmux kill-pane failed");
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

  it("tails the backend-reported exec log inside the visible pane (0.3.2)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);
    const execLogPath = "/tmp/custom-exec-log-location/run.jsonl";
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%101",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane tail team",
        identity
      });
      new AgentService({
        db,
        statePath,
        executionBackend: new FakeExecBackendWithLog(execLogPath),
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).createAgent({
        name: "Builder",
        teamName: "alpha-team",
        mode: "read",
        prompt: SECRET_PANE_VISIBILITY_PROMPT,
        description: "Pane tail Builder",
        identity
      });

      // The overlay derived a `tail -f <exec_log_path>` command from the backend's
      // reported log path and handed it to createPane.
      expect(fakePane.createCommands).toEqual([["tail", "-f", execLogPath]]);
    } finally {
      adapter.close();
    }
  });

  it("falls back to the canonical run log path when the backend reports none (0.3.2)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%102",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane tail fallback team",
        identity
      });
      // FakeRealExecutionBackend carries NO exec_log_path metadata.
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
        description: "Pane tail fallback Builder",
        identity
      });

      expect(fakePane.createCommands).toHaveLength(1);
      const command = fakePane.createCommands[0];
      expect(command?.[0]).toBe("tail");
      expect(command?.[1]).toBe("-f");
      // Derived from workspace_root + run_id via codexExecLogPath.
      expect(command?.[2]).toContain(`${workspaceRoot}/.codex-team/runs/`);
      expect(command?.[2]?.endsWith(".jsonl")).toBe(true);
    } finally {
      adapter.close();
    }
  });

  it("passes the DB-derived previous teammate pane ids to createPane (layout determinism)", () => {
    // Regression for the horizontal-stacking bug: the pane backend is rebuilt on
    // every Agent tool call, so closure layout state reset and every teammate
    // re-split the leader. The lifecycle now derives the anchor list from the DB
    // and hands it to createPane via previousTeammatePaneIds.
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-1",
      session_name: "w0t0p0:session"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane layout team",
        identity
      });
      // Each Agent tool call builds a fresh AgentService (the real-world condition
      // that reset the old closure state) — share the pane backend to record calls.
      const makeAgent = (name: string) =>
        new AgentService({
          db,
          statePath,
          executionBackend: new FakeRealExecutionBackend(),
          paneMode: { enabled: true },
          paneBackend: fakePane
        }).createAgent({
          name,
          teamName: "alpha-team",
          mode: "read",
          prompt: SECRET_PANE_VISIBILITY_PROMPT,
          description: `Pane layout ${name}`,
          identity
        });

      makeAgent("Builder");
      makeAgent("Reviewer");

      expect(fakePane.createCalls).toHaveLength(2);
      // First teammate: no prior panes -> empty anchor list -> leader split.
      expect(fakePane.createPreviousIds[0]).toEqual([]);
      // Second teammate: anchored off the first teammate's persisted pane so the
      // backend stacks it instead of re-splitting the leader.
      expect(fakePane.createPreviousIds[1]).toEqual(["iterm-pane-1"]);
    } finally {
      adapter.close();
    }
  });

  it("derives previousTeammatePaneIds most-recent first and excludes non-available panes", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-new",
      session_name: "w0t0p0:session"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane ordering team",
        identity
      });
      const teamId = (
        db
          .prepare(`SELECT team_id FROM ${TABLE_NAMES.teams} LIMIT 1`)
          .get() as { team_id: string }
      ).team_id;

      // Seed three prior runs with explicit created_at so ordering is deterministic
      // (run_id carries a random UUID, so we never rely on the timestamp tiebreak):
      //   - older available pane %10
      //   - newer available pane %20
      //   - newest pane %30 but UNAVAILABLE (must be excluded)
      const seedRun = (
        runId: string,
        createdAt: string,
        pane: PaneBackendMetadata
      ) => {
        db.prepare(
          `INSERT INTO ${TABLE_NAMES.runs}
             (run_id, team_id, member_id, status, backend, workspace_path,
              metadata_json, created_at, updated_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          runId,
          teamId,
          null,
          "idle",
          "codex_cli_exec",
          null,
          JSON.stringify({ backend_metadata: { pane } }),
          createdAt,
          createdAt,
          null
        );
      };
      seedRun("run:seed:older", "2026-01-01T00:00:01.000Z", {
        mode: "pane",
        backend_type: "iterm2",
        availability_status: "available",
        pane_id: "%10",
        session_name: "w0t0p0:session"
      });
      seedRun("run:seed:newer", "2026-01-01T00:00:02.000Z", {
        mode: "pane",
        backend_type: "iterm2",
        availability_status: "available",
        pane_id: "%20",
        session_name: "w0t0p0:session"
      });
      seedRun("run:seed:newest-closed", "2026-01-01T00:00:03.000Z", {
        mode: "pane",
        backend_type: "iterm2",
        availability_status: "unavailable",
        degradation_reason: "pane_closed",
        pane_id: "%30",
        session_name: "w0t0p0:session"
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
        description: "Pane ordering Builder",
        identity
      });

      expect(fakePane.createCalls).toHaveLength(1);
      // Most-recent first, unavailable %30 excluded -> ["%20", "%10"].
      expect(fakePane.createPreviousIds[0]).toEqual(["%20", "%10"]);
    } finally {
      adapter.close();
    }
  });

  it("pane-hosted execution backend: startContext carries previousTeammatePaneIds and the overlay never re-opens a pane", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-visibility";
    const identity = buildIdentity(workspaceRoot);
    // A SEPARATE overlay pane backend — it must NOT be used because the execution
    // backend already produced pane metadata (overlay skip via extractPaneMetadata).
    const overlayPane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "overlay-should-not-open",
      session_name: "w0t0p0:session"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Pane-hosted team",
        identity
      });

      const exec = new FakePaneHostedExecutionBackend();
      const makeAgent = (name: string) =>
        new AgentService({
          db,
          statePath,
          executionBackend: exec,
          paneMode: { enabled: true },
          paneBackend: overlayPane
        }).createAgent({
          name,
          teamName: "alpha-team",
          mode: "read",
          prompt: SECRET_PANE_VISIBILITY_PROMPT,
          description: `Pane-hosted ${name}`,
          identity
        });

      makeAgent("Builder");
      makeAgent("Reviewer");

      // The lifecycle threaded the DB-derived anchors into the start context BEFORE
      // calling the (pane-hosted) execution backend's startRun.
      expect(exec.startCalls).toHaveLength(2);
      expect(exec.startCalls[0].previousTeammatePaneIds).toEqual([]);
      expect(exec.startCalls[1].previousTeammatePaneIds).toEqual(["iterm-pane-1"]);

      // The overlay was skipped entirely — the execution backend owns the pane.
      expect(overlayPane.createCalls).toHaveLength(0);

      // Both runs persisted the EXECUTION backend's pane (never an overlay pane).
      const paneIds = (
        db
          .prepare(`SELECT metadata_json FROM ${TABLE_NAMES.runs}`)
          .all() as Array<{ metadata_json: string }>
      )
        .map((row) =>
          readPaneFromRun({
            status: "",
            backend_status: null,
            backend_thread_id: null,
            metadata_json: row.metadata_json
          })
        )
        .map((pane) => pane?.pane_id);
      expect(paneIds.sort()).toEqual(["iterm-pane-1", "iterm-pane-2"]);
      expect(paneIds).not.toContain("overlay-should-not-open");
    } finally {
      adapter.close();
    }
  });
});

describe("SendMessage short-nudge delivery to a resumed teammate (Phase 16 notify + pull)", () => {
  const FULL_BODY_SENTINEL =
    "FULL_BODY_DELIVERY_SENTINEL: the complete human answer the teammate must receive verbatim.";

  it("threads only a SHORT bounded inbox nudge into the resume context — never the full body (notify + pull, D-02)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/full-body-delivery";
    const callerMetadata = { sessionId: "session-1", clientName: "codex" };
    const identity = buildIdentity(workspaceRoot);
    const fakeExec = new FakeRealExecutionBackend();
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%201",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Full-body delivery team",
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
        description: "Full-body delivery Builder",
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
        message: FULL_BODY_SENTINEL,
        summary: "short summary",
        identity
      });

      // Phase 16 (notify + pull): the resume CONTEXT now carries a SHORT inbox NUDGE
      // (count + senders) as resume_delivery_text — NEVER the full body. The recipient
      // pulls the full body over MCP/JSON via CheckInbox.
      expect(fakeExec.resumeCalls).toHaveLength(1);
      const resumeMeta = fakeExec.resumeCalls[0].context.metadata ?? {};
      const nudge = resumeMeta.resume_delivery_text;
      expect(typeof nudge).toBe("string");
      expect(nudge).toContain("CheckInbox");
      // The full body is NEVER injected into the pane (the long-body hazard is gone).
      expect(nudge).not.toContain(FULL_BODY_SENTINEL);
      // Bounded + single line, independent of body size.
      expect((nudge as string).length).toBeLessThan(512);
      expect(nudge as string).not.toMatch(/[\r\n]/);
      // The non-sensitive summary still rides alongside (the fallback channel).
      expect(resumeMeta.summary).toBe("short summary");

      // D-02: neither the full body nor the resume_delivery_text key ever lands in
      // the persisted run metadata (the body lives only in the messages table).
      const run = readRunRow(db);
      expect(run.metadata_json).not.toContain("resume_delivery_text");
      expect(run.metadata_json).not.toContain(FULL_BODY_SENTINEL);
    } finally {
      adapter.close();
    }

    // D-02: nor anywhere in the diagnostics payload (reads runs/members/messages
    // metadata — never message body_json or the in-memory resume context).
    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata,
      paneMode: { enabled: true },
      includeDebug: true
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("resume_delivery_text");
    expect(serialized).not.toContain(FULL_BODY_SENTINEL);
  });

  it("never threads delivery_text for a system lifecycle notice (and never resumes it)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/full-body-delivery";
    const identity = buildIdentity(workspaceRoot);
    const fakeExec = new FakeRealExecutionBackend();
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%202",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "System notice team",
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
        description: "System notice Builder",
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
        message: FULL_BODY_SENTINEL,
        summary: "lifecycle completion",
        // A system lifecycle notice: suppresses resume (D10-3) AND carries no body.
        metadata: { message_type: "lifecycle_completion" },
        identity
      });

      // The recursion guard prevented any resume, so no delivery_text was injected.
      expect(fakeExec.resumeCalls).toHaveLength(0);
      const run = readRunRow(db);
      expect(run.metadata_json).not.toContain("resume_delivery_text");
      expect(run.metadata_json).not.toContain(FULL_BODY_SENTINEL);
    } finally {
      adapter.close();
    }
  });
});

interface RunIdsRow {
  team_id: string;
  member_id: string | null;
  run_id: string;
}

// Reads a single run's identifiers. With a memberId, scopes to that member's run.
function readRunIds(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  memberId?: string
): RunIdsRow {
  const sql = memberId
    ? `SELECT team_id, member_id, run_id FROM ${TABLE_NAMES.runs} WHERE member_id = ? LIMIT 1`
    : `SELECT team_id, member_id, run_id FROM ${TABLE_NAMES.runs} LIMIT 1`;
  const stmt = db.prepare(sql);
  return (memberId ? stmt.get(memberId) : stmt.get()) as RunIdsRow;
}

// Pane availability for a specific member's run (null when no pane recorded).
function readMemberPaneStatus(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  memberId: string
): string | null {
  const row = db
    .prepare(
      `SELECT metadata_json FROM ${TABLE_NAMES.runs} WHERE member_id = ? LIMIT 1`
    )
    .get(memberId) as { metadata_json: string } | undefined;
  if (!row) {
    return null;
  }
  const pane = readPaneFromRun({
    status: "",
    backend_status: null,
    backend_thread_id: null,
    metadata_json: row.metadata_json
  });
  return typeof pane?.availability_status === "string"
    ? pane.availability_status
    : null;
}

describe("lifecycle pane teardown (TeamDelete / shutdown_request)", () => {
  function seedAgent(input: {
    db: ReturnType<DurableStateAdapter["getDatabase"]>;
    statePath: string;
    identity: ReturnType<typeof buildIdentity>;
    paneBackend: PaneBackendRegistry;
    name: string;
  }): ScheduledAgentLike {
    return new AgentService({
      db: input.db,
      statePath: input.statePath,
      executionBackend: new FakeRealExecutionBackend(),
      paneMode: { enabled: true },
      paneBackend: input.paneBackend
    }).createAgent({
      name: input.name,
      teamName: "alpha-team",
      mode: "read",
      prompt: SECRET_PANE_VISIBILITY_PROMPT,
      description: `Teardown ${input.name}`,
      identity: input.identity
    }) as unknown as ScheduledAgentLike;
  }

  it("closePanesForTeam closes every available pane and marks each run closed", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-1",
      session_name: "w0t0p0:session"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Teardown team",
        identity
      });
      seedAgent({ db, statePath, identity, paneBackend: fakePane, name: "Builder" });
      const { team_id } = readRunIds(db);

      const summary = new LifecycleService({
        db,
        statePath,
        paneBackend: fakePane
      }).closePanesForTeam(team_id);

      // The available pane was attempted and closed exactly once.
      expect(summary).toEqual({ attempted: 1, closed: 1 });
      expect(fakePane.closeCalls).toHaveLength(1);
      expect(fakePane.closeCalls[0]?.pane_id).toBe("iterm-pane-1");

      // The run's pane is now marked closed (unavailable + pane_closed reason).
      const pane = readPaneFromRun(readRunRow(db));
      expect(pane).toMatchObject({
        availability_status: "unavailable",
        degradation_reason: "pane_closed"
      });
    } finally {
      adapter.close();
    }
  });

  it("re-running closePanesForTeam skips already-closed panes (no double close)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%55",
      session_name: "codex-team-alpha-team",
      socket_name: "codex-team-alpha-team-run"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Teardown idempotency team",
        identity
      });
      seedAgent({ db, statePath, identity, paneBackend: fakePane, name: "Builder" });
      const { team_id } = readRunIds(db);

      const lifecycle = new LifecycleService({ db, statePath, paneBackend: fakePane });
      expect(lifecycle.closePanesForTeam(team_id)).toEqual({
        attempted: 1,
        closed: 1
      });
      // Second sweep finds the pane already unavailable -> nothing to do.
      expect(lifecycle.closePanesForTeam(team_id)).toEqual({
        attempted: 0,
        closed: 0
      });
      expect(fakePane.closeCalls).toHaveLength(1);
    } finally {
      adapter.close();
    }
  });

  it("closePanesForMember closes only the targeted member's pane", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
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
        description: "Teardown per-member team",
        identity
      });
      const builder = seedAgent({
        db,
        statePath,
        identity,
        paneBackend: fakePane,
        name: "Builder"
      });
      const reviewer = seedAgent({
        db,
        statePath,
        identity,
        paneBackend: fakePane,
        name: "Reviewer"
      });
      const builderMemberId = builder.debug.internal_member_id;
      const reviewerMemberId = reviewer.debug.internal_member_id;
      const teamId = readRunIds(db, builderMemberId).team_id;

      const summary = new LifecycleService({
        db,
        statePath,
        paneBackend: fakePane
      }).closePanesForMember(teamId, builderMemberId);

      expect(summary).toEqual({ attempted: 1, closed: 1 });
      // Only the Builder's pane is now closed; the Reviewer's stays available.
      expect(readMemberPaneStatus(db, builderMemberId)).toBe("unavailable");
      expect(readMemberPaneStatus(db, reviewerMemberId)).toBe("available");
    } finally {
      adapter.close();
    }
  });

  it("closePanesForTeam is best-effort: a throwing closePane never throws and leaves the run intact", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const paneMeta: PaneBackendMetadata = {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%88",
      session_name: "codex-team-alpha-team"
    };
    const okPane = new FakeAvailablePaneBackend(paneMeta, "ok");
    const throwingPane = new FakeAvailablePaneBackend(paneMeta, "throw");

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Teardown best-effort team",
        identity
      });
      // Persist an available pane using the OK backend.
      seedAgent({ db, statePath, identity, paneBackend: okPane, name: "Builder" });
      const { team_id } = readRunIds(db);

      // Tear down with a backend whose closePane THROWS.
      const lifecycle = new LifecycleService({
        db,
        statePath,
        paneBackend: throwingPane
      });
      let summary: { attempted: number; closed: number } | undefined;
      expect(() => {
        summary = lifecycle.closePanesForTeam(team_id);
      }).not.toThrow();

      // Attempted but not closed; the run's pane is untouched (still available).
      expect(summary).toEqual({ attempted: 1, closed: 0 });
      const pane = readPaneFromRun(readRunRow(db));
      expect(pane).toMatchObject({ availability_status: "available", pane_id: "%88" });
    } finally {
      adapter.close();
    }
  });

  it("SendMessage with a structured shutdown_request closes the recipient pane and reports pane_teardown", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const fakeExec = new FakeRealExecutionBackend();
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%91",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Shutdown teardown team",
        identity
      });
      const builder = seedAgent({
        db,
        statePath,
        identity,
        paneBackend: fakePane,
        name: "Builder"
      });

      const result = new MessageService({
        db,
        statePath,
        executionBackend: fakeExec,
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).sendMessage({
        teamName: "alpha-team",
        to: "Builder",
        message: { type: "shutdown_request" },
        summary: "shutdown",
        identity
      });

      // The message is STILL persisted/queued (shutdown never skips persistence)
      // and the teardown summary is attached.
      expect(result.persisted).toBe(true);
      expect(
        (result as { pane_teardown?: { attempted: number; closed: number } })
          .pane_teardown
      ).toEqual({ attempted: 1, closed: 1 });
      expect(fakePane.closeCalls).toHaveLength(1);
      expect(readMemberPaneStatus(db, builder.debug.internal_member_id)).toBe(
        "unavailable"
      );
    } finally {
      adapter.close();
    }
  });

  it("a normal (non-shutdown) SendMessage never tears down the pane", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const fakeExec = new FakeRealExecutionBackend();
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%92",
      session_name: "codex-team-alpha-team"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "No-teardown team",
        identity
      });
      const builder = seedAgent({
        db,
        statePath,
        identity,
        paneBackend: fakePane,
        name: "Builder"
      });

      const result = new MessageService({
        db,
        statePath,
        executionBackend: fakeExec,
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).sendMessage({
        teamName: "alpha-team",
        to: "Builder",
        message: "Please continue your work",
        identity
      });

      expect(result.persisted).toBe(true);
      expect(
        (result as { pane_teardown?: unknown }).pane_teardown
      ).toBeUndefined();
      expect(fakePane.closeCalls).toHaveLength(0);
      expect(readMemberPaneStatus(db, builder.debug.internal_member_id)).toBe(
        "available"
      );
    } finally {
      adapter.close();
    }
  });

  it("shutdown teardown is best-effort: a throwing closePane still returns a persisted send", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const fakeExec = new FakeRealExecutionBackend();
    const paneMeta: PaneBackendMetadata = {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%93",
      session_name: "codex-team-alpha-team"
    };
    const okPane = new FakeAvailablePaneBackend(paneMeta, "ok");
    const throwingPane = new FakeAvailablePaneBackend(paneMeta, "throw");

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Shutdown best-effort team",
        identity
      });
      // Persist the pane with the OK backend so a live pane exists to target.
      seedAgent({ db, statePath, identity, paneBackend: okPane, name: "Builder" });

      // Send the shutdown with a backend whose closePane throws.
      let result: ReturnType<MessageService["sendMessage"]> | undefined;
      expect(() => {
        result = new MessageService({
          db,
          statePath,
          executionBackend: fakeExec,
          paneMode: { enabled: true },
          paneBackend: throwingPane
        }).sendMessage({
          teamName: "alpha-team",
          to: "Builder",
          message: { type: "shutdown_request" },
          identity
        });
      }).not.toThrow();

      // The send still succeeded and was persisted; the per-run close failure was
      // swallowed (attempted but not closed) and never surfaced to the caller.
      expect(result?.persisted).toBe(true);
      expect(
        (result as { pane_teardown?: { attempted: number; closed: number } })
          .pane_teardown
      ).toEqual({ attempted: 1, closed: 0 });
      // The pane stays available because the close failed.
      expect(
        readMemberPaneStatus(
          db,
          readRunIds(db).member_id ?? ""
        )
      ).toBe("available");
    } finally {
      adapter.close();
    }
  });

  it("TeamDelete archives the team and includes a best-effort pane_teardown summary", async () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = path.join(stateRoot, "workspace");
    const identity = buildIdentity(workspaceRoot);

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "TeamDelete teardown team",
        identity
      });
    } finally {
      adapter.close();
    }

    const handler = createTeamDeleteHandler({ stateRoot, workspaceRoot });
    const raw = await handler(
      { team_name: "Alpha Team" },
      { sessionId: "session-1", clientName: "codex" }
    );
    const first = raw.content[0];
    const response = JSON.parse(
      first?.type === "text" ? first.text : "{}"
    ) as Record<string, unknown>;

    // Archive succeeded (no error) and the response carries the teardown summary.
    expect(response.implemented_now).toBe(true);
    expect(response.error_code).toBeUndefined();
    // Pane mode is off in this handler path, so teardown is a clean no-op — its
    // mere presence proves the wiring runs before archive without breaking it.
    expect(response.pane_teardown).toEqual({ attempted: 0, closed: 0 });
  });

  // ---------------------------------------------------------------------------
  // BUG #4: an intentional teardown of a RUNNING teammate is a clean stop, not a
  // crash. The run + member become `stopped`, last_error is never the gone-pane
  // reason, a teammate_stopped (not teammate_backend_failed) event is recorded, and
  // a later reconcile cannot flip it to failed.
  // ---------------------------------------------------------------------------

  const PANE_PROCESS_GONE = "codex_pane_exited_without_completion";

  // Seed a RUNNING pane-hosted teammate (the execution backend owns a live pane).
  function seedRunningPaneTeammate(input: {
    db: ReturnType<DurableStateAdapter["getDatabase"]>;
    statePath: string;
    identity: ReturnType<typeof buildIdentity>;
    paneBackend: PaneBackendRegistry;
    name: string;
  }): ScheduledAgentLike {
    return new AgentService({
      db: input.db,
      statePath: input.statePath,
      executionBackend: new FakePaneHostedExecutionBackend(),
      paneMode: { enabled: true },
      paneBackend: input.paneBackend
    }).createAgent({
      name: input.name,
      teamName: "alpha-team",
      mode: "read",
      prompt: SECRET_PANE_VISIBILITY_PROMPT,
      description: `Running ${input.name}`,
      identity: input.identity
    }) as unknown as ScheduledAgentLike;
  }

  function readRunStatus(
    db: ReturnType<DurableStateAdapter["getDatabase"]>,
    runId: string
  ): { status: string; backend_status: string | null; last_error: string | null } {
    return db
      .prepare(
        `SELECT status, backend_status, last_error FROM ${TABLE_NAMES.runs} WHERE run_id = ?`
      )
      .get(runId) as {
      status: string;
      backend_status: string | null;
      last_error: string | null;
    };
  }

  function readEventTypes(
    db: ReturnType<DurableStateAdapter["getDatabase"]>
  ): string[] {
    return (
      db.prepare(`SELECT event_type FROM ${TABLE_NAMES.events}`).all() as Array<{
        event_type: string;
      }>
    ).map((row) => row.event_type);
  }

  it("shutdown_request marks a running teammate stopped (not failed) and survives a later reconcile", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-1",
      session_name: "w0t0p0:session"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "Shutdown stopped team",
        identity
      });
      const builder = seedRunningPaneTeammate({
        db,
        statePath,
        identity,
        paneBackend: fakePane,
        name: "Builder"
      });
      // Sanity: the pane-hosted teammate is genuinely running before shutdown.
      expect(readRunStatus(db, builder.run_id).status).toBe(MEMBER_STATUSES.running);

      const result = new MessageService({
        db,
        statePath,
        executionBackend: new FakePaneHostedExecutionBackend(),
        paneMode: { enabled: true },
        paneBackend: fakePane
      }).sendMessage({
        teamName: "alpha-team",
        to: "Builder",
        message: { type: "shutdown_request" },
        summary: "shutdown",
        identity
      });

      expect(result.persisted).toBe(true);
      expect(
        (result as { pane_teardown?: { attempted: number; closed: number } })
          .pane_teardown
      ).toEqual({ attempted: 1, closed: 1 });

      // The run + member are a CLEAN stop — never failed, never the gone-pane error.
      const run = readRunStatus(db, builder.run_id);
      expect(run.status).toBe(MEMBER_STATUSES.stopped);
      expect(run.backend_status).toBe(RUN_BACKEND_STATUSES.stopped);
      expect(run.last_error).not.toBe(PANE_PROCESS_GONE);
      expect(run.last_error).toBeNull();
      expect(
        readMemberPaneStatus(db, builder.debug.internal_member_id)
      ).toBe("unavailable");

      let events = readEventTypes(db);
      expect(events).toContain(EVENT_TYPES.teammateStopped);
      expect(events).not.toContain(EVENT_TYPES.teammateBackendFailed);

      // A SUBSEQUENT reconcile must NOT re-classify the intentional stop as failed:
      // a stopped run is outside the running set, so it is never reconciled.
      new ReconciliationService({
        db,
        statePath,
        executionBackend: new FakePaneHostedExecutionBackend()
      }).reconcileWorkspace({
        workspaceRoot,
        actorCallerKey: identity.callerKey,
        mode: "finalize"
      });

      expect(readRunStatus(db, builder.run_id).status).toBe(MEMBER_STATUSES.stopped);
      events = readEventTypes(db);
      expect(events).not.toContain(EVENT_TYPES.teammateBackendFailed);
    } finally {
      adapter.close();
    }
  });

  it("TeamDelete teardown (closePanesForTeam) marks a running teammate stopped (not failed)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/pane-teardown";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-1",
      session_name: "w0t0p0:session"
    });

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      new TeamService({ db, statePath }).createTeam({
        teamName: "Alpha Team",
        description: "TeamDelete stopped team",
        identity
      });
      const builder = seedRunningPaneTeammate({
        db,
        statePath,
        identity,
        paneBackend: fakePane,
        name: "Builder"
      });
      const { team_id } = readRunIds(db);
      expect(readRunStatus(db, builder.run_id).status).toBe(MEMBER_STATUSES.running);

      // closePanesForTeam is exactly what the TeamDelete handler invokes before
      // archive (closeTeamPanesBestEffort -> LifecycleService.closePanesForTeam).
      const summary = new LifecycleService({
        db,
        statePath,
        paneBackend: fakePane
      }).closePanesForTeam(team_id);
      expect(summary).toEqual({ attempted: 1, closed: 1 });

      const run = readRunStatus(db, builder.run_id);
      // The run is a clean stop, NOT a gone-pane failure.
      expect(run.status).toBe(MEMBER_STATUSES.stopped);
      expect(run.backend_status).toBe(RUN_BACKEND_STATUSES.stopped);
      expect(run.last_error).not.toBe(PANE_PROCESS_GONE);
      expect(readMemberPaneStatus(db, builder.debug.internal_member_id)).toBe(
        "unavailable"
      );
      const events = readEventTypes(db);
      expect(events).toContain(EVENT_TYPES.teammateStopped);
      expect(events).not.toContain(EVENT_TYPES.teammateBackendFailed);
    } finally {
      adapter.close();
    }
  });
});

// ---------------------------------------------------------------------------
// FIX #3: a teammate's FINAL terminal transition under TeamDelete / shutdown is the
// teardown-stop path (markRunStoppedByTeardown), which the reconcile-side
// changed_files capture never reaches. Without a capture here, changed_files_json
// keeps a STALE pre-stop snapshot (the real UAT bug: a teammate reverted a change
// but diagnostics still listed it). The teardown must re-capture the worktree's
// FINAL state ONCE, best-effort, touching ONLY changed_files_json + diff_summary.
// ---------------------------------------------------------------------------

describe("lifecycle teardown changed_files capture (FIX #3)", () => {
  const TEARDOWN_PANE: PaneBackendMetadata = {
    mode: "pane",
    backend_type: "iterm2",
    availability_status: "available",
    pane_id: "iterm-pane-capture",
    session_name: "w0t0p0:session"
  };

  // An inspection path that THROWS — proves the teardown capture is best-effort
  // (degrades to leaving changed_files as-is, never breaks the stop transition).
  class ThrowingTeardownSafetyService extends WorkspaceSafetyService {
    inspectCalls = 0;
    inspectWorkspace(_input: WorkspaceInspectionInput): WorkspaceInspectionResult {
      this.inspectCalls += 1;
      throw new Error("inspect boom: teardown capture");
    }
  }

  // A real temp git repo. dirty:true leaves an uncommitted change at stop time;
  // dirty:false leaves a CLEAN working tree (mirrors a teammate that reverted).
  function createGitWorkspace(options: { dirty: boolean }): {
    workspacePath: string;
    baseRevision: string;
  } {
    const workspacePath = mkdtempSync(
      path.join(tmpdir(), "codex-team-teardown-git-")
    );
    tempRoots.push(workspacePath);
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: workspacePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Codex Test"]);
    writeFileSync(path.join(workspacePath, "package.json"), '{"name":"base"}\n');
    git(["add", "package.json"]);
    git(["commit", "-m", "base"]);
    const baseRevision = git(["rev-parse", "HEAD"]).trim();
    if (options.dirty) {
      writeFileSync(
        path.join(workspacePath, "package.json"),
        '{"name":"changed"}\n'
      );
    }
    return { workspacePath, baseRevision };
  }

  function createTeamId(
    db: ReturnType<DurableStateAdapter["getDatabase"]>,
    statePath: string,
    identity: ReturnType<typeof buildIdentity>
  ): string {
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Teardown capture team",
      identity
    });
    return (
      db.prepare(`SELECT team_id FROM ${TABLE_NAMES.teams} LIMIT 1`).get() as {
        team_id: string;
      }
    ).team_id;
  }

  // Seed a RUNNING pane teammate run bound to a worktree, with a STALE changed_files
  // snapshot to prove the teardown capture overwrites it with the FINAL state.
  function seedRunningWorktreeRun(input: {
    db: ReturnType<DurableStateAdapter["getDatabase"]>;
    teamId: string;
    workspaceRoot: string;
    memberId: string;
    runId: string;
    workspacePath: string;
    baseRevision: string;
    staleChangedFiles: string[];
  }): void {
    input.db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.members}
           (member_id, team_id, display_name, role, status, workspace_root, joined_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.memberId,
        input.teamId,
        "Builder",
        "teammate",
        MEMBER_STATUSES.running,
        input.workspaceRoot,
        "2026-06-05T00:00:00.000Z",
        JSON.stringify({ publicTeammateId: `${input.memberId}@alpha-team` })
      );
    input.db
      .prepare(
        `INSERT INTO ${TABLE_NAMES.runs}
           (run_id, team_id, member_id, status, backend, workspace_path, metadata_json,
            created_at, updated_at, last_error, backend_status, base_revision,
            review_status, changed_files_json, diff_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.runId,
        input.teamId,
        input.memberId,
        MEMBER_STATUSES.running,
        "codex_cli_exec",
        input.workspacePath,
        JSON.stringify({ backend_metadata: { pane: TEARDOWN_PANE } }),
        "2026-06-05T00:00:00.000Z",
        "2026-06-05T00:00:00.000Z",
        null,
        RUN_BACKEND_STATUSES.running,
        input.baseRevision,
        "pending_review",
        JSON.stringify(input.staleChangedFiles),
        null
      );
  }

  function readCapture(
    db: ReturnType<DurableStateAdapter["getDatabase"]>,
    runId: string
  ): { status: string; review_status: string | null; changed_files: string[] } {
    const row = db
      .prepare(
        `SELECT status, review_status, changed_files_json FROM ${TABLE_NAMES.runs} WHERE run_id = ?`
      )
      .get(runId) as {
      status: string;
      review_status: string | null;
      changed_files_json: string | null;
    };
    return {
      status: row.status,
      review_status: row.review_status,
      changed_files: JSON.parse(row.changed_files_json ?? "[]") as string[]
    };
  }

  it("re-captures the FINAL (clean) worktree state, overwriting a stale changed_files snapshot", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/teardown-capture";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend(TEARDOWN_PANE);

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      const teamId = createTeamId(db, statePath, identity);
      // Worktree was dirty earlier, then REVERTED -> clean at stop time.
      const workspace = createGitWorkspace({ dirty: false });
      seedRunningWorktreeRun({
        db,
        teamId,
        workspaceRoot,
        memberId: "teammate:capture",
        runId: "run:capture",
        workspacePath: workspace.workspacePath,
        baseRevision: workspace.baseRevision,
        staleChangedFiles: ["package.json"]
      });

      const summary = new LifecycleService({
        db,
        statePath,
        paneBackend: fakePane
      }).closePanesForTeam(teamId);
      expect(summary).toEqual({ attempted: 1, closed: 1 });

      const result = readCapture(db, "run:capture");
      // Clean stop AND the final, clean changed_files (the stale ["package.json"] is gone).
      expect(result.status).toBe(MEMBER_STATUSES.stopped);
      expect(result.changed_files).toEqual([]);
      // D-02: the capture writes ONLY changed_files — review_status is untouched.
      expect(result.review_status).toBe("pending_review");
    } finally {
      adapter.close();
    }
  });

  it("records the ACTUAL changed files when the worktree is still dirty at teardown", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/teardown-capture";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend(TEARDOWN_PANE);

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      const teamId = createTeamId(db, statePath, identity);
      const workspace = createGitWorkspace({ dirty: true });
      seedRunningWorktreeRun({
        db,
        teamId,
        workspaceRoot,
        memberId: "teammate:dirty",
        runId: "run:dirty",
        workspacePath: workspace.workspacePath,
        baseRevision: workspace.baseRevision,
        staleChangedFiles: []
      });

      new LifecycleService({ db, statePath, paneBackend: fakePane }).closePanesForTeam(
        teamId
      );

      const result = readCapture(db, "run:dirty");
      expect(result.status).toBe(MEMBER_STATUSES.stopped);
      // The real uncommitted change is captured (not lost).
      expect(result.changed_files).toContain("package.json");
    } finally {
      adapter.close();
    }
  });

  it("is best-effort: a throwing inspection never breaks teardown (run still -> stopped)", () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = "/workspace/teardown-capture";
    const identity = buildIdentity(workspaceRoot);
    const fakePane = new FakeAvailablePaneBackend(TEARDOWN_PANE);
    const safety = new ThrowingTeardownSafetyService();

    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const db = adapter.getDatabase();
      const statePath = adapter.describeStateRoot().stateRoot;
      const teamId = createTeamId(db, statePath, identity);
      const workspace = createGitWorkspace({ dirty: true });
      seedRunningWorktreeRun({
        db,
        teamId,
        workspaceRoot,
        memberId: "teammate:degrade",
        runId: "run:degrade",
        workspacePath: workspace.workspacePath,
        baseRevision: workspace.baseRevision,
        staleChangedFiles: ["package.json"]
      });

      let summary: { attempted: number; closed: number } | undefined;
      expect(() => {
        summary = new LifecycleService({
          db,
          statePath,
          paneBackend: fakePane,
          workspaceSafetyService: safety
        }).closePanesForTeam(teamId);
      }).not.toThrow();
      expect(summary).toEqual({ attempted: 1, closed: 1 });

      const result = readCapture(db, "run:degrade");
      // The stop transition completed; changed_files degraded to as-is (unchanged).
      expect(result.status).toBe(MEMBER_STATUSES.stopped);
      expect(result.changed_files).toEqual(["package.json"]);
      expect(safety.inspectCalls).toBe(1);
    } finally {
      adapter.close();
    }
  });
});
