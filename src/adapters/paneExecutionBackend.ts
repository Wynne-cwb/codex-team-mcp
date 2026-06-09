import {
  type ExecutionBackend,
  type ExecutionBackendActionResult,
  type ExecutionBackendDescription,
  type ExecutionBackendReconcileResult,
  type ExecutionRunContext,
  type ExecutionTrigger,
  ScaffoldExecutionBackend
} from "./execution.js";
import {
  createDefaultPaneBackendRegistry,
  type PaneBackendMetadata,
  type PaneBackendRegistry,
  type PaneLaunchResult,
  type PaneRunMetadata
} from "./paneBackend.js";
import {
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  WORK_CLASSIFICATIONS
} from "../state/schema.js";
import type { CodexTeamServerOptions, PaneModeOptions } from "../types.js";

type Phase7ExecutionClaim =
  | "durable_start_resume_supported"
  | "durable_start_only_supported"
  | "attach_status_only"
  | "pane_backend_unavailable";

export interface PaneExecutionCommandBuilder {
  buildStartCommand(context: ExecutionRunContext): readonly string[];
  buildResumeCommand(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): readonly string[];
}

export interface PaneExecutionBackendOptions extends PaneModeOptions {
  paneBackend?: PaneBackendRegistry;
  commandBuilder?: PaneExecutionCommandBuilder;
  executionClaim?: Phase7ExecutionClaim;
}

const DEFAULT_EXECUTION_CLAIM: Phase7ExecutionClaim = "attach_status_only";

const CODEX_SESSION_METADATA_UNAVAILABLE =
  "codex_session_metadata_unavailable";
const PANE_BACKEND_UNAVAILABLE_PREFIX = "pane_backend_unavailable";
const WORKSPACE_ISOLATION_REQUIRED =
  "workspace isolation or review diff is required before pane-backed file-modifying work can start";

export class PaneExecutionBackend implements ExecutionBackend {
  private readonly paneBackend: PaneBackendRegistry;
  private readonly commandBuilder: PaneExecutionCommandBuilder;
  private readonly executionClaim: Phase7ExecutionClaim;

  constructor(options: PaneExecutionBackendOptions = {}) {
    this.paneBackend =
      options.paneBackend ??
      createDefaultPaneBackendRegistry({
        preferredBackend: options.preferredBackend,
        sessionPrefix: options.sessionPrefix
      });
    this.commandBuilder =
      options.commandBuilder ?? createDefaultCommandBuilder(options.codexCommand);
    this.executionClaim = options.executionClaim ?? DEFAULT_EXECUTION_CLAIM;
  }

  describeBackend(): ExecutionBackendDescription {
    const pane = sanitizePaneMetadata(this.paneBackend.describeAvailability());
    const backend = backendName(pane);

    if (
      this.executionClaim === "pane_backend_unavailable" ||
      pane.availability_status === "unavailable"
    ) {
      return {
        status: "unavailable",
        teammateExecutionImplemented: false,
        backend,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        capabilities: {
          canStart: false,
          canResume: false,
          canReconcile: true,
          supportsWorkspaces: true
        },
        limitation: paneBackendUnavailableReason(pane)
      };
    }

    if (this.executionClaim === "attach_status_only") {
      return {
        status: "unavailable",
        teammateExecutionImplemented: false,
        backend,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        capabilities: {
          canStart: false,
          canResume: false,
          canReconcile: true,
          supportsWorkspaces: true
        },
        limitation: CODEX_SESSION_METADATA_UNAVAILABLE
      };
    }

    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend,
      backend_status: RUN_BACKEND_STATUSES.running,
      capabilities: {
        canStart: true,
        canResume: this.executionClaim === "durable_start_resume_supported",
        canReconcile: true,
        supportsWorkspaces: true
      }
    };
  }

  startRun(context: ExecutionRunContext): ExecutionBackendActionResult {
    const pane = sanitizePaneMetadata(this.paneBackend.describeAvailability());
    const backend = backendName(pane);

    if (
      this.executionClaim === "pane_backend_unavailable" ||
      pane.availability_status === "unavailable"
    ) {
      return unavailableActionResult(backend, pane, paneBackendUnavailableReason(pane));
    }

    if (fileModifyingWorkRequiresIsolation(context)) {
      return unavailableActionResult(
        backend,
        {
          ...pane,
          availability_status: "degraded",
          degradation_reason: WORKSPACE_ISOLATION_REQUIRED
        },
        WORKSPACE_ISOLATION_REQUIRED
      );
    }

    const command = sanitizeCommandArgs(this.commandBuilder.buildStartCommand(context));

    if (this.executionClaim === "attach_status_only") {
      const launch = safeCreatePane(this.paneBackend, context, command);
      return unsupportedAttachOnlyResult(backend, launch.pane);
    }

    const launch = safeCreatePane(this.paneBackend, context, command);
    if (!launch.ok) {
      return failedActionResult(backend, launch.pane);
    }

    const durableThreadId = normalizeOptionalText(launch.thread_id);
    if (!durableThreadId) {
      return unsupportedAttachOnlyResult(backend, {
        ...launch.pane,
        availability_status: "degraded",
        degradation_reason: CODEX_SESSION_METADATA_UNAVAILABLE
      });
    }

    return {
      status: "started",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendStartAttempted,
      backend,
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: durableThreadId,
      thread_id: durableThreadId,
      process_id: normalizeOptionalText(launch.process_id) ?? undefined,
      workspace_path: context.workspace_path ?? undefined,
      started_at: new Date().toISOString(),
      metadata: {
        pane: sanitizePaneMetadata(launch.pane)
      }
    };
  }

  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    const pane = sanitizePaneMetadata(this.paneBackend.describeAvailability());
    const backend = backendName(pane);

    if (
      this.executionClaim === "pane_backend_unavailable" ||
      pane.availability_status === "unavailable"
    ) {
      return unavailableActionResult(backend, pane, paneBackendUnavailableReason(pane));
    }

    if (this.executionClaim !== "durable_start_resume_supported") {
      return {
        status: "not_resumable",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        backend,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        last_error: CODEX_SESSION_METADATA_UNAVAILABLE,
        metadata: {
          pane: {
            ...pane,
            availability_status: "degraded",
            degradation_reason: CODEX_SESSION_METADATA_UNAVAILABLE
          }
        }
      };
    }

    const durableThreadId = durableThreadIdFromContext(context);
    if (!durableThreadId) {
      return {
        status: "not_resumable",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        backend,
        backend_status: RUN_BACKEND_STATUSES.notStarted,
        last_error: CODEX_SESSION_METADATA_UNAVAILABLE,
        metadata: {
          pane: {
            ...pane,
            availability_status: "degraded",
            degradation_reason: CODEX_SESSION_METADATA_UNAVAILABLE
          }
        }
      };
    }

    const safeContext = {
      ...context,
      metadata: {
        ...context.metadata,
        backend_thread_id: durableThreadId
      }
    };
    const command = sanitizeCommandArgs(
      this.commandBuilder.buildResumeCommand(
        safeContext,
        stripUnsafeTriggerFields(trigger)
      )
    );
    const launch = safeResumePane(
      this.paneBackend,
      safeContext,
      stripUnsafeTriggerFields(trigger),
      command
    );
    if (!launch.ok) {
      return failedActionResult(backend, launch.pane);
    }

    const resumedThreadId = normalizeOptionalText(launch.thread_id) ?? durableThreadId;
    return {
      status: "resumed",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
      backend,
      backend_status: RUN_BACKEND_STATUSES.running,
      backend_run_id: resumedThreadId,
      thread_id: resumedThreadId,
      process_id: normalizeOptionalText(launch.process_id) ?? undefined,
      workspace_path: context.workspace_path ?? undefined,
      metadata: {
        pane: sanitizePaneMetadata(launch.pane)
      }
    };
  }

  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult {
    try {
      const result = this.paneBackend.reconcilePane(context);
      const pane = sanitizePaneMetadata(result.pane);
      return {
        status: result.status,
        backend: backendName(pane),
        backend_status: backendStatusFromReconcileStatus(result.status),
        backend_run_id: durableThreadIdFromContext(context) ?? undefined,
        thread_id: durableThreadIdFromContext(context) ?? undefined,
        process_id: durableProcessIdFromContext(context) ?? pane.pane_id,
        workspace_path: context.workspace_path ?? undefined,
        metadata: {
          pane,
          session_deleted: false
        }
      };
    } catch (error) {
      const pane =
        extractPaneMetadata(context.metadata) ??
        ({
          mode: "pane",
          backend_type: "tmux",
          availability_status: "degraded",
          degradation_reason: sanitizeText(
            error instanceof Error ? error.message : String(error)
          )
        } satisfies PaneRunMetadata["pane"]);

      return {
        status: "unknown",
        backend: backendName(pane),
        backend_status: RUN_BACKEND_STATUSES.unknown,
        last_error: pane.degradation_reason,
        metadata: {
          pane,
          session_deleted: false
        }
      };
    }
  }
}

export function createExecutionBackendFromOptions(
  options: CodexTeamServerOptions
): ExecutionBackend {
  if (options.executionBackend) {
    return options.executionBackend;
  }

  if (options.paneMode?.enabled === true) {
    return new PaneExecutionBackend(options.paneMode);
  }

  return new ScaffoldExecutionBackend();
}

export function extractPaneMetadata(
  metadata: Record<string, unknown> | undefined
): PaneRunMetadata["pane"] | null {
  if (!metadata) {
    return null;
  }

  const backendMetadata = metadata.backend_metadata;
  if (isRecord(backendMetadata) && isPaneMetadata(backendMetadata.pane)) {
    return sanitizePaneMetadata(backendMetadata.pane);
  }

  if (isPaneMetadata(metadata.pane)) {
    return sanitizePaneMetadata(metadata.pane);
  }

  return null;
}

function createDefaultCommandBuilder(
  codexCommand: string | undefined
): PaneExecutionCommandBuilder {
  const command = normalizeOptionalText(codexCommand) ?? "codex";
  return {
    buildStartCommand() {
      return [command, "exec", "--json", "printf codex-team-pane-start"];
    },
    buildResumeCommand(context) {
      return [
        command,
        "exec",
        "resume",
        "--json",
        durableThreadIdFromContext(context) ?? ""
      ];
    }
  };
}

function safeCreatePane(
  paneBackend: PaneBackendRegistry,
  context: ExecutionRunContext,
  command: readonly string[]
): PaneLaunchResult {
  try {
    return paneBackend.createPane(context, command);
  } catch (error) {
    return {
      ok: false,
      pane: {
        mode: "pane",
        backend_type: "tmux",
        availability_status: "degraded",
        degradation_reason: sanitizeText(
          error instanceof Error ? error.message : String(error)
        )
      }
    };
  }
}

function safeResumePane(
  paneBackend: PaneBackendRegistry,
  context: ExecutionRunContext,
  trigger: ExecutionTrigger,
  command: readonly string[]
): PaneLaunchResult {
  try {
    return paneBackend.resumePane(context, trigger, command);
  } catch (error) {
    return {
      ok: false,
      pane: {
        mode: "pane",
        backend_type: "tmux",
        availability_status: "degraded",
        degradation_reason: sanitizeText(
          error instanceof Error ? error.message : String(error)
        )
      }
    };
  }
}

function unavailableActionResult(
  backend: string,
  pane: PaneRunMetadata["pane"],
  reason: string
): ExecutionBackendActionResult {
  return {
    status: "unsupported",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
    backend,
    backend_status: RUN_BACKEND_STATUSES.notStarted,
    last_error: sanitizeText(reason),
    metadata: {
      pane: sanitizePaneMetadata(pane)
    }
  };
}

function unsupportedAttachOnlyResult(
  backend: string,
  pane: PaneRunMetadata["pane"]
): ExecutionBackendActionResult {
  return {
    status: "unsupported",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
    backend,
    backend_status: RUN_BACKEND_STATUSES.notStarted,
    last_error: CODEX_SESSION_METADATA_UNAVAILABLE,
    metadata: {
      pane: {
        ...sanitizePaneMetadata(pane),
        availability_status: "degraded",
        degradation_reason: CODEX_SESSION_METADATA_UNAVAILABLE
      }
    }
  };
}

function failedActionResult(
  backend: string,
  pane: PaneRunMetadata["pane"]
): ExecutionBackendActionResult {
  return {
    status: "backend_failed",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
    backend,
    backend_status: RUN_BACKEND_STATUSES.failed,
    last_error: pane.degradation_reason ?? "pane_backend_failed",
    metadata: {
      pane: {
        ...sanitizePaneMetadata(pane),
        availability_status:
          pane.availability_status === "unavailable" ? "unavailable" : "degraded"
      }
    }
  };
}

function paneBackendUnavailableReason(pane: PaneRunMetadata["pane"]): string {
  const reason = pane.degradation_reason ?? "no pane backend is available";
  return `${PANE_BACKEND_UNAVAILABLE_PREFIX}:${sanitizeText(reason)}`;
}

function fileModifyingWorkRequiresIsolation(context: ExecutionRunContext): boolean {
  if (
    context.work_classification !== WORK_CLASSIFICATIONS.codeImplementation &&
    context.work_classification !== WORK_CLASSIFICATIONS.artifactWriting
  ) {
    return false;
  }

  return (
    context.isolation_kind !== "git_worktree" &&
    context.isolation_kind !== "review_diff" &&
    context.isolation_kind !== "declared_output_path"
  );
}

function durableThreadIdFromContext(context: ExecutionRunContext): string | null {
  return (
    stringFromMetadata(context.metadata, "backend_thread_id") ??
    stringFromMetadata(context.metadata, "thread_id") ??
    stringFromMetadata(context.metadata, "backend_run_id") ??
    stringFromNestedMetadata(context.metadata, "backend_metadata", "thread_id") ??
    stringFromNestedMetadata(
      context.metadata,
      "backend_metadata",
      "backend_thread_id"
    )
  );
}

function durableProcessIdFromContext(context: ExecutionRunContext): string | null {
  return (
    stringFromMetadata(context.metadata, "backend_process_id") ??
    stringFromMetadata(context.metadata, "process_id") ??
    stringFromNestedMetadata(
      context.metadata,
      "backend_metadata",
      "backend_process_id"
    )
  );
}

function stringFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | null {
  if (!metadata) {
    return null;
  }

  return normalizeOptionalText(metadata[key]);
}

function stringFromNestedMetadata(
  metadata: Record<string, unknown> | undefined,
  containerKey: string,
  key: string
): string | null {
  if (!metadata || !isRecord(metadata[containerKey])) {
    return null;
  }

  return normalizeOptionalText(metadata[containerKey][key]);
}

function stripUnsafeTriggerFields(trigger: ExecutionTrigger): ExecutionTrigger {
  return {
    kind: trigger.kind,
    occurred_at: trigger.occurred_at,
    reason: trigger.reason
  };
}

function sanitizeCommandArgs(args: readonly string[]): string[] {
  return args.map((arg) => sanitizeText(arg));
}

function sanitizePaneMetadata(pane: PaneBackendMetadata): PaneRunMetadata["pane"] {
  return {
    mode: "pane",
    backend_type:
      pane.backend_type === "iterm2" || pane.backend_type === "tmux"
        ? pane.backend_type
        : "tmux",
    availability_status:
      pane.availability_status === "available" ||
      pane.availability_status === "unavailable" ||
      pane.availability_status === "degraded"
        ? pane.availability_status
        : "degraded",
    degradation_reason: normalizeOptionalText(pane.degradation_reason) ?? undefined,
    pane_id: normalizeOptionalText(pane.pane_id) ?? undefined,
    session_name: normalizeOptionalText(pane.session_name) ?? undefined,
    window_name: normalizeOptionalText(pane.window_name) ?? undefined,
    socket_name: normalizeOptionalText(pane.socket_name) ?? undefined,
    attach_command: normalizeOptionalText(pane.attach_command) ?? undefined,
    is_native: pane.is_native
  };
}

function backendName(pane: PaneRunMetadata["pane"]): string {
  return pane.backend_type;
}

function backendStatusFromReconcileStatus(
  status: ExecutionBackendReconcileResult["status"]
) {
  if (status === "active") {
    return RUN_BACKEND_STATUSES.running;
  }
  if (status === "idle") {
    return RUN_BACKEND_STATUSES.idle;
  }
  if (status === "stopped" || status === "unsupported") {
    return RUN_BACKEND_STATUSES.notStarted;
  }
  if (status === "failed") {
    return RUN_BACKEND_STATUSES.failed;
  }
  if (status === "stale") {
    return RUN_BACKEND_STATUSES.stale;
  }

  return RUN_BACKEND_STATUSES.unknown;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const sanitized = sanitizeText(value).trim();
  return sanitized ? sanitized : null;
}

function sanitizeText(value: string): string {
  return value
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPaneMetadata(value: unknown): value is PaneBackendMetadata {
  return (
    isRecord(value) &&
    value.mode === "pane" &&
    (value.backend_type === "tmux" || value.backend_type === "iterm2") &&
    (value.availability_status === "available" ||
      value.availability_status === "unavailable" ||
      value.availability_status === "degraded")
  );
}
