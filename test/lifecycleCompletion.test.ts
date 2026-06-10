import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendDescription,
  ExecutionRunContext
} from "../src/adapters/execution.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, MEMBER_STATUSES, TABLE_NAMES } from "../src/state/schema.js";

const tempRoots: string[] = [];
const SECRET_COMPLETION_PROMPT = "SECRET_PHASE9_COMPLETION_PROMPT";

interface MemberRow {
  member_id: string;
  role: string;
  status: string;
}

interface RunRow {
  run_id: string;
  status: string;
  backend: string | null;
  backend_status: string | null;
  backend_run_id: string | null;
  backend_thread_id: string | null;
  workspace_path: string | null;
  metadata_json: string;
}

interface EventRow {
  event_type: string;
  payload_json: string;
}

interface MessageRow {
  sender_member_id: string | null;
  recipient_member_id: string | null;
  delivery_status: string;
  summary: string | null;
  body_json: string;
  metadata_json: string;
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-completion-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(workspaceRoot: string): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata({ sessionId: "session-1" })
  });
}

// A one-shot completion backend: a synchronous turn that completes immediately,
// returning durable ids + turn_completed (mirrors codex_cli_exec one-shot exit).
class FakeCompletionBackend implements ExecutionBackend {
  readonly startCalls: ExecutionRunContext[] = [];

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "codex_cli_exec",
      backend_status: "running",
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true,
        supportsOsSandbox: true
      }
    };
  }

  startRun(context: ExecutionRunContext) {
    this.startCalls.push(context);
    return {
      status: "started" as const,
      delivery_status: "backend_start_attempted" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const,
      backend_run_id: "thread-xyz",
      thread_id: "thread-xyz",
      workspace_path: context.workspace_path ?? undefined,
      started_at: "2026-06-09T00:00:00.000Z",
      ended_at: "2026-06-09T00:00:01.000Z",
      turn_completed: true,
      final_backend_status: "idle" as const,
      metadata: { sandbox_mode: "read-only" }
    };
  }

  resumeRun() {
    return {
      status: "not_resumable" as const,
      delivery_status: "backend_unavailable" as const,
      backend: "codex_cli_exec",
      backend_status: "not_started" as const,
      last_error: "resume not exercised in this test"
    };
  }

  reconcileRun() {
    return {
      status: "idle" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const
    };
  }
}

function setup() {
  const identity = createIdentity("/workspace/completion");
  const adapter = new DurableStateAdapter({
    stateRoot: createTempStateRoot(),
    workspaceRoot: identity.workspaceRoot
  });
  const statePath = adapter.describeStateRoot().stateRoot;
  new TeamService({ db: adapter.getDatabase(), statePath }).createTeam({
    teamName: "Alpha Team",
    description: "Completion test team",
    identity
  });
  return { identity, adapter, statePath, db: adapter.getDatabase() };
}

function readMembers(db: Database.Database): MemberRow[] {
  return db
    .prepare(`SELECT member_id, role, status FROM ${TABLE_NAMES.members} ORDER BY member_id`)
    .all() as MemberRow[];
}

function readRuns(db: Database.Database): RunRow[] {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} ORDER BY created_at, run_id`)
    .all() as RunRow[];
}

function eventRows(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `SELECT event_type, payload_json FROM ${TABLE_NAMES.events} ORDER BY created_at, event_id`
    )
    .all() as EventRow[];
}

function messageRows(db: Database.Database): MessageRow[] {
  return db
    .prepare(
      `SELECT sender_member_id, recipient_member_id, delivery_status, summary, body_json, metadata_json
       FROM ${TABLE_NAMES.messages} ORDER BY created_at, message_id`
    )
    .all() as MessageRow[];
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("one-shot completion (D-03/D-06) via AgentService.createAgent", () => {
  it("finalizes a completed turn to idle with durable ids and a sanitized completion event", () => {
    const { identity, adapter, statePath, db } = setup();
    const backend = new FakeCompletionBackend();

    const result = new AgentService({ db, statePath, executionBackend: backend }).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      mode: "read",
      prompt: `read-only: summarize ${SECRET_COMPLETION_PROMPT}`,
      description: "read-only status check",
      identity
    });

    // Member + run end idle (not running).
    expect(result.status).toBe("idle");
    const member = readMembers(db).find(
      (row) => row.member_id === String(result.debug.internal_member_id)
    );
    expect(member?.status).toBe(MEMBER_STATUSES.idle);

    const runs = readRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: MEMBER_STATUSES.idle,
      backend: "codex_cli_exec",
      backend_status: "idle",
      backend_run_id: "thread-xyz",
      backend_thread_id: "thread-xyz"
    });

    // A sanitized teammate_run_completed event exists with lifecycle fields only.
    const events = eventRows(db);
    const completion = events.find(
      (row) => row.event_type === EVENT_TYPES.teammateRunCompleted
    );
    expect(completion).toBeDefined();
    const completionPayload = JSON.parse(completion?.payload_json ?? "{}");
    expect(completionPayload).toMatchObject({
      run_id: result.run_id,
      to_status: MEMBER_STATUSES.idle,
      backend: "codex_cli_exec",
      backend_status: "idle"
    });
    expect(completionPayload).not.toHaveProperty("prompt");

    // No prompt/secret leaks into ANY event payload (D-02).
    expect(JSON.stringify(events)).not.toContain(SECRET_COMPLETION_PROMPT);

    adapter.close();
  });

  it("notifies team-lead on completion without starting/resuming the lead (no feedback loop)", () => {
    const { identity, adapter, statePath, db } = setup();
    const backend = new FakeCompletionBackend();

    const result = new AgentService({ db, statePath, executionBackend: backend }).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      mode: "read",
      prompt: `read-only: summarize ${SECRET_COMPLETION_PROMPT}`,
      description: "read-only status check",
      identity
    });
    expect(result.status).toBe("idle");

    const teamId = String(result.debug.team_id);
    const leaderMemberId = `leader:${teamId}`;

    // A completion message was persisted to the lead.
    const messages = messageRows(db);
    const toLead = messages.filter((row) => row.recipient_member_id === leaderMemberId);
    expect(toLead).toHaveLength(1);
    expect(toLead[0]?.sender_member_id).toBe(String(result.debug.internal_member_id));
    expect(toLead[0]?.delivery_status).toBe("queued_while_idle");
    expect(JSON.parse(toLead[0]?.metadata_json ?? "{}")).toMatchObject({
      message_type: "lifecycle_completion"
    });
    // The notification body carries no prompt/secret.
    expect(JSON.stringify(messages)).not.toContain(SECRET_COMPLETION_PROMPT);

    // The lead is NOT started/resumed: still active, with no run row.
    const leader = readMembers(db).find((row) => row.member_id === leaderMemberId);
    expect(leader?.status).toBe(MEMBER_STATUSES.active);
    const leaderRuns = readRuns(db).filter((row) =>
      row.metadata_json.includes(leaderMemberId)
    );
    expect(leaderRuns).toHaveLength(0);

    // Backend started exactly once (the teammate's turn) — the lead never started.
    expect(backend.startCalls).toHaveLength(1);

    adapter.close();
  });
});
