import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z, ZodError } from "zod";

import { normalizeCallerMetadata } from "../context/caller.js";
import { enforceTeammateCapability } from "./capabilityGuard.js";
import { buildWorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { ContextResolver } from "../services/contextResolver.js";
import {
  LifecycleService,
  type PaneTeardownSummary
} from "../services/lifecycleService.js";
import {
  TeamArchiveResolutionError,
  TeamService
} from "../services/teamService.js";
import { canonicalizeTeamName } from "../services/teamNames.js";
import { DurableStateAdapter } from "../state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../state/schema.js";
import type { CodexTeamServerOptions } from "../types.js";
import type { DurableStateRootDescription } from "../adapters/state.js";
import type { WorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";

type JsonToolResponse = Promise<{ content: Array<{ type: "text"; text: string }> }>;

const TEAM_CREATE_VALIDATION_ERROR_CODE = "team_create_validation_failed";
const TEAM_DELETE_VALIDATION_ERROR_CODE = "team_delete_validation_failed";

const teamCreateInputSchema = z.object({
  team_name: z
    .string({
      required_error: "team_name is required"
    })
    .trim()
    .min(1, "team_name is required"),
  description: z.string().optional(),
  agent_type: z.string().optional(),
  model: z.string().optional()
});

const teamDeleteInputSchema = z.object({
  team_name: z.string().optional(),
  reason: z.string().optional()
});

const explicitTeamDeleteNameSchema = z.object({
  team_name: z
    .string({
      required_error: "team_name is required"
    })
    .trim()
    .min(1, "team_name cannot be blank")
    .refine((value) => {
      try {
        canonicalizeTeamName(value);
        return true;
      } catch {
        return false;
      }
    }, "team_name must include at least one supported character")
});

export function createTeamCreateHandler(
  options: CodexTeamServerOptions = {}
): (args: unknown, extra: unknown) => JsonToolResponse {
  return async (args, extra) => {
    const adapter = new DurableStateAdapter(options);
    const state = describeDurableState(adapter);
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: state.workspaceRoot,
      caller: normalizeCallerMetadata(extra)
    });

    try {
      const denial = enforceTeammateCapability({
        tool: "TeamCreate",
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
      const input = teamCreateInputSchema.parse(args);
      const service = new TeamService({
        db: adapter.getDatabase(),
        statePath: state.stateRoot
      });
      const result = service.createTeam({
        teamName: input.team_name,
        description: input.description,
        identity,
        agentType: input.agent_type,
        modelHint: input.model
      });

      return jsonResponse({
        implemented_now: true,
        ...result
      });
    } catch (error) {
      if (isTeamCreateValidationFailure(error)) {
        appendTeamCreateValidationFailureEvent(
          adapter.getDatabase(),
          identity,
          buildValidationContext(error)
        );

        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: TEAM_CREATE_VALIDATION_ERROR_CODE,
          message: buildTeamCreateValidationMessage(error)
        });
      }

      return jsonResponse({
        implemented_now: true,
        status: "error",
        error_code: "team_create_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      adapter.close();
    }
  };
}

export function createTeamDeleteHandler(
  options: CodexTeamServerOptions = {}
): (args: unknown, extra: unknown) => JsonToolResponse {
  return async (args, extra) => {
    const adapter = new DurableStateAdapter(options);
    const state = describeDurableState(adapter);
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: state.workspaceRoot,
      caller: normalizeCallerMetadata(extra)
    });

    try {
      const denial = enforceTeammateCapability({
        tool: "TeamDelete",
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
      const input = parseTeamDeleteInput(args);
      const service = new TeamService({
        db: adapter.getDatabase(),
        statePath: state.stateRoot
      });

      // Best-effort, non-gating pane teardown BEFORE archive: resolve the team
      // while it is still active (archive flips its status, after which resolve
      // would fail), then close every pane for the team. Any failure is swallowed
      // so archiveTeam below always runs and returns exactly as before.
      const paneTeardown = closeTeamPanesBestEffort({
        db: adapter.getDatabase(),
        statePath: state.stateRoot,
        teamName: input.teamName,
        identity,
        options
      });

      const result = service.archiveTeam({
        teamName: input.teamName,
        reason: input.reason,
        identity
      });

      return jsonResponse({
        implemented_now: true,
        ...result,
        ...(paneTeardown ? { pane_teardown: paneTeardown } : {})
      });
    } catch (error) {
      if (isTeamDeleteValidationFailure(error)) {
        appendTeamDeleteValidationFailureEvent(
          adapter.getDatabase(),
          identity,
          buildValidationContext(error)
        );

        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: TEAM_DELETE_VALIDATION_ERROR_CODE,
          message: buildTeamDeleteValidationMessage(error)
        });
      }

      if (error instanceof TeamArchiveResolutionError) {
        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: error.errorCode,
          message: error.message
        });
      }

      return jsonResponse({
        implemented_now: true,
        status: "error",
        error_code: "team_delete_failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      adapter.close();
    }
  };
}

// Best-effort pane teardown for TeamDelete. Returns the {attempted, closed}
// summary on success, or undefined when the team could not be resolved or the
// teardown threw — in which case the caller simply omits pane_teardown. This
// NEVER throws: pane teardown is a pure side effect and must not change archive
// behavior.
function closeTeamPanesBestEffort(input: {
  db: Database.Database;
  statePath: string;
  teamName?: string;
  identity: WorkspaceScopedCallerIdentity;
  options: CodexTeamServerOptions;
}): PaneTeardownSummary | undefined {
  try {
    const resolved = new ContextResolver(input.db).resolveTeam({
      teamName: input.teamName,
      identity: input.identity
    });
    if (!resolved.ok) {
      return undefined;
    }

    return new LifecycleService({
      db: input.db,
      statePath: input.statePath,
      paneMode: input.options.paneMode
    }).closePanesForTeam(resolved.team.teamId);
  } catch {
    return undefined;
  }
}

function parseTeamDeleteInput(args: unknown): {
  teamName?: string;
  reason?: string;
} {
  const input = teamDeleteInputSchema.parse(args);
  const hasExplicitTeamName =
    isRecord(args) && Object.prototype.hasOwnProperty.call(args, "team_name");

  if (!hasExplicitTeamName) {
    return {
      teamName: undefined,
      reason: input.reason
    };
  }

  return {
    teamName: explicitTeamDeleteNameSchema.parse({
      team_name: input.team_name
    }).team_name,
    reason: input.reason
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeDurableState(
  adapter: DurableStateAdapter
): DurableStateRootDescription {
  const state = adapter.describeStateRoot();
  if (state.status !== "durable") {
    throw new Error("Durable Team lifecycle handlers require durable state.");
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

function isTeamCreateValidationFailure(error: unknown): boolean {
  return (
    error instanceof ZodError ||
    (error instanceof Error &&
      error.message === "Team name must include at least one supported character.")
  );
}

function isTeamDeleteValidationFailure(error: unknown): boolean {
  return error instanceof ZodError;
}

function buildValidationContext(error: unknown): {
  fields: string[];
  issue_codes: string[];
} {
  if (error instanceof ZodError) {
    return {
      fields: [
        ...new Set(
          error.issues.map((issue) => issue.path.join(".")).filter((path) => path)
        )
      ],
      issue_codes: [...new Set(error.issues.map((issue) => issue.code))]
    };
  }

  return {
    fields: ["team_name"],
    issue_codes: ["invalid_team_name"]
  };
}

function buildTeamCreateValidationMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return "team_name is required to create a durable team.";
  }

  return error instanceof Error ? error.message : "TeamCreate validation failed.";
}

function buildTeamDeleteValidationMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return "team_name must be a nonblank string with at least one supported character when provided to TeamDelete.";
  }

  return error instanceof Error ? error.message : "TeamDelete validation failed.";
}

function appendTeamCreateValidationFailureEvent(
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
    TEAM_CREATE_VALIDATION_ERROR_CODE,
    JSON.stringify({
      error_code: TEAM_CREATE_VALIDATION_ERROR_CODE,
      fallback_used: identity.fallbackUsed,
      validation
    }),
    new Date().toISOString()
  );
}

function appendTeamDeleteValidationFailureEvent(
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
    TEAM_DELETE_VALIDATION_ERROR_CODE,
    JSON.stringify({
      error_code: TEAM_DELETE_VALIDATION_ERROR_CODE,
      fallback_used: identity.fallbackUsed,
      validation
    }),
    new Date().toISOString()
  );
}
