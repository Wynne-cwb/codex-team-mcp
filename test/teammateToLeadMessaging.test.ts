import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { ContextResolver } from "../src/services/contextResolver.js";
import { createAgentHandler } from "../src/tools/agentHandler.js";
import { createSendMessageHandler } from "../src/tools/messageHandler.js";
import { createTeamCreateHandler } from "../src/tools/teamHandlers.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { TABLE_NAMES } from "../src/state/schema.js";

// Phase 13 e2e (SC3 / SC5 / BIDIR-03 / D-Q5 / D-Q6): a pane-hosted teammate's
// co-located codex-team MCP proactively messages the Team Lead through the SAME
// shared team DB. The teammate identity uses a callerKey DISTINCT from the
// TeamCreate caller (different sessionId => NO active binding), and SendMessage is
// called with BOTH team_name AND from OMITTED — carrying only the TL-injected
// member id + role. The team must resolve via member_identity and the sender via
// the teammate's own member row.

let stateRoot: string;
let workspaceRoot: string;

const PROACTIVE_BODY = "PROACTIVE_BIDIR_BODY_42_unique_marker";
const BACKWARD_COMPAT_BODY = "BACKWARD_COMPAT_BODY_7_unique_marker";

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-bidir-"));
}

beforeEach(() => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

async function callHandler(
  handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>,
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
  delivery_status: string;
  body_json: string;
}

async function seedTeamAndTeammate(): Promise<{
  teamId: string;
  leaderMemberId: string;
  builderMemberId: string;
}> {
  await callHandler(
    createTeamCreateHandler({ stateRoot, workspaceRoot }),
    { team_name: "Alpha Team", description: "bidir e2e" },
    { sessionId: "lead-session" }
  );
  const agentPayload = await callHandler(
    createAgentHandler({ stateRoot, workspaceRoot }),
    { name: "Builder", team_name: "alpha-team", prompt: "seed teammate" },
    { sessionId: "lead-session" }
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

describe("teammate -> Team Lead proactive messaging on the shared DB (Phase 13)", () => {
  it("resolves a from-omitted, team_name-omitted teammate send to the lead inbox via member_identity", async () => {
    const { teamId, leaderMemberId, builderMemberId } = await seedTeamAndTeammate();

    // The co-located teammate MCP: DISTINCT session (no active binding) carrying
    // only the TL-injected member id + role. team_name AND from are BOTH omitted.
    const sendPayload = await callHandler(
      createSendMessageHandler({ stateRoot, workspaceRoot }),
      { to: "team-lead@alpha-team", message: PROACTIVE_BODY },
      {
        sessionId: "builder-session",
        codexTeamMemberId: builderMemberId,
        codexTeamMemberRole: "teammate"
      }
    );

    // Sender = the teammate (NOT the leader); recipient = the lead.
    expect(sendPayload.persisted).toBe(true);
    expect(sendPayload.team_name).toBe("alpha-team");
    expect(sendPayload.sender).toMatchObject({
      member_id: builderMemberId,
      teammate_id: "builder@alpha-team"
    });
    expect(sendPayload.recipient).toMatchObject({
      member_id: leaderMemberId,
      teammate_id: "team-lead@alpha-team"
    });

    // The team resolved via the NEW member_identity path (no binding for this caller).
    const builderIdentity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot,
      caller: normalizeCallerMetadata({
        sessionId: "builder-session",
        codexTeamMemberId: builderMemberId,
        codexTeamMemberRole: "teammate"
      })
    });
    withAdapter((adapter) => {
      const resolved = new ContextResolver(adapter.getDatabase()).resolveTeam({
        identity: builderIdentity
      });
      expect(resolved).toMatchObject({
        ok: true,
        team: { teamId, teamName: "alpha-team", resolution: "member_identity" }
      });
    });

    // The message landed in the lead's inbox on the shared DB, delivered/queued.
    const leadInbox = withAdapter(
      (adapter) =>
        adapter
          .getDatabase()
          .prepare(
            `SELECT message_id, sender_member_id, recipient_member_id, delivery_status, body_json
             FROM ${TABLE_NAMES.messages}
             WHERE recipient_member_id = ?`
          )
          .all(leaderMemberId) as MessageRow[]
    );
    expect(leadInbox).toHaveLength(1);
    expect(leadInbox[0].sender_member_id).toBe(builderMemberId);
    expect(["queued_while_idle", "queued_for_next_turn"]).toContain(
      leadInbox[0].delivery_status
    );
  });

  it("persists the body ONLY in the messages table (D-02 sanitization)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();

    await callHandler(
      createSendMessageHandler({ stateRoot, workspaceRoot }),
      { to: "team-lead@alpha-team", message: PROACTIVE_BODY },
      {
        sessionId: "builder-session",
        codexTeamMemberId: builderMemberId,
        codexTeamMemberRole: "teammate"
      }
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

      // Body lives in the inbox...
      expect(messageBodies.some((row) => row.body_json.includes(PROACTIVE_BODY))).toBe(
        true
      );
      // ...and NOWHERE else (events / runs).
      expect(eventPayloads.some((row) => row.payload_json.includes(PROACTIVE_BODY))).toBe(
        false
      );
      expect(runMetadata.some((row) => row.metadata_json.includes(PROACTIVE_BODY))).toBe(
        false
      );
    });
  });

  it("makes NO SQLite pragma change (WAL + busy_timeout=5000 unchanged)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await callHandler(
      createSendMessageHandler({ stateRoot, workspaceRoot }),
      { to: "team-lead@alpha-team", message: PROACTIVE_BODY },
      {
        sessionId: "builder-session",
        codexTeamMemberId: builderMemberId,
        codexTeamMemberRole: "teammate"
      }
    );

    withAdapter((adapter) => {
      const db = adapter.getDatabase();
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(Number(db.pragma("busy_timeout", { simple: true }))).toBe(5000);
    });
  });

  it("still resolves a from-omitted send to the leader when no teammate env/role is present (backward-compat, D-Q5)", async () => {
    const { leaderMemberId } = await seedTeamAndTeammate();

    // The TL's own MCP: active binding present, NO member id/role in identity.
    const sendPayload = await callHandler(
      createSendMessageHandler({ stateRoot, workspaceRoot }),
      { to: "builder@alpha-team", message: BACKWARD_COMPAT_BODY },
      { sessionId: "lead-session" }
    );

    expect(sendPayload.persisted).toBe(true);
    expect(sendPayload.sender).toMatchObject({
      member_id: leaderMemberId,
      teammate_id: "team-lead@alpha-team"
    });
  });
});
