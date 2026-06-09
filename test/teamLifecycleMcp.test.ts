import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexTeamServer } from "../src/server.js";
import { FALLBACK_CALLER_KEY } from "../src/context/caller.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../src/state/schema.js";
import {
  createTeamCreateHandler,
  createTeamDeleteHandler
} from "../src/tools/teamHandlers.js";
import { teamCreateSchema } from "../src/tools/schemas.js";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;
let stateRoot: string;
let workspaceRoot: string;

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-mcp-"));
}

beforeEach(async () => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "codex-team-test",
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

async function callLifecycleHandlerWithExtra(
  name: "TeamCreate" | "TeamDelete",
  args: Record<string, unknown>,
  extra: unknown
) {
  const handler =
    name === "TeamCreate"
      ? createTeamCreateHandler({ stateRoot, workspaceRoot })
      : createTeamDeleteHandler({ stateRoot, workspaceRoot });
  const result = await handler(args, extra);
  const first = result.content[0];
  expect(first?.type).toBe("text");

  return JSON.parse(first?.type === "text" ? first.text : "{}") as Record<
    string,
    unknown
  >;
}

function readToolValidationFailureEvent() {
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
          LIMIT 1
        `
      )
      .get(EVENT_TYPES.toolValidationFailed) as
      | {
          teamId: string | null;
          workspaceRoot: string;
          actorCallerKey: string;
          eventType: string;
          errorCode: string;
          payloadJson: string;
        }
      | undefined;
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

function readLeaderMember(teamId: string) {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    return adapter
      .getDatabase()
      .prepare(
        `
          SELECT member_id AS memberId, model_hint AS modelHint
          FROM ${TABLE_NAMES.members}
          WHERE team_id = ?
            AND role = 'leader'
          LIMIT 1
        `
      )
      .get(teamId) as
      | {
          memberId: string;
          modelHint: string | null;
        }
      | undefined;
  } finally {
    adapter.close();
  }
}

describe("Team lifecycle MCP handlers", () => {
  it("creates durable teams through MCP TeamCreate", async () => {
    const payload = await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Build the compatibility layer",
      agent_type: "planner"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      team_name: "alpha-team",
      state_path: stateRoot,
      lead_agent_id: "team-lead@alpha-team",
      status: "created",
      active_binding: {
        workspace_root: path.resolve(workspaceRoot),
        caller_key: FALLBACK_CALLER_KEY,
        fallback_used: true
      }
    });
    expect(payload.active_binding).toHaveProperty("binding_key");
    expect(payload.active_binding).toHaveProperty("team_id");
  });

  it("exposes model in TeamCreate schema and stores it as the leader model hint", async () => {
    expect(teamCreateSchema.model).toBeDefined();

    const payload = await callTool("TeamCreate", {
      team_name: "Model Team",
      model: "gpt-5.1"
    });
    const activeBinding = payload.active_binding as Record<string, unknown>;
    const teamId = String(activeBinding.team_id);

    expect(readLeaderMember(teamId)).toMatchObject({
      memberId: `leader:${teamId}`,
      modelHint: "gpt-5.1"
    });
  });

  it("generates a unique canonical team name for MCP TeamCreate conflicts", async () => {
    await callTool("TeamCreate", { team_name: "Alpha Team" });
    const payload = await callTool("TeamCreate", { team_name: "Alpha Team" });

    expect(payload).toMatchObject({
      implemented_now: true,
      team_name: "alpha-team-2",
      lead_agent_id: "team-lead@alpha-team-2",
      status: "created"
    });
  });

  it("archives teams by explicit name and by omitted active binding", async () => {
    const alpha = await callTool("TeamCreate", { team_name: "Alpha Team" });
    const explicitArchive = await callTool("TeamDelete", {
      team_name: alpha.team_name,
      reason: "Done"
    });

    expect(explicitArchive).toMatchObject({
      implemented_now: true,
      status: "archived",
      team_name: "alpha-team"
    });

    await callTool("TeamCreate", { team_name: "Beta Team" });
    const activeArchive = await callTool("TeamDelete", {
      reason: "Active team done"
    });

    expect(activeArchive).toMatchObject({
      implemented_now: true,
      status: "archived",
      team_name: "beta-team"
    });
  });

  it("archives an MCP-created team when TeamDelete receives the original requested name", async () => {
    await callTool("TeamCreate", { team_name: "Alpha Team" });
    const archive = await callTool("TeamDelete", {
      team_name: "Alpha Team",
      reason: "Done"
    });

    expect(archive).toMatchObject({
      implemented_now: true,
      status: "archived",
      team_name: "alpha-team"
    });
  });

  it("returns durable validation errors and records teamless audit events", async () => {
    const payload = await callTool("TeamCreate", { team_name: "   " });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "team_create_validation_failed"
    });
    expect(String(payload.message)).toContain("team_name");

    const event = readToolValidationFailureEvent();
    expect(event).toMatchObject({
      teamId: null,
      workspaceRoot: path.resolve(workspaceRoot),
      actorCallerKey: FALLBACK_CALLER_KEY,
      eventType: EVENT_TYPES.toolValidationFailed,
      errorCode: "team_create_validation_failed"
    });

    const eventPayload = JSON.parse(event?.payloadJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(eventPayload).toMatchObject({
      fallback_used: true,
      validation: expect.any(Object)
    });
    expect(eventPayload).not.toHaveProperty("prompt");
    expect(eventPayload).not.toHaveProperty("message");
    expect(eventPayload).not.toHaveProperty("body");
  });

  it("preserves resolver-specific TeamDelete error codes", async () => {
    const payload = await callTool("TeamDelete", {});

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "no_active_team"
    });
    expect(payload.error_code).not.toBe("team_delete_failed");
  });

  it("rejects blank explicit TeamDelete without archiving the active team", async () => {
    await callTool("TeamCreate", { team_name: "Blank Delete Team" });

    const payload = await callTool("TeamDelete", { team_name: "   " });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "team_delete_validation_failed"
    });
    expect(String(payload.message)).toContain("team_name");

    const validationEvents = readToolValidationFailureEvents(
      "team_delete_validation_failed"
    );
    expect(validationEvents).toHaveLength(1);
    expect(validationEvents[0]).toMatchObject({
      teamId: null,
      workspaceRoot: path.resolve(workspaceRoot),
      actorCallerKey: FALLBACK_CALLER_KEY,
      eventType: EVENT_TYPES.toolValidationFailed,
      errorCode: "team_delete_validation_failed"
    });

    const eventPayload = JSON.parse(validationEvents[0]?.payloadJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(eventPayload).toMatchObject({
      error_code: "team_delete_validation_failed",
      fallback_used: true,
      validation: expect.any(Object)
    });
    expect(eventPayload).not.toHaveProperty("prompt");
    expect(eventPayload).not.toHaveProperty("message");
    expect(eventPayload).not.toHaveProperty("body");

    const archive = await callTool("TeamDelete", { reason: "safe omitted delete" });

    expect(archive).toMatchObject({
      implemented_now: true,
      status: "archived",
      team_name: "blank-delete-team"
    });
  });

  it("rejects unsupported-character TeamDelete names with sanitized audit events", async () => {
    await callTool("TeamCreate", { team_name: "Unsupported Delete Team" });

    const payload = await callTool("TeamDelete", { team_name: "!!!" });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "team_delete_validation_failed"
    });
    expect(String(payload.message)).toContain("team_name");

    const validationEvents = readToolValidationFailureEvents(
      "team_delete_validation_failed"
    );
    expect(validationEvents).toHaveLength(1);
    expect(validationEvents[0]).toMatchObject({
      teamId: null,
      workspaceRoot: path.resolve(workspaceRoot),
      actorCallerKey: FALLBACK_CALLER_KEY,
      eventType: EVENT_TYPES.toolValidationFailed,
      errorCode: "team_delete_validation_failed"
    });

    const eventPayload = JSON.parse(validationEvents[0]?.payloadJson ?? "{}") as Record<
      string,
      unknown
    >;
    expect(eventPayload).toMatchObject({
      error_code: "team_delete_validation_failed",
      fallback_used: true,
      validation: expect.any(Object)
    });
    expect(eventPayload).not.toHaveProperty("prompt");
    expect(eventPayload).not.toHaveProperty("message");
    expect(eventPayload).not.toHaveProperty("body");

    const archive = await callTool("TeamDelete", { reason: "safe omitted delete" });

    expect(archive).toMatchObject({
      implemented_now: true,
      status: "archived",
      team_name: "unsupported-delete-team"
    });
  });

  it("uses fallback binding for requestId-only lifecycle calls even when requestId changes", async () => {
    const created = await callLifecycleHandlerWithExtra(
      "TeamCreate",
      { team_name: "Request Only Team" },
      { requestId: "req-1" }
    );

    expect(created).toMatchObject({
      implemented_now: true,
      team_name: "request-only-team",
      status: "created",
      active_binding: {
        caller_key: FALLBACK_CALLER_KEY,
        fallback_used: true
      }
    });

    const archive = await callLifecycleHandlerWithExtra(
      "TeamDelete",
      { reason: "done" },
      { requestId: "req-2" }
    );

    expect(archive).toMatchObject({
      implemented_now: true,
      status: "archived",
      team_name: "request-only-team"
    });
  });

  it("does not persist clientName-only metadata as durable lifecycle caller identity", async () => {
    const payload = await callLifecycleHandlerWithExtra(
      "TeamCreate",
      { team_name: "Client Only Team" },
      { clientName: "codex" }
    );

    expect(payload).toMatchObject({
      implemented_now: true,
      team_name: "client-only-team",
      status: "created",
      active_binding: {
        caller_key: FALLBACK_CALLER_KEY,
        fallback_used: true
      }
    });
    expect(JSON.stringify(payload)).not.toContain("codex-team:clientName:codex");
  });

  it("returns ambiguous_active_team for omitted operations over multiple fallback-created teams", async () => {
    await callLifecycleHandlerWithExtra(
      "TeamCreate",
      { team_name: "Fallback One" },
      { requestId: "req-1" }
    );
    await callLifecycleHandlerWithExtra(
      "TeamCreate",
      { team_name: "Fallback Two" },
      { clientName: "codex" }
    );

    const payload = await callLifecycleHandlerWithExtra(
      "TeamDelete",
      {},
      { requestId: "req-3" }
    );

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "ambiguous_active_team"
    });
  });

  it("reports Phase 5 MCP tools and diagnostics as implemented with unsupported default backend", async () => {
    await callTool("TeamCreate", { team_name: "Diagnostics Backend Team" });
    await callTool("Agent", {
      name: "Observer",
      mode: "read",
      prompt: "Review lifecycle status",
      description: "Read lifecycle status"
    });

    const payload = await callTool("TeamDiagnostics", {});
    const mapping = payload.tools as {
      mapping: Array<{ codexToolName: string; status: string }>;
    };
    const statusByTool = Object.fromEntries(
      mapping.mapping.map((tool) => [tool.codexToolName, tool.status])
    );

    expect(statusByTool).toMatchObject({
      SendMessage: "implemented",
      TaskCreate: "implemented",
      TaskUpdate: "implemented",
      TaskList: "implemented",
      TaskGet: "implemented",
      TeamDiagnostics: "implemented"
    });
    expect(payload).toMatchObject({
      phase: "05-lifecycle-isolation-and-status",
      execution: {
        backend: "none",
        status: "scheduled_only",
        backend_status: "not_started",
        teammateExecutionImplemented: false,
        limitation: expect.stringContaining("unsupported")
      },
      lifecycleSummary: expect.any(Object),
      runSummary: expect.any(Object),
      workspaceReviewSummary: expect.any(Object),
      reconciliationSummary: expect.any(Object)
    });
    expect(payload.execution).not.toHaveProperty("backend_run_id");
    expect(payload.execution).not.toHaveProperty("thread_id");
    expect(payload.execution).not.toHaveProperty("process_id");
    expect(JSON.stringify(payload)).toContain("needs_review");
  });
});
