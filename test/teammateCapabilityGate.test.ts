import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import {
  TEAMMATE_RESTRICTED_TOOL_ERROR_CODES,
  enforceTeammateCapability,
  type TeammateRestrictedTool
} from "../src/tools/capabilityGuard.js";
import { createAgentHandler } from "../src/tools/agentHandler.js";
import { createSendMessageHandler } from "../src/tools/messageHandler.js";
import { createTeamMergeHandler } from "../src/tools/mergeHandler.js";
import {
  createTeamCreateHandler,
  createTeamDeleteHandler
} from "../src/tools/teamHandlers.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../src/state/schema.js";

let stateRoot: string;
let workspaceRoot: string;

const RESTRICTED_TOOLS: TeammateRestrictedTool[] = [
  "Agent",
  "TeamCreate",
  "TeamDelete",
  "TeamMerge"
];

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-capability-gate-"));
}

beforeEach(() => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function buildIdentity(extra: unknown): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(extra)
  });
}

function teammateExtra(sessionId = "teammate-session"): Record<string, unknown> {
  return {
    sessionId,
    codexTeamMemberId: "teammate:alpha-team:builder",
    codexTeamMemberRole: "teammate"
  };
}

function withAdapter<T>(fn: (adapter: DurableStateAdapter) => T): T {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    return fn(adapter);
  } finally {
    adapter.close();
  }
}

function gateEvents(adapter: DurableStateAdapter, errorCode: string) {
  return adapter
    .getDatabase()
    .prepare(
      `
        SELECT team_id AS teamId, error_code AS errorCode, payload_json AS payloadJson
        FROM ${TABLE_NAMES.events}
        WHERE event_type = ?
          AND error_code = ?
        ORDER BY created_at ASC
      `
    )
    .all(EVENT_TYPES.toolValidationFailed, errorCode) as Array<{
    teamId: string | null;
    errorCode: string;
    payloadJson: string;
  }>;
}

function durableCounts() {
  return withAdapter((adapter) => {
    const db = adapter.getDatabase();
    const teams = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE_NAMES.teams}`).get() as { c: number }
    ).c;
    const members = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE_NAMES.members}`).get() as { c: number }
    ).c;
    const runs = (
      db.prepare(`SELECT COUNT(*) AS c FROM ${TABLE_NAMES.runs}`).get() as { c: number }
    ).c;
    return { teams, members, runs };
  });
}

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

describe("enforceTeammateCapability (unit)", () => {
  for (const tool of RESTRICTED_TOOLS) {
    it(`denies ${tool} for role "teammate" with a sanitized event`, () => {
      withAdapter((adapter) => {
        const identity = buildIdentity(teammateExtra());
        const denial = enforceTeammateCapability({
          tool,
          identity,
          db: adapter.getDatabase()
        });

        expect(denial).not.toBeNull();
        expect(denial?.denied).toBe(true);
        expect(denial?.error_code).toBe(TEAMMATE_RESTRICTED_TOOL_ERROR_CODES[tool]);
        expect(typeof denial?.message).toBe("string");

        const rows = gateEvents(adapter, TEAMMATE_RESTRICTED_TOOL_ERROR_CODES[tool]);
        expect(rows).toHaveLength(1);
        expect(rows[0].teamId).toBeNull();
        const payload = JSON.parse(rows[0].payloadJson) as Record<string, unknown>;
        expect(payload).toMatchObject({
          error_code: TEAMMATE_RESTRICTED_TOOL_ERROR_CODES[tool],
          role: "teammate",
          tool,
          reason: "teammate_capability_boundary"
        });
        // D-02: no prompt/message/body text leaks into the denial event.
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain("prompt");
        expect(serialized).not.toContain("message");
        expect(serialized).not.toContain("body");
      });
    });

    it(`is a no-op for role "leader" on ${tool}`, () => {
      withAdapter((adapter) => {
        const identity = buildIdentity({
          sessionId: "leader-session",
          codexTeamMemberRole: "leader"
        });
        const denial = enforceTeammateCapability({
          tool,
          identity,
          db: adapter.getDatabase()
        });
        expect(denial).toBeNull();
        expect(gateEvents(adapter, TEAMMATE_RESTRICTED_TOOL_ERROR_CODES[tool])).toHaveLength(0);
      });
    });

    it(`is a no-op when no role is present on ${tool}`, () => {
      withAdapter((adapter) => {
        const identity = buildIdentity({ sessionId: "absent-role-session" });
        const denial = enforceTeammateCapability({
          tool,
          identity,
          db: adapter.getDatabase()
        });
        expect(denial).toBeNull();
        expect(gateEvents(adapter, TEAMMATE_RESTRICTED_TOOL_ERROR_CODES[tool])).toHaveLength(0);
      });
    });
  }

  it("maps the Agent tool to the existing agent_nested_teammate_rejected code", () => {
    expect(TEAMMATE_RESTRICTED_TOOL_ERROR_CODES.Agent).toBe(
      "agent_nested_teammate_rejected"
    );
  });
});

describe("teammate-role capability gate at the MCP handler boundary", () => {
  it("denies TeamCreate for a teammate-role caller and writes no team row", async () => {
    const payload = await callHandler(
      createTeamCreateHandler({ stateRoot, workspaceRoot }),
      { team_name: "Beta Team", description: "should be rejected" },
      teammateExtra()
    );

    expect(payload).toMatchObject({
      status: "error",
      error_code: "team_create_teammate_rejected"
    });
    expect(durableCounts()).toMatchObject({ teams: 0, members: 0, runs: 0 });
  });

  it("denies TeamDelete for a teammate-role caller", async () => {
    const payload = await callHandler(
      createTeamDeleteHandler({ stateRoot, workspaceRoot }),
      { team_name: "alpha-team", reason: "should be rejected" },
      teammateExtra()
    );

    expect(payload).toMatchObject({
      status: "error",
      error_code: "team_delete_teammate_rejected"
    });
  });

  it("denies TeamMerge for a teammate-role caller and writes no run row", async () => {
    const payload = await callHandler(
      createTeamMergeHandler({ stateRoot, workspaceRoot }),
      { action: "merge", member_id: "teammate:alpha-team:builder" },
      teammateExtra()
    );

    expect(payload).toMatchObject({
      status: "error",
      error_code: "team_merge_teammate_rejected"
    });
    expect(durableCounts()).toMatchObject({ teams: 0, members: 0, runs: 0 });
  });

  it("denies Agent for a teammate-role caller and writes no member or run row", async () => {
    // Seed a team via a leader caller so a team exists; the teammate-role Agent
    // call must still be denied by the gate before any member/run write.
    await callHandler(
      createTeamCreateHandler({ stateRoot, workspaceRoot }),
      { team_name: "Alpha Team", description: "seed" },
      { sessionId: "leader-session" }
    );

    const payload = await callHandler(
      createAgentHandler({ stateRoot, workspaceRoot }),
      { name: "Reviewer", team_name: "alpha-team", prompt: "should be rejected" },
      teammateExtra()
    );

    expect(payload).toMatchObject({
      status: "error",
      error_code: "agent_nested_teammate_rejected"
    });
    // Exactly the leader from the seed; no teammate member, no run.
    expect(durableCounts()).toMatchObject({ teams: 1, members: 1, runs: 0 });
  });

  it("allows SendMessage for a teammate-role caller (not gated)", async () => {
    // Seed team + a teammate via the leader path.
    await callHandler(
      createTeamCreateHandler({ stateRoot, workspaceRoot }),
      { team_name: "Alpha Team", description: "seed" },
      { sessionId: "leader-session" }
    );
    const agentPayload = await callHandler(
      createAgentHandler({ stateRoot, workspaceRoot }),
      { name: "Builder", team_name: "alpha-team", prompt: "seed teammate" },
      { sessionId: "leader-session" }
    );
    const builderMemberId = (agentPayload.debug as { internal_member_id: string })
      .internal_member_id;

    const sendPayload = await callHandler(
      createSendMessageHandler({ stateRoot, workspaceRoot }),
      { team_name: "alpha-team", to: "team-lead@alpha-team", message: "hello lead" },
      {
        sessionId: "builder-session",
        codexTeamMemberId: builderMemberId,
        codexTeamMemberRole: "teammate"
      }
    );

    // Not a capability error: SendMessage proceeded and persisted.
    expect(sendPayload.persisted).toBe(true);
    expect(sendPayload).not.toMatchObject({
      error_code: "team_create_teammate_rejected"
    });
    expect(String(sendPayload.error_code ?? "")).not.toContain("teammate_rejected");
  });

  it("allows read-only TeamDiagnostics for a teammate-role caller (not gated)", () => {
    const payload = buildDiagnosticsPayload({
      stateRoot,
      workspaceRoot,
      callerMetadata: teammateExtra(),
      targetClaudeTools: ["TeamDiagnostics"]
    });

    const serialized = JSON.stringify(payload);
    // No capability denial code anywhere: the read-only surface ignores the role lock.
    expect(serialized).not.toContain("teammate_rejected");
    // The teammate role WAS observed, yet diagnostics still returned a normal payload.
    expect(payload.caller.observedMetadata.codexTeamMemberRole).toBe("teammate");
    expect(payload).toHaveProperty("tools");
    expect(payload).toHaveProperty("execution");
  });
});
