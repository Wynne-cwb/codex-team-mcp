import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";

import type {
  CodexTeamServerOptions,
  CompatibilityToolName,
  ToolAvailabilityStatus,
  ToolMapping
} from "../types.js";
import { buildDiagnosticsPayload } from "../diagnostics.js";
import { createExecutionBackendFromOptions } from "../adapters/paneExecutionBackend.js";
import { normalizeCallerMetadata } from "../context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { ContextResolver } from "../services/contextResolver.js";
import { LifecycleService } from "../services/lifecycleService.js";
import { MemberResolver } from "../services/memberResolver.js";
import {
  MessageInboxService,
  shouldUseInboxDigest,
  toInboxDigestMessage,
  toInboxEnvelopeMessage
} from "../services/messageInboxService.js";
import { DurableStateAdapter } from "../state/durableState.js";
import {
  agentSchema,
  checkInboxSchema,
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
import { createInboxHandler } from "./inboxHandler.js";
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
    "Codex Team compatibility equivalent of Claude Agent. Creates durable TeamMates, records lifecycle/isolation metadata, and attempts backend-dependent start and resume in Phase 5 when supported. Isolation = merge-gate: file-modifying teammate work runs in an isolated worktree (or a reviewable diff); it is NOT in the leader tree until the Team Lead reviews and merges it via TeamMerge. Treat pending_review / needs_review as gates, not as merged work.",
  SendMessage:
    "Codex Team compatibility equivalent of Claude SendMessage. Stores persisted explicit TeamMate messages, queues running recipients for the next turn boundary, and reports Phase 5 backend start/resume outcomes. Delivery is at a turn boundary, not synchronous: the message is persisted now and delivered when the recipient is idle between turns (queued_for_next_turn while it is running, queued_while_idle while idle — both normal, neither an error). It is never injected mid-turn.",
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

const checkInboxDescription =
  "codex-team extension (NOT a native Claude tool): pull messages addressed to you (the caller) over the reliable MCP/JSON channel — full bodies, oldest first. Message bodies are pulled, never pushed: you are nudged that mail exists (a 📬 pane line for teammates; an inbox_pending count + an auto-surfaced inbox block for the Team Lead), then call CheckInbox to pull the full bodies. inbox_pending is the count of your own unread messages on every codex-team tool result — pull when it is > 0. Do not poll CheckInbox speculatively — call it when nudged or at a checkpoint, never on a loop. peek leaves messages unread; include_read returns read history; limit caps the batch. Reading marks the returned unread messages read (writes only a timestamp). Available to all roles.";

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
  },
  {
    claudeToolName: "CheckInbox",
    codexToolName: "CheckInbox",
    title: "CheckInbox",
    description: checkInboxDescription,
    status: "implemented",
    nextPhase: "Phase 16",
    inputSchema: checkInboxSchema
  }
];

interface DiagnosticsToolArgs {
  include_debug?: boolean;
  // Phase 17 focus filters (snake_case primary + camelCase aliases).
  team_name?: string;
  teamName?: string;
  current_team_only?: boolean;
  currentTeamOnly?: boolean;
  include_archived?: boolean;
  includeArchived?: boolean;
  include_history?: boolean;
  includeHistory?: boolean;
  max_events?: number;
  maxEvents?: number;
  max_runs?: number;
  maxRuns?: number;
  max_messages?: number;
  maxMessages?: number;
  messages_since?: string;
  messagesSince?: string;
  teammate_id?: string;
  teammateId?: string;
}

function createDiagnosticsToolHandler(
  options: CodexTeamServerOptions,
  // Lazily reads the connected client's declared MCP capabilities at request time
  // (the client has connected by then). Best-effort: any failure yields undefined
  // and the debug block simply shows null. Threaded in from registerCompatibilityTools
  // because only it holds the McpServer instance.
  getClientCapabilities?: () => unknown
): (
  args: DiagnosticsToolArgs,
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
            clientCapabilities: safeGetClientCapabilities(getClientCapabilities),
            includeDebug: args.include_debug,
            // Map the focus filters (snake_case primary; camelCase alias fallback).
            teamName: args.team_name ?? args.teamName,
            currentTeamOnly: args.current_team_only ?? args.currentTeamOnly,
            includeArchived: args.include_archived ?? args.includeArchived,
            includeHistory: args.include_history ?? args.includeHistory,
            maxEvents: args.max_events ?? args.maxEvents,
            maxRuns: args.max_runs ?? args.maxRuns,
            maxMessages: args.max_messages ?? args.maxMessages,
            messagesSince: args.messages_since ?? args.messagesSince,
            teammateId: args.teammate_id ?? args.teammateId,
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
      | ReturnType<typeof createInboxHandler>
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
      handler = createDiagnosticsToolHandler(options, () =>
        server.server.getClientCapabilities()
      );
    } else if (tool.codexToolName === "TeamMerge") {
      handler = createTeamMergeHandler(options);
    } else if (tool.codexToolName === "CheckInbox") {
      handler = createInboxHandler(options);
    } else {
      handler = createScaffoldToolHandler(tool, options);
    }

    // Two independent shared post-steps wrap every codex-team tool:
    //   (inner) §1.4(a) delivery backstop — drains pending pane nudges (pane mode only);
    //   (outer) §3 TL inbox auto-surface — appends the leader's unread inbox to the
    //   JSON result. The surface is pane-independent (pure JSON + read_at stamp), so
    //   it wraps the backstop and runs regardless of pane mode.
    server.registerTool(
      tool.codexToolName,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      withLeaderInboxSurface(
        withDeliveryBackstop(handler as RegisteredToolHandler, options),
        options
      )
    );
  }
}

type RegisteredToolHandler = (
  args: unknown,
  extra: unknown
) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

// Best-effort read of the connected client's declared MCP capabilities. Never
// throws into the diagnostics handler — an unavailable getter (no client yet,
// SDK shape change) just yields undefined, surfaced as null in the debug block.
function safeGetClientCapabilities(
  getClientCapabilities?: () => unknown
): unknown {
  if (!getClientCapabilities) {
    return undefined;
  }
  try {
    return getClientCapabilities();
  } catch {
    return undefined;
  }
}

// Phase 16 (§1.4(a) BACKSTOP): wrap every codex-team tool handler with a thin,
// best-effort, NON-GATING post-step that drains recipients ALREADY idle/stopped with
// pending rows for the caller's team. It catches debounce-merged messages and any
// recipient that went idle without a reconcile yet but whose pane is live. It does
// NOT run the full finalize reconcile (that stays in TeamDiagnostics) and must never
// fail the originating tool. Skipped entirely when pane mode is off (no pane to
// nudge), so non-pane setups see zero behavior change and zero extra DB work.
function withDeliveryBackstop(
  handler: RegisteredToolHandler,
  options: CodexTeamServerOptions
): RegisteredToolHandler {
  if (options.paneMode?.enabled !== true) {
    return handler;
  }
  return async (args, extra) => {
    const result = await handler(args, extra);
    try {
      runDeliveryBackstop(options, extra);
    } catch {
      // Best-effort: the backstop must never fail the originating tool.
    }
    return result;
  };
}

function runDeliveryBackstop(
  options: CodexTeamServerOptions,
  extra: unknown
): void {
  const adapter = new DurableStateAdapter(options);
  try {
    const state = adapter.describeStateRoot();
    if (state.status !== "durable") {
      return;
    }
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: state.workspaceRoot,
      caller: normalizeCallerMetadata(extra)
    });
    const resolved = new ContextResolver(adapter.getDatabase()).resolveTeam({
      identity
    });
    if (!resolved.ok) {
      return;
    }
    new LifecycleService({
      db: adapter.getDatabase(),
      statePath: state.stateRoot,
      executionBackend: createExecutionBackendFromOptions(options),
      paneMode: options.paneMode
    }).drainTeamPendingDeliveries({
      teamId: resolved.team.teamId,
      teamName: resolved.team.teamName,
      identity
    });
  } finally {
    adapter.close();
  }
}

const LEADER_ROLE_TEAMMATE = "teammate";
// Item 1 (§2c, SECONDARY/fallback owner): the auto-surface `inbox` block `note`
// carries a ONE-CLAUSE version of the anti-speculative-poll hint. The PRIMARY home
// of the full §2c text is the UserPromptSubmit hook nudge (hooks/README.md); per the
// ownership map this note must NOT restate the full hook/`inbox_pending` mechanics,
// only the short "don't poll on a loop" clause.
const LEADER_INBOX_NOTE =
  "Unread teammate→TL messages, oldest first. Now marked read. Do not poll CheckInbox on a loop — you are nudged when mail arrives.";
// Item 1 (§2b): digest-mode note. Full bodies were elided to keep the block bounded;
// the TL pulls them on demand. Same one-clause anti-poll hint.
const LEADER_INBOX_DIGEST_NOTE =
  "Unread teammate→TL messages (compact digest, oldest first). Now marked read. Pull full bodies with CheckInbox(include_read). Do not poll CheckInbox on a loop — you are nudged when mail arrives.";

// Phase 16 (T6 / §3) + Item 1 (§2a/§2b): shared post-processor. When the caller is the
// LEADER — i.e. the env-derived role is NOT "teammate" AND the resolved caller member
// is leader:<teamId> (memberResolver.ts:85-90,248-250) — claim & stamp read_at for the
// leader's unread rows in ONE atomic BEGIN IMMEDIATE txn and append an `inbox` block to
// the tool's JSON result. Item 1 folds two behaviors into this SAME db open (no third
// wrapper): (§2a) attach a top-level `inbox_pending` COUNT of the leader's
// remaining-unread mail (computed POST-claim, always present incl. 0); (§2b) render the
// `inbox` block size-aware — full bodies for a small/short batch, a compact digest
// (capped previews, no full body) for a large/heavy one. Teammate-role callers get NO
// inbox block and NO `inbox_pending` (they receive pane nudges + pull via CheckInbox).
// Applied to ALL codex-team tool results via this ONE wrapper. Concurrent leader calls
// cannot double-surface: the second atomic claim flips zero rows. NON-GATING: any
// failure leaves the originating tool result untouched. D-02: writes ONLY read_at — the
// body/preview shown is lawful delivery to its intended recipient (the leader), never
// persisted into events/metadata.
export function withLeaderInboxSurface(
  handler: RegisteredToolHandler,
  options: CodexTeamServerOptions
): RegisteredToolHandler {
  return async (args, extra) => {
    const result = await handler(args, extra);
    try {
      return surfaceLeaderInbox(result, options, extra);
    } catch {
      // Best-effort: the surface must never fail the originating tool.
      return result;
    }
  };
}

function surfaceLeaderInbox(
  result: { content: Array<{ type: "text"; text: string }> },
  options: CodexTeamServerOptions,
  extra: unknown
): { content: Array<{ type: "text"; text: string }> } {
  const caller = normalizeCallerMetadata(extra);
  // Role gate: teammate-role callers never receive the leader inbox.
  if (caller.observedMetadata.codexTeamMemberRole === LEADER_ROLE_TEAMMATE) {
    return result;
  }

  const adapter = new DurableStateAdapter(options);
  try {
    const state = adapter.describeStateRoot();
    if (state.status !== "durable") {
      return result;
    }
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: state.workspaceRoot,
      caller
    });
    const db = adapter.getDatabase();
    const resolved = new ContextResolver(db).resolveTeam({ identity });
    if (!resolved.ok) {
      return result;
    }

    const leaderMemberId = `leader:${resolved.team.teamId}`;
    // Belt-and-suspenders with the role gate: the caller must resolve to the leader
    // member (purpose "sender" returns leader when no member id is injected).
    const callerMember = new MemberResolver({ db, identity }).resolveMemberReference({
      teamId: resolved.team.teamId,
      teamName: resolved.team.teamName,
      purpose: "sender",
      identity
    });
    if (
      callerMember.status !== "resolved" ||
      callerMember.member.member_id !== leaderMemberId
    ) {
      return result;
    }

    const inboxService = new MessageInboxService(db);
    const claimed = inboxService.claimRead(
      resolved.team.teamId,
      leaderMemberId,
      new Date().toISOString()
    );

    // Item 1 (§2a): compute `inbox_pending` from the POST-claim state — what remains
    // unread for the leader AFTER this surface claimed its rows — so the counter never
    // disagrees with the `inbox` block shown in this same result. Reuses THIS db open
    // (no third wrapper). A COUNT only; reads no body (D-02 safe).
    const inboxPending = inboxService.countUnreadForMember(
      resolved.team.teamId,
      leaderMemberId
    );

    if (claimed.length === 0) {
      // No new mail to surface, but still emit `inbox_pending` (typically 0) so the TL
      // can always trust the field's presence on a leader tool result.
      return appendInboxPending(result, inboxPending);
    }

    // Item 1 (§2b): size-aware rendering. Full-body inline for a small/short batch;
    // compact digest (no body, capped preview) when the batch is large/heavy. The
    // claim above marked the SAME rows read in either mode — digest only changes how
    // much of each claimed row is rendered inline; the TL pulls full bodies on demand
    // via CheckInbox(include_read).
    const useDigest = shouldUseInboxDigest(claimed);
    const inboxBlock: Record<string, unknown> = useDigest
      ? {
          unread_count: claimed.length,
          digest: true,
          messages: claimed.map((row) =>
            toInboxDigestMessage(row, resolved.team.teamName)
          ),
          note: LEADER_INBOX_DIGEST_NOTE
        }
      : {
          unread_count: claimed.length,
          messages: claimed.map((row) =>
            toInboxEnvelopeMessage(row, resolved.team.teamName)
          ),
          note: LEADER_INBOX_NOTE
        };

    return appendInboxBlock(result, inboxBlock, inboxPending);
  } finally {
    adapter.close();
  }
}

// Parse the handler's JSON result, attach the `inbox` block + the top-level
// `inbox_pending` counter (Item 1 §2a), re-serialize. Any non-JSON / non-object
// payload is left exactly as the handler produced it.
function appendInboxBlock(
  result: { content: Array<{ type: "text"; text: string }> },
  inbox: Record<string, unknown>,
  inboxPending: number
): { content: Array<{ type: "text"; text: string }> } {
  return mergeTopLevel(result, { inbox, inbox_pending: inboxPending });
}

// Item 1 (§2a): attach ONLY the top-level `inbox_pending` counter (no `inbox` block)
// — used when the leader has no newly-claimed mail this call but the counter must
// still be present (typically 0) so the TL can always trust the field.
function appendInboxPending(
  result: { content: Array<{ type: "text"; text: string }> },
  inboxPending: number
): { content: Array<{ type: "text"; text: string }> } {
  return mergeTopLevel(result, { inbox_pending: inboxPending });
}

// Merge top-level keys into the handler's JSON result and re-serialize. Any
// non-JSON / non-object payload is left exactly as the handler produced it.
function mergeTopLevel(
  result: { content: Array<{ type: "text"; text: string }> },
  extra: Record<string, unknown>
): { content: Array<{ type: "text"; text: string }> } {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    return result;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(first.text);
  } catch {
    return result;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return result;
  }
  const augmented = { ...(payload as Record<string, unknown>), ...extra };
  return {
    ...result,
    content: [
      { type: "text", text: JSON.stringify(augmented, null, 2) },
      ...result.content.slice(1)
    ]
  };
}
