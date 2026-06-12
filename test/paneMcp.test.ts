import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendActionResult,
  ExecutionBackendDescription,
  ExecutionBackendReconcileResult,
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import { createCodexTeamServer } from "../src/server.js";
import {
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  TABLE_NAMES
} from "../src/state/schema.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { COMPATIBILITY_TOOLS, TARGET_CLAUDE_TOOLS } from "../src/tools/registry.js";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;
let stateRoot: string;
let workspaceRoot: string;
let fakePaneBackend: FakePaneExecutionBackend;

function createTempStateRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-team-pane-mcp-"));
}

class FakePaneExecutionBackend implements ExecutionBackend {
  readonly startCalls: ExecutionRunContext[] = [];
  readonly resumeCalls: Array<{
    context: ExecutionRunContext;
    trigger: ExecutionTrigger;
  }> = [];

  describeBackend(): ExecutionBackendDescription {
    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "tmux",
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true
      }
    };
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    this.startCalls.push(context);
    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend: "tmux",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: "thread-pane-1",
      thread_id: "thread-pane-1",
      process_id: "%12",
      workspace_path: context.workspace_path ?? undefined,
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "tmux",
          availability_status: "available",
          pane_id: "%12",
          session_name: "codex-team-alpha-team",
          window_name: "teammates",
          socket_name: "codex-team-alpha-team-run-alpha-builder",
          attach_command:
            "tmux -L codex-team-alpha-team-run-alpha-builder attach-session -t codex-team-alpha-team"
        }
      }
    };
  }

  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    this.resumeCalls.push({ context, trigger });
    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend: "tmux",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: "thread-pane-1",
      thread_id: "thread-pane-1",
      process_id: "%12",
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "tmux",
          availability_status: "available",
          pane_id: "%12",
          attach_command:
            "tmux -L codex-team-alpha-team-run-alpha-builder attach-session -t codex-team-alpha-team"
        }
      }
    };
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    return {
      status: "active",
      backend: "tmux",
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: "thread-pane-1",
      thread_id: "thread-pane-1",
      process_id: "%12",
      metadata: context.metadata
    };
  }
}

beforeEach(async () => {
  stateRoot = createTempStateRoot();
  workspaceRoot = path.join(stateRoot, "workspace");
  fakePaneBackend = new FakePaneExecutionBackend();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "codex-team-pane-mcp-test",
    version: "0.1.0"
  });
  server = createCodexTeamServer({
    stateRoot,
    workspaceRoot,
    paneMode: {
      enabled: true,
      preferredBackend: "tmux"
    },
    executionBackend: fakePaneBackend
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

function readMessageCount(): number {
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  try {
    const row = adapter
      .getDatabase()
      .prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAMES.messages}`)
      .get() as { count: number };

    return row.count;
  } finally {
    adapter.close();
  }
}

describe("pane MCP routing", () => {
  it("starts Agent through injected paneMode ExecutionBackend and reports attach metadata", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Pane MCP team"
    });
    const agent = await callTool("Agent", {
      name: "Builder",
      mode: "read",
      prompt: "Create a pane-backed TeamMate"
    });

    expect(agent).toMatchObject({
      implemented_now: true,
      status: "running",
      delivery_status: "backend_start_attempted",
      backend: {
        backend: "tmux",
        status: RUN_BACKEND_STATUSES.running,
        thread_id: "thread-pane-1",
        process_id: "%12"
      }
    });
    expect(fakePaneBackend.startCalls).toHaveLength(1);

    const diagnostics = await callTool("TeamDiagnostics", {});

    // D-03 intentional contract change: the default (non-debug) diagnostics keep
    // an attach hint + pane/backend labels, NOT the full attach_command.
    expect(diagnostics).toMatchObject({
      paneSummary: {
        total: 1,
        panes: [
          expect.objectContaining({
            backend_type: "tmux",
            pane_id: "%12",
            attach_hint: true
          })
        ]
      }
    });
    const firstDefaultPane = (
      (diagnostics.paneSummary as { panes?: Array<Record<string, unknown>> })
        .panes ?? []
    )[0];
    expect(firstDefaultPane).not.toHaveProperty("attach_command");

    // D-03: the full, copy-pasteable attach_command is only exposed under
    // include_debug.
    const debugDiagnostics = await callTool("TeamDiagnostics", {
      include_debug: true
    });

    expect(debugDiagnostics).toMatchObject({
      paneSummary: {
        total: 1,
        panes: [
          expect.objectContaining({
            backend_type: "tmux",
            pane_id: "%12",
            attach_command:
              "tmux -L codex-team-alpha-team-run-alpha-builder attach-session -t codex-team-alpha-team"
          })
        ]
      }
    });
  });

  it("keeps SendMessage as the only MCP path for user text and status inspection creates no messages", async () => {
    await callTool("TeamCreate", {
      team_name: "Alpha Team",
      description: "Pane MCP message path"
    });
    await callTool("Agent", {
      name: "Builder",
      mode: "read",
      prompt: "Create a pane-backed TeamMate"
    });

    await callTool("TeamDiagnostics", {});
    expect(readMessageCount()).toBe(0);

    const sent = await callTool("SendMessage", {
      to: "Builder",
      summary: "pane control message",
      message: "Only SendMessage may persist user text"
    });

    expect(sent).toMatchObject({
      implemented_now: true,
      message_id: expect.stringMatching(/^message:/),
      persisted: true
    });
    expect(readMessageCount()).toBe(1);
  });

  it("keeps COMPATIBILITY_TOOLS limited to Claude targets and TeamDiagnostics without kill or terminate controls", () => {
    const toolNames = COMPATIBILITY_TOOLS.map((tool) => tool.codexToolName);

    expect(TARGET_CLAUDE_TOOLS).toEqual([
      "TeamCreate",
      "TeamDelete",
      "Agent",
      "SendMessage",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet"
    ]);
    // Phase 12 adds the TeamMerge codex-team extension and Phase 16 adds CheckInbox
    // (same precedent as TeamDiagnostics); the 8 Claude target tools are unchanged
    // and there are still no kill/terminate controls.
    expect(toolNames).toEqual([
      ...TARGET_CLAUDE_TOOLS,
      "TeamDiagnostics",
      "TeamMerge",
      "CheckInbox"
    ]);
    expect(toolNames).not.toEqual(
      expect.arrayContaining([
        "TeamPaneKill",
        "TeamPaneTerminate",
        "ForceKill",
        "Terminate"
      ])
    );
  });
});
