import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexTeamServer } from "../src/server.js";
import { createAgentHandler } from "../src/tools/agentHandler.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../src/state/schema.js";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;
let stateRoot: string;
let workspaceRoot: string;

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-agent-mcp-"));
}

beforeEach(async () => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "codex-team-agent-test",
    version: "0.1.0"
  });
  server = createCodexTeamServer({
    stateRoot,
    workspaceRoot
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  rmSync(stateRoot, { recursive: true, force: true });
});

async function callTool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({
    name,
    arguments: args
  });

  expect(result.isError).not.toBe(true);
  expect("content" in result).toBe(true);
  const content = "content" in result ? result.content : [];
  const first = content[0];
  expect(first?.type).toBe("text");

  return JSON.parse(first?.type === "text" ? first.text : "{}") as Record<
    string,
    unknown
  >;
}

async function callAgentHandlerWithExtra(
  args: Record<string, unknown>,
  extra: unknown
) {
  const handler = createAgentHandler({ stateRoot, workspaceRoot });
  const result = await handler(args, extra);
  const first = result.content[0];
  expect(first?.type).toBe("text");

  return JSON.parse(first?.type === "text" ? first.text : "{}") as Record<
    string,
    unknown
  >;
}

function readDurableCounts(): {
  leaderMembers: number;
  nonLeaderMembers: number;
  runs: number;
} {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    const db = adapter.getDatabase();
    const leaderMembers = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ${TABLE_NAMES.members}
         WHERE role = 'leader'`
      )
      .get() as { count: number };
    const nonLeaderMembers = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM ${TABLE_NAMES.members}
         WHERE role != 'leader'`
      )
      .get() as { count: number };
    const runs = db
      .prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAMES.runs}`)
      .get() as { count: number };

    return {
      leaderMembers: leaderMembers.count,
      nonLeaderMembers: nonLeaderMembers.count,
      runs: runs.count
    };
  } finally {
    adapter.close();
  }
}

function readToolValidationFailureEvents(errorCode: string) {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    return adapter
      .getDatabase()
      .prepare(
        `
          SELECT
            team_id AS teamId,
            workspace_root AS workspaceRoot,
            actor_caller_key AS actorCallerKey,
            event_type AS eventType,
            error_code AS errorCode,
            payload_json AS payloadJson
          FROM ${TABLE_NAMES.events}
          WHERE event_type = ?
            AND error_code = ?
          ORDER BY created_at ASC
        `
      )
      .all(EVENT_TYPES.toolValidationFailed, errorCode) as Array<{
      teamId: string | null;
      workspaceRoot: string;
      actorCallerKey: string;
      eventType: string;
      errorCode: string;
      payloadJson: string;
    }>;
  } finally {
    adapter.close();
  }
}

function expectScheduledTeamMatePayload(payload: Record<string, unknown>): void {
  expect(payload).toMatchObject({
    implemented_now: true,
    status: "scheduled",
    teammate_id: "builder@alpha-team",
    team_name: "alpha-team",
    display_name: "Builder",
    run_id: expect.stringMatching(/^run:/),
    backend: {
      status: "not_started",
      backend: "none",
      execution_available: false
    },
    debug: {
      internal_member_id: expect.stringMatching(/^teammate:/)
    }
  });
}

function expectNoFakeBackendProcessFields(payload: Record<string, unknown>): void {
  expect(payload).not.toHaveProperty("process_id");
  expect(payload).not.toHaveProperty("thread_id");
  expect(payload).not.toHaveProperty("pane_id");
  expect(payload).not.toHaveProperty("tmux_session");
  expect(payload).not.toHaveProperty("workspace_path");
}

describe("Agent MCP handler", () => {
  it("creates a TeamMate through Agent after TeamCreate active binding", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP Agent active binding test"
    });

    const payload = await callTool("Agent", {
      name: "Builder",
      mode: "write",
      prompt: "Build the durable Agent service",
      description: "Create the scheduled TeamMate",
      model: "gpt-5",
      agent_type: "developer",
      subagent_type: "implementation",
      run_in_background: true,
      isolation: "worktree",
      cwd: workspaceRoot
    });

    expectScheduledTeamMatePayload(payload);
    expect(payload.backend).toMatchObject({
      teammate_execution_implemented: false
    });
    expect(payload.debug).toMatchObject({
      team_resolution: "active_binding"
    });
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 1,
      nonLeaderMembers: 1,
      runs: 1
    });
  });

  it("creates a TeamMate through Agent with explicit team_name", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP Agent explicit team test"
    });

    const payload = await callTool("Agent", {
      name: "Builder",
      team_name: "Alpha Team",
      prompt: "Use explicit team name",
      description: "Explicit team path"
    });

    expectScheduledTeamMatePayload(payload);
    expect(payload.debug).toMatchObject({
      team_resolution: "explicit"
    });
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 1,
      nonLeaderMembers: 1,
      runs: 1
    });
  });

  it("returns ordinary_subagent_path when Agent omits name", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP Agent ordinary path test"
    });

    const payload = await callTool("Agent", {
      prompt: "Inspect only",
      description: "ordinary route"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "ordinary_subagent_path",
      not_handled_by_team_layer: true,
      reason: "missing_teammate_name"
    });
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 1,
      nonLeaderMembers: 0,
      runs: 0
    });
  });

  it("returns resolver error when named Agent has no active or explicit team", async () => {
    const payload = await callTool("Agent", {
      name: "Builder",
      prompt: "No active team exists"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "no_active_team"
    });
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 0,
      nonLeaderMembers: 0,
      runs: 0
    });
  });

  it("rejects duplicate TeamMate names through MCP", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP duplicate Agent test"
    });
    await callTool("Agent", {
      name: "Builder",
      team_name: "alpha-team",
      prompt: "First builder"
    });

    const payload = await callTool("Agent", {
      name: "builder",
      team_name: "alpha-team",
      prompt: "Duplicate builder"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "agent_duplicate_teammate_name",
      team_name: "alpha-team",
      teammate_id: "builder@alpha-team"
    });
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 1,
      nonLeaderMembers: 1,
      runs: 1
    });
  });

  it("rejects role-only TeamMate metadata through MCP without member or run writes", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP role-only nested Agent test"
    });

    const payload = await callAgentHandlerWithExtra(
      {
        name: "Reviewer",
        team_name: "alpha-team",
        prompt: "Role-only nested addressable creation should fail"
      },
      {
        sessionId: "role-only-teammate-session",
        codexTeamMemberRole: "teammate"
      }
    );

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "agent_nested_teammate_rejected",
      team_name: "alpha-team"
    });
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 1,
      nonLeaderMembers: 0,
      runs: 0
    });
  });

  it("rejects blank explicit Agent team_name as a sanitized validation failure", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP blank Agent team_name validation test"
    });

    const payload = await callTool("Agent", {
      name: "Builder",
      team_name: "   ",
      prompt: "This prompt must not be audited"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "agent_validation_failed"
    });
    expect(String(payload.message)).toContain("team_name");
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 1,
      nonLeaderMembers: 0,
      runs: 0
    });

    const validationEvents = readToolValidationFailureEvents(
      "agent_validation_failed"
    );
    expect(validationEvents).toHaveLength(1);
    expect(validationEvents[0]).toMatchObject({
      teamId: null,
      workspaceRoot: path.resolve(workspaceRoot),
      eventType: EVENT_TYPES.toolValidationFailed,
      errorCode: "agent_validation_failed"
    });

    const eventPayload = JSON.parse(validationEvents[0]?.payloadJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(eventPayload).toMatchObject({
      error_code: "agent_validation_failed",
      validation: expect.any(Object)
    });
    expect(eventPayload).not.toHaveProperty("prompt");
    expect(eventPayload).not.toHaveProperty("message");
    expect(eventPayload).not.toHaveProperty("body");
    expect(JSON.stringify(eventPayload)).not.toContain(
      "This prompt must not be audited"
    );
  });

  it("rejects unsupported-character explicit Agent team_name as a sanitized validation failure", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP unsupported Agent team_name validation test"
    });

    const payload = await callTool("Agent", {
      name: "Builder",
      team_name: "!!!",
      prompt: "This unsupported prompt must not be audited"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "agent_validation_failed"
    });
    expect(String(payload.message)).toContain("team_name");
    expect(readDurableCounts()).toMatchObject({
      leaderMembers: 1,
      nonLeaderMembers: 0,
      runs: 0
    });

    const validationEvents = readToolValidationFailureEvents(
      "agent_validation_failed"
    );
    expect(validationEvents).toHaveLength(1);
    expect(validationEvents[0]).toMatchObject({
      teamId: null,
      workspaceRoot: path.resolve(workspaceRoot),
      eventType: EVENT_TYPES.toolValidationFailed,
      errorCode: "agent_validation_failed"
    });

    const eventPayload = JSON.parse(validationEvents[0]?.payloadJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(eventPayload).toMatchObject({
      error_code: "agent_validation_failed",
      validation: expect.any(Object)
    });
    expect(eventPayload).not.toHaveProperty("prompt");
    expect(eventPayload).not.toHaveProperty("message");
    expect(eventPayload).not.toHaveProperty("body");
    expect(JSON.stringify(eventPayload)).not.toContain(
      "This unsupported prompt must not be audited"
    );
  });

  it("does not expose fake backend process fields", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP fake backend field protection"
    });

    const payload = await callTool("Agent", {
      name: "Builder",
      team_name: "alpha-team",
      prompt: "Protect backend fields"
    });

    expectScheduledTeamMatePayload(payload);
    expectNoFakeBackendProcessFields(payload);
    expect(JSON.stringify(payload)).not.toContain("process_id");
    expect(JSON.stringify(payload)).not.toContain("thread_id");
    expect(JSON.stringify(payload)).not.toContain("pane_id");
    expect(JSON.stringify(payload)).not.toContain("tmux_session");
    expect(JSON.stringify(payload)).not.toContain("workspace_path");
  });
});
