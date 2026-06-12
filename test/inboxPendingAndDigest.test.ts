import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentHandler } from "../src/tools/agentHandler.js";
import { createInboxHandler } from "../src/tools/inboxHandler.js";
import { createSendMessageHandler } from "../src/tools/messageHandler.js";
import { createTeamCreateHandler } from "../src/tools/teamHandlers.js";
import { withLeaderInboxSurface } from "../src/tools/registry.js";
import { TABLE_NAMES } from "../src/state/schema.js";
import { DurableStateAdapter } from "../src/state/durableState.js";

// Item 1 (CANONICAL-PULL-MODEL.md §2a/§2b): the `inbox_pending` counter on every
// codex-team tool result, and the size-aware leader auto-surface (full-body inline for
// few/short, compact digest for many/large). Mirrors tlInboxSurfaceAndCheckInbox.test.ts
// (handler-level, shared DB).

let stateRoot: string;
let workspaceRoot: string;

type ToolHandler = (
  args: unknown,
  extra: unknown
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-inbox-pending-"));
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

async function seedTeamAndTeammate(): Promise<{ teamId: string; builderMemberId: string }> {
  await callHandler(
    createTeamCreateHandler({ stateRoot, workspaceRoot }),
    { team_name: "Alpha Team", description: "inbox pending e2e" },
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

// A trivial inner handler whose JSON result the auto-surface wraps.
function fakeToolHandler(): ToolHandler {
  return async () => ({
    content: [{ type: "text", text: JSON.stringify({ ok: true, tool: "TaskList" }) }]
  });
}

interface FullBodyMessage {
  message_id: string;
  from: string | null;
  summary: string | null;
  body: string;
  created_at: string;
}

interface DigestMessage {
  message_id: string;
  from: string | null;
  summary: string | null;
  created_at: string;
  preview: string;
  truncated: boolean;
}

describe("Item 1 §2a — inbox_pending counter", () => {
  it("emits inbox_pending: 0 on a leader tool result when there is no mail", async () => {
    await seedTeamAndTeammate();
    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });

    const result = await callHandler(wrapped, {}, leadExtra);
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty("inbox_pending", 0);
    expect(result).not.toHaveProperty("inbox");
  });

  it("counts the leader's own unread and reflects POST-claim state (drops to 0 after surfacing)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "ONE", "one");
    await teammateToLead(builderMemberId, "TWO", "two");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });

    // First call claims both rows; inbox_pending reflects what remains AFTER the claim.
    const first = await callHandler(wrapped, {}, leadExtra);
    expect((first.inbox as { unread_count: number }).unread_count).toBe(2);
    expect(first.inbox_pending).toBe(0);

    // Second call: nothing left, still emits the counter.
    const second = await callHandler(wrapped, {}, leadExtra);
    expect(second).not.toHaveProperty("inbox");
    expect(second.inbox_pending).toBe(0);
  });

  it("does NOT attach inbox_pending for a teammate-role caller (role gate returns early)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "FOR_THE_LEAD", "to lead");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });
    const result = await callHandler(wrapped, {}, teammateExtra(builderMemberId));

    expect(result).not.toHaveProperty("inbox");
    expect(result).not.toHaveProperty("inbox_pending");
  });
});

describe("Item 1 §2b — size-aware leader auto-surface", () => {
  it("FULL-BODY inline when few + short (<= 5 rows AND <= 8 KiB total)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "SHORT_ONE", "s1");
    await teammateToLead(builderMemberId, "SHORT_TWO", "s2");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });
    const result = await callHandler(wrapped, {}, leadExtra);

    const inbox = result.inbox as { unread_count: number; digest?: boolean; messages: FullBodyMessage[] };
    expect(inbox.unread_count).toBe(2);
    expect(inbox.digest).toBeUndefined();
    // Full bodies are present.
    expect(inbox.messages.map((m) => m.body)).toEqual(["SHORT_ONE", "SHORT_TWO"]);
    expect(inbox.messages[0]).not.toHaveProperty("preview");
  });

  it("DIGEST when the COUNT bound is exceeded (> 5 short rows)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    for (let i = 0; i < 6; i += 1) {
      await teammateToLead(builderMemberId, `BODY_${i}`, `s${i}`);
    }

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });
    const result = await callHandler(wrapped, {}, leadExtra);

    const inbox = result.inbox as { unread_count: number; digest?: boolean; messages: DigestMessage[]; note: string };
    expect(inbox.unread_count).toBe(6);
    expect(inbox.digest).toBe(true);
    // Digest rows carry preview + truncated, NO full body field.
    for (const message of inbox.messages) {
      expect(message).toHaveProperty("preview");
      expect(message.truncated).toBe(true);
      expect(message).not.toHaveProperty("body");
    }
    expect(inbox.note).toContain("CheckInbox");
  });

  it("DIGEST when the BYTE bound is exceeded (a single > 8 KiB body)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    const bigBody = "X".repeat(9000); // > 8192 bytes (ASCII)
    await teammateToLead(builderMemberId, bigBody, "big");

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });
    const result = await callHandler(wrapped, {}, leadExtra);

    const inbox = result.inbox as { unread_count: number; digest?: boolean; messages: DigestMessage[] };
    expect(inbox.unread_count).toBe(1);
    expect(inbox.digest).toBe(true);
    const [message] = inbox.messages;
    // Preview is capped at 200 chars; full body never inlined.
    expect(message.preview.length).toBe(200);
    expect(message).not.toHaveProperty("body");
  });

  it("DIGEST mode marks the SAME rows read; the TL can re-pull full bodies via CheckInbox(include_read)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    for (let i = 0; i < 6; i += 1) {
      await teammateToLead(builderMemberId, `REPULL_${i}`, `r${i}`);
    }

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });
    const surfaced = await callHandler(wrapped, {}, leadExtra);
    expect((surfaced.inbox as { digest?: boolean }).digest).toBe(true);
    // All claimed → nothing left unread.
    expect(surfaced.inbox_pending).toBe(0);

    // Full bodies are recoverable on demand.
    const history = await callHandler(
      createInboxHandler({ stateRoot, workspaceRoot }),
      { include_read: true },
      leadExtra
    );
    const bodies = (history.messages as FullBodyMessage[]).map((m) => m.body);
    for (let i = 0; i < 6; i += 1) {
      expect(bodies).toContain(`REPULL_${i}`);
    }
  });

  it("D-02: digest preview never lands in events or runs metadata", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    const marker = "DIGEST_D02_MARKER_pqr";
    for (let i = 0; i < 6; i += 1) {
      await teammateToLead(builderMemberId, `${marker}_${i}`, `s${i}`);
    }

    const wrapped = withLeaderInboxSurface(fakeToolHandler(), { stateRoot, workspaceRoot });
    await callHandler(wrapped, {}, leadExtra);

    withAdapter((adapter) => {
      const db = adapter.getDatabase();
      const events = db.prepare(`SELECT payload_json FROM ${TABLE_NAMES.events}`).all();
      const runs = db.prepare(`SELECT metadata_json FROM ${TABLE_NAMES.runs}`).all();
      expect(JSON.stringify(events)).not.toContain(marker);
      expect(JSON.stringify(runs)).not.toContain(marker);
    });
  });
});
