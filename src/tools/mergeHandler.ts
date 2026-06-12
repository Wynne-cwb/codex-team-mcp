import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z, ZodError } from "zod";

import { createExecutionBackendFromOptions } from "../adapters/paneExecutionBackend.js";
import { normalizeCallerMetadata } from "../context/caller.js";
import { enforceTeammateCapability } from "./capabilityGuard.js";
import { buildWorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { LifecycleService } from "../services/lifecycleService.js";
import type { DurableStateRootDescription } from "../adapters/state.js";
import { DurableStateAdapter } from "../state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../state/schema.js";
import type { CodexTeamServerOptions } from "../types.js";

type JsonToolResponse = Promise<{ content: Array<{ type: "text"; text: string }> }>;

const MERGE_VALIDATION_ERROR_CODE = "team_merge_validation_failed";
const MERGE_TARGET_NOT_FOUND_ERROR_CODE = "merge_target_not_found";

const teamMergeInputSchema = z.object({
  action: z.enum(["review", "merge", "escalate"]),
  teammate_id: z.string().optional(),
  member_id: z.string().optional(),
  run_id: z.string().optional(),
  team_name: z.string().optional()
});

interface TargetRunIdRow {
  runId: string;
}

export function createTeamMergeHandler(
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
      // Phase 13 (D-Q2): teammate-role callers cannot drive TL-only worktree
      // merges. Deny BEFORE parse / lifecycle construction (no body touched).
      const denial = enforceTeammateCapability({
        tool: "TeamMerge",
        identity,
        db: adapter.getDatabase()
      });
      if (denial) {
        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: denial.error_code,
          message: denial.message
        });
      }
      const input = teamMergeInputSchema.parse(args);
      const db = adapter.getDatabase();

      const runId = resolveTargetRunId(db, state.workspaceRoot, input);
      if (!runId) {
        // No destructive action — just an honest, precise error.
        return jsonResponse({
          implemented_now: true,
          status: "error",
          action: input.action,
          error_code: MERGE_TARGET_NOT_FOUND_ERROR_CODE,
          message:
            "No worktree run resolved for the supplied run_id / teammate_id / member_id."
        });
      }

      const lifecycle = new LifecycleService({
        db,
        statePath: state.stateRoot,
        executionBackend: createExecutionBackendFromOptions(options),
        paneMode: options.paneMode
      });

      const request = {
        run_id: runId,
        identity,
        teammate_id: input.teammate_id,
        team_name: input.team_name
      };

      if (input.action === "review") {
        const result = lifecycle.reviewWorktree(request);
        return jsonResponse({ implemented_now: true, action: "review", ...result });
      }

      if (input.action === "merge") {
        const result = lifecycle.mergeWorktree(request);
        return jsonResponse({ implemented_now: true, action: "merge", ...result });
      }

      const result = lifecycle.escalateWorktree(request);
      return jsonResponse({ implemented_now: true, action: "escalate", ...result });
    } catch (error) {
      if (error instanceof ZodError && identity) {
        appendMergeValidationFailureEvent(
          adapter.getDatabase(),
          identity,
          buildValidationContext(error)
        );

        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: MERGE_VALIDATION_ERROR_CODE,
          message: buildValidationMessage(error)
        });
      }

      return jsonResponse({
        implemented_now: true,
        status: "error",
        error_code: "team_merge_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      adapter.close();
    }
  };
}

// Resolve the target run: run_id wins; otherwise the most recent run for the
// member_id / teammate_id, preferring an isolated git_worktree run.
function resolveTargetRunId(
  db: Database.Database,
  workspaceRoot: string,
  input: z.infer<typeof teamMergeInputSchema>
): string | null {
  const runId = normalizeText(input.run_id);
  if (runId) {
    return runId;
  }

  const memberId = normalizeText(input.member_id);
  const teammateId = normalizeText(input.teammate_id);
  if (!memberId && !teammateId) {
    return null;
  }

  const row = db
    .prepare(
      `
        SELECT runs.run_id AS runId
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.members} AS members
          ON members.member_id = runs.member_id
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?
          AND (
            members.member_id = ?
            OR json_extract(members.metadata_json, '$.publicTeammateId') = ?
          )
        ORDER BY
          CASE WHEN runs.isolation_kind = 'git_worktree' THEN 0 ELSE 1 END,
          runs.updated_at DESC,
          runs.run_id DESC
        LIMIT 1
      `
    )
    .get(workspaceRoot, memberId ?? "", teammateId ?? "") as
    | TargetRunIdRow
    | undefined;

  return row?.runId ?? null;
}

function describeDurableState(
  adapter: DurableStateAdapter
): DurableStateRootDescription {
  const state = adapter.describeStateRoot();
  if (state.status !== "durable") {
    throw new Error("Durable TeamMerge handler requires durable state.");
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

function buildValidationContext(error: ZodError): {
  fields: string[];
  issue_codes: string[];
} {
  return {
    fields: [
      ...new Set(
        error.issues.map((issue) => issue.path.join(".")).filter((path) => path)
      )
    ],
    issue_codes: [...new Set(error.issues.map((issue) => issue.code))]
  };
}

function buildValidationMessage(error: ZodError): string {
  const validation = buildValidationContext(error);
  const fields =
    validation.fields.length > 0 ? ` for fields: ${validation.fields.join(", ")}` : "";

  return `TeamMerge input validation failed${fields}.`;
}

function appendMergeValidationFailureEvent(
  db: Database.Database,
  identity: WorkspaceScopedCallerIdentity,
  validation: { fields: string[]; issue_codes: string[] }
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
    MERGE_VALIDATION_ERROR_CODE,
    JSON.stringify({
      error_code: MERGE_VALIDATION_ERROR_CODE,
      fallback_used: identity.fallbackUsed,
      validation
    }),
    new Date().toISOString()
  );
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
