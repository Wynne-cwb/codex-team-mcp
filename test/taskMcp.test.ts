import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexTeamServer } from "../src/server.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, MEMBER_STATUSES, TABLE_NAMES } from "../src/state/schema.js";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;
let stateRoot: string;
let workspaceRoot: string;

interface EventRow {
  event_type: string;
  error_code: string | null;
  payload_json: string;
}

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-task-mcp-"));
}

beforeEach(async () => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "codex-team-task-test",
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

function expectSanitizedValidationEvent(errorCode: string): void {
  const validationEvents = readEvents().filter(
    (event) =>
      event.event_type === EVENT_TYPES.toolValidationFailed &&
      event.error_code === errorCode
  );
  expect(validationEvents).toHaveLength(1);
  const serialized = JSON.stringify(
    validationEvents.map((event) => JSON.parse(event.payload_json))
  );

  expect(serialized).not.toContain("payload_json");
  expect(serialized).not.toContain("message");
  expect(serialized).not.toContain("body");
  expect(serialized).not.toContain("prompt");
  expect(serialized).not.toContain("notes");
  expect(serialized).not.toContain("description");
  expect(serialized).not.toContain("Sensitive implementation details");
}

describe("Task MCP handlers", () => {
  it("creates updates lists and gets tasks through the active team path", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Task MCP active team test"
    });
    const teammate = await callTool("Agent", {
      name: "Builder",
      prompt: "Create a scheduled TeamMate for TaskCreate owner"
    });
    const memberId = String((teammate.debug as Record<string, unknown>).internal_member_id);
    setMemberStatus(memberId, MEMBER_STATUSES.idle);

    const created = await callTool("TaskCreate", {
      subject: "Implement task MCP path",
      description: "Create a team-scoped task",
      active_form: "Drafting MCP task",
      owner: "Builder",
      metadata: { priority: "high" }
    });

    expect(created).toMatchObject({
      implemented_now: true,
      status: "created",
      task_id: expect.stringMatching(/^task:/),
      public_task_id: "task-1",
      team_name: "alpha-team",
      task: {
        active_form: "Drafting MCP task"
      },
      assignment_notification: {
        persisted: true,
        delivery_status: "backend_unavailable",
        recipient: {
          member_id: memberId,
          teammate_id: "builder@alpha-team"
        }
      }
    });

    const updated = await callTool("TaskUpdate", {
      taskId: "task-1",
      status: "in_progress",
      active_form: "Reviewing MCP task",
      notes: "Started work",
      metadata: { reviewed: false }
    });
    const listed = await callTool("TaskList", {
      status: "in_progress",
      owner: "Builder"
    });
    const detail = await callTool("TaskGet", {
      taskId: "task-1"
    });

    expect(updated).toMatchObject({
      implemented_now: true,
      status: "updated",
      task: {
        status: "in_progress",
        activeForm: "Reviewing MCP task",
        active_form: "Reviewing MCP task",
        metadata: {
          priority: "high",
          reviewed: false
        }
      }
    });
    expect(listed).toMatchObject({
      implemented_now: true,
      status: "listed",
      tasks: [
        {
          task_id: "task-1",
          subject: "Implement task MCP path",
          status: "in_progress",
          owner: {
            teammate_id: "builder@alpha-team"
          }
        }
      ]
    });
    expect(detail).toMatchObject({
      implemented_now: true,
      status: "found",
      task: {
        public_task_id: "task-1",
        history: expect.arrayContaining([
          expect.objectContaining({ event_type: "task_note_added" })
        ])
      }
    });
  });

  it("supports explicit team_name task_id aliases and owner resolution by public ID", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Task MCP explicit path test"
    });
    await callTool("Agent", {
      name: "Reviewer",
      team_name: "alpha-team",
      prompt: "Create a reviewer TeamMate"
    });
    const created = await callTool("TaskCreate", {
      team_name: "Alpha Team",
      subject: "Explicit task",
      owner: "reviewer@alpha-team"
    });
    const blockedTask = await callTool("TaskCreate", {
      team_name: "Alpha Team",
      subject: "Task this one blocks"
    });
    const blockerTask = await callTool("TaskCreate", {
      team_name: "Alpha Team",
      subject: "Task blocking this one"
    });
    const updated = await callTool("TaskUpdate", {
      team_name: "alpha-team",
      task_id: created.public_task_id,
      addBlocks: [blockedTask.public_task_id],
      addBlockedBy: [blockerTask.public_task_id],
      metadata: { path: "task_id alias" }
    });
    const detail = await callTool("TaskGet", {
      team_name: "alpha-team",
      task_id: created.task_id
    });

    expect(created).toMatchObject({
      implemented_now: true,
      status: "created",
      task_id: expect.stringMatching(/^task:/),
      public_task_id: "task-1",
      task: {
        owner: {
          teammate_id: "reviewer@alpha-team"
        }
      }
    });
    expect(updated).toMatchObject({
      implemented_now: true,
      status: "updated",
      task: {
        metadata: {
          path: "task_id alias"
        },
        dependencies: {
          blocks: [blockedTask.public_task_id],
          blockedBy: [blockerTask.public_task_id]
        }
      }
    });
    expect(detail).toMatchObject({
      implemented_now: true,
      status: "found",
      task: {
        task_id: created.task_id,
        public_task_id: created.public_task_id
      }
    });
  });

  it("rejects self-referential dependency updates", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Task MCP self dependency test"
    });
    const created = await callTool("TaskCreate", {
      team_name: "Alpha Team",
      subject: "Self dependency candidate"
    });

    const blocksSelf = await callTool("TaskUpdate", {
      team_name: "alpha-team",
      task_id: created.public_task_id,
      addBlocks: [created.public_task_id]
    });
    const blockedBySelf = await callTool("TaskUpdate", {
      team_name: "alpha-team",
      task_id: created.public_task_id,
      addBlockedBy: [created.task_id]
    });

    expect(blocksSelf).toMatchObject({
      implemented_now: true,
      status: "invalid_task_dependency",
      error_code: "invalid_task_dependency",
      task_id: created.task_id,
      persisted: false
    });
    expect(blockedBySelf).toMatchObject({
      implemented_now: true,
      status: "invalid_task_dependency",
      error_code: "invalid_task_dependency",
      task_id: created.task_id,
      persisted: false
    });
    const failureEvents = readEvents().filter(
      (event) => event.error_code === "invalid_task_dependency"
    );
    expect(failureEvents).toHaveLength(2);
  });

  it("rejects blank team_name through sanitized validation", async () => {
    const createPayload = await callTool("TaskCreate", {
      team_name: "   ",
      subject: "Sensitive implementation details must not leak"
    });
    const updatePayload = await callTool("TaskUpdate", {
      team_name: "   ",
      taskId: "task-1",
      notes: "Sensitive implementation details must not leak"
    });
    const listPayload = await callTool("TaskList", {
      team_name: "   "
    });
    const getPayload = await callTool("TaskGet", {
      team_name: "   ",
      taskId: "task-1"
    });

    expect(createPayload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "task_create_validation_failed"
    });
    expect(updatePayload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "task_update_validation_failed"
    });
    expect(listPayload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "task_list_validation_failed"
    });
    expect(getPayload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "task_get_validation_failed"
    });
    expect(String(createPayload.message)).toContain("team_name");
    expect(String(updatePayload.message)).toContain("team_name");
    expect(String(listPayload.message)).toContain("team_name");
    expect(String(getPayload.message)).toContain("team_name");
    expectSanitizedValidationEvent("task_create_validation_failed");
    expectSanitizedValidationEvent("task_update_validation_failed");
    expectSanitizedValidationEvent("task_list_validation_failed");
    expectSanitizedValidationEvent("task_get_validation_failed");
  });

  it("records sanitized validation errors for missing task identifiers", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Task MCP validation privacy test"
    });

    const payload = await callTool("TaskUpdate", {
      status: "completed",
      notes: "Sensitive implementation details must not leak",
      description: "Sensitive implementation details must not leak",
      metadata: {
        secret: "Sensitive implementation details must not leak"
      }
    });

    expect(payload).toMatchObject({
      implemented_now: true,
      status: "error",
      error_code: "task_update_validation_failed"
    });
    expect(String(payload.message)).toContain("taskId");
    expectSanitizedValidationEvent("task_update_validation_failed");
  });
});
