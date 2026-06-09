import { mkdtempSync, rmSync } from "node:fs";
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
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { MessageService } from "../src/services/messageService.js";
import { TeamService } from "../src/services/teamService.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  TABLE_NAMES
} from "../src/state/schema.js";

const tempRoots: string[] = [];

interface TeamContext {
  identity: WorkspaceScopedCallerIdentity;
  adapter: DurableStateAdapter;
  teamId: string;
  teamName: string;
}

interface MessageRow {
  message_id: string;
  team_id: string;
  sender_member_id: string | null;
  recipient_member_id: string | null;
  status: string;
  delivery_status: string;
  body_json: string;
}

interface RunRow {
  run_id: string;
  member_id: string | null;
  status: string;
  backend: string | null;
  last_error: string | null;
  backend_status: string | null;
  metadata_json: string;
}

interface EventRow {
  event_type: string;
  error_code: string | null;
  payload_json: string;
}

interface ResumeCall {
  context: ExecutionRunContext;
  trigger: ExecutionTrigger;
}

const SECRET_PHASE5_MESSAGE = "SECRET_PHASE5_MESSAGE";

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-message-service-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(
  workspaceRoot: string,
  metadata: unknown = { sessionId: "session-1", threadId: "thread-1" }
): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(metadata)
  });
}

function createTeam(input: {
  workspaceRoot?: string;
  teamName?: string;
  metadata?: unknown;
} = {}): TeamContext {
  const identity = createIdentity(input.workspaceRoot ?? "/workspace/project", input.metadata);
  const adapter = new DurableStateAdapter({
    stateRoot: createTempStateRoot(),
    workspaceRoot: identity.workspaceRoot
  });
  const result = new TeamService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  }).createTeam({
    teamName: input.teamName ?? "Alpha Team",
    description: "Message service RED test team",
    identity
  });

  return {
    identity,
    adapter,
    teamId: result.active_binding.team_id,
    teamName: result.team_name
  };
}

function createMessageService(
  adapter: DurableStateAdapter,
  executionBackend?: ExecutionBackend
): MessageService {
  return new MessageService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot,
    executionBackend
  });
}

function createAgentService(adapter: DurableStateAdapter): AgentService {
  return new AgentService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  });
}

function createTeammate(input: {
  context: TeamContext;
  name: string;
  status?: string;
}): string {
  const created = createAgentService(input.context.adapter).createAgent({
    name: input.name,
    teamName: input.context.teamName,
    prompt: `Research current status for ${input.name}`,
    description: `read-only status check for ${input.name}`,
    identity: input.context.identity
  });

  if (created.status !== "scheduled") {
    throw new Error(`Expected scheduled TeamMate, got ${created.status}`);
  }

  const memberId = created.debug.internal_member_id;
  if (input.status !== undefined) {
    setMemberStatus(input.context.adapter.getDatabase(), memberId, input.status);
  }

  return memberId;
}

function insertManualTeammate(input: {
  db: Database.Database;
  teamId: string;
  memberId: string;
  displayName: string;
  publicTeammateId: string;
  status?: string;
}): void {
  input.db
    .prepare(
      `
        INSERT INTO ${TABLE_NAMES.members} (
          member_id,
          team_id,
          display_name,
          role,
          status,
          workspace_root,
          joined_at,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.memberId,
      input.teamId,
      input.displayName,
      "teammate",
      input.status ?? MEMBER_STATUSES.scheduled,
      "/workspace/project",
      "2026-06-05T00:00:00.000Z",
      JSON.stringify({ publicTeammateId: input.publicTeammateId })
    );
}

function setMemberStatus(
  db: Database.Database,
  memberId: string,
  status: string
): void {
  db.prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`).run(
    status,
    memberId
  );
}

function setResumableRun(input: {
  db: Database.Database;
  memberId: string;
  status: string;
}): void {
  setMemberStatus(input.db, input.memberId, input.status);
  input.db
    .prepare(
      `
        UPDATE ${TABLE_NAMES.runs}
        SET status = ?,
            backend = ?,
            backend_status = ?,
            backend_run_id = ?,
            backend_thread_id = ?,
            backend_process_id = ?,
            work_classification = ?,
            isolation_kind = ?,
            review_status = ?,
            updated_at = ?
        WHERE member_id = ?
      `
    )
    .run(
      input.status,
      "fake-backend",
      RUN_BACKEND_STATUSES.stopped,
      `backend-run:${input.memberId}`,
      `thread:${input.memberId}`,
      `process:${input.memberId}`,
      "read_only",
      "none",
      "none",
      new Date().toISOString(),
      input.memberId
    );
}

function setResumableRunBackendIds(input: {
  db: Database.Database;
  memberId: string;
  status: string;
  columnIds?: {
    backendRunId: string | null;
    backendThreadId: string | null;
    backendProcessId: string | null;
  };
  metadataIds?: {
    backend_run_id: string;
    backend_thread_id: string;
    backend_process_id: string;
  };
}): void {
  setMemberStatus(input.db, input.memberId, input.status);
  input.db
    .prepare(
      `
        UPDATE ${TABLE_NAMES.runs}
        SET status = ?,
            backend = ?,
            backend_status = ?,
            backend_run_id = ?,
            backend_thread_id = ?,
            backend_process_id = ?,
            metadata_json = ?,
            work_classification = ?,
            isolation_kind = ?,
            review_status = ?,
            updated_at = ?
        WHERE member_id = ?
      `
    )
    .run(
      input.status,
      "fake-backend",
      RUN_BACKEND_STATUSES.stopped,
      input.columnIds?.backendRunId ?? null,
      input.columnIds?.backendThreadId ?? null,
      input.columnIds?.backendProcessId ?? null,
      JSON.stringify({
        prompt_present: true,
        ...(input.metadataIds ?? {})
      }),
      "read_only",
      "none",
      "none",
      new Date().toISOString(),
      input.memberId
    );
}

function messages(db: Database.Database): MessageRow[] {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.messages} ORDER BY created_at, message_id`)
    .all() as MessageRow[];
}

function events(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `
        SELECT event_type, error_code, payload_json
        FROM ${TABLE_NAMES.events}
        ORDER BY created_at, event_id
      `
    )
    .all() as EventRow[];
}

function readRunByMember(db: Database.Database, memberId: string): RunRow {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} WHERE member_id = ? LIMIT 1`)
    .get(memberId) as RunRow;
}

function readMemberMetadata(
  db: Database.Database,
  memberId: string
): Record<string, unknown> {
  const row = db
    .prepare(`SELECT metadata_json FROM ${TABLE_NAMES.members} WHERE member_id = ?`)
    .get(memberId) as { metadata_json: string };
  return JSON.parse(row.metadata_json) as Record<string, unknown>;
}

function expectSanitizedFailureEvents(rows: EventRow[]): void {
  const serialized = JSON.stringify(rows.map((row) => JSON.parse(row.payload_json)));

  expect(serialized).not.toContain("payload_json");
  expect(serialized).not.toContain("message");
  expect(serialized).not.toContain("body");
  expect(serialized).not.toContain("prompt");
  expect(serialized).not.toContain("notes");
  expect(serialized).not.toContain("description");
}

function expectNoFakeBackendFields(payload: Record<string, unknown>): void {
  expect(payload).not.toHaveProperty("delivered");
  expect(payload).not.toHaveProperty("process_id");
  expect(payload).not.toHaveProperty("thread_id");
  expect(payload).not.toHaveProperty("pane_id");
  expect(payload).not.toHaveProperty("tmux_session");
  expect(JSON.stringify(payload)).not.toContain("process_id");
  expect(JSON.stringify(payload)).not.toContain("thread_id");
  expect(JSON.stringify(payload)).not.toContain("pane_id");
  expect(JSON.stringify(payload)).not.toContain("tmux_session");
}

class FakeResumeBackend implements ExecutionBackend {
  readonly resumeCalls: ResumeCall[] = [];

  constructor(
    private readonly input: {
      action?: "resumed" | "backend_failed";
      onResume?: () => void;
      throwOnResume?: boolean;
    } = {}
  ) {}

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.idle,
      capabilities: {
        canStart: false,
        canResume: true,
        canReconcile: false,
        supportsWorkspaces: false
      }
    };
  }

  startRun(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: "start unsupported in fake resume backend"
    };
  }

  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    this.input.onResume?.();
    this.resumeCalls.push({ context, trigger });

    if (this.input.throwOnResume) {
      throw new Error(`fake backend resume threw ${SECRET_PHASE5_MESSAGE}`);
    }

    if (this.input.action === "backend_failed") {
      return {
        status: "backend_failed",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
        backend: "fake-backend",
        backend_status: RUN_BACKEND_STATUSES.failed,
        last_error: "fake backend resume failed"
      };
    }

    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: "backend-run-resumed",
      thread_id: "thread-resumed",
      process_id: "process-resumed",
      started_at: "2026-06-05T00:00:00.000Z"
    };
  }

  reconcileRun(): ExecutionBackendReconcileResult {
    return {
      status: "unsupported",
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.unknown
    };
  }
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("MessageService.sendMessage", () => {
  it("persists valid messages before returning queued_for_next_turn for running recipients", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({
      context,
      name: "Builder",
      status: MEMBER_STATUSES.running
    });

    const result = createMessageService(context.adapter).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "What is your current status?",
      summary: "Status check",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "queued_for_next_turn",
      team_name: "alpha-team",
      persisted: true,
      delivery_status: "queued_for_next_turn",
      recipient_status: MEMBER_STATUSES.running,
      recipient: {
        member_id: recipientMemberId,
        display_name: "Builder",
        teammate_id: "builder@alpha-team"
      },
      backend: {
        limitation: expect.stringContaining("No execution backend")
      }
    });
    expect(result.message_id).toMatch(/^message:/);
    expect(messages(context.adapter.getDatabase())).toEqual([
      expect.objectContaining({
        message_id: result.message_id,
        team_id: context.teamId,
        sender_member_id: `leader:${context.teamId}`,
        recipient_member_id: recipientMemberId,
        status: "queued",
        delivery_status: "queued_for_next_turn"
      })
    ]);
    expect(events(context.adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: "message_queued" })
      ])
    );

    context.adapter.close();
  });

  it("persists before attempting backend resume for stopped recipients", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({
      context,
      name: "Builder"
    });
    setResumableRun({
      db: context.adapter.getDatabase(),
      memberId: recipientMemberId,
      status: MEMBER_STATUSES.stopped
    });
    let sawPersistedRowBeforeResume = false;
    const backend = new FakeResumeBackend({
      onResume: () => {
        const rows = messages(context.adapter.getDatabase());
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          recipient_member_id: recipientMemberId,
          status: "queued",
          delivery_status: "queued_while_idle"
        });
        sawPersistedRowBeforeResume = true;
      }
    });

    const result = createMessageService(context.adapter, backend).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Resume stopped builder",
      summary: "Resume builder",
      identity: context.identity
    });

    expect(sawPersistedRowBeforeResume).toBe(true);
    expect(backend.resumeCalls).toHaveLength(1);
    expect(backend.resumeCalls[0]?.trigger).toMatchObject({
      kind: "message",
      message_id: result.message_id
    });
    expect(result).toMatchObject({
      status: "backend_resume_attempted",
      delivery_status: "backend_resume_attempted",
      row_status: "queued",
      backend: {
        backend: "fake-backend",
        backend_run_id: "backend-run-resumed",
        status: "running"
      },
      debug: {
        lifecycle: {
          backend_action: "resume_attempted"
        }
      }
    });
    const run = readRunByMember(context.adapter.getDatabase(), recipientMemberId);
    expect(run).toMatchObject({
      status: MEMBER_STATUSES.running,
      backend_status: RUN_BACKEND_STATUSES.running
    });
    expect(JSON.parse(run.metadata_json)).toMatchObject({
      execution_available: true,
      teammate_execution_implemented: true,
      backend_status: RUN_BACKEND_STATUSES.running
    });
    expect(readMemberMetadata(context.adapter.getDatabase(), recipientMemberId)).toMatchObject({
      execution_available: true,
      teammate_execution_implemented: true,
      backend_status: RUN_BACKEND_STATUSES.running
    });

    context.adapter.close();
  });

  it("keeps running recipients queued for the next turn boundary", () => {
    const context = createTeam();
    createTeammate({
      context,
      name: "Builder",
      status: MEMBER_STATUSES.running
    });
    const backend = new FakeResumeBackend();

    const result = createMessageService(context.adapter, backend).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Queue for next turn",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "queued_for_next_turn",
      delivery_status: "queued_for_next_turn",
      row_status: "queued",
      debug: {
        lifecycle: {
          backend_action: "not_attempted"
        }
      }
    });
    expect(backend.resumeCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("delivered");

    context.adapter.close();
  });

  it("leaves queued message rows when backend resume fails", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({
      context,
      name: "Builder"
    });
    setResumableRun({
      db: context.adapter.getDatabase(),
      memberId: recipientMemberId,
      status: MEMBER_STATUSES.stopped
    });
    const backend = new FakeResumeBackend({ action: "backend_failed" });

    const result = createMessageService(context.adapter, backend).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: SECRET_PHASE5_MESSAGE,
      summary: "Failure summary",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "backend_failed",
      delivery_status: "backend_failed",
      row_status: "queued",
      backend: {
        status: "failed",
        last_error: "fake backend resume failed"
      }
    });
    expect(messages(context.adapter.getDatabase())).toEqual([
      expect.objectContaining({
        message_id: result.message_id,
        recipient_member_id: recipientMemberId,
        status: "queued",
        delivery_status: "queued_while_idle"
      })
    ]);
    expect(events(context.adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "teammate_backend_resume_attempted",
          error_code: "backend_failed"
        })
      ])
    );

    context.adapter.close();
  });

  it("does not leak SECRET_PHASE5_MESSAGE in lifecycle failure events", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({
      context,
      name: "Builder"
    });
    setResumableRun({
      db: context.adapter.getDatabase(),
      memberId: recipientMemberId,
      status: MEMBER_STATUSES.stopped
    });
    const backend = new FakeResumeBackend({ action: "backend_failed" });

    createMessageService(context.adapter, backend).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: SECRET_PHASE5_MESSAGE,
      summary: "Failure summary",
      identity: context.identity
    });

    const serializedEvents = JSON.stringify(events(context.adapter.getDatabase()));
    expect(serializedEvents).not.toContain(SECRET_PHASE5_MESSAGE);
    expect(JSON.stringify(backend.resumeCalls)).not.toContain(SECRET_PHASE5_MESSAGE);

    context.adapter.close();
  });

  it("converts thrown backend resume into queued backend_failed result", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({
      context,
      name: "Builder"
    });
    setResumableRun({
      db: context.adapter.getDatabase(),
      memberId: recipientMemberId,
      status: MEMBER_STATUSES.stopped
    });
    const backend = new FakeResumeBackend({ throwOnResume: true });

    const result = createMessageService(context.adapter, backend).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: SECRET_PHASE5_MESSAGE,
      summary: "Resume failure summary",
      identity: context.identity
    });

    expect(backend.resumeCalls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "backend_failed",
      delivery_status: "backend_failed",
      row_status: "queued",
      backend: {
        status: "failed",
        backend: "fake-backend",
        last_error: expect.any(String)
      }
    });
    expect(messages(context.adapter.getDatabase())).toEqual([
      expect.objectContaining({
        message_id: result.message_id,
        recipient_member_id: recipientMemberId,
        status: "queued",
        delivery_status: "queued_while_idle"
      })
    ]);
    const run = readRunByMember(context.adapter.getDatabase(), recipientMemberId);
    expect(run).toMatchObject({
      status: MEMBER_STATUSES.failed,
      backend: "fake-backend",
      backend_status: RUN_BACKEND_STATUSES.failed
    });
    expect(run.last_error).not.toContain(SECRET_PHASE5_MESSAGE);
    expect(JSON.stringify(events(context.adapter.getDatabase()))).not.toContain(
      SECRET_PHASE5_MESSAGE
    );
    expect(JSON.stringify(result.backend)).not.toContain(SECRET_PHASE5_MESSAGE);

    context.adapter.close();
  });

  it("uses metadata_json backend identifiers when resuming", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({
      context,
      name: "Builder"
    });
    setResumableRunBackendIds({
      db: context.adapter.getDatabase(),
      memberId: recipientMemberId,
      status: MEMBER_STATUSES.stopped,
      metadataIds: {
        backend_run_id: "metadata-run",
        backend_thread_id: "metadata-thread",
        backend_process_id: "metadata-process"
      }
    });
    const backend = new FakeResumeBackend();

    createMessageService(context.adapter, backend).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Resume with metadata ids",
      summary: "Resume metadata",
      identity: context.identity
    });

    expect(backend.resumeCalls).toHaveLength(1);
    expect(backend.resumeCalls[0]?.context.metadata).toMatchObject({
      backend_run_id: "metadata-run",
      backend_thread_id: "metadata-thread",
      backend_process_id: "metadata-process"
    });

    context.adapter.close();
  });

  it("prefers run column backend identifiers over metadata_json when resuming", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({
      context,
      name: "Builder"
    });
    setResumableRunBackendIds({
      db: context.adapter.getDatabase(),
      memberId: recipientMemberId,
      status: MEMBER_STATUSES.stopped,
      columnIds: {
        backendRunId: "column-run",
        backendThreadId: "column-thread",
        backendProcessId: "column-process"
      },
      metadataIds: {
        backend_run_id: "metadata-run",
        backend_thread_id: "metadata-thread",
        backend_process_id: "metadata-process"
      }
    });
    const backend = new FakeResumeBackend();

    createMessageService(context.adapter, backend).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Resume with column ids",
      summary: "Resume columns",
      identity: context.identity
    });

    expect(backend.resumeCalls).toHaveLength(1);
    expect(backend.resumeCalls[0]?.context.metadata).toMatchObject({
      backend_run_id: "column-run",
      backend_thread_id: "column-thread",
      backend_process_id: "column-process"
    });

    context.adapter.close();
  });

  it("persists valid messages before returning backend_unavailable for scheduled idle and stopped recipients", () => {
    const context = createTeam();
    createTeammate({ context, name: "Scheduled" });
    createTeammate({ context, name: "Idle", status: MEMBER_STATUSES.idle });
    createTeammate({ context, name: "Stopped", status: MEMBER_STATUSES.stopped });
    const service = createMessageService(context.adapter);

    const scheduled = service.sendMessage({
      teamName: "alpha-team",
      to: "Scheduled",
      message: "Scheduled recipient",
      identity: context.identity
    });
    const idle = service.sendMessage({
      teamName: "alpha-team",
      to: "Idle",
      message: "Idle recipient",
      identity: context.identity
    });
    const stopped = service.sendMessage({
      teamName: "alpha-team",
      to: "Stopped",
      message: "Stopped recipient",
      identity: context.identity
    });

    for (const payload of [scheduled, idle, stopped]) {
      expect(payload).toMatchObject({
        status: "backend_unavailable",
        persisted: true,
        delivery_status: "backend_unavailable",
        row_status: "queued",
        backend: {
          last_error: expect.stringContaining("No execution backend")
        }
      });
    }
    expect(messages(context.adapter.getDatabase())).toHaveLength(3);
    expect(messages(context.adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "queued",
          delivery_status: "queued_while_idle"
        })
      ])
    );

    context.adapter.close();
  });

  it("resolves recipients by display name and public TeamMate ID within one team", () => {
    const context = createTeam();
    const recipientMemberId = createTeammate({ context, name: "Builder" });
    const service = createMessageService(context.adapter);

    const byDisplayName = service.sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Display name route",
      identity: context.identity
    });
    const byPublicId = service.sendMessage({
      teamName: "alpha-team",
      to: "builder@alpha-team",
      message: "Public ID route",
      identity: context.identity
    });

    expect(byDisplayName).toMatchObject({
      status: "backend_unavailable",
      recipient: {
        member_id: recipientMemberId,
        teammate_id: "builder@alpha-team"
      }
    });
    expect(byPublicId).toMatchObject({
      status: "backend_unavailable",
      recipient: {
        member_id: recipientMemberId,
        teammate_id: "builder@alpha-team"
      }
    });
    expect(messages(context.adapter.getDatabase())).toHaveLength(2);

    context.adapter.close();
  });

  it("rejects ambiguous display-name recipients without creating message rows", () => {
    const context = createTeam();
    createTeammate({ context, name: "Builder" });
    insertManualTeammate({
      db: context.adapter.getDatabase(),
      teamId: context.teamId,
      memberId: `teammate:${context.teamId}:builder-copy`,
      displayName: "Builder",
      publicTeammateId: "builder-copy@alpha-team"
    });

    const result = createMessageService(context.adapter).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Ambiguous display names must not route",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "ambiguous_recipient",
      error_code: "ambiguous_recipient",
      persisted: false
    });
    expect(messages(context.adapter.getDatabase())).toHaveLength(0);
    const auditEvents = events(context.adapter.getDatabase()).filter(
      (event) => event.error_code === "ambiguous_recipient"
    );
    expect(auditEvents).toHaveLength(1);
    expectSanitizedFailureEvents(auditEvents);

    context.adapter.close();
  });

  it("rejects missing archived and cross-team recipients with sanitized audit events", () => {
    const context = createTeam();
    createTeammate({
      context,
      name: "Former",
      status: MEMBER_STATUSES.archived
    });
    const other = createTeam({
      workspaceRoot: context.identity.workspaceRoot,
      teamName: "Beta Team",
      metadata: { sessionId: "other-team" }
    });
    createTeammate({ context: other, name: "Builder" });
    const service = createMessageService(context.adapter);

    const missing = service.sendMessage({
      teamName: "alpha-team",
      to: "Ghost",
      message: "Missing recipient text must not be audited",
      identity: context.identity
    });
    const archived = service.sendMessage({
      teamName: "alpha-team",
      to: "Former",
      message: "Archived recipient text must not be audited",
      identity: context.identity
    });
    const crossTeam = service.sendMessage({
      teamName: "alpha-team",
      to: "builder@beta-team",
      message: "Cross-team recipient text must not be audited",
      identity: context.identity
    });

    expect(missing).toMatchObject({ status: "missing_recipient", persisted: false });
    expect(archived).toMatchObject({
      status: "recipient_archived",
      persisted: false
    });
    expect(crossTeam).toMatchObject({
      status: "cross_team_recipient",
      persisted: false
    });
    expect(messages(context.adapter.getDatabase())).toHaveLength(0);
    expectSanitizedFailureEvents(
      events(context.adapter.getDatabase()).filter((event) =>
        ["missing_recipient", "recipient_archived", "cross_team_recipient"].includes(
          event.error_code ?? ""
        )
      )
    );

    context.adapter.close();
    other.adapter.close();
  });

  it("returns broadcast_unsupported_in_v1 without creating message rows", () => {
    const context = createTeam();
    createTeammate({ context, name: "Builder" });

    const result = createMessageService(context.adapter).sendMessage({
      teamName: "alpha-team",
      to: "*",
      message: "Broadcast is deferred to ADV-01",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "broadcast_unsupported_in_v1",
      persisted: false,
      delivery_status: "broadcast_unsupported_in_v1"
    });
    expect(messages(context.adapter.getDatabase())).toHaveLength(0);
    const auditEvents = events(context.adapter.getDatabase()).filter(
      (event) => event.error_code === "broadcast_unsupported_in_v1"
    );
    expect(auditEvents).toHaveLength(1);
    expectSanitizedFailureEvents(auditEvents);

    context.adapter.close();
  });

  it("resolves default sender to current member then team lead", () => {
    const context = createTeam();
    const builderMemberId = createTeammate({ context, name: "Builder" });
    const reviewerMemberId = createTeammate({ context, name: "Reviewer" });
    const teammateIdentity = createIdentity(context.identity.workspaceRoot, {
      sessionId: "builder-session",
      codexTeamMemberId: builderMemberId,
      codexTeamMemberRole: "teammate"
    });
    const service = createMessageService(context.adapter);

    const fromCurrentMember = service.sendMessage({
      teamName: "alpha-team",
      to: "Reviewer",
      message: "Message from the current TeamMate",
      identity: teammateIdentity
    });
    const fromTeamLead = service.sendMessage({
      teamName: "alpha-team",
      to: "Reviewer",
      message: "Message from the Team Lead",
      identity: context.identity
    });

    expect(fromCurrentMember).toMatchObject({
      sender: {
        member_id: builderMemberId,
        teammate_id: "builder@alpha-team"
      },
      recipient: {
        member_id: reviewerMemberId
      }
    });
    expect(fromTeamLead).toMatchObject({
      sender: {
        member_id: `leader:${context.teamId}`,
        teammate_id: "team-lead@alpha-team"
      }
    });

    context.adapter.close();
  });

  it("rejects invalid explicit sender without creating message rows", () => {
    const context = createTeam();
    createTeammate({ context, name: "Builder" });

    const result = createMessageService(context.adapter).sendMessage({
      teamName: "alpha-team",
      from: "ghost@alpha-team",
      to: "Builder",
      message: "Explicit sender should not leak",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "invalid_sender",
      error_code: "invalid_sender",
      persisted: false
    });
    expect(messages(context.adapter.getDatabase())).toHaveLength(0);
    const auditEvents = events(context.adapter.getDatabase()).filter(
      (event) => event.error_code === "invalid_sender"
    );
    expect(auditEvents).toHaveLength(1);
    expectSanitizedFailureEvents(auditEvents);

    context.adapter.close();
  });

  it("does not treat ordinary Agent text as a teammate message", () => {
    const context = createTeam();

    const ordinary = createAgentService(context.adapter).createAgent({
      teamName: "alpha-team",
      prompt: "SendMessage to Builder: this is ordinary Agent text",
      description: "ordinary Agent text must not create message rows",
      identity: context.identity
    });

    expect(ordinary).toMatchObject({
      status: "ordinary_subagent_path",
      not_handled_by_team_layer: true
    });
    expect(messages(context.adapter.getDatabase())).toHaveLength(0);

    context.adapter.close();
  });

  it("returns backend limitation details without delivered or fake backend fields", () => {
    const context = createTeam();
    createTeammate({
      context,
      name: "Builder",
      status: MEMBER_STATUSES.running
    });

    const result = createMessageService(context.adapter).sendMessage({
      teamName: "alpha-team",
      to: "builder@alpha-team",
      message: {
        type: "shutdown_request",
        reason: "Need a backend limitation result"
      },
      summary: "backend limitation",
      identity: context.identity
    });

    expect(result).toMatchObject({
      status: "queued_for_next_turn",
      persisted: true,
      backend: {
        status: "not_started",
        backend: "none",
        limitation: expect.stringContaining("No execution backend")
      }
    });
    expectNoFakeBackendFields(result as Record<string, unknown>);

    context.adapter.close();
  });
});
