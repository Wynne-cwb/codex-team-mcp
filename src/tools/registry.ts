import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

import type {
  CodexTeamServerOptions,
  CompatibilityToolName,
  ToolAvailabilityStatus,
  ToolMapping
} from "../types.js";
import { buildDiagnosticsPayload } from "../diagnostics.js";
import {
  agentSchema,
  diagnosticsSchema,
  sendMessageSchema,
  taskCreateSchema,
  taskGetSchema,
  taskListSchema,
  taskUpdateSchema,
  teamCreateSchema,
  teamDeleteSchema,
  teamMergeSchema
} from "./schemas.js";
import { createAgentHandler } from "./agentHandler.js";
import { createTeamMergeHandler } from "./mergeHandler.js";
import { createSendMessageHandler } from "./messageHandler.js";
import { createScaffoldToolHandler } from "./scaffoldHandlers.js";
import {
  createTaskCreateHandler,
  createTaskGetHandler,
  createTaskListHandler,
  createTaskUpdateHandler
} from "./taskHandlers.js";
import {
  createTeamCreateHandler,
  createTeamDeleteHandler
} from "./teamHandlers.js";

interface CompatibilityToolDefinition extends ToolMapping {
  inputSchema: ZodRawShape;
  title: string;
}

export const TARGET_CLAUDE_TOOLS = [
  "TeamCreate",
  "TeamDelete",
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet"
] as const satisfies readonly CompatibilityToolName[];

const targetToolDescriptions: Record<(typeof TARGET_CLAUDE_TOOLS)[number], string> = {
  TeamCreate:
    "Codex Team compatibility equivalent of Claude TeamCreate. Creates durable teams with scoped active binding in Phase 2.",
  TeamDelete:
    "Codex Team compatibility equivalent of Claude TeamDelete. Archives durable teams and invalidates active bindings in Phase 2.",
  Agent:
    "Codex Team compatibility equivalent of Claude Agent. Creates durable TeamMates, records lifecycle/isolation metadata, and attempts backend-dependent start and resume in Phase 5 when supported.",
  SendMessage:
    "Codex Team compatibility equivalent of Claude SendMessage. Stores persisted explicit TeamMate messages, queues running recipients for the next turn boundary, and reports Phase 5 backend start/resume outcomes.",
  TaskCreate:
    "Codex Team compatibility equivalent of Claude TaskCreate. Creates durable team-scoped tasks and routes assignment notifications through Phase 5 lifecycle-aware messaging.",
  TaskUpdate:
    "Codex Team compatibility equivalent of Claude TaskUpdate. Updates durable team-scoped tasks and routes assignment notifications through Phase 5 lifecycle-aware messaging.",
  TaskList:
    "Codex Team compatibility equivalent of Claude TaskList. Lists durable team-scoped tasks with Phase 5 lifecycle-compatible ownership state.",
  TaskGet:
    "Codex Team compatibility equivalent of Claude TaskGet. Reads durable team-scoped task detail and history with Phase 5 lifecycle-compatible ownership state."
};

const nextPhaseByTool: Record<(typeof TARGET_CLAUDE_TOOLS)[number], string> = {
  TeamCreate: "Phase 2",
  TeamDelete: "Phase 2",
  Agent: "Phase 5",
  SendMessage: "Phase 5",
  TaskCreate: "Phase 5",
  TaskUpdate: "Phase 5",
  TaskList: "Phase 5",
  TaskGet: "Phase 5"
};

const targetToolStatuses: Record<
  (typeof TARGET_CLAUDE_TOOLS)[number],
  ToolAvailabilityStatus
> = {
  TeamCreate: "implemented",
  TeamDelete: "implemented",
  Agent: "implemented",
  SendMessage: "implemented",
  TaskCreate: "implemented",
  TaskUpdate: "implemented",
  TaskList: "implemented",
  TaskGet: "implemented"
};

const targetToolSchemas: Record<(typeof TARGET_CLAUDE_TOOLS)[number], ZodRawShape> = {
  TeamCreate: teamCreateSchema,
  TeamDelete: teamDeleteSchema,
  Agent: agentSchema,
  SendMessage: sendMessageSchema,
  TaskCreate: taskCreateSchema,
  TaskUpdate: taskUpdateSchema,
  TaskList: taskListSchema,
  TaskGet: taskGetSchema
};

function createTargetToolDefinition(
  toolName: (typeof TARGET_CLAUDE_TOOLS)[number]
): CompatibilityToolDefinition {
  return {
    claudeToolName: toolName,
    codexToolName: toolName,
    title: toolName,
    description: targetToolDescriptions[toolName],
    status: targetToolStatuses[toolName],
    nextPhase: nextPhaseByTool[toolName],
    inputSchema: targetToolSchemas[toolName]
  };
}

const diagnosticsDescription =
  "Diagnostics for the Codex Team compatibility equivalent of Claude Agent Team tools. Reports Phase 5 lifecycle, run, message, task, stale reconciliation, workspace review, and backend-dependent status summaries. Phase 7 adds backend-dependent pane attach/status and workspace review visibility as summary-only diagnostics.";

const teamMergeDescription =
  "codex-team extension (NOT a native Claude tool): TL-driven review/merge/escalate of an isolated worktree branch back into the leader working tree. Auditable and explicit — never a silent background auto-merge. On conflict the leader is rolled back clean and the worktree is preserved; unresolved conflicts can be escalated to a human.";

export const COMPATIBILITY_TOOLS: readonly CompatibilityToolDefinition[] = [
  ...TARGET_CLAUDE_TOOLS.map(createTargetToolDefinition),
  {
    claudeToolName: "TeamDiagnostics",
    codexToolName: "TeamDiagnostics",
    title: "TeamDiagnostics",
    description: diagnosticsDescription,
    status: "implemented",
    nextPhase: "Phase 5",
    inputSchema: diagnosticsSchema
  },
  {
    claudeToolName: "TeamMerge",
    codexToolName: "TeamMerge",
    title: "TeamMerge",
    description: teamMergeDescription,
    status: "implemented",
    nextPhase: "Phase 12",
    inputSchema: teamMergeSchema
  }
];

function createDiagnosticsToolHandler(
  options: CodexTeamServerOptions
): (
  args: { include_debug?: boolean },
  extra: unknown
) => Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return async (args, extra) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          buildDiagnosticsPayload({
            ...options,
            callerMetadata: extra,
            includeDebug: args.include_debug,
            targetClaudeTools: TARGET_CLAUDE_TOOLS,
            registeredTools: COMPATIBILITY_TOOLS
          }),
          null,
          2
        )
      }
    ]
  });
}

export function registerCompatibilityTools(
  server: McpServer,
  options: CodexTeamServerOptions = {}
): void {
  for (const tool of COMPATIBILITY_TOOLS) {
    let handler:
      | ReturnType<typeof createDiagnosticsToolHandler>
      | ReturnType<typeof createAgentHandler>
      | ReturnType<typeof createTeamMergeHandler>
      | ReturnType<typeof createSendMessageHandler>
      | ReturnType<typeof createTaskCreateHandler>
      | ReturnType<typeof createTaskUpdateHandler>
      | ReturnType<typeof createTaskListHandler>
      | ReturnType<typeof createTaskGetHandler>
      | ReturnType<typeof createTeamCreateHandler>
      | ReturnType<typeof createTeamDeleteHandler>
      | ReturnType<typeof createScaffoldToolHandler>;

    if (tool.codexToolName === "TeamCreate") {
      handler = createTeamCreateHandler(options);
    } else if (tool.codexToolName === "TeamDelete") {
      handler = createTeamDeleteHandler(options);
    } else if (tool.codexToolName === "Agent") {
      handler = createAgentHandler(options);
    } else if (tool.codexToolName === "SendMessage") {
      handler = createSendMessageHandler(options);
    } else if (tool.codexToolName === "TaskCreate") {
      handler = createTaskCreateHandler(options);
    } else if (tool.codexToolName === "TaskUpdate") {
      handler = createTaskUpdateHandler(options);
    } else if (tool.codexToolName === "TaskList") {
      handler = createTaskListHandler(options);
    } else if (tool.codexToolName === "TaskGet") {
      handler = createTaskGetHandler(options);
    } else if (tool.codexToolName === "TeamDiagnostics") {
      handler = createDiagnosticsToolHandler(options);
    } else if (tool.codexToolName === "TeamMerge") {
      handler = createTeamMergeHandler(options);
    } else {
      handler = createScaffoldToolHandler(tool, options);
    }

    server.registerTool(
      tool.codexToolName,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      handler
    );
  }
}
