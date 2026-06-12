import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentHandler } from "../src/tools/agentHandler.js";
import { createInboxHandler } from "../src/tools/inboxHandler.js";
import { createSendMessageHandler } from "../src/tools/messageHandler.js";
import { createTeamCreateHandler } from "../src/tools/teamHandlers.js";
import { withLeaderInboxSurface } from "../src/tools/registry.js";
import { MessageInboxService } from "../src/services/messageInboxService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { TABLE_NAMES } from "../src/state/schema.js";

// Phase 16 (T6 + T7 / §3): the TL inbox auto-surface envelope + the CheckInbox pull
// tool. Built ON TOP of the T1-T5 read-model (MessageInboxService) + delivery drain.
// Mirrors test/teammateToLeadMessaging.test.ts (handler-level, shared DB) +
// test/messageMcp.test.ts (JSON result parsing).

let stateRoot: string;
let workspaceRoot: string;

type ToolHandler = (
  args: unknown,
  extra: unknown
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-inbox-surface-"));
}

beforeEach(() => {
  stateRoot = createTempStateRoot();
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
  leaderMemberId: string;
  builderMemberId: string;
}

async function seedTeamAndTeammate(): Promise<SeedResult> {
  await callHandler(
    createTeamCreateHandler({ stateRoot, workspaceRoot }),
    { team_name: "Alpha Team", description: "inbox surface e2e" },
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

  return { teamId, leaderMemberId: `leader:${teamId}`, builderMemberId };
}

// A teammate proactively messages the Team Lead (recipient = leader:<teamId>).
async function teammateToLead(
  builderMemberId: string,
  message: string,
  summary: string
): Promise<void> {
  await callHandler(
    createSendMessageHandler({ stateRoot, workspaceRoot }),
    { to: "team-lead@alpha-team", message, summary },
    teammateExtra(builderMemberId)
  );
}

// The Team Lead messages the Builder teammate (recipient = the teammate).
async function leadToBuilder(message: string, summary: string): Promise<void> {
  await callHandler(
    createSendMessageHandler({ stateRoot, workspaceRoot }),
    { to: "builder@alpha-team", message, summary },
    leadExtra
  );
}

// A trivial inner handler whose JSON result the auto-surface wraps.
function fakeToolHandler(): ToolHandler {
  return async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, tool: "TaskList" }) }]
  });
}

function readReadAt(recipientMemberId: string): Array<string | null> {
  return withAdapter((adapter) =>
    (
      adapter
        .getDatabase()
        .prepare(
          `SELECT read_at FROM ${TABLE_NAMES.messages}
           WHERE recipient_member_id = ? ORDER BY rowid ASC`
        )
        .all(recipientMemberId) as Array<{ read_at: string | null }>
    ).map((row) => row.read_at)
  );
}

interface InboxBlock {
  unread_count: number;
  messages: Array<{
    message_id: string;
    from: string | null;
    summary: string | null;
    body: string;
    created_at: string;
  }>;
  note: string;
}

describe("Phase 16 TL inbox auto-surface (T6)", () => {
  it("appends an inbox block (oldest-first, full body) to a leader tool result and stamps read_at", async () => {
    const { leaderMemberId, builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "BODY_ONE_unique", "first claim");
    await teammateToLead(builderMemberId, "BODY_TWO_unique", "second claim");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), {
      stateRoot,
      workspaceRoot
    });
    const result = await callHandler(wrapped, {}, leadExtra);

    expect(result.ok).toBe(true);
    const inbox = result.inbox as InboxBlock;
    expect(inbox.unread_count).toBe(2);
    expect(inbox.messages).toHaveLength(2);
    // Oldest-first FIFO.
    expect(inbox.messages[0]).toMatchObject({
      from: "builder@alpha-team",
      summary: "first claim",
      body: "BODY_ONE_unique"
    });
    expect(inbox.messages[1]).toMatchObject({
      from: "builder@alpha-team",
      summary: "second claim",
      body: "BODY_TWO_unique"
    });
    expect(inbox.note).toContain("oldest first");

    // read_at stamped for both leader-addressed rows.
    expect(readReadAt(leaderMemberId).every((value) => value !== null)).toBe(true);
  });

  it("does NOT re-surface already-read messages on a second leader tool call", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "ONLY_BODY", "only");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), {
      stateRoot,
      workspaceRoot
    });
    const first = await callHandler(wrapped, {}, leadExtra);
    expect((first.inbox as InboxBlock).unread_count).toBe(1);

    const second = await callHandler(wrapped, {}, leadExtra);
    expect(second).not.toHaveProperty("inbox");
  });

  it("ROLE GATE: a teammate-role caller's tool result has NO inbox block and the leader inbox stays unread", async () => {
    const { leaderMemberId, builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "FOR_THE_LEAD", "to lead");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), {
      stateRoot,
      workspaceRoot
    });
    const result = await callHandler(wrapped, {}, teammateExtra(builderMemberId));

    expect(result).not.toHaveProperty("inbox");
    // The teammate call never consumed the leader's inbox.
    expect(readReadAt(leaderMemberId)).toEqual([null]);
  });

  it("CONCURRENT LEADER SURFACE: the atomic claim surfaces each unread row exactly once total", async () => {
    const { teamId, leaderMemberId, builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "RACE_ONE", "r1");
    await teammateToLead(builderMemberId, "RACE_TWO", "r2");

    // Two MessageInboxService instances on the SAME WAL db claim-and-stamp read_at;
    // the BEGIN IMMEDIATE conditional claim means one gets all unread, the other none
    // (no double-surface). Each owns its own connection.
    const a = new DurableStateAdapter({ stateRoot, workspaceRoot });
    const b = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const claimA = new MessageInboxService(a.getDatabase()).claimRead(
        teamId,
        leaderMemberId,
        "2026-06-12T00:00:01.000Z"
      );
      const claimB = new MessageInboxService(b.getDatabase()).claimRead(
        teamId,
        leaderMemberId,
        "2026-06-12T00:00:02.000Z"
      );
      expect(claimA.length + claimB.length).toBe(2);
      // Disjoint: one claims both, the other zero.
      expect([claimA.length, claimB.length].sort()).toEqual([0, 2]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("D-02: surfacing writes ONLY read_at — the body never lands in events or runs metadata", async () => {
    const { leaderMemberId, builderMemberId } = await seedTeamAndTeammate();
    const marker = "D02_SURFACE_MARKER_qzx";
    await teammateToLead(builderMemberId, `secret ${marker}`, "answer");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), {
      stateRoot,
      workspaceRoot
    });
    await callHandler(wrapped, {}, leadExtra);

    withAdapter((adapter) => {
      const db = adapter.getDatabase();
      const events = db
        .prepare(`SELECT payload_json FROM ${TABLE_NAMES.events}`)
        .all() as Array<{ payload_json: string }>;
      const runs = db
        .prepare(`SELECT metadata_json FROM ${TABLE_NAMES.runs}`)
        .all() as Array<{ metadata_json: string }>;
      const bodies = db
        .prepare(`SELECT body_json FROM ${TABLE_NAMES.messages}`)
        .all() as Array<{ body_json: string }>;

      expect(JSON.stringify(events)).not.toContain(marker);
      expect(JSON.stringify(runs)).not.toContain(marker);
      // The body lives ONLY in messages.body_json.
      expect(JSON.stringify(bodies)).toContain(marker);
    });

    // read_at was the only mutation to the leader rows.
    expect(readReadAt(leaderMemberId).every((value) => value !== null)).toBe(true);
  });

  it("re-pull: the leader can read auto-surfaced messages again via CheckInbox include_read", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "REPULL_BODY", "repull");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), {
      stateRoot,
      workspaceRoot
    });
    await callHandler(wrapped, {}, leadExtra); // marks read

    const history = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      { include_read: true },
      leadExtra
    );
    expect(history.status).toBe("ok");
    const messages = history.messages as InboxBlock["messages"];
    expect(messages.map((message) => message.body)).toContain("REPULL_BODY");
  });
});

describe("Phase 16 CheckInbox tool (T7)", () => {
  it("returns unread messages oldest-first and marks them read (teammate-role caller, not denied)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("INBOX_ONE", "one");
    await leadToBuilder("INBOX_TWO", "two");

    const payload = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      {},
      teammateExtra(builderMemberId)
    );

    // Callable by a teammate role — NOT a capability denial.
    expect(payload.status).toBe("ok");
    expect(payload).not.toHaveProperty("error_code");
    expect(payload.member_id).toBe(builderMemberId);
    expect(payload.marked_read).toBe(2);
    const messages = payload.messages as InboxBlock["messages"];
    expect(messages.map((message) => message.body)).toEqual([
      "INBOX_ONE",
      "INBOX_TWO"
    ]);
    expect(messages.every((message) => message.from === "team-lead@alpha-team")).toBe(
      true
    );

    // The rows are now read; a second pull returns nothing.
    expect(readReadAt(builderMemberId).every((value) => value !== null)).toBe(true);
    const again = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      {},
      teammateExtra(builderMemberId)
    );
    expect(again.returned_count).toBe(0);
    expect(again.unread_count).toBe(0);
  });

  it("peek:true returns unread WITHOUT marking them read", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("PEEK_BODY", "peek");

    const peeked = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      { peek: true },
      teammateExtra(builderMemberId)
    );
    expect(peeked.marked_read).toBe(0);
    expect((peeked.messages as InboxBlock["messages"])[0].body).toBe("PEEK_BODY");
    // Still unread on disk.
    expect(readReadAt(builderMemberId)).toEqual([null]);

    // A real (non-peek) pull then marks it read.
    const read = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      {},
      teammateExtra(builderMemberId)
    );
    expect(read.marked_read).toBe(1);
    expect(readReadAt(builderMemberId).every((value) => value !== null)).toBe(true);
  });

  it("include_read:true returns prior read history alongside fresh unread", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("HIST_ONE", "h1");
    await leadToBuilder("HIST_TWO", "h2");

    // Read the first two.
    await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      {},
      teammateExtra(builderMemberId)
    );
    // A third arrives.
    await leadToBuilder("HIST_THREE", "h3");

    const history = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      { include_read: true },
      teammateExtra(builderMemberId)
    );
    expect(history.returned_count).toBe(3);
    expect(history.marked_read).toBe(1); // only the newly-unread third
    const messages = history.messages as InboxBlock["messages"];
    expect(messages.map((message) => message.body)).toEqual([
      "HIST_ONE",
      "HIST_TWO",
      "HIST_THREE"
    ]);

    // Without include_read, after reading everything, nothing is returned.
    const fresh = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      {},
      teammateExtra(builderMemberId)
    );
    expect(fresh.returned_count).toBe(0);
  });

  it("honors limit: only the oldest N unread are returned + marked read per call", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await leadToBuilder("LIM_ONE", "l1");
    await leadToBuilder("LIM_TWO", "l2");
    await leadToBuilder("LIM_THREE", "l3");

    const firstBatch = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      { limit: 2 },
      teammateExtra(builderMemberId)
    );
    expect(firstBatch.returned_count).toBe(2);
    expect(firstBatch.marked_read).toBe(2);
    expect(
      (firstBatch.messages as InboxBlock["messages"]).map((message) => message.body)
    ).toEqual(["LIM_ONE", "LIM_TWO"]);

    const secondBatch = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      { limit: 2 },
      teammateExtra(builderMemberId)
    );
    expect(secondBatch.returned_count).toBe(1);
    expect(
      (secondBatch.messages as InboxBlock["messages"]).map((message) => message.body)
    ).toEqual(["LIM_THREE"]);
  });

  it("D-02: CheckInbox writes ONLY read_at — the body never lands in events or runs metadata", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    const marker = "D02_CHECKINBOX_MARKER_wvu";
    await leadToBuilder(`secret ${marker}`, "secret");

    await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      {},
      teammateExtra(builderMemberId)
    );

    withAdapter((adapter) => {
      const db = adapter.getDatabase();
      const events = db
        .prepare(`SELECT payload_json FROM ${TABLE_NAMES.events}`)
        .all() as Array<{ payload_json: string }>;
      const runs = db
        .prepare(`SELECT metadata_json FROM ${TABLE_NAMES.runs}`)
        .all() as Array<{ metadata_json: string }>;
      const bodies = db
        .prepare(`SELECT body_json FROM ${TABLE_NAMES.messages}`)
        .all() as Array<{ body_json: string }>;

      expect(JSON.stringify(events)).not.toContain(marker);
      expect(JSON.stringify(runs)).not.toContain(marker);
      expect(JSON.stringify(bodies)).toContain(marker);
    });
    expect(readReadAt(builderMemberId).every((value) => value !== null)).toBe(true);
  });
});
