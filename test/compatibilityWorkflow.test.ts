import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexTeamServer } from "../src/server.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { TABLE_NAMES } from "../src/state/schema.js";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;
let stateRoot: string;
let workspaceRoot: string;

interface WorkflowRows {
  teams: Array<Record<string, unknown>>;
  activeBindings: Array<Record<string, unknown>>;
  members: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  taskEvents: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-compat-workflow-"));
}

async function openServer(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "codex-team-compat-workflow-test",
    version: "0.1.0"
  });
  server = createCodexTeamServer({
    stateRoot,
    workspaceRoot
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

beforeEach(async () => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");

  await openServer();
});

afterEach(async () => {
  await client.close();
  await server.close();
  rmSync(stateRoot, { recursive: true, force: true });
});

async function reopenServer(): Promise<void> {
  await client.close();
  await server.close();
  await openServer();
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
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

function readRows(): WorkflowRows {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    const db = adapter.getDatabase();

    return {
      teams: db.prepare(`SELECT * FROM ${TABLE_NAMES.teams}`).all() as Array<
        Record<string, unknown>
      >,
      activeBindings: db
        .prepare(`SELECT * FROM ${TABLE_NAMES.activeBindings}`)
        .all() as Array<Record<string, unknown>>,
      members: db
        .prepare(`SELECT * FROM ${TABLE_NAMES.members}`)
        .all() as Array<Record<string, unknown>>,
      runs: db.prepare(`SELECT * FROM ${TABLE_NAMES.runs}`).all() as Array<
        Record<string, unknown>
      >,
      messages: db
        .prepare(
          `
            SELECT message_id, status, delivery_status, body_json
            FROM ${TABLE_NAMES.messages}
            ORDER BY created_at, message_id
          `
        )
        .all() as Array<Record<string, unknown>>,
      tasks: db
        .prepare(`SELECT * FROM ${TABLE_NAMES.tasks}`)
        .all() as Array<Record<string, unknown>>,
      taskEvents: db
        .prepare(
          `
            SELECT event_type, task_id
            FROM ${TABLE_NAMES.taskEvents}
            ORDER BY created_at, task_event_id
          `
        )
        .all() as Array<Record<string, unknown>>,
      events: db
        .prepare(
          `
            SELECT event_type, error_code
            FROM ${TABLE_NAMES.events}
            ORDER BY created_at, event_id
          `
        )
        .all() as Array<Record<string, unknown>>
    };
  } finally {
    adapter.close();
  }
}

function nonLeaderMembers(rows: WorkflowRows): Array<Record<string, unknown>> {
  return rows.members.filter((row) => row.role !== "leader");
}

function statusByTool(payload: Record<string, unknown>): Record<string, string> {
  const tools = payload.tools as {
    mapping: Array<{ codexToolName: string; status: string }>;
  };

  return Object.fromEntries(
    tools.mapping.map((tool) => [tool.codexToolName, tool.status])
  );
}

describe("fixture-backed Claude Team compatibility workflow", () => {
  it("runs the synthetic workflow through MCP-visible compatibility tools", async () => {
    const fixturePath = path.join(
      process.cwd(),
      "test/fixtures/synthetic-claude-team-workflow.md"
    );
    const fixture = readFileSync(fixturePath, "utf8");

    for (const requiredText of [
      "TeamCreate",
      "Agent",
      "SendMessage",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TeamDiagnostics",
      "Agent Team compatibility layer unavailable",
      "Do not silently substitute generic subagents"
    ]) {
      expect(fixture).toContain(requiredText);
    }

    const team = await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Phase 6 compatibility workflow"
    });

    expect(team).toMatchObject({
      implemented_now: true,
      team_name: "alpha-team",
      lead_agent_id: "team-lead@alpha-team",
      status: "created"
    });

    const builder = await callTool("Agent", {
      name: "Builder",
      prompt: "Review the fixture and report status",
      description: "Create the Builder TeamMate",
      mode: "read"
    });

    expect(builder).toMatchObject({
      implemented_now: true,
      status: "scheduled",
      teammate_id: "builder@alpha-team",
      team_name: "alpha-team"
    });
    expect(String(builder.teammate_id)).toMatch(/^builder@alpha-team$/);

    const afterBuilder = readRows();
    expect(nonLeaderMembers(afterBuilder)).toHaveLength(1);
    expect(afterBuilder.runs).toHaveLength(1);

    const ordinary = await callTool("Agent", {
      prompt: "Inspect only",
      description: "ordinary route"
    });

    expect(ordinary).toMatchObject({
      implemented_now: true,
      status: "ordinary_subagent_path",
      not_handled_by_team_layer: true
    });

    const afterOrdinary = readRows();
    expect(nonLeaderMembers(afterOrdinary)).toHaveLength(
      nonLeaderMembers(afterBuilder).length
    );
    expect(afterOrdinary.runs).toHaveLength(afterBuilder.runs.length);
    expect(afterOrdinary.messages).toHaveLength(afterBuilder.messages.length);

    const message = await callTool("SendMessage", {
      to: "Builder",
      summary: "Compatibility workflow status check",
      message: "Please review the synthetic workflow fixture."
    });

    expect(message).toMatchObject({
      implemented_now: true,
      status: "backend_unavailable",
      team_name: "alpha-team",
      persisted: true,
      delivery_status: "backend_unavailable"
    });

    const afterMessage = readRows();
    expect(afterMessage.messages).toEqual([
      expect.objectContaining({
        status: "queued",
        delivery_status: expect.stringMatching(
          /queued_while_idle|queued_for_next_turn/
        )
      })
    ]);

    const createdTask = await callTool("TaskCreate", {
      subject: "Validate compatibility workflow",
      owner: "Builder",
      metadata: { phase: "06", priority: "high" }
    });

    expect(createdTask).toMatchObject({
      implemented_now: true,
      status: "created",
      public_task_id: "task-1",
      assignment_notification: {
        persisted: true
      }
    });

    const updatedTask = await callTool("TaskUpdate", {
      taskId: "task-1",
      status: "in_progress",
      notes: "Started validation",
      metadata: { reviewed: false }
    });

    expect(updatedTask).toMatchObject({
      implemented_now: true,
      status: "updated",
      task: {
        status: "in_progress",
        metadata: {
          phase: "06",
          priority: "high",
          reviewed: false
        }
      }
    });

    const listedTasks = await callTool("TaskList", {
      status: "in_progress",
      owner: "Builder"
    });

    expect(listedTasks).toMatchObject({
      implemented_now: true,
      status: "listed",
      tasks: [
        {
          task_id: "task-1",
          public_task_id: "task-1"
        }
      ]
    });

    const taskDetail = await callTool("TaskGet", {
      taskId: "task-1"
    });

    expect(taskDetail).toMatchObject({
      implemented_now: true,
      status: "found",
      team_name: "alpha-team",
      task: {
        public_task_id: "task-1",
        history: expect.arrayContaining([
          expect.objectContaining({ event_type: "task_created" }),
          expect.objectContaining({ event_type: "task_status_updated" }),
          expect.objectContaining({ event_type: "task_note_added" })
        ])
      }
    });

    await reopenServer();

    const restartedTaskDetail = await callTool("TaskGet", {
      taskId: "task-1"
    });

    expect(restartedTaskDetail).toMatchObject({
      implemented_now: true,
      status: "found",
      team_name: "alpha-team",
      task: {
        public_task_id: "task-1"
      }
    });

    const diagnostics = await callTool("TeamDiagnostics", {});
    const diagnosticsJson = JSON.stringify(diagnostics);

    expect(diagnostics.state).toMatchObject({
      activeBinding: {
        team_name: "alpha-team"
      },
      messageSummary: {
        total: expect.any(Number),
        queued: expect.any(Number)
      },
      taskSummary: {
        total: 1,
        by_status: {
          in_progress: 1
        }
      }
    });
    expect(diagnostics).toMatchObject({
      execution: {
        backend: "none",
        status: "scheduled_only",
        backend_status: "not_started",
        limitation: expect.stringContaining("unsupported")
      },
      lifecycleSummary: expect.any(Object),
      runSummary: expect.any(Object),
      workspaceReviewSummary: expect.any(Object),
      reconciliationSummary: expect.any(Object)
    });
    expect(statusByTool(diagnostics)).toMatchObject({
      TeamCreate: "implemented",
      Agent: "implemented",
      SendMessage: "implemented",
      TaskCreate: "implemented",
      TaskUpdate: "implemented",
      TaskList: "implemented",
      TaskGet: "implemented",
      TeamDiagnostics: "implemented"
    });
    expect(diagnosticsJson).toContain("backend-dependent");
    expect(diagnosticsJson).not.toContain("Review the fixture and report status");

    const finalRows = readRows();
    expect(finalRows.teams.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.activeBindings.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.members.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.runs.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.messages.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.tasks.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.taskEvents.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.events.length).toBeGreaterThanOrEqual(1);
    expect(finalRows.events.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "team_created",
        "teammate_created",
        "message_sent",
        "task_created",
        "task_updated"
      ])
    );
  });
});
