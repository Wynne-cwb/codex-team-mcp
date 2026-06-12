import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z, ZodError } from "zod";

import type { DurableStateRootDescription } from "../adapters/state.js";
import { normalizeCallerMetadata } from "../context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { ContextResolver } from "../services/contextResolver.js";
import { MemberResolver } from "../services/memberResolver.js";
import {
  MessageInboxService,
  toInboxEnvelopeMessage,
  type UnreadInboxRow
} from "../services/messageInboxService.js";
import { DurableStateAdapter } from "../state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../state/schema.js";
import type { CodexTeamServerOptions } from "../types.js";
import { checkInboxSchema, optionalCanonicalTeamNameSchema } from "./schemas.js";

type JsonToolResponse = Promise<{ content: Array<{ type: "text"; text: string }> }>;

const CHECK_INBOX_VALIDATION_ERROR_CODE = "check_inbox_validation_failed";

// Re-parse with the canonical-team-name validator + defaults applied (peek/include_read
// default false, limit defaults to 50, capped at 500 — matching the read-model cap).
const checkInboxInputSchema = z.object({
  ...checkInboxSchema,
  team_name: optionalCanonicalTeamNameSchema,
  peek: z.boolean().optional().default(false),
  include_read: z.boolean().optional().default(false),
  limit: z.number().int().positive().max(500).optional().default(50)
});

// Phase 16 (T7 / §3.3): CheckInbox. Pull messages addressed to the caller over the
// reliable MCP/JSON channel (full bodies, oldest-first). Available to ALL roles — it
// is deliberately NOT in the teammate-restricted set (capabilityGuard.ts): teammates
// call it to read the bodies behind a 📬 pane nudge, and the TL re-reads
// auto-surfaced messages. Non-peek reads mark the returned unread rows read (writes
// ONLY read_at — D-02 safe; the body is lawful delivery to its recipient).
export function createInboxHandler(
  options: CodexTeamServerOptions = {}
): (args: unknown, extra: unknown) => JsonToolResponse {
  return async (args, extra) => {
    const adapter = new DurableStateAdapter(options);
    let identity: WorkspaceScopedCallerIdentity | undefined;

    try {
      const state = describeDurableState(adapter);
      identity = buildWorkspaceScopedCallerIdentity({
        workspaceRoot: state.workspaceRoot,
        caller: normalizeCallerMetadata(extra)
      });
      const input = checkInboxInputSchema.parse(args);
      const db = adapter.getDatabase();

      const resolved = new ContextResolver(db).resolveTeam({
        teamName: input.team_name,
        identity
      });
      if (!resolved.ok) {
        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: resolved.errorCode,
          message: resolved.message
        });
      }

      // Resolve the caller's own member row (purpose "sender" returns the caller:
      // the TL-injected member id for a teammate, else the leader).
      const callerMember = new MemberResolver({ db, identity }).resolveMemberReference({
        teamId: resolved.team.teamId,
        teamName: resolved.team.teamName,
        purpose: "sender",
        identity
      });
      if (callerMember.status !== "resolved") {
        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: callerMember.error_code ?? "caller_member_unresolved",
          message: "Could not resolve the calling member for the inbox."
        });
      }

      const memberId = callerMember.member.member_id;
      const inbox = new MessageInboxService(db);
      const isoTime = new Date().toISOString();

      let rows: UnreadInboxRow[];
      let markedRead = 0;
      if (input.peek) {
        // Peek: never mutate read state; return unread (+ history if requested).
        rows = inbox.selectUnreadForMember(resolved.team.teamId, memberId, {
          includeRead: input.include_read,
          limit: input.limit
        });
      } else {
        // Claim-and-stamp the currently-unread rows in one atomic txn; `claimed` is
        // exactly what THIS call flipped (race-safe against concurrent pulls).
        const claimed = inbox.claimRead(resolved.team.teamId, memberId, isoTime, {
          limit: input.limit
        });
        markedRead = claimed.length;
        if (input.include_read) {
          // History view: re-select the full set (now including the just-read rows).
          rows = inbox.selectUnreadForMember(resolved.team.teamId, memberId, {
            includeRead: true,
            limit: input.limit
          });
        } else {
          rows = claimed;
        }
      }

      const messages = rows.map((row) =>
        toInboxEnvelopeMessage(row, resolved.team.teamName)
      );
      const unreadCount = messages.filter((message) => message.read_at === null).length;

      return jsonResponse({
        implemented_now: true,
        status: "ok",
        team_name: resolved.team.teamName,
        member_id: memberId,
        peeked: input.peek,
        include_read: input.include_read,
        limit: input.limit,
        returned_count: messages.length,
        unread_count: unreadCount,
        marked_read: markedRead,
        messages,
        note: input.peek
          ? "Peek: messages were NOT marked read."
          : "Returned unread messages are now marked read."
      });
    } catch (error) {
      if (error instanceof ZodError && identity) {
        appendInboxValidationFailureEvent(adapter.getDatabase(), identity, error);
        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: CHECK_INBOX_VALIDATION_ERROR_CODE,
          message: buildValidationMessage(error)
        });
      }

      return jsonResponse({
        implemented_now: true,
        status: "error",
        error_code: "check_inbox_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      adapter.close();
    }
  };
}

function describeDurableState(
  adapter: DurableStateAdapter
): DurableStateRootDescription {
  const state = adapter.describeStateRoot();
  if (state.status !== "durable") {
    throw new Error("Durable CheckInbox handler requires durable state.");
  }

  return state;
}

function jsonResponse(payload: Record<string, unknown>): JsonToolResponse {
  return Promise.resolve({
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  });
}

function buildValidationMessage(error: ZodError): string {
  const fields = [
    ...new Set(
      error.issues.map((issue) => issue.path.join(".")).filter((path) => path)
    )
  ];
  const suffix = fields.length > 0 ? ` for fields: ${fields.join(", ")}` : "";
  return `CheckInbox input validation failed${suffix}.`;
}

function appendInboxValidationFailureEvent(
  db: Database.Database,
  identity: WorkspaceScopedCallerIdentity,
  error: ZodError
): void {
  // Only identifiers + an enum reason + non-sensitive field paths — never any body.
  const fields = [
    ...new Set(
      error.issues.map((issue) => issue.path.join(".")).filter((path) => path)
    )
  ];
  db.prepare(
    `
      INSERT INTO ${TABLE_NAMES.events} (
        event_id,
        team_id,
        workspace_root,
        actor_caller_key,
        event_type,
        error_code,
        payload_json,
        created_at
      )
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    randomUUID(),
    identity.workspaceRoot,
    identity.callerKey,
    EVENT_TYPES.toolValidationFailed,
    CHECK_INBOX_VALIDATION_ERROR_CODE,
    JSON.stringify({
      error_code: CHECK_INBOX_VALIDATION_ERROR_CODE,
      fallback_used: identity.fallbackUsed,
      validation: {
        fields,
        issue_codes: [...new Set(error.issues.map((issue) => issue.code))]
      }
    }),
    new Date().toISOString()
  );
}
