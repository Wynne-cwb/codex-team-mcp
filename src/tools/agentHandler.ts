import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z, ZodError } from "zod";

import { createExecutionBackendFromOptions } from "../adapters/paneExecutionBackend.js";
import { normalizeCallerMetadata } from "../context/caller.js";
import { AgentService } from "../services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { canonicalizeTeamName } from "../services/teamNames.js";
import type { WorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import type { DurableStateRootDescription } from "../adapters/state.js";
import { DurableStateAdapter } from "../state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../state/schema.js";
import type { CodexTeamServerOptions } from "../types.js";

type JsonToolResponse = Promise<{ content: Array<{ type: "text"; text: string }> }>;

const AGENT_VALIDATION_ERROR_CODE = "agent_validation_failed";

const agentNameSchema = z
  .string()
  .transform((value) => value.trim())
  .refine(
    (value) => value.length === 0 || /[a-z0-9]/i.test(value),
    "name must include at least one supported character"
  )
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional();

const agentTeamNameSchema = z
  .string()
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
  .optional();

const agentInputSchema = z.object({
  name: agentNameSchema,
  team_name: agentTeamNameSchema,
  mode: z.string().optional(),
  prompt: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  agent_type: z.string().optional(),
  subagent_type: z.string().optional(),
  run_in_background: z.boolean().optional(),
  isolation: z.string().optional(),
  cwd: z.string().optional()
});

export function createAgentHandler(
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
      const input = agentInputSchema.parse(args);
      const service = new AgentService({
        db: adapter.getDatabase(),
        statePath: state.stateRoot,
        executionBackend: createExecutionBackendFromOptions(options),
        paneMode: options.paneMode
      });
      const result = service.createAgent({
        name: input.name,
        teamName: input.team_name,
        mode: input.mode,
        prompt: input.prompt,
        description: input.description,
        modelHint: input.model,
        agentType: input.agent_type,
        subagentType: input.subagent_type,
        runInBackground: input.run_in_background,
        isolation: input.isolation,
        cwd: input.cwd,
        identity
      });

      return jsonResponse({
        implemented_now: true,
        ...result
      });
    } catch (error) {
      if (isAgentValidationFailure(error) && identity) {
        appendAgentValidationFailureEvent(
          adapter.getDatabase(),
          identity,
          buildValidationContext(error)
        );

        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: AGENT_VALIDATION_ERROR_CODE,
          message: buildAgentValidationMessage(error)
        });
      }

      return jsonResponse({
        implemented_now: true,
        status: "error",
        error_code: "agent_failed",
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
    throw new Error("Durable Agent handler requires durable state.");
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

function isAgentValidationFailure(error: unknown): boolean {
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
    fields: [],
    issue_codes: ["invalid_agent_input"]
  };
}

function buildAgentValidationMessage(error: unknown): string {
  if (error instanceof ZodError) {
    const validation = buildValidationContext(error);
    const fields =
      validation.fields.length > 0 ? ` for fields: ${validation.fields.join(", ")}` : "";

    return `Agent input validation failed${fields}.`;
  }

  return "Agent input validation failed.";
}

function appendAgentValidationFailureEvent(
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
    AGENT_VALIDATION_ERROR_CODE,
    JSON.stringify({
      error_code: AGENT_VALIDATION_ERROR_CODE,
      fallback_used: identity.fallbackUsed,
      validation
    }),
    new Date().toISOString()
  );
}
