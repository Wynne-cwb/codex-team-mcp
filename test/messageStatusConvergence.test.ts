import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentHandler } from "../src/tools/agentHandler.js";
import { createInboxHandler } from "../src/tools/inboxHandler.js";
import { createSendMessageHandler } from "../src/tools/messageHandler.js";
import { createTeamCreateHandler } from "../src/tools/teamHandlers.js";
import { MessageInboxService } from "../src/services/messageInboxService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ROW_STATUSES,
  TABLE_NAMES
} from "../src/state/schema.js";

// v1.2 FIX #1/#2: message row `status` / `delivery_status` must CONVERGE to terminal
// observability values (delivered, then read) instead of being stuck at `queued` /
// the push-attempt delivery value forever. The hard invariant: timestamps
// (delivered_at / read_at) remain the SINGLE source of truth for row SELECTION, so
// advancing status/delivery_status MUST NOT change which rows any query returns.
// These tests pin both the convergence AND the selection-invariance (the landmine:
// delivered-but-unread messages must still surface via CheckInbox / the TL surface).

let stateRoot: string;
let workspaceRoot: string;

type ToolHandler = (
  args: unknown,
  extra: unknown
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-msg-converge-"));
  workspaceRoot = path.join(stateRoot, "workspace");
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

async function callHandler(
  handler: ToolHandler,
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

const leadExtra = { sessionId: "lead-session" };
function teammateExtra(builderMemberId: string): Record<string, unknown> {
  return {
    sessionId: "builder-session",
    codexTeamMemberId: builderMemberId,
    codexTeamMemberRole: "teammate"
  };
}

interface SeedResult {
  teamId: string;
  builderMemberId: string;
}

async function seedTeamAndTeammate(): Promise<SeedResult> {
  await callHandler(
    createTeamCreateHandler({ stateRoot, workspaceRoot }),
    { team_name: "Alpha Team", description: "status convergence e2e" },
    leadExtra
  );
  const agentPayload = await callHandler(
    createAgentHandler({ stateRoot, workspaceRoot }),
    { name: "Builder", team_name: "alpha-team", prompt: "seed teammate" },
    leadExtra
  );
  const builderMemberId = (agentPayload.debug as { internal_member_id: string })
    .internal_member_id;
  const teamId = withAdapter((adapter) => {
    const row = adapter
      .getDatabase()
      .prepare(`SELECT team_id AS teamId FROM ${TABLE_NAMES.teams} LIMIT 1`)
      .get() as { teamId: string };
    return row.teamId;
  });
  return { teamId, builderMemberId };
}

async function leadToBuilder(message: string, summary: string): Promise<void> {
  await callHandler(
    createSendMessageHandler({ stateRoot, workspaceRoot }),
    { to: "builder@alpha-team", message, summary },
    leadExtra
  );
}

interface RawMessageRow {
  message_id: string;
  status: string;
  delivery_status: string | null;
  delivered_at: string | null;
  read_at: string | null;
}

function readMessageRows(recipientMemberId: string): RawMessageRow[] {
  return withAdapter((adapter) =>
    adapter
      .getDatabase()
      .prepare(
        `SELECT message_id, status, delivery_status, delivered_at, read_at
         FROM ${TABLE_NAMES.messages}
         WHERE recipient_member_id = ?
         ORDER BY rowid ASC`
      )
      .all(recipientMemberId) as RawMessageRow[]
  );
}

describe("v1.2 message status/delivery_status convergence (FIX #1/#2)", () => {
  it("LANDMINE: after claimDelivered the row is status='delivered' but still surfaces (read_at NULL)", async () => {
    const { teamId, builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("DELIVERED_UNREAD_BODY", "claim");

    // Freshly queued + undelivered.
    const before = readMessageRows(builderMemberId);
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe(MESSAGE_ROW_STATUSES.queued);
    expect(before[0].delivered_at).toBeNull();
    expect(before[0].read_at).toBeNull();

    // Deliver (turn-boundary drain claim) WITHOUT reading.
    const claimed = withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).claimDelivered(
        teamId,
        builderMemberId,
        "2026-06-12T00:00:01.000Z"
      )
    );
    expect(claimed).toHaveLength(1);

    // status converged to 'delivered'; delivered_at set; read_at STILL NULL.
    const afterDeliver = readMessageRows(builderMemberId)[0];
    expect(afterDeliver.status).toBe(MESSAGE_ROW_STATUSES.delivered);
    expect(afterDeliver.delivered_at).not.toBeNull();
    expect(afterDeliver.read_at).toBeNull();

    // The read-model still surfaces the delivered-but-unread row (read_at IS NULL).
    const unread = withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).selectUnreadForMember(
        teamId,
        builderMemberId
      )
    );
    expect(unread.map((row) => row.message_id)).toContain(afterDeliver.message_id);

    // ...and so does the REAL CheckInbox surface (end-to-end landmine guard): the
    // delivered-unread message is returned and only NOW marked read.
    const inbox = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      {},
      teammateExtra(builderMemberId)
    );
    expect(inbox.marked_read).toBe(1);
    const messages = inbox.messages as Array<{ body: string }>;
    expect(messages.map((m) => m.body)).toContain("DELIVERED_UNREAD_BODY");
  });

  it("claimRead converges status='read' + delivery_status='delivered' and drops the row from unread", async () => {
    const { teamId, builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("READ_BODY", "read");

    withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).claimRead(
        teamId,
        builderMemberId,
        "2026-06-12T00:00:02.000Z"
      )
    );

    const row = readMessageRows(builderMemberId)[0];
    expect(row.status).toBe(MESSAGE_ROW_STATUSES.read);
    expect(row.read_at).not.toBeNull();
    // delivery_status is no longer stuck at the push-attempt value.
    expect(row.delivery_status).toBe(MESSAGE_DELIVERY_STATUSES.delivered);

    // No longer unread; still retrievable via include_read history.
    const unread = withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).selectUnreadForMember(
        teamId,
        builderMemberId
      )
    );
    expect(unread).toHaveLength(0);
    const history = withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).selectUnreadForMember(
        teamId,
        builderMemberId,
        { includeRead: true }
      )
    );
    expect(history.map((r) => r.message_id)).toContain(row.message_id);
  });

  it("pending set is UNCHANGED across the queued->delivered transition (delivered drops, queued stays)", async () => {
    const { teamId, builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("FIRST_BODY", "first");

    // Both messages are queued-undelivered: a fresh second one arrives later.
    const firstMessageId = readMessageRows(builderMemberId)[0].message_id;

    // Pending originally contains the first message.
    const pendingBefore = withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).selectPendingForRecipient(
        teamId,
        builderMemberId
      )
    );
    expect(pendingBefore.map((r) => r.message_id)).toEqual([firstMessageId]);

    // Deliver the first message (status -> delivered, delivered_at set).
    withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).claimDelivered(
        teamId,
        builderMemberId,
        "2026-06-12T00:00:03.000Z"
      )
    );

    // A new queued-undelivered message arrives.
    await leadToBuilder("SECOND_BODY", "second");
    const rows = readMessageRows(builderMemberId);
    const secondMessageId = rows.find((r) => r.message_id !== firstMessageId)!
      .message_id;

    // The delivered row drops out; the still-queued one stays — pending tracks the
    // delivered_at timestamp, NOT the status column.
    const pendingAfter = withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).selectPendingForRecipient(
        teamId,
        builderMemberId
      )
    );
    expect(pendingAfter.map((r) => r.message_id)).toEqual([secondMessageId]);
  });

  it("a queued-undelivered message is still selected for delivery exactly as before", async () => {
    const { teamId, builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("PENDING_BODY", "pending");

    const pending = withAdapter((adapter) =>
      new MessageInboxService(adapter.getDatabase()).selectPendingForRecipient(
        teamId,
        builderMemberId
      )
    );
    expect(pending).toHaveLength(1);

    // Selection is timestamp-gated: the row is queued + delivered_at IS NULL.
    const row = readMessageRows(builderMemberId)[0];
    expect(row.status).toBe(MESSAGE_ROW_STATUSES.queued);
    expect(row.delivered_at).toBeNull();
  });
});
