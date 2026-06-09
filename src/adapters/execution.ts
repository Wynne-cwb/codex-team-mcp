import {
  MESSAGE_DELIVERY_STATUSES,
  RUN_BACKEND_STATUSES,
  type MessageDeliveryStatus,
  type RunBackendStatus
} from "../state/schema.js";

export interface ExecutionBackendCapabilities {
  canStart: boolean;
  canResume: boolean;
  canReconcile: boolean;
  supportsWorkspaces: boolean;
}

export interface ExecutionBackendDescription {
  status: "scheduled_only" | "available" | "unavailable";
  teammateExecutionImplemented: boolean;
  backend: string;
  backend_status: RunBackendStatus;
  capabilities: ExecutionBackendCapabilities;
  limitation?: string;
}

export interface ExecutionRunContext {
  run_id: string;
  team_id: string;
  member_id: string | null;
  teammate_id?: string;
  team_name?: string;
  workspace_root: string;
  prompt_present: boolean;
  work_classification?: string | null;
  isolation_kind?: string | null;
  workspace_path?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ExecutionTrigger {
  kind:
    | "agent_create"
    | "message"
    | "task_assignment"
    | "manual"
    | "startup_reconcile"
    | "status_reconcile";
  message_id?: string;
  task_id?: string;
  occurred_at?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type ExecutionBackendActionStatus =
  | "started"
  | "resumed"
  | "queued"
  | "unsupported"
  | "backend_failed"
  | "not_resumable";

export interface ExecutionBackendActionResult {
  status: ExecutionBackendActionStatus;
  delivery_status: MessageDeliveryStatus;
  backend: string;
  backend_status: RunBackendStatus;
  backend_run_id?: string;
  thread_id?: string;
  process_id?: string;
  workspace_path?: string;
  started_at?: string;
  ended_at?: string;
  last_error?: string;
  metadata?: Record<string, unknown>;
}

export type ExecutionBackendReconcileStatus =
  | "active"
  | "idle"
  | "stopped"
  | "failed"
  | "stale"
  | "unsupported"
  | "unknown";

export interface ExecutionBackendReconcileResult {
  status: ExecutionBackendReconcileStatus;
  backend: string;
  backend_status: RunBackendStatus;
  backend_run_id?: string;
  thread_id?: string;
  process_id?: string;
  workspace_path?: string;
  started_at?: string;
  ended_at?: string;
  last_error?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionBackend {
  describeBackend(): ExecutionBackendDescription;
  startRun(context: ExecutionRunContext): ExecutionBackendActionResult;
  resumeRun(
    context: ExecutionRunContext,
    trigger: ExecutionTrigger
  ): ExecutionBackendActionResult;
  reconcileRun(context: ExecutionRunContext): ExecutionBackendReconcileResult;
}

const unsupportedCapabilities: ExecutionBackendCapabilities = {
  canStart: false,
  canResume: false,
  canReconcile: false,
  supportsWorkspaces: false
};

const unsupportedLimitation =
  "No execution backend is configured; TeamMate start, resume, and reconcile actions are unsupported.";

export class ScaffoldExecutionBackend implements ExecutionBackend {
  describeBackend(): ExecutionBackendDescription {
    return {
      status: "scheduled_only",
      teammateExecutionImplemented: false,
      backend: "none",
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      capabilities: unsupportedCapabilities,
      limitation: unsupportedLimitation
    };
  }

  startRun(_context: ExecutionRunContext): ExecutionBackendActionResult {
    return this.unsupportedActionResult();
  }

  resumeRun(
    _context: ExecutionRunContext,
    _trigger: ExecutionTrigger
  ): ExecutionBackendActionResult {
    return this.unsupportedActionResult();
  }

  reconcileRun(_context: ExecutionRunContext): ExecutionBackendReconcileResult {
    return {
      status: "unsupported",
      backend: "none",
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: unsupportedLimitation
    };
  }

  private unsupportedActionResult(): ExecutionBackendActionResult {
    return {
      status: "unsupported",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      backend: "none",
      backend_status: RUN_BACKEND_STATUSES.notStarted,
      last_error: unsupportedLimitation
    };
  }
}
