import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexTeamServer } from "../src/server.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { MEMBER_STATUSES, TABLE_NAMES } from "../src/state/schema.js";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;
let stateRoot: string;
let workspaceRoot: string;

interface MessageRow {
  message_id: string;
  team_id: string;
  sender_member_id: string | null;
  recipient_member_id: string | null;
  status: string;
  delivery_status: string;
  body_json: string;
}

interface EventRow {
  event_type: string;
  error_code: string | null;
  payload_json: string;
}

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-message-mcp-"));
}

beforeEach(async () => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "codex-team-message-test",
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

function readMessages(): MessageRow[] {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    return adapter
      .getDatabase()
      .prepare(`SELECT * FROM ${TABLE_NAMES.messages} ORDER BY created_at, message_id`)
      .all() as MessageRow[];
  } finally {
    adapter.close();
  }
}

function readEvents(): EventRow[] {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    return adapter
      .getDatabase()
      .prepare(
        `
          SELECT event_type, error_code, payload_json
          FROM ${TABLE_NAMES.events}
          ORDER BY created_at, event_id
        `
      )
      .all() as EventRow[];
  } finally {
    adapter.close();
  }
}

function setMemberStatus(memberId: string, status: string): void {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    adapter
      .getDatabase()
      .prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`)
      .run(status, memberId);
  } finally {
    adapter.close();
  }
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

function expectSanitizedEvents(rows: EventRow[]): void {
  const serialized = JSON.stringify(rows.map((row) => JSON.parse(row.payload_json)));

  expect(serialized).not.toContain("payload_json");
  expect(serialized).not.toContain("message");
  expect(serialized).not.toContain("body");
  expect(serialized).not.toContain("prompt");
  expect(serialized).not.toContain("notes");
  expect(serialized).not.toContain("description");
}

function expectSanitizedValidationEvent(errorCode: string): void {
  const validationEvents = readEvents().filter(
    (event) =>
      event.event_type === "tool_validation_failed" && event.error_code === errorCode
  );
  expect(validationEvents).toHaveLength(1);
  const serialized = JSON.stringify(
    validationEvents.map((event) => JSON.parse(event.payload_json))
  );

  expect(serialized).not.toContain("Sensitive implementation details");
  expect(serialized).not.toContain("body");
  expect(serialized).not.toContain("prompt");
  expect(serialized).not.toContain("notes");
  expect(serialized).not.toContain("description");
}

describe("SendMessage MCP handler", () => {
  it("sends through the active team path and reports backend_unavailable for scheduled recipients", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP SendMessage active path test"
    });
    const teammate = await callTool("Agent", {
      name: "Builder",
      prompt: "Create a scheduled TeamMate for message delivery"
    });

    const payload = await callTool("SendMessage", {
      to: "Builder",
      summary: "MCP active SendMessage",
      message: {
        type: "shutdown_request",
        reason: "Test active team SendMessage"
      }
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "backend_unavailable",
      message_id: expect.stringMatching(/^message:/),
      team_name: "alpha-team",
      sender: {
        teammate_id: "team-lead@alpha-team"
      },
      recipient: {
        teammate_id: "builder@alpha-team"
      },
      recipient_status: MEMBER_STATUSES.scheduled,
      persisted: true,
      delivery_status: "backend_unavailable",
      backend: {
        last_error: expect.stringContaining("unsupported")
      }
    });
    expect(payload.recipient).toMatchObject({
      member_id: String((teammate.debug as Record<string, unknown>).internal_member_id)
    });
    expectNoFakeBackendFields(payload);
    expect(readMessages()).toEqual([
      expect.objectContaining({
        message_id: payload.message_id,
        status: "queued",
        delivery_status: "queued_while_idle"
      })
    ]);
  });

  it("sends through explicit team_name and returns queued_for_next_turn for running recipients", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP SendMessage explicit path test"
    });
    const teammate = await callTool("Agent", {
      name: "Runner",
      team_name: "alpha-team",
      prompt: "Create a running recipient for explicit SendMessage"
    });
    const memberId = String((teammate.debug as Record<string, unknown>).internal_member_id);
    setMemberStatus(memberId, MEMBER_STATUSES.running);

    const payload = await callTool("SendMessage", {
      team_name: "Alpha Team",
      to: "runner@alpha-team",
      message: "Please consume this on the next turn"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "queued_for_next_turn",
      message_id: expect.stringMatching(/^message:/),
      team_name: "alpha-team",
      recipient: {
        member_id: memberId,
        teammate_id: "runner@alpha-team"
      },
      recipient_status: MEMBER_STATUSES.running,
      persisted: true,
      delivery_status: "queued_for_next_turn",
      backend: {
        limitation: expect.stringContaining("unsupported")
      }
    });
    expectNoFakeBackendFields(payload);
    expect(readMessages()).toHaveLength(1);
  });

  it("records sanitized audit events for missing recipients and broadcast_unsupported_in_v1", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "MCP SendMessage invalid routing test"
    });
    await callTool("Agent", {
      name: "Builder",
      prompt: "Create a scheduled TeamMate for invalid routing checks"
    });

    const missing = await callTool("SendMessage", {
      to: "Ghost",
      message: "This missing recipient body must not appear in events"
    });
    const broadcast = await callTool("SendMessage", {
      to: "*",
      message: "This broadcast body must not appear in events"
    });

    expect(missing).toMatchObject({
      implemented_now: true,
      status: "missing_recipient",
      persisted: false
    });
    expect(broadcast).toMatchObject({
      implemented_now: true,
      status: "broadcast_unsupported_in_v1",
      persisted: false,
      delivery_status: "broadcast_unsupported_in_v1"
    });
    expect(readMessages()).toHaveLength(0);
    const failureEvents = readEvents().filter((event) =>
      ["missing_recipient", "broadcast_unsupported_in_v1"].includes(
        event.error_code ?? ""
      )
    );
    expect(failureEvents).toHaveLength(2);
    expectSanitizedEvents(failureEvents);
  });

  it("rejects blank team_name through sanitized validation", async () => {
    const payload = await callTool("SendMessage", {
      team_name: "   ",
      to: "Builder",
      message: "Sensitive implementation details must not leak"
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "send_message_validation_failed"
    });
    expect(String(payload.message)).toContain("team_name");
    expectSanitizedValidationEvent("send_message_validation_failed");
  });
});
