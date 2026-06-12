import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { MessageService } from "../src/services/messageService.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { MEMBER_STATUSES, TABLE_NAMES } from "../src/state/schema.js";

// Phase 14 (BIDIR-06 / SC3 / D-Q2 / D-Q5): a teammate-role caller may send at
// most N proactive messages per turn (default 3, configurable) and may not
// self-send. Both guards are enforced in MessageService.sendMessage AFTER
// resolution and BEFORE persist, are EXEMPT for system lifecycle notices, and
// never throttle a leader / absent-role sender. The per-turn count is derived
// purely from messages.rowid ordering — no Date.now, no timer, no migration.

const tempRoots: string[] = [];

interface TeamContext {
  identity: WorkspaceScopedCallerIdentity;
  adapter: DurableStateAdapter;
  teamId: string;
  teamName: string;
}

interface MessageRow {
  message_id: string;
  sender_member_id: string | null;
  recipient_member_id: string | null;
  metadata_json: string;
}

interface EventRow {
  event_type: string;
  error_code: string | null;
  payload_json: string;
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-proactive-limit-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(
  workspaceRoot: string,
  metadata: unknown = { sessionId: "lead-session" }
): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(metadata)
  });
}

function createTeam(): TeamContext {
  const identity = createIdentity("/workspace/project");
  const adapter = new DurableStateAdapter({
    stateRoot: createTempStateRoot(),
    workspaceRoot: identity.workspaceRoot
  });
  const result = new TeamService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  }).createTeam({
    teamName: "Alpha Team",
    description: "Teammate per-turn proactive bound RED test",
    identity
  });

  return {
    identity,
    adapter,
    teamId: result.active_binding.team_id,
    teamName: result.team_name
  };
}

function createTeammate(input: {
  context: TeamContext;
  name: string;
  status?: string;
}): string {
  const created = new AgentService({
    db: input.context.adapter.getDatabase(),
    statePath: input.context.adapter.describeStateRoot().stateRoot
  }).createAgent({
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
    input.context.adapter
      .getDatabase()
      .prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`)
      .run(input.status, memberId);
  }

  return memberId;
}

function teammateIdentity(
  context: TeamContext,
  memberId: string
): WorkspaceScopedCallerIdentity {
  return createIdentity(context.identity.workspaceRoot, {
    sessionId: `teammate-session-${memberId}`,
    codexTeamMemberId: memberId,
    codexTeamMemberRole: "teammate"
  });
}

function createMessageService(
  context: TeamContext,
  maxProactiveMessagesPerTurn?: number
): MessageService {
  return new MessageService({
    db: context.adapter.getDatabase(),
    statePath: context.adapter.describeStateRoot().stateRoot,
    maxProactiveMessagesPerTurn
  });
}

function messages(db: Database.Database): MessageRow[] {
  return db
    .prepare(
      `SELECT message_id, sender_member_id, recipient_member_id, metadata_json
       FROM ${TABLE_NAMES.messages} ORDER BY rowid`
    )
    .all() as MessageRow[];
}

function events(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `SELECT event_type, error_code, payload_json
       FROM ${TABLE_NAMES.events} ORDER BY created_at, event_id`
    )
    .all() as EventRow[];
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("teammate per-turn proactive bound + self-send guard (Phase 14)", () => {
  it("persists the first N proactive sends and rejects the (N+1)th without a row", () => {
    // Explicit small cap (N=2) keeps the (N+1)th-rejected assertion cheap; the
    // DEFAULT (8) is covered by its own test below.
    const context = createTeam();
    const builderId = createTeammate({ context, name: "Builder" });
    createTeammate({ context, name: "Reviewer", status: MEMBER_STATUSES.running });
    const identity = teammateIdentity(context, builderId);
    const service = createMessageService(context, 2);

    const accepted = [1, 2].map((n) =>
      service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: `proactive ${n}`,
        identity
      })
    );
    for (const result of accepted) {
      expect(result.persisted).toBe(true);
    }

    const rejected = service.sendMessage({
      teamName: "alpha-team",
      to: "reviewer@alpha-team",
      message: "proactive 3 — over the bound",
      identity
    });

    expect(rejected).toMatchObject({
      status: "error",
      error_code: "teammate_proactive_limit_exceeded",
      persisted: false
    });

    const db = context.adapter.getDatabase();
    const outbound = messages(db).filter(
      (row) => row.sender_member_id === builderId
    );
    expect(outbound).toHaveLength(2);

    const failureEvents = events(db).filter(
      (event) => event.error_code === "teammate_proactive_limit_exceeded"
    );
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0].event_type).toBe("message_send_failed");
    const payload = JSON.parse(failureEvents[0].payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      error_code: "teammate_proactive_limit_exceeded",
      reason: "teammate_proactive_limit_per_turn",
      limit: 2,
      persisted: false
    });
    // No body / prompt text in the sanitized event.
    expect(failureEvents[0].payload_json).not.toContain("over the bound");
    expect(failureEvents[0].payload_json).not.toContain("body");
    expect(failureEvents[0].payload_json).not.toContain("prompt");

    context.adapter.close();
  });

  it("defaults to N=8 when no option (and no env override) is provided", () => {
    const context = createTeam();
    const builderId = createTeammate({ context, name: "Builder" });
    createTeammate({ context, name: "Reviewer", status: MEMBER_STATUSES.running });
    const identity = teammateIdentity(context, builderId);
    // No maxProactiveMessagesPerTurn option AND the env override is absent in the
    // test runner -> the effective bound must resolve to the default 8.
    expect(process.env.CODEX_TEAM_MAX_PROACTIVE_MESSAGES_PER_TURN).toBeUndefined();
    const service = createMessageService(context);

    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(
        service.sendMessage({
          teamName: "alpha-team",
          to: "reviewer@alpha-team",
          message: `default proactive ${n}`,
          identity
        }).persisted
      ).toBe(true);
    }

    const rejected = service.sendMessage({
      teamName: "alpha-team",
      to: "reviewer@alpha-team",
      message: "default proactive 9 — over the default bound",
      identity
    });
    expect(rejected).toMatchObject({
      status: "error",
      error_code: "teammate_proactive_limit_exceeded",
      persisted: false
    });
    const failureEvents = events(context.adapter.getDatabase()).filter(
      (event) => event.error_code === "teammate_proactive_limit_exceeded"
    );
    expect(failureEvents).toHaveLength(1);
    expect(
      (JSON.parse(failureEvents[0].payload_json) as { limit?: number }).limit
    ).toBe(8);

    context.adapter.close();
  });

  it("resets the allowance after a new inbound message is addressed to the teammate", () => {
    const context = createTeam();
    const builderId = createTeammate({ context, name: "Builder" });
    createTeammate({ context, name: "Reviewer", status: MEMBER_STATUSES.running });
    const builderIdentity = teammateIdentity(context, builderId);
    // Explicit small cap (N=2) keeps the per-turn reset assertion cheap.
    const service = createMessageService(context, 2);

    // Builder exhausts the allowance this turn.
    for (const n of [1, 2]) {
      expect(
        service.sendMessage({
          teamName: "alpha-team",
          to: "reviewer@alpha-team",
          message: `turn-1 message ${n}`,
          identity: builderIdentity
        }).persisted
      ).toBe(true);
    }
    expect(
      service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: "turn-1 over the bound",
        identity: builderIdentity
      })
    ).toMatchObject({ error_code: "teammate_proactive_limit_exceeded" });

    // The leader sends an inbound message TO the teammate (a new turn boundary).
    expect(
      service.sendMessage({
        teamName: "alpha-team",
        to: "builder@alpha-team",
        message: "leader inbound — new turn",
        identity: context.identity
      }).persisted
    ).toBe(true);

    // Builder may again send the full allowance.
    for (const n of [1, 2]) {
      expect(
        service.sendMessage({
          teamName: "alpha-team",
          to: "reviewer@alpha-team",
          message: `turn-2 message ${n}`,
          identity: builderIdentity
        }).persisted
      ).toBe(true);
    }
    expect(
      service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: "turn-2 over the bound",
        identity: builderIdentity
      })
    ).toMatchObject({ error_code: "teammate_proactive_limit_exceeded" });

    context.adapter.close();
  });

  it("exempts system lifecycle notices from the bound (neither counted nor blocked)", () => {
    const context = createTeam();
    const builderId = createTeammate({ context, name: "Builder" });
    createTeammate({ context, name: "Reviewer", status: MEMBER_STATUSES.running });
    const identity = teammateIdentity(context, builderId);
    // Explicit small cap (N=2) keeps the exemption assertion cheap.
    const service = createMessageService(context, 2);

    // Even though the teammate has not sent anything, five system notices all
    // persist and NONE are rejected (exempt) ...
    for (const n of [1, 2, 3, 4, 5]) {
      const notice = service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: `resume failed notice ${n}`,
        metadata: {
          message_type: "resume_failure_notice",
          teammate_id: "reviewer@alpha-team",
          error_code: "backend_failed"
        },
        identity
      });
      expect(notice.persisted).toBe(true);
    }

    // ... and they do NOT count toward the bound: two plain proactive sends
    // still succeed, only the 3rd plain send is rejected.
    for (const n of [1, 2]) {
      expect(
        service.sendMessage({
          teamName: "alpha-team",
          to: "reviewer@alpha-team",
          message: `plain proactive ${n}`,
          identity
        }).persisted
      ).toBe(true);
    }
    expect(
      service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: "plain proactive 3",
        identity
      })
    ).toMatchObject({ error_code: "teammate_proactive_limit_exceeded" });

    context.adapter.close();
  });

  it("does not bound a leader / absent-role sender", () => {
    const context = createTeam();
    createTeammate({ context, name: "Reviewer", status: MEMBER_STATUSES.running });
    const service = createMessageService(context);

    for (const n of [1, 2, 3, 4, 5]) {
      expect(
        service.sendMessage({
          teamName: "alpha-team",
          to: "reviewer@alpha-team",
          message: `leader proactive ${n}`,
          identity: context.identity
        }).persisted
      ).toBe(true);
    }

    const leaderOutbound = messages(context.adapter.getDatabase()).filter(
      (row) => row.sender_member_id === `leader:${context.teamId}`
    );
    expect(leaderOutbound).toHaveLength(5);

    context.adapter.close();
  });

  it("rejects a teammate self-send without a row and with one sanitized event", () => {
    const context = createTeam();
    const builderId = createTeammate({ context, name: "Builder" });
    const identity = teammateIdentity(context, builderId);

    const result = createMessageService(context).sendMessage({
      teamName: "alpha-team",
      to: "builder@alpha-team",
      message: "talking to myself",
      identity
    });

    expect(result).toMatchObject({
      status: "error",
      error_code: "teammate_self_send_rejected",
      persisted: false
    });

    const db = context.adapter.getDatabase();
    expect(messages(db)).toHaveLength(0);
    const failureEvents = events(db).filter(
      (event) => event.error_code === "teammate_self_send_rejected"
    );
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0].event_type).toBe("message_send_failed");
    expect(failureEvents[0].payload_json).not.toContain("talking to myself");

    context.adapter.close();
  });

  it("does not gate a leader self-send (team-lead -> team-lead persists)", () => {
    const context = createTeam();

    const result = createMessageService(context).sendMessage({
      teamName: "alpha-team",
      to: "team-lead@alpha-team",
      message: "leader note to self",
      identity: context.identity
    });

    expect(result.persisted).toBe(true);
    expect(messages(context.adapter.getDatabase())).toHaveLength(1);

    context.adapter.close();
  });

  it("honors a configured maxProactiveMessagesPerTurn override", () => {
    const context = createTeam();
    const builderId = createTeammate({ context, name: "Builder" });
    createTeammate({ context, name: "Reviewer", status: MEMBER_STATUSES.running });
    const identity = teammateIdentity(context, builderId);
    const service = createMessageService(context, 1);

    expect(
      service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: "only proactive allowed",
        identity
      }).persisted
    ).toBe(true);
    expect(
      service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: "second is over the cap of 1",
        identity
      })
    ).toMatchObject({
      error_code: "teammate_proactive_limit_exceeded",
      persisted: false
    });

    context.adapter.close();
  });

  it("makes no SQLite pragma change after sends and rejections", () => {
    const context = createTeam();
    const builderId = createTeammate({ context, name: "Builder" });
    createTeammate({ context, name: "Reviewer", status: MEMBER_STATUSES.running });
    const identity = teammateIdentity(context, builderId);
    const service = createMessageService(context);

    for (const n of [1, 2, 3, 4]) {
      service.sendMessage({
        teamName: "alpha-team",
        to: "reviewer@alpha-team",
        message: `pragma probe ${n}`,
        identity
      });
    }

    const db = context.adapter.getDatabase();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(Number(db.pragma("busy_timeout", { simple: true }))).toBe(5000);

    context.adapter.close();
  });
});
