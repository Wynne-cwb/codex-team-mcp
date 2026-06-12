import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { WorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { EVENT_TYPES, TABLE_NAMES } from "../state/schema.js";

// Phase 13 (D-Q2 / BIDIR-04): the tools a teammate-role caller may NOT use. A
// teammate's co-located MCP self-identifies via the per-launch CODEX_TEAM_MEMBER_ROLE
// env var (-> observedMetadata.codexTeamMemberRole). These four management/spawn/merge
// tools are denied; SendMessage and read-only TeamDiagnostics stay open.
export type TeammateRestrictedTool = "Agent" | "TeamCreate" | "TeamDelete" | "TeamMerge";

// Sanitized, per-tool error codes. Agent REUSES the existing
// `agent_nested_teammate_rejected` code to preserve the established contract and the
// MCP test at test/agentMcp.test.ts.
export const TEAMMATE_RESTRICTED_TOOL_ERROR_CODES: Record<
  TeammateRestrictedTool,
  string
> = {
  Agent: "agent_nested_teammate_rejected",
  TeamCreate: "team_create_teammate_rejected",
  TeamDelete: "team_delete_teammate_rejected",
  TeamMerge: "team_merge_teammate_rejected"
};

const TEAMMATE_ROLE = "teammate";

export interface CapabilityDenial {
  denied: true;
  error_code: string;
  message: string;
}

export interface EnforceTeammateCapabilityInput {
  tool: TeammateRestrictedTool;
  identity: WorkspaceScopedCallerIdentity;
  db: Database.Database;
}

// Single reusable role gate shared by the four restricted handlers. Denies iff the
// caller's env-derived role is exactly "teammate" (NOT `!== "leader"`, so an absent
// role — the TL and every pre-Phase-13 launch — is allowed, keeping SC5 backward-compat
// exact). On denial it appends ONE sanitized `tool_validation_failed` audit event
// (team_id NULL) and returns the denial; otherwise it returns null (no-op, no event).
//
// D-02: this runs BEFORE any schema parse / service construction in the handlers, so no
// prompt/message/body text is ever touched on denial, and the event payload carries only
// identifiers + an enum reason — never any caller-supplied text.
export function enforceTeammateCapability(
  input: EnforceTeammateCapabilityInput
): CapabilityDenial | null {
  if (input.identity.observedMetadata.codexTeamMemberRole !== TEAMMATE_ROLE) {
    return null;
  }

  const errorCode = TEAMMATE_RESTRICTED_TOOL_ERROR_CODES[input.tool];
  appendCapabilityDenialEvent(input.db, input.identity, input.tool, errorCode);

  return {
    denied: true,
    error_code: errorCode,
    message: `${input.tool} is not permitted for teammate-role callers. Teammates may use SendMessage and read-only TeamDiagnostics only.`
  };
}

function appendCapabilityDenialEvent(
  db: Database.Database,
  identity: WorkspaceScopedCallerIdentity,
  tool: TeammateRestrictedTool,
  errorCode: string
): void {
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
    errorCode,
    JSON.stringify({
      error_code: errorCode,
      role: TEAMMATE_ROLE,
      tool,
      reason: "teammate_capability_boundary",
      fallback_used: identity.fallbackUsed
    }),
    new Date().toISOString()
  );
}
