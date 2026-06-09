import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z, ZodError } from "zod";

import { createExecutionBackendFromOptions } from "../adapters/paneExecutionBackend.js";
import type { DurableStateRootDescription } from "../adapters/state.js";
import { normalizeCallerMetadata } from "../context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../services/callerIdentity.js";
import { TaskService, type TaskUpdateInput } from "../services/taskService.js";
import { DurableStateAdapter } from "../state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../state/schema.js";
import type { CodexTeamServerOptions } from "../types.js";
import {
  optionalCanonicalTeamNameSchema,
  taskCreateSchema,
  taskGetSchema,
  taskListSchema,
  taskUpdateSchema
} from "./schemas.js";

type JsonToolResponse = Promise<{ content: Array<{ type: "text"; text: string }> }>;

const TASK_CREATE_VALIDATION_ERROR_CODE = "task_create_validation_failed";
const TASK_UPDATE_VALIDATION_ERROR_CODE = "task_update_validation_failed";
const TASK_LIST_VALIDATION_ERROR_CODE = "task_list_validation_failed";
const TASK_GET_VALIDATION_ERROR_CODE = "task_get_validation_failed";

const taskCreateInputSchema = z.object({
  ...taskCreateSchema,
  team_name: optionalCanonicalTeamNameSchema
});
const taskUpdateInputSchema = z.object({
  ...taskUpdateSchema,
  team_name: optionalCanonicalTeamNameSchema
}).refine(
  (input) => input.taskId !== undefined || input.task_id !== undefined,
  {
    path: ["taskId"],
    message: "taskId or task_id is required"
  }
);
const taskListInputSchema = z.object({
  ...taskListSchema,
  team_name: optionalCanonicalTeamNameSchema
});
const taskGetInputSchema = z.object({
  ...taskGetSchema,
  team_name: optionalCanonicalTeamNameSchema
}).refine(
  (input) => input.taskId !== undefined || input.task_id !== undefined,
  {
    path: ["taskId"],
    message: "taskId or task_id is required"
  }
);

export function createTaskCreateHandler(
  options: CodexTeamServerOptions = {}
): (args: unknown, extra: unknown) => JsonToolResponse {
  return createTaskToolHandler({
    options,
    toolName: "TaskCreate",
    validationErrorCode: TASK_CREATE_VALIDATION_ERROR_CODE,
    parse: (args) => taskCreateInputSchema.parse(args),
    invoke: (service, input, identity) =>
      service.createTask({
        teamName: input.team_name,
        title: input.title,
        subject: input.subject,
        description: input.description,
        activeForm: input.activeForm,
        active_form: input.active_form,
        owner: input.owner,
        metadata: input.metadata,
        identity
      })
  });
}

export function createTaskUpdateHandler(
  options: CodexTeamServerOptions = {}
): (args: unknown, extra: unknown) => JsonToolResponse {
  return createTaskToolHandler({
    options,
    toolName: "TaskUpdate",
    validationErrorCode: TASK_UPDATE_VALIDATION_ERROR_CODE,
    parse: (args) => taskUpdateInputSchema.parse(args),
    invoke: (service, input, identity) => {
      const updateInput: TaskUpdateInput = {
        teamName: input.team_name,
        taskId: input.taskId,
        task_id: input.task_id,
        identity
      };

      if (Object.prototype.hasOwnProperty.call(input, "subject")) {
        updateInput.subject = input.subject;
      }
      if (Object.prototype.hasOwnProperty.call(input, "status")) {
        updateInput.status = input.status;
      }
      if (Object.prototype.hasOwnProperty.call(input, "owner")) {
        updateInput.owner = input.owner;
      }
      if (Object.prototype.hasOwnProperty.call(input, "description")) {
        updateInput.description = input.description;
      }
      if (Object.prototype.hasOwnProperty.call(input, "activeForm")) {
        updateInput.activeForm = input.activeForm;
      }
      if (Object.prototype.hasOwnProperty.call(input, "active_form")) {
        updateInput.active_form = input.active_form;
      }
      if (Object.prototype.hasOwnProperty.call(input, "notes")) {
        updateInput.notes = input.notes;
      }
      if (Object.prototype.hasOwnProperty.call(input, "addBlocks")) {
        updateInput.addBlocks = input.addBlocks;
      }
      if (Object.prototype.hasOwnProperty.call(input, "addBlockedBy")) {
        updateInput.addBlockedBy = input.addBlockedBy;
      }
      if (Object.prototype.hasOwnProperty.call(input, "metadata")) {
        updateInput.metadata = input.metadata;
      }

      return service.updateTask(updateInput);
    }
  });
}

export function createTaskListHandler(
  options: CodexTeamServerOptions = {}
): (args: unknown, extra: unknown) => JsonToolResponse {
  return createTaskToolHandler({
    options,
    toolName: "TaskList",
    validationErrorCode: TASK_LIST_VALIDATION_ERROR_CODE,
    parse: (args) => taskListInputSchema.parse(args),
    invoke: (service, input, identity) =>
      service.listTasks({
        teamName: input.team_name,
        status: input.status,
        owner: input.owner,
        identity
      })
  });
}

export function createTaskGetHandler(
  options: CodexTeamServerOptions = {}
): (args: unknown, extra: unknown) => JsonToolResponse {
  return createTaskToolHandler({
    options,
    toolName: "TaskGet",
    validationErrorCode: TASK_GET_VALIDATION_ERROR_CODE,
    parse: (args) => taskGetInputSchema.parse(args),
    invoke: (service, input, identity) =>
      service.getTask({
        teamName: input.team_name,
        taskId: input.taskId,
        task_id: input.task_id,
        identity
      })
  });
}

function createTaskToolHandler<TInput>(input: {
  options: CodexTeamServerOptions;
  toolName: string;
  validationErrorCode: string;
  parse: (args: unknown) => TInput;
  invoke: (
    service: TaskService,
    input: TInput,
    identity: WorkspaceScopedCallerIdentity
  ) => Record<string, unknown>;
}): (args: unknown, extra: unknown) => JsonToolResponse {
  return async (args, extra) => {
    const adapter = new DurableStateAdapter(input.options);
    let identity: WorkspaceScopedCallerIdentity | undefined;

    try {
      const state = describeDurableState(adapter);
      identity = buildWorkspaceScopedCallerIdentity({
        workspaceRoot: state.workspaceRoot,
        caller: normalizeCallerMetadata(extra)
      });
      const parsed = input.parse(args);
      const service = new TaskService({
        db: adapter.getDatabase(),
        statePath: state.stateRoot,
        executionBackend: createExecutionBackendFromOptions(input.options)
      });
      const result = input.invoke(service, parsed, identity);

      return jsonResponse({
        implemented_now: true,
        ...result
      });
    } catch (error) {
      if (isTaskValidationFailure(error) && identity) {
        const validation = buildValidationContext(error);
        appendTaskValidationFailureEvent(
          adapter.getDatabase(),
          identity,
          input.validationErrorCode,
          validation
        );

        return jsonResponse({
          implemented_now: true,
          status: "error",
          error_code: input.validationErrorCode,
          message: buildValidationMessage(input.toolName, validation)
        });
      }

      return jsonResponse({
        implemented_now: true,
        status: "error",
        error_code: `${input.toolName.toLowerCase()}_failed`,
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
    throw new Error("Durable task handlers require durable state.");
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

function isTaskValidationFailure(error: unknown): boolean {
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
      issue_codes: ["invalid_task_input"],
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

function appendTaskValidationFailureEvent(
  db: Database.Database,
  identity: WorkspaceScopedCallerIdentity,
  errorCode: string,
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
    errorCode,
    JSON.stringify({
      error_code: errorCode,
      fallback_used: identity.fallbackUsed,
      workspace_root: identity.workspaceRoot,
      caller_key: identity.callerKey,
      validation
    }),
    new Date().toISOString()
  );
}
