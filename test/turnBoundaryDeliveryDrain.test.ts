import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
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
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import {
  LifecycleService,
  type DeliveryDrainHook
} from "../src/services/lifecycleService.js";
import {
  MessageInboxService,
  buildInboxNudge
} from "../src/services/messageInboxService.js";
import { MessageService } from "../src/services/messageService.js";
import { ReconciliationService } from "../src/services/reconciliationService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { openTeamDatabase } from "../src/state/database.js";
import {
  getMigrationStatus,
  MIGRATIONS,
  runMigrations
} from "../src/state/migrations.js";
import { STATE_DB_FILENAME } from "../src/state/root.js";
import {
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  TABLE_NAMES
} from "../src/state/schema.js";

const tempRoots: string[] = [];
const THREAD_ID = "thread-drain-1";

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-drain-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

// A pane-hosted-style backend: starts/resumes with a durable thread id + an AVAILABLE
// pane, staying `running` (no synchronous turn_completed) so no finalizer recursion.
// resumeRun is the delivery spy. Configurable resume/reconcile outcomes.
class RecordingExecutionBackend implements ExecutionBackend {
  readonly startCalls: ExecutionRunContext[] = [];
  readonly resumeCalls: Array<{
    context: ExecutionRunContext;
    trigger: ExecutionTrigger;
  }> = [];

  constructor(
    private readonly opts: {
      resume?: "resumed" | "not_resumable" | "backend_failed";
      reconcile?: "active" | "idle";
    } = {}
  ) {}

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
    const paneId = `pane-${this.startCalls.length}`;
    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend: "iterm2",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: THREAD_ID,
      thread_id: THREAD_ID,
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
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    this.resumeCalls.push({ context, trigger });
    if (this.opts.resume === "not_resumable") {
      return {
        status: "not_resumable",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        backend: "iterm2",
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        last_error: "pane_unavailable_for_resume"
      };
    }
    if (this.opts.resume === "backend_failed") {
      return {
        status: "backend_failed",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
        backend: "iterm2",
        backend_status: RUN_BACKEND_STATUSES.failed,
        last_error: "pane_send_failed"
      };
    }
    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: "iterm2",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: THREAD_ID,
      thread_id: THREAD_ID,
      // The real PaneExecutionBackend.resumeRun re-returns the live pane so the
      // persisted pane metadata survives across resumes.
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: "pane-1",
          session_name: "w0t0p0:session"
        }
      }
    };
  }

  reconcileRun(_context: ExecutionRunContext): ExecutionBackendReconcileResult {
    if (this.opts.reconcile === "idle") {
      return {
        status: "idle",
        backend: "iterm2",
        backend_status: RUN_BACKEND_STATUSES.idle,
        ended_at: "2026-06-10T00:01:00.000Z",
        thread_id: THREAD_ID
      };
    }
    return {
      status: "active",
      backend: "iterm2",
      backend_status: RUN_BACKEND_STATUSES.running,
      thread_id: THREAD_ID
    };
  }
}

// Minimal available pane backend (its create/reconcile are only exercised by the
// AgentService start; the drain's reachability reads the persisted pane metadata).
class FakeAvailablePaneBackend implements PaneBackendRegistry {
  describeAvailability(): PaneBackendMetadata {
    return { mode: "pane", backend_type: "iterm2", availability_status: "available" };
  }
  createPane(_context: PaneLaunchRequest): PaneLaunchResult {
    return {
      ok: true,
      pane: {
        mode: "pane",
        backend_type: "iterm2",
        availability_status: "available",
        pane_id: "pane-overlay"
      }
    };
  }
  resumePane(): PaneLaunchResult {
    return {
      ok: true,
      pane: { mode: "pane", backend_type: "iterm2", availability_status: "available" }
    };
  }
  reconcilePane(_context: ExecutionRunContext): PaneReconcileResult {
    return {
      status: "active",
      pane: { mode: "pane", backend_type: "iterm2", availability_status: "available" },
      deleted: false
    };
  }
  closePane(): PaneBackendCloseResult {
    return { ok: true };
  }
}

function buildIdentity(workspaceRoot: string): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata({ sessionId: "lead-session", clientName: "codex" })
  });
}

interface DrainFixture {
  adapter: DurableStateAdapter;
  db: Database.Database;
  statePath: string;
  teamId: string;
  teamName: string;
  builderMemberId: string;
  identity: WorkspaceScopedCallerIdentity;
  backend: RecordingExecutionBackend;
}

// Create a team + a pane-hosted teammate that is RUNNING with a live pane + durable
// resume metadata (the realistic state when peer messages arrive mid-turn).
function seedRunningPaneTeammate(): DrainFixture {
  const stateRoot = createTempStateRoot();
  const workspaceRoot = "/workspace/drain";
  const identity = buildIdentity(workspaceRoot);
  const backend = new RecordingExecutionBackend();
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  const db = adapter.getDatabase();
  const statePath = adapter.describeStateRoot().stateRoot;

  const team = new TeamService({ db, statePath }).createTeam({
    teamName: "Alpha Team",
    description: "drain team",
    identity
  });
  const created = new AgentService({
    db,
    statePath,
    executionBackend: backend,
    paneMode: { enabled: true },
    paneBackend: new FakeAvailablePaneBackend()
  }).createAgent({
    name: "Builder",
    teamName: "alpha-team",
    mode: "read",
    prompt: "Research current status",
    description: "drain builder",
    identity
  });
  const builderMemberId = (
    created as unknown as { debug: { internal_member_id: string } }
  ).debug.internal_member_id;

  return {
    adapter,
    db,
    statePath,
    teamId: team.active_binding.team_id,
    teamName: team.team_name,
    builderMemberId,
    identity,
    backend
  };
}

function newMessageService(
  fixture: DrainFixture,
  backend?: ExecutionBackend
): MessageService {
  return new MessageService({
    db: fixture.db,
    statePath: fixture.statePath,
    executionBackend: backend ?? fixture.backend,
    paneMode: { enabled: true },
    paneBackend: new FakeAvailablePaneBackend()
  });
}

function newLifecycle(
  fixture: DrainFixture,
  backend?: ExecutionBackend
): LifecycleService {
  return new LifecycleService({
    db: fixture.db,
    statePath: fixture.statePath,
    executionBackend: backend ?? fixture.backend
  });
}

function setMemberAndRunStatus(
  db: Database.Database,
  memberId: string,
  status: string
): void {
  db.prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`).run(
    status,
    memberId
  );
  db.prepare(`UPDATE ${TABLE_NAMES.runs} SET status = ? WHERE member_id = ?`).run(
    status,
    memberId
  );
}

function sendFromLead(
  fixture: DrainFixture,
  message: unknown,
  options: { summary?: string; metadata?: Record<string, unknown> } = {}
): void {
  newMessageService(fixture).sendMessage({
    teamName: fixture.teamName,
    to: "builder@alpha-team",
    message,
    summary: options.summary,
    metadata: options.metadata,
    identity: fixture.identity
  });
}

interface MessageRow {
  message_id: string;
  delivery_status: string;
  delivered_at: string | null;
  read_at: string | null;
  body_json: string;
  rowid: number;
}

function builderMessages(fixture: DrainFixture): MessageRow[] {
  return fixture.db
    .prepare(
      `SELECT message_id, delivery_status, delivered_at, read_at, body_json, rowid
       FROM ${TABLE_NAMES.messages}
       WHERE recipient_member_id = ?
       ORDER BY rowid ASC`
    )
    .all(fixture.builderMemberId) as MessageRow[];
}

describe("Phase 16 turn-boundary delivery drain", () => {
  it("GAP REPRO: a message to a RUNNING recipient queues for next turn and is never delivered (delivered_at NULL, spy not called)", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "peer message while running");

      const rows = builderMessages(fixture);
      expect(rows).toHaveLength(1);
      expect(rows[0].delivery_status).toBe(
        MESSAGE_DELIVERY_STATUSES.queuedForNextTurn
      );
      expect(rows[0].delivered_at).toBeNull();
      // The runtime was never nudged mid-turn.
      expect(fixture.backend.resumeCalls).toHaveLength(0);
    } finally {
      fixture.adapter.close();
    }
  });

  it("NO MID-TURN STEER: draining a running recipient returns immediately without injecting", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "queued while running");
      // Recipient is still running (no turn boundary).
      const result = newLifecycle(fixture).drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });

      expect(result.status).toBe("recipient_running");
      expect(result.nudged).toBe(false);
      expect(fixture.backend.resumeCalls).toHaveLength(0);
      expect(builderMessages(fixture)[0].delivered_at).toBeNull();
    } finally {
      fixture.adapter.close();
    }
  });

  it("TURN-BOUNDARY DELIVERY: at idle the drain injects ONE nudge, stamps delivered_at on all pending (FIFO), flips delivery_status", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "first");
      sendFromLead(fixture, "second");
      sendFromLead(fixture, "third");
      // The recipient reaches its turn boundary.
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);

      const result = newLifecycle(fixture).drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });

      expect(result).toMatchObject({ status: "delivered", nudged: true, claimed_count: 3 });
      // Exactly ONE nudge for the whole batch.
      expect(fixture.backend.resumeCalls).toHaveLength(1);

      const rows = builderMessages(fixture);
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.delivered_at).not.toBeNull();
        expect(row.delivery_status).toBe(
          MESSAGE_DELIVERY_STATUSES.backendResumeAttempted
        );
      }
      // One claim txn -> a single shared delivered_at timestamp across the batch.
      expect(new Set(rows.map((row) => row.delivered_at)).size).toBe(1);
    } finally {
      fixture.adapter.close();
    }
  });

  it("BURST / DEBOUNCE-MERGE: one nudge covers all 3 burst messages; the read-model returns all 3 oldest-first", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "burst-1");
      sendFromLead(fixture, "burst-2");
      sendFromLead(fixture, "burst-3");
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);

      newLifecycle(fixture).drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });

      // A single nudge submitted; its text names the count (3), not the bodies.
      expect(fixture.backend.resumeCalls).toHaveLength(1);
      const nudge = fixture.backend.resumeCalls[0].context.metadata
        ?.resume_delivery_text as string;
      expect(nudge).toContain("3 new messages");

      // The read (unread) side returns all 3 oldest-first for a CheckInbox pull.
      const unread = new MessageInboxService(fixture.db).selectUnreadForMember(
        fixture.teamId,
        fixture.builderMemberId
      );
      expect(unread.map((row) => JSON.parse(row.body_json).text)).toEqual([
        "burst-1",
        "burst-2",
        "burst-3"
      ]);
    } finally {
      fixture.adapter.close();
    }
  });

  it("NO LOOP: a second drain with no new messages injects nothing", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "only message");
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);
      const lifecycle = newLifecycle(fixture);

      const first = lifecycle.drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });
      expect(first.status).toBe("delivered");
      expect(fixture.backend.resumeCalls).toHaveLength(1);

      // The recipient went back to idle without any NEW message -> no re-nudge.
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);
      const second = lifecycle.drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });
      expect(second.status).toBe("nothing_pending");
      expect(fixture.backend.resumeCalls).toHaveLength(1);
    } finally {
      fixture.adapter.close();
    }
  });

  it("MULTI-PROCESS RACE: two LifecycleService instances on the same db deliver the nudge exactly once (claim-first)", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "race-1");
      sendFromLead(fixture, "race-2");
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);

      const backendA = new RecordingExecutionBackend();
      const backendB = new RecordingExecutionBackend();
      const lifecycleA = newLifecycle(fixture, backendA);
      const lifecycleB = newLifecycle(fixture, backendB);

      const drainArgs = {
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      };
      lifecycleA.drainPendingDeliveries(drainArgs);
      lifecycleB.drainPendingDeliveries(drainArgs);

      // Exactly one of the two backends ever injected — claim-first dedup.
      expect(backendA.resumeCalls.length + backendB.resumeCalls.length).toBe(1);
      const rows = builderMessages(fixture);
      for (const row of rows) {
        expect(row.delivered_at).not.toBeNull();
      }
      // delivered_at set exactly once (single claim txn).
      expect(new Set(rows.map((row) => row.delivered_at)).size).toBe(1);
    } finally {
      fixture.adapter.close();
    }
  });

  it("CLAIM-FIRST: two concurrent claimDelivered calls split the rows disjointly (one claims all, the other none)", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "c-1");
      sendFromLead(fixture, "c-2");
      const inboxA = new MessageInboxService(fixture.db);
      const inboxB = new MessageInboxService(fixture.db);

      const claimedA = inboxA.claimDelivered(
        fixture.teamId,
        fixture.builderMemberId,
        "2026-06-10T00:00:05.000Z"
      );
      const claimedB = inboxB.claimDelivered(
        fixture.teamId,
        fixture.builderMemberId,
        "2026-06-10T00:00:06.000Z"
      );

      expect(claimedA).toHaveLength(2);
      expect(claimedB).toHaveLength(0);
    } finally {
      fixture.adapter.close();
    }
  });

  it("SUPPRESS_RESUME: system lifecycle notices to a teammate are never nudged by the drain", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "TeamMate completed its turn.", {
        summary: "completion",
        metadata: { message_type: "lifecycle_completion" }
      });
      sendFromLead(fixture, "Resume failed.", {
        summary: "resume failure",
        metadata: { message_type: "resume_failure_notice" }
      });
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);

      const pending = new MessageInboxService(fixture.db).selectPendingForRecipient(
        fixture.teamId,
        fixture.builderMemberId
      );
      expect(pending).toHaveLength(0);

      const result = newLifecycle(fixture).drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });
      expect(result.status).toBe("nothing_pending");
      expect(fixture.backend.resumeCalls).toHaveLength(0);
    } finally {
      fixture.adapter.close();
    }
  });

  it("INJECT FAILURE -> COMPENSATE: a dead pane leaves delivered_at NULL and re-queues the rows", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "will-fail-1");
      sendFromLead(fixture, "will-fail-2");
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);

      const failingBackend = new RecordingExecutionBackend({ resume: "not_resumable" });
      const result = newLifecycle(fixture, failingBackend).drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });

      expect(result.status).toBe("inject_failed");
      expect(failingBackend.resumeCalls).toHaveLength(1);
      // Compensated: a later drain must retry, so delivered_at is restored to NULL.
      const rows = builderMessages(fixture);
      for (const row of rows) {
        expect(row.delivered_at).toBeNull();
        expect(row.delivery_status).toBe(
          MESSAGE_DELIVERY_STATUSES.queuedForNextTurn
        );
      }
    } finally {
      fixture.adapter.close();
    }
  });

  it("LONG BODY: a 5KB multi-line body produces a SHORT single-line nudge (no body, no newlines, <512) while the body is preserved byte-exact", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      const bigBody =
        "BODY_MARKER_5KB " +
        Array.from({ length: 200 }, (_, i) => `line ${i} of the very long answer`).join(
          "\n"
        );
      expect(bigBody.length).toBeGreaterThan(5000);

      sendFromLead(fixture, bigBody, { summary: "long answer" });
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);

      newLifecycle(fixture).drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });

      const nudge = fixture.backend.resumeCalls[0].context.metadata
        ?.resume_delivery_text as string;
      // Bounded + single line + independent of body size, never the body.
      expect(nudge.length).toBeLessThan(512);
      expect(nudge).not.toMatch(/[\r\n]/);
      expect(nudge).toContain("CheckInbox");
      expect(nudge).not.toContain("BODY_MARKER_5KB");

      // The full body is preserved byte-exact in messages.body_json (CheckInbox pull).
      const unread = new MessageInboxService(fixture.db).selectUnreadForMember(
        fixture.teamId,
        fixture.builderMemberId
      );
      expect(unread).toHaveLength(1);
      expect(JSON.parse(unread[0].body_json).text).toBe(bigBody);
    } finally {
      fixture.adapter.close();
    }
  });

  it("D-02: after a drain the body never lands in events.payload_json or runs.metadata_json (only timestamps written)", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      const marker = "D02_UNIQUE_BODY_MARKER_xyz";
      sendFromLead(fixture, `secret answer ${marker}`, { summary: "answer" });
      setMemberAndRunStatus(fixture.db, fixture.builderMemberId, MEMBER_STATUSES.idle);

      newLifecycle(fixture).drainPendingDeliveries({
        teamId: fixture.teamId,
        teamName: fixture.teamName,
        recipientMemberId: fixture.builderMemberId,
        identity: fixture.identity
      });

      const events = fixture.db
        .prepare(`SELECT payload_json FROM ${TABLE_NAMES.events}`)
        .all() as Array<{ payload_json: string }>;
      const runs = fixture.db
        .prepare(`SELECT metadata_json FROM ${TABLE_NAMES.runs}`)
        .all() as Array<{ metadata_json: string }>;
      expect(JSON.stringify(events)).not.toContain(marker);
      expect(JSON.stringify(events)).not.toContain("resume_delivery_text");
      expect(JSON.stringify(runs)).not.toContain(marker);
      expect(JSON.stringify(runs)).not.toContain("resume_delivery_text");

      // The body lives ONLY in messages.body_json.
      const bodies = fixture.db
        .prepare(`SELECT body_json FROM ${TABLE_NAMES.messages}`)
        .all() as Array<{ body_json: string }>;
      expect(JSON.stringify(bodies)).toContain(marker);
    } finally {
      fixture.adapter.close();
    }
  });

  it("RECONCILE HOOK: finalize flipping a completed pane run to idle fires the drain", () => {
    const fixture = seedRunningPaneTeammate();
    try {
      sendFromLead(fixture, "deliver me at the boundary");
      // The run stays `running` (a live pane TUI); the reconcile observes completion.
      const reconcileBackend = new RecordingExecutionBackend({ reconcile: "idle" });
      const drainBackend = new RecordingExecutionBackend();
      const deliveryDrain: DeliveryDrainHook = (input) => {
        new LifecycleService({
          db: fixture.db,
          statePath: fixture.statePath,
          executionBackend: drainBackend
        }).drainPendingDeliveries({
          teamId: input.teamId,
          teamName: input.teamName,
          recipientMemberId: input.recipientMemberId,
          identity: fixture.identity
        });
      };

      new ReconciliationService({
        db: fixture.db,
        statePath: fixture.statePath,
        executionBackend: reconcileBackend,
        deliveryDrain
      }).reconcileWorkspace({
        workspaceRoot: fixture.identity.workspaceRoot,
        mode: "finalize"
      });

      // The member was finalized to idle and the drain delivered the nudge once.
      expect(drainBackend.resumeCalls).toHaveLength(1);
      const rows = builderMessages(fixture);
      expect(rows[0].delivered_at).not.toBeNull();
    } finally {
      fixture.adapter.close();
    }
  });
});

describe("Phase 16 inbox nudge builder", () => {
  it("is bounded and independent of body size", () => {
    const nudge = buildInboxNudge(2, ["alice@team", "bob@team"]);
    expect(nudge).toBe(
      "📬 2 new messages from alice@team, bob@team — run CheckInbox to read."
    );
    expect(nudge).not.toMatch(/[\r\n]/);
  });

  it("caps the sender list and hard-caps the length", () => {
    const manySenders = Array.from({ length: 50 }, (_, i) => `member-${i}@team`);
    const nudge = buildInboxNudge(50, manySenders);
    expect(nudge.length).toBeLessThan(512);
    expect(nudge).toContain("…");
    expect(nudge).toContain("CheckInbox");
  });

  it("singularizes for a single message", () => {
    expect(buildInboxNudge(1, ["alice@team"])).toBe(
      "📬 1 new message from alice@team — run CheckInbox to read."
    );
  });
});

describe("Phase 16 migration v8 (delivered_at)", () => {
  it("adds messages.delivered_at idempotently; existing rows default to NULL", () => {
    const stateRoot = createTempStateRoot();
    const databasePath = path.join(stateRoot, STATE_DB_FILENAME);
    expect(existsSync(databasePath)).toBe(false);
    const db = openTeamDatabase(databasePath);

    // Apply only v1..v7 (a pre-Phase-16 database) and seed a message row.
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 7)) {
      migration.up(db);
      db.prepare(
        `INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`
      ).run(migration.version, migration.name, "2026-06-10T00:00:00.000Z");
    }
    db.prepare(
      `INSERT INTO ${TABLE_NAMES.teams} (
         team_id, canonical_name, requested_name, status, workspace_root,
         lead_agent_id, created_by_caller_key, created_at
       ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`
    ).run(
      "team-pre16",
      "pre16",
      "pre16",
      "/workspace",
      "lead",
      "caller",
      "2026-06-10T00:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO ${TABLE_NAMES.messages} (
         message_id, team_id, status, body_json, created_at
       ) VALUES (?, ?, 'queued', ?, ?)`
    ).run("msg-pre16", "team-pre16", "{}", "2026-06-10T00:00:00.000Z");

    expect(tableColumns(db, TABLE_NAMES.messages)).not.toContain("delivered_at");

    const upgrade = runMigrations(db);
    expect(upgrade.appliedMigrations.map((m) => m.version)).toEqual([8]);
    expect(getMigrationStatus(db)).toMatchObject({
      status: "up_to_date",
      latestVersion: 8,
      targetVersion: 8
    });
    expect(tableColumns(db, TABLE_NAMES.messages)).toContain("delivered_at");
    // Existing row -> NULL marker.
    expect(
      db.prepare(`SELECT delivered_at FROM ${TABLE_NAMES.messages} WHERE message_id = ?`).get(
        "msg-pre16"
      )
    ).toMatchObject({ delivered_at: null });
    // The covering index exists.
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_recipient_pending'`
        )
        .get()
    ).toMatchObject({ name: "idx_messages_recipient_pending" });

    // Idempotent: a second run applies nothing and never throws.
    const second = runMigrations(db);
    expect(second.appliedMigrations).toEqual([]);

    db.close();
  });
});

function tableColumns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}
