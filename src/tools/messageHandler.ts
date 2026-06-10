import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z, ZodError } from "zod";

import { createExecutionBackendFromOptions } from "../adapters/paneExecutionBackend.js";
import type { DurableStateRootDescription } from "../adapters/state.js";
import { normalizeCallerMetadata } from "../context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { MessageService } from "../services/messageService.js";
import { DurableStateAdapter } from "../state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../state/schema.js";
import type { CodexTeamServerOptions } from "../types.js";
import { optionalCanonicalTeamNameSchema, sendMessageSchema } from "./schemas.js";

type JsonToolResponse = Promise<{ content: Array<{ type: "text"; text: string }> }>;

const SEND_MESSAGE_VALIDATION_ERROR_CODE = "send_message_validation_failed";
const sendMessageInputSchema = z.object({
  ...sendMessageSchema,
  team_name: optionalCanonicalTeamNameSchema
});

export function createSendMessageHandler(
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
      const input = sendMessageInputSchema.parse(args);
      const service = new MessageService({
        db: adapter.getDatabase(),
        statePath: state.stateRoot,
        executionBackend: createExecutionBackendFromOptions(options),
        paneMode: options.paneMode
      });
      const result = service.sendMessage({
        teamName: input.team_name,
        to: input.to,
        message: input.message,
        from: input.from,
        summary: input.summary,
        identity
      });

      return jsonResponse({
        implemented_now: true,
        ...result
      });
    } catch (error) {
      if (isSendMessageValidationFailure(error) && identity) {
        const validation = buildValidationContext(error);
        appendSendMessageValidationFailureEvent(
          adapter.getDatabase(),
          identity,
          validation
        );

        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: SEND_MESSAGE_VALIDATION_ERROR_CODE,
          message: buildValidationMessage("SendMessage", validation)
        });
      }

      return jsonResponse({
        implemented_now: true,
        status: "error",
        error_code: "send_message_failed",
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
    throw new Error("Durable SendMessage handler requires durable state.");
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

function isSendMessageValidationFailure(error: unknown): boolean {
  return error instanceof ZodError;
}

interface ValidationContext {
  fields: string[];
  issue_codes: string[];
  redacted_field_count: number;
}

const sensitiveValidationFields = new Set([
  "message",
  "body",
  "payload_json",
  "prompt",
  "notes",
  "description"
]);

function buildValidationContext(error: unknown): ValidationContext {
  if (!(error instanceof ZodError)) {
    return {
      fields: [],
      issue_codes: ["invalid_send_message_input"],
      redacted_field_count: 0
    };
  }

  const fields = new Set<string>();
  let redactedFieldCount = 0;
  for (const issue of error.issues) {
    const path = issue.path.join(".");
    if (!path) {
      continue;
    }

    const rootField = String(issue.path[0] ?? "");
    if (sensitiveValidationFields.has(rootField)) {
      redactedFieldCount += 1;
      continue;
    }

    fields.add(path);
  }

  return {
    fields: [...fields],
    issue_codes: [...new Set(error.issues.map((issue) => issue.code))],
    redacted_field_count: redactedFieldCount
  };
}

function buildValidationMessage(
  toolName: string,
  validation: ValidationContext
): string {
  const fields =
    validation.fields.length > 0 ? ` for fields: ${validation.fields.join(", ")}` : "";

  return `${toolName} input validation failed${fields}.`;
}

function appendSendMessageValidationFailureEvent(
  db: Database.Database,
  identity: WorkspaceScopedCallerIdentity,
  validation: ValidationContext
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
    SEND_MESSAGE_VALIDATION_ERROR_CODE,
    JSON.stringify({
      error_code: SEND_MESSAGE_VALIDATION_ERROR_CODE,
      fallback_used: identity.fallbackUsed,
      workspace_root: identity.workspaceRoot,
      caller_key: identity.callerKey,
      validation
    }),
    new Date().toISOString()
  );
}
