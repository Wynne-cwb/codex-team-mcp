import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendActionResult,
  ExecutionBackendDescription,
  ExecutionBackendReconcileResult,
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { MessageService } from "../src/services/messageService.js";
import { createAgentHandler } from "../src/tools/agentHandler.js";
import { TEAMMATE_RESTRICTED_TOOL_ERROR_CODES } from "../src/tools/capabilityGuard.js";
import { createSendMessageHandler } from "../src/tools/messageHandler.js";
import { createTeamCreateHandler } from "../src/tools/teamHandlers.js";
import { COMPATIBILITY_TOOLS, TARGET_CLAUDE_TOOLS } from "../src/tools/registry.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  TABLE_NAMES
} from "../src/state/schema.js";

// Phase 14 e2e (BIDIR-05 / BIDIR-06 / SC1 / SC2 / SC4): pane-hosted TeamMates
// address and message EACH OTHER on the shared team DB. Peer discovery is the
// read-only TeamDiagnostics roster; a from-omitted/team_name-omitted peer send
// resolves via member_identity; delivery reuses the EXISTING recipient-keyed
// resume -> sendToPane path UNCHANGED (proven with a teammate SENDER); pane-exited
// queues + emits one resume_failure_notice; cross-team is rejected; the body
// persists ONLY to the messages table; and the per-turn anti-loop bound wires
// through end-to-end.

let stateRoot: string;
let workspaceRoot: string;

const PEER_BODY = "PEER_TO_PEER_BODY_42_unique_marker";
const PANE_EXITED_BODY = "PANE_EXITED_PEER_BODY_7_unique_marker";

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-peer-"));
}

beforeEach(() => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

async function callHandler(
  handler: (
    args: unknown,
    extra: unknown
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>,
  args: Record<string, unknown>,
  extra: unknown
): Promise<Record<string, unknown>> {
  const result = await handler(args, extra);
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first && "text" in first ? (first.text ?? "{}") : "{}") as Record<
    string,
    unknown
  >;
}

function withAdapter<T>(fn: (adapter: DurableStateAdapter) => T): T {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    return fn(adapter);
  } finally {
    adapter.close();
  }
}

interface MessageRow {
  message_id: string;
  sender_member_id: string | null;
  recipient_member_id: string | null;
  status: string;
  delivery_status: string;
  body_json: string;
  metadata_json: string;
}

function teammateExtra(memberId: string): Record<string, unknown> {
  return {
    sessionId: `teammate-session-${memberId}`,
    codexTeamMemberId: memberId,
    codexTeamMemberRole: "teammate"
  };
}

function teammateIdentity(memberId: string): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(teammateExtra(memberId))
  });
}

function setResumableRun(input: {
  db: Database.Database;
  memberId: string;
  status: string;
}): void {
  input.db
    .prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`)
    .run(input.status, input.memberId);
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

interface ResumeCall {
  context: ExecutionRunContext;
  trigger: ExecutionTrigger;
}

// Mirrors test/messageService.test.ts FakeResumeBackend: records the context it is
// handed so the test can prove WHICH run/pane a peer send resumes.
class FakeResumeBackend implements ExecutionBackend {
  readonly resumeCalls: ResumeCall[] = [];

  constructor(
    private readonly input: {
      action?: "resumed" | "backend_failed" | "backend_unavailable";
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
    this.resumeCalls.push({ context, trigger });

    if (this.input.action === "backend_failed") {
      return {
        status: "backend_failed",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
        backend: "fake-backend",
        backend_status: RUN_BACKEND_STATUSES.failed,
        last_error: "fake backend resume failed"
      };
    }

    if (this.input.action === "backend_unavailable") {
      return {
        status: "not_resumable",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        backend: "fake-backend",
        backend_status: RUN_BACKEND_STATUSES.stopped,
        last_error: "fake backend resume unavailable"
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

async function seedTeamWithTwoTeammates(): Promise<{
  teamId: string;
  builderMemberId: string;
  testerMemberId: string;
}> {
  await callHandler(
    createTeamCreateHandler({ stateRoot, workspaceRoot }),
    { team_name: "Alpha Team", description: "peer e2e" },
    { sessionId: "lead-session" }
  );
  const builder = await callHandler(
    createAgentHandler({ stateRoot, workspaceRoot }),
    { name: "Builder", team_name: "alpha-team", prompt: "seed builder" },
    { sessionId: "lead-session" }
  );
  const tester = await callHandler(
    createAgentHandler({ stateRoot, workspaceRoot }),
    { name: "Tester", team_name: "alpha-team", prompt: "seed tester" },
    { sessionId: "lead-session" }
  );
  const builderMemberId = (builder.debug as { internal_member_id: string })
    .internal_member_id;
  const testerMemberId = (tester.debug as { internal_member_id: string })
    .internal_member_id;
  const teamId = withAdapter((adapter) => {
    const row = adapter
      .getDatabase()
      .prepare(`SELECT team_id AS teamId FROM ${TABLE_NAMES.teams} LIMIT 1`)
      .get() as { teamId: string };
    return row.teamId;
  });

  return { teamId, builderMemberId, testerMemberId };
}

describe("teammate <-> teammate messaging on the shared DB (Phase 14)", () => {
  it("SC1: a teammate-role caller discovers a peer's teammate_id via read-only TeamDiagnostics", async () => {
    const { builderMemberId, testerMemberId } = await seedTeamWithTwoTeammates();

    // TeamDiagnostics is NOT in the teammate capability denylist (ungated read).
    expect(Object.keys(TEAMMATE_RESTRICTED_TOOL_ERROR_CODES)).not.toContain(
      "TeamDiagnostics"
    );

    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: teammateExtra(builderMemberId),
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });

    const peer = payload.teammates.find(
      (teammate) => teammate.teammate_id === "tester@alpha-team"
    );
    expect(peer).toBeDefined();
    expect(peer?.member_id).toBe(testerMemberId);
  });

  it("SC1: a from-omitted/team_name-omitted peer send resolves via member_identity into the peer inbox", async () => {
    const { builderMemberId, testerMemberId } = await seedTeamWithTwoTeammates();

    const sendPayload = await callHandler(
      createSendMessageHandler({ stateRoot, workspaceRoot }),
      { to: "tester@alpha-team", message: PEER_BODY },
      teammateExtra(builderMemberId)
    );

    expect(sendPayload.persisted).toBe(true);
    expect(sendPayload.team_name).toBe("alpha-team");
    // Sender = the PEER (builder), NOT the leader; recipient = the other peer.
    expect(sendPayload.sender).toMatchObject({
      member_id: builderMemberId,
      teammate_id: "builder@alpha-team"
    });
    expect(sendPayload.recipient).toMatchObject({
      member_id: testerMemberId,
      teammate_id: "tester@alpha-team"
    });

    const peerInbox = withAdapter(
      (adapter) =>
        adapter
          .getDatabase()
          .prepare(
            `SELECT message_id, sender_member_id, recipient_member_id, status, delivery_status, body_json, metadata_json
             FROM ${TABLE_NAMES.messages} WHERE recipient_member_id = ?`
          )
          .all(testerMemberId) as MessageRow[]
    );
    expect(peerInbox).toHaveLength(1);
    expect(peerInbox[0].sender_member_id).toBe(builderMemberId);
    expect(peerInbox[0].body_json).toContain(PEER_BODY);
  });

  it("SC2 live pane: a peer send resumes the RECIPIENT's run with the peer body (recipient-keyed, sender-agnostic)", async () => {
    const { builderMemberId, testerMemberId } = await seedTeamWithTwoTeammates();

    const result = withAdapter((adapter) => {
      // The recipient (tester) is idle with a durable, resumable run + live pane.
      setResumableRun({
        db: adapter.getDatabase(),
        memberId: testerMemberId,
        status: MEMBER_STATUSES.idle
      });
      const backend = new FakeResumeBackend();
      const service = new MessageService({
        db: adapter.getDatabase(),
        statePath: stateRoot,
        executionBackend: backend
      });

      const sendResult = service.sendMessage({
        to: "tester@alpha-team",
        message: PEER_BODY,
        identity: teammateIdentity(builderMemberId)
      });

      return { sendResult, backend };
    });

    // The resume targeted the RECIPIENT's run/member (never the sender's). Phase 16
    // (notify + pull): a SHORT inbox nudge (naming the sender) rode resume_delivery_text
    // into the recipient's pane — NOT the full peer body (pulled later via CheckInbox).
    expect(result.backend.resumeCalls).toHaveLength(1);
    const resumed = result.backend.resumeCalls[0];
    expect(resumed.context.member_id).toBe(testerMemberId);
    expect(resumed.context.metadata?.backend_run_id).toBe(
      `backend-run:${testerMemberId}`
    );
    const nudge = resumed.context.metadata?.resume_delivery_text;
    expect(typeof nudge).toBe("string");
    expect(nudge).toContain("CheckInbox");
    expect(nudge).toContain("builder@alpha-team");
    expect(nudge).not.toContain(PEER_BODY);
    expect(resumed.trigger).toMatchObject({ kind: "message" });
    expect(result.sendResult.delivery_status).toBe(
      MESSAGE_DELIVERY_STATUSES.backendResumeAttempted
    );
  });

  it("SC2 pane exited: a peer send to an unresumable recipient queues (never drops) + one resume_failure_notice that does not re-resume", async () => {
    const { builderMemberId, testerMemberId } = await seedTeamWithTwoTeammates();

    const { backend } = withAdapter((adapter) => {
      const db = adapter.getDatabase();
      // Recipient (tester) is idle but the pane/backend cannot resume; the SENDER
      // (builder) is ALSO idle + resumable, so if the failure notice tried to
      // resume the sender it WOULD call the backend — proving it does not.
      setResumableRun({ db, memberId: testerMemberId, status: MEMBER_STATUSES.idle });
      setResumableRun({ db, memberId: builderMemberId, status: MEMBER_STATUSES.idle });
      const fakeBackend = new FakeResumeBackend({ action: "backend_unavailable" });
      const service = new MessageService({
        db,
        statePath: stateRoot,
        executionBackend: fakeBackend
      });

      service.sendMessage({
        to: "tester@alpha-team",
        message: PANE_EXITED_BODY,
        identity: teammateIdentity(builderMemberId)
      });

      return { backend: fakeBackend };
    });

    withAdapter((adapter) => {
      const db = adapter.getDatabase();
      // The original inbound row is preserved and stays queued (never dropped).
      const inbound = db
        .prepare(
          `SELECT status, delivery_status, body_json FROM ${TABLE_NAMES.messages}
           WHERE recipient_member_id = ? AND sender_member_id = ?`
        )
        .all(testerMemberId, builderMemberId) as MessageRow[];
      expect(inbound).toHaveLength(1);
      expect(inbound[0].status).toBe("queued");
      expect(inbound[0].delivery_status).toBe(
        MESSAGE_DELIVERY_STATUSES.queuedWhileIdle
      );

      // Exactly ONE resume_failure_notice, addressed back to the peer sender.
      const notices = (
        db
          .prepare(
            `SELECT recipient_member_id, metadata_json FROM ${TABLE_NAMES.messages}`
          )
          .all() as MessageRow[]
      ).filter((row) => {
        try {
          return (
            (JSON.parse(row.metadata_json) as { message_type?: string })
              .message_type === "resume_failure_notice"
          );
        } catch {
          return false;
        }
      });
      expect(notices).toHaveLength(1);
      expect(notices[0].recipient_member_id).toBe(builderMemberId);
    });

    // The backend resumed ONLY the recipient (tester); the suppress_resume notice
    // to the idle sender (builder) did NOT trigger a second resume.
    expect(backend.resumeCalls).toHaveLength(1);
    expect(backend.resumeCalls[0].context.member_id).toBe(testerMemberId);
  });

  it("SC4 cross-team: a peer send to a foreign team suffix is rejected with no row", async () => {
    const { builderMemberId, testerMemberId } = await seedTeamWithTwoTeammates();

    const result = withAdapter((adapter) =>
      new MessageService({
        db: adapter.getDatabase(),
        statePath: stateRoot
      }).sendMessage({
        to: "tester@other-team",
        message: "cross-team must not route",
        identity: teammateIdentity(builderMemberId)
      })
    );

    expect(result).toMatchObject({
      status: "cross_team_recipient",
      persisted: false
    });
    withAdapter((adapter) => {
      const rows = adapter
        .getDatabase()
        .prepare(`SELECT recipient_member_id FROM ${TABLE_NAMES.messages}`)
        .all() as MessageRow[];
      // No row for any recipient was created by the cross-team attempt.
      expect(rows.every((row) => row.recipient_member_id !== testerMemberId)).toBe(
        true
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("SC4 D-02 + no-pragma: the peer body persists ONLY to messages; events/runs are clean; pragmas unchanged", async () => {
    const { builderMemberId } = await seedTeamWithTwoTeammates();

    await callHandler(
      createSendMessageHandler({ stateRoot, workspaceRoot }),
      { to: "tester@alpha-team", message: PEER_BODY },
      teammateExtra(builderMemberId)
    );

    withAdapter((adapter) => {
      const db = adapter.getDatabase();
      const messageBodies = db
        .prepare(`SELECT body_json FROM ${TABLE_NAMES.messages}`)
        .all() as Array<{ body_json: string }>;
      const eventPayloads = db
        .prepare(`SELECT payload_json FROM ${TABLE_NAMES.events}`)
        .all() as Array<{ payload_json: string }>;
      const runMetadata = db
        .prepare(`SELECT metadata_json FROM ${TABLE_NAMES.runs}`)
        .all() as Array<{ metadata_json: string }>;

      expect(messageBodies.some((row) => row.body_json.includes(PEER_BODY))).toBe(true);
      expect(eventPayloads.some((row) => row.payload_json.includes(PEER_BODY))).toBe(
        false
      );
      expect(runMetadata.some((row) => row.metadata_json.includes(PEER_BODY))).toBe(
        false
      );

      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(Number(db.pragma("busy_timeout", { simple: true }))).toBe(5000);
    });
  });

  it("anti-loop wiring: the handler threads CODEX_TEAM_MAX_PROACTIVE_MESSAGES_PER_TURN and rejects the over-bound peer send", async () => {
    const { builderMemberId } = await seedTeamWithTwoTeammates();
    const previous = process.env.CODEX_TEAM_MAX_PROACTIVE_MESSAGES_PER_TURN;
    process.env.CODEX_TEAM_MAX_PROACTIVE_MESSAGES_PER_TURN = "2";

    try {
      const handler = createSendMessageHandler({ stateRoot, workspaceRoot });
      const first = await callHandler(
        handler,
        { to: "tester@alpha-team", message: "peer 1" },
        teammateExtra(builderMemberId)
      );
      const second = await callHandler(
        handler,
        { to: "tester@alpha-team", message: "peer 2" },
        teammateExtra(builderMemberId)
      );
      const third = await callHandler(
        handler,
        { to: "tester@alpha-team", message: "peer 3 — over the bound" },
        teammateExtra(builderMemberId)
      );

      expect(first.persisted).toBe(true);
      expect(second.persisted).toBe(true);
      expect(third).toMatchObject({
        status: "error",
        error_code: "teammate_proactive_limit_exceeded",
        persisted: false
      });
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_TEAM_MAX_PROACTIVE_MESSAGES_PER_TURN;
      } else {
        process.env.CODEX_TEAM_MAX_PROACTIVE_MESSAGES_PER_TURN = previous;
      }
    }
  });
});
