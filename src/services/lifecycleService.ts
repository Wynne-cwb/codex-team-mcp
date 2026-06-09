import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  type ExecutionBackend,
  type ExecutionBackendActionResult,
  type ExecutionBackendCapabilities,
  type ExecutionBackendDescription,
  type ExecutionTrigger,
  ScaffoldExecutionBackend
} from "../adapters/execution.js";
import { extractPaneMetadata } from "../adapters/paneExecutionBackend.js";
import {
  EVENT_TYPES,
  ISOLATION_KINDS,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ROW_STATUSES,
  MEMBER_STATUSES,
  RUN_BACKEND_STATUSES,
  RUN_REVIEW_STATUSES,
  TABLE_NAMES,
  WORK_CLASSIFICATIONS,
  type IsolationKind,
  type MessageDeliveryStatus,
  type RunBackendStatus,
  type RunReviewStatus,
  type WorkClassification
} from "../state/schema.js";
import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import {
  WorkspaceSafetyService,
  type WorkspaceBackendCapabilities,
  type WorkspaceSafetyReadyResult,
  type WorkspaceSafetyResult
} from "./workspaceSafetyService.js";

export interface LifecycleServiceOptions {
  db: Database.Database;
  statePath: string;
  executionBackend?: ExecutionBackend;
  workspaceSafetyService?: WorkspaceSafetyService;
}

export interface WorkClassificationInput {
  mode?: string | null;
  description?: string | null;
  prompt?: string | null;
  isolation?: string | null;
}

export interface WorkClassificationResult {
  work_classification: WorkClassification;
}

interface LifecycleRunContextInput {
  team_id: string;
  team_name: string;
  member_id: string;
  run_id: string;
  teammate_id: string;
  prompt_present: boolean;
  identity: WorkspaceScopedCallerIdentity;
}

export interface StartScheduledRunInput extends LifecycleRunContextInput {
  prompt?: string | null;
  mode?: string | null;
  description?: string | null;
  cwd?: string | null;
  isolation?: string | null;
  workspace_path?: string | null;
  review_diff_artifact_path?: string | null;
  declared_output_path?: string | null;
  base_revision?: string | null;
}

export interface DeliveryLifecycleInput {
  message_id: string;
  team_id: string;
  team_name: string;
  sender_member_id: string;
  recipient_member_id: string;
  recipient_status: string;
  teammate_id: string;
  summary?: string | null;
  task_id?: string | null;
  trigger_kind?: "message" | "task_assignment";
  run_id?: string | null;
  identity: WorkspaceScopedCallerIdentity;
}

export interface ResumeRunInput extends LifecycleRunContextInput {
  message_id: string;
  recipient_status: string;
  summary?: string | null;
  task_id?: string | null;
  trigger_kind?: "message" | "task_assignment" | "manual";
}

export interface LifecycleDeliveryResult {
  delivery_status: MessageDeliveryStatus;
  message_row_status: typeof MESSAGE_ROW_STATUSES.queued;
  error_code?: LifecycleActionResult["error_code"] | "recipient_stale";
  backend: LifecycleBackendResult;
  lifecycle: LifecycleMetadataResult;
  debug: LifecycleDebugResult & {
    message_id: string;
    run_id?: string;
    recipient_status: string;
  };
}

export interface LifecycleActionResult {
  status: "scheduled" | "running" | "idle" | "stopped" | "failed" | "stale";
  delivery_status: MessageDeliveryStatus;
  error_code?: "workspace_isolation_required" | "backend_failed" | "backend_unavailable";
  backend: LifecycleBackendResult;
  lifecycle: LifecycleMetadataResult;
  debug: LifecycleDebugResult;
}

export interface LifecycleBackendResult {
  status: RunBackendStatus;
  backend: string;
  execution_available: boolean;
  teammate_execution_implemented: boolean;
  pane?: LifecyclePaneMetadata;
  backend_run_id?: string;
  thread_id?: string;
  process_id?: string;
  workspace_path?: string;
  last_error?: string;
  limitation?: string;
}

type LifecyclePaneMetadata = NonNullable<ReturnType<typeof extractPaneMetadata>>;

export interface LifecycleMetadataResult {
  work_classification: WorkClassification;
  isolation_kind: IsolationKind;
  review_status: RunReviewStatus;
  workspace_path?: string;
  review_diff_artifact_path?: string;
  declared_output_path?: string;
  base_revision?: string;
}

export interface LifecycleDebugResult {
  prompt_present: boolean;
  safety_status: WorkspaceSafetyResult["status"];
  backend_action: "not_attempted" | "start_attempted" | "resume_attempted";
}

interface RunMetadataRow {
  metadata_json: string;
}

interface MemberMetadataRow {
  metadata_json: string;
}

interface RunBackendFieldsRow {
  backend_run_id: string | null;
  backend_thread_id: string | null;
  backend_process_id: string | null;
}

interface DeliveryRunRow {
  run_id: string;
  team_id: string;
  member_id: string | null;
  status: string;
  backend: string | null;
  workspace_path: string | null;
  metadata_json: string;
  last_error: string | null;
  backend_status: RunBackendStatus | null;
  backend_run_id: string | null;
  backend_thread_id: string | null;
  backend_process_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  work_classification: WorkClassification | null;
  isolation_kind: IsolationKind | null;
  base_revision: string | null;
  review_status: RunReviewStatus | null;
}

const BACKEND_FAILED_ERROR_CODE = "backend_failed";
const BACKEND_UNAVAILABLE_ERROR_CODE = "backend_unavailable";
const WORKSPACE_ISOLATION_ERROR_CODE = "workspace_isolation_required";
const BACKEND_RESUME_METADATA_MISSING_ERROR_CODE =
  "backend_resume_metadata_missing";
const PROMPT_REDACTION = "[redacted_prompt]";
const QUEUED_FOR_NEXT_TURN_DELIVERY_STATUS =
  MESSAGE_DELIVERY_STATUSES.queuedForNextTurn satisfies "queued_for_next_turn";
const CODE_IMPLEMENTATION_CLASSIFICATION =
  WORK_CLASSIFICATIONS.codeImplementation satisfies "code_implementation";
const PENDING_REVIEW_STATUS =
  RUN_REVIEW_STATUSES.pendingReview satisfies "pending_review";
const TEAMMATE_BACKEND_START_ATTEMPTED_EVENT_TYPE =
  EVENT_TYPES.teammateBackendStartAttempted satisfies "teammate_backend_start_attempted";
const TEAMMATE_BACKEND_RESUME_ATTEMPTED_EVENT_TYPE =
  EVENT_TYPES.teammateBackendResumeAttempted satisfies "teammate_backend_resume_attempted";
const TEAMMATE_LIFECYCLE_TRANSITION_EVENT_TYPE =
  EVENT_TYPES.teammateLifecycleTransition satisfies "teammate_lifecycle_transition";
const WRITE_INTENT_PATTERN =
  /\b(add|build|delete|edit|fix|implement|modify|move|patch|remove|rename|refactor|update)\b|\bchange\b|\bcreate[-_ ]file\b|\bwrite[-_ ]code\b|\bapply[-_ ]changes\b|\bmake[-_ ]changes\b|\b(?:write|create|make)\b(?:\s+\w+){0,3}\s+\b(code|files?|migrations?|modules?|tests?)\b/;
const ARTIFACT_INTENT_PATTERN =
  /(?=.*\b(write|draft|create|produce|output|generate)\b)(?=.*\b(docs?|documents?|artifact|report)\b)/;
const REVIEW_ONLY_PATTERN = /\b(review|audit)\b/;
const READ_ONLY_PATTERN =
  /\b(read[-_ ]?only|read only|no[-_ ]?change|no changes?|inspect|research|status|summari[sz]e)\b/;

export class LifecycleService {
  private readonly executionBackend: ExecutionBackend;
  private readonly workspaceSafetyService: WorkspaceSafetyService;

  constructor(private readonly options: LifecycleServiceOptions) {
    this.executionBackend =
      options.executionBackend ?? new ScaffoldExecutionBackend();
    this.workspaceSafetyService =
      options.workspaceSafetyService ?? new WorkspaceSafetyService();
  }

  classifyWork(input: WorkClassificationInput): WorkClassificationResult {
    const mode = normalizeOptionalText(input.mode)?.toLowerCase() ?? "";
    const isolation =
      normalizeOptionalText(input.isolation)?.toLowerCase() ?? "";
    const text = [input.description, input.prompt, input.mode]
      .map((value) => normalizeOptionalText(value)?.toLowerCase())
      .filter((value): value is string => Boolean(value))
      .join(" ");

    if (
      isolation === "worktree" ||
      mode === "write" ||
      mode === "implementation" ||
      mode === "code"
    ) {
      return { work_classification: CODE_IMPLEMENTATION_CLASSIFICATION };
    }

    if (WRITE_INTENT_PATTERN.test(text)) {
      return { work_classification: CODE_IMPLEMENTATION_CLASSIFICATION };
    }

    if (ARTIFACT_INTENT_PATTERN.test(text)) {
      return { work_classification: WORK_CLASSIFICATIONS.artifactWriting };
    }

    if (REVIEW_ONLY_PATTERN.test(text)) {
      return { work_classification: WORK_CLASSIFICATIONS.reviewOnly };
    }

    if (mode === "read" || mode === "read-only" || mode === "read_only") {
      return { work_classification: WORK_CLASSIFICATIONS.readOnly };
    }

    if (READ_ONLY_PATTERN.test(text)) {
      return { work_classification: WORK_CLASSIFICATIONS.readOnly };
    }

    if (text.length > 0) {
      return { work_classification: CODE_IMPLEMENTATION_CLASSIFICATION };
    }

    return { work_classification: WORK_CLASSIFICATIONS.readOnly };
  }

  attemptDeliveryAfterPersistence(
    input: DeliveryLifecycleInput
  ): LifecycleDeliveryResult {
    const backendDescription = this.executionBackend.describeBackend();

    if (input.recipient_status === MEMBER_STATUSES.running) {
      return this.buildDeliveryResult({
        input,
        deliveryStatus: QUEUED_FOR_NEXT_TURN_DELIVERY_STATUS,
        backendDescription,
        lifecycle: defaultLifecycleMetadataResult(),
        backendAction: "not_attempted"
      });
    }

    if (input.recipient_status === MEMBER_STATUSES.stale) {
      return this.buildDeliveryResult({
        input,
        deliveryStatus: MESSAGE_DELIVERY_STATUSES.recipientStale,
        errorCode: "recipient_stale",
        backendDescription,
        lifecycle: defaultLifecycleMetadataResult(),
        backendAction: "not_attempted"
      });
    }

    const run = this.findDeliveryRun(input);
    if (!run) {
      return this.buildDeliveryResult({
        input,
        deliveryStatus: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        errorCode: BACKEND_UNAVAILABLE_ERROR_CODE,
        backendDescription,
        lifecycle: defaultLifecycleMetadataResult(),
        backendAction: "not_attempted"
      });
    }

    if (input.recipient_status === MEMBER_STATUSES.scheduled) {
      const startResult = this.startScheduledRun(
        this.buildStartInputFromDeliveryRun(input, run)
      );

      return this.buildDeliveryResultFromAction({
        input,
        runId: run.run_id,
        actionResult: startResult,
        deliveryStatus:
          startResult.status === "running"
            ? MESSAGE_DELIVERY_STATUSES.backendStartAttempted
            : startResult.delivery_status
      });
    }

    if (
      input.recipient_status === MEMBER_STATUSES.idle ||
      input.recipient_status === MEMBER_STATUSES.stopped
    ) {
      const resumeResult = this.resumeRun({
        team_id: input.team_id,
        team_name: input.team_name,
        member_id: input.recipient_member_id,
        run_id: run.run_id,
        teammate_id: input.teammate_id,
        prompt_present: false,
        message_id: input.message_id,
        recipient_status: input.recipient_status,
        summary: input.summary,
        task_id: input.task_id,
        trigger_kind: input.trigger_kind,
        identity: input.identity
      });

      return this.buildDeliveryResultFromAction({
        input,
        runId: run.run_id,
        actionResult: resumeResult,
        deliveryStatus:
          resumeResult.status === "running"
            ? MESSAGE_DELIVERY_STATUSES.backendResumeAttempted
            : resumeResult.delivery_status
      });
    }

    return this.buildDeliveryResult({
      input,
      deliveryStatus: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      errorCode: BACKEND_UNAVAILABLE_ERROR_CODE,
      backendDescription,
      lifecycle: buildLifecycleMetadataResult(
        resolveRunClassification(run),
        buildSafetyResultFromRun(run)
      ),
      backendAction: "not_attempted",
      runId: run.run_id
    });
  }

  startScheduledRun(input: StartScheduledRunInput): LifecycleActionResult {
    const backendDescription = this.executionBackend.describeBackend();
    const classification = this.classifyWork(input).work_classification;
    const safety = this.prepareSafety(input, backendDescription, classification);

    if (backendDescription.capabilities.canStart !== true) {
      this.updateRunLifecycle({
        input,
        classification,
        safety,
        memberStatus: MEMBER_STATUSES.scheduled,
        runStatus: MEMBER_STATUSES.scheduled,
        backend: backendDescription.backend,
        backendStatus: backendDescription.backend_status,
        lastError: backendDescription.limitation ?? null,
        updatedAt: new Date().toISOString()
      });

      return this.buildScheduledResult({
        backendDescription,
        classification,
        safety,
        deliveryStatus: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        errorCode: BACKEND_UNAVAILABLE_ERROR_CODE,
        lastError: backendDescription.limitation,
        promptPresent: input.prompt_present
      });
    }

    if (isFileModifyingWork(classification) && !isStartSafe(safety, classification)) {
      this.markWorkspaceReviewRequired(input, classification, safety);
      return this.buildScheduledResult({
        backendDescription,
        classification,
        safety,
        deliveryStatus: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        errorCode: WORKSPACE_ISOLATION_ERROR_CODE,
        lastError: WORKSPACE_ISOLATION_ERROR_CODE,
        promptPresent: input.prompt_present
      });
    }

    const attemptedAt = new Date().toISOString();
    const startContext = {
      run_id: input.run_id,
      team_id: input.team_id,
      member_id: input.member_id,
      teammate_id: input.teammate_id,
      team_name: input.team_name,
      workspace_root: input.identity.workspaceRoot,
      prompt_present: input.prompt_present,
      work_classification: classification,
      isolation_kind: safety.isolation_kind,
      workspace_path: safety.status === "ready" ? safety.workspace_path : null,
      metadata: {
        prompt: input.prompt ?? null,
        prompt_present: input.prompt_present,
        mode: normalizeOptionalText(input.mode),
        description: normalizeOptionalText(input.description),
        cwd: normalizeOptionalText(input.cwd),
        review_diff_artifact_path:
          safety.status === "ready" ? safety.review_diff_artifact_path : null,
        declared_output_path:
          safety.status === "ready" ? safety.declared_output_path : null,
        base_revision: safety.status === "ready" ? safety.base_revision : null
      }
    };
    const actionResult = (() => {
      try {
        return this.executionBackend.startRun(startContext);
      } catch (error) {
        return coerceBackendActionException(
          error,
          backendDescription,
          MESSAGE_DELIVERY_STATUSES.backendFailed
        );
      }
    })();
    const sanitizedLastError = sanitizeText(
      actionResult.last_error,
      input.prompt
    );

    this.appendBackendStartAttemptedEvent({
      input,
      classification,
      safety,
      actionResult,
      lastError: sanitizedLastError,
      createdAt: attemptedAt
    });

    if (actionResult.status === "started") {
      this.updateRunLifecycle({
        input,
        classification,
        safety,
        actionResult,
        memberStatus: MEMBER_STATUSES.running,
        runStatus: MEMBER_STATUSES.running,
        backend: actionResult.backend,
        backendStatus: actionResult.backend_status,
        lastError: null,
        updatedAt: actionResult.started_at ?? attemptedAt
      });
      this.appendLifecycleTransitionEvent({
        input,
        fromStatus: MEMBER_STATUSES.scheduled,
        toStatus: MEMBER_STATUSES.running,
        classification,
        safety,
        actionResult,
        createdAt: actionResult.started_at ?? attemptedAt
      });

      return {
        status: "running",
        delivery_status: actionResult.delivery_status,
        backend: this.buildBackendResultFromAction(
          backendDescription,
          actionResult,
          sanitizedLastError
        ),
        lifecycle: buildLifecycleMetadataResult(classification, safety),
        debug: {
          prompt_present: input.prompt_present,
          safety_status: safety.status,
          backend_action: "start_attempted"
        }
      };
    }

    if (actionResult.status === "backend_failed") {
      this.updateRunLifecycle({
        input,
        classification,
        safety,
        actionResult,
        memberStatus: MEMBER_STATUSES.failed,
        runStatus: MEMBER_STATUSES.failed,
        backend: actionResult.backend,
        backendStatus: actionResult.backend_status,
        lastError: sanitizedLastError ?? BACKEND_FAILED_ERROR_CODE,
        updatedAt: attemptedAt
      });
      this.appendLifecycleTransitionEvent({
        input,
        fromStatus: MEMBER_STATUSES.scheduled,
        toStatus: MEMBER_STATUSES.failed,
        classification,
        safety,
        actionResult,
        createdAt: attemptedAt
      });

      return {
        status: "failed",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
        error_code: BACKEND_FAILED_ERROR_CODE,
        backend: this.buildBackendResultFromAction(
          backendDescription,
          actionResult,
          sanitizedLastError ?? BACKEND_FAILED_ERROR_CODE
        ),
        lifecycle: buildLifecycleMetadataResult(classification, safety),
        debug: {
          prompt_present: input.prompt_present,
          safety_status: safety.status,
          backend_action: "start_attempted"
        }
      };
    }

    this.updateRunLifecycle({
      input,
      classification,
      safety,
      actionResult,
      memberStatus: MEMBER_STATUSES.scheduled,
      runStatus: MEMBER_STATUSES.scheduled,
      backend: actionResult.backend,
      backendStatus: actionResult.backend_status,
      lastError: sanitizedLastError ?? BACKEND_UNAVAILABLE_ERROR_CODE,
      updatedAt: attemptedAt
    });

    return {
      status: "scheduled",
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      error_code: BACKEND_UNAVAILABLE_ERROR_CODE,
      backend: this.buildBackendResultFromAction(
        backendDescription,
        actionResult,
        sanitizedLastError ?? BACKEND_UNAVAILABLE_ERROR_CODE
      ),
      lifecycle: buildLifecycleMetadataResult(classification, safety),
      debug: {
        prompt_present: input.prompt_present,
        safety_status: safety.status,
        backend_action: "start_attempted"
      }
    };
  }

  resumeRun(input: ResumeRunInput): LifecycleActionResult {
    const backendDescription = this.executionBackend.describeBackend();
    const run = this.findRunById(input.run_id);
    const classification = run
      ? resolveRunClassification(run)
      : WORK_CLASSIFICATIONS.readOnly;
    const safety = run ? buildSafetyResultFromRun(run) : defaultSafetyResult();
    const currentStatus = normalizeRecipientLifecycleStatus(
      input.recipient_status
    );

    if (!run) {
      return this.buildResumeUnavailableResult({
        input,
        backendDescription,
        classification,
        safety,
        currentStatus,
        lastError: BACKEND_RESUME_METADATA_MISSING_ERROR_CODE
      });
    }

    if (backendDescription.capabilities.canResume !== true) {
      this.updateResumeUnavailable({
        input,
        run,
        classification,
        safety,
        backendDescription,
        currentStatus,
        lastError:
          backendDescription.limitation ?? BACKEND_UNAVAILABLE_ERROR_CODE
      });

      return this.buildResumeUnavailableResult({
        input,
        backendDescription,
        classification,
        safety,
        currentStatus,
        lastError: backendDescription.limitation
      });
    }

    if (!hasDurableResumeMetadata(run)) {
      this.updateResumeUnavailable({
        input,
        run,
        classification,
        safety,
        backendDescription,
        currentStatus,
        lastError: BACKEND_RESUME_METADATA_MISSING_ERROR_CODE
      });

      return this.buildResumeUnavailableResult({
        input,
        backendDescription,
        classification,
        safety,
        currentStatus,
        lastError: BACKEND_RESUME_METADATA_MISSING_ERROR_CODE
      });
    }

    const attemptedAt = new Date().toISOString();
    const resumeContext = {
      run_id: input.run_id,
      team_id: input.team_id,
      member_id: input.member_id,
      teammate_id: input.teammate_id,
      team_name: input.team_name,
      workspace_root: input.identity.workspaceRoot,
      prompt_present: false,
      work_classification: classification,
      isolation_kind: safety.isolation_kind,
      workspace_path: run.workspace_path,
      metadata: buildResumeContextMetadata(input, run)
    };
    const resumeTrigger = buildResumeTrigger(input, attemptedAt);
    const actionResult = (() => {
      try {
        return this.executionBackend.resumeRun(resumeContext, resumeTrigger);
      } catch (error) {
        return coerceBackendActionException(
          error,
          backendDescription,
          MESSAGE_DELIVERY_STATUSES.backendFailed
        );
      }
    })();
    const sanitizedLastError = sanitizeText(
      actionResult.last_error,
      input.summary
    );

    this.appendBackendResumeAttemptedEvent({
      input,
      classification,
      safety,
      actionResult,
      lastError: sanitizedLastError,
      createdAt: attemptedAt
    });

    if (actionResult.status === "resumed") {
      this.updateRunLifecycle({
        input,
        classification,
        safety,
        actionResult,
        memberStatus: MEMBER_STATUSES.running,
        runStatus: MEMBER_STATUSES.running,
        backend: actionResult.backend,
        backendStatus: actionResult.backend_status,
        lastError: null,
        updatedAt: actionResult.started_at ?? attemptedAt
      });
      this.appendLifecycleTransitionEvent({
        input,
        fromStatus: currentStatus,
        toStatus: MEMBER_STATUSES.running,
        classification,
        safety,
        actionResult,
        createdAt: actionResult.started_at ?? attemptedAt
      });

      return {
        status: "running",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
        backend: this.buildBackendResultFromAction(
          backendDescription,
          actionResult,
          sanitizedLastError,
          backendDescription.capabilities.canResume
        ),
        lifecycle: buildLifecycleMetadataResult(classification, safety),
        debug: {
          prompt_present: false,
          safety_status: safety.status,
          backend_action: "resume_attempted"
        }
      };
    }

    if (actionResult.status === "backend_failed") {
      this.updateRunLifecycle({
        input,
        classification,
        safety,
        actionResult,
        memberStatus: MEMBER_STATUSES.failed,
        runStatus: MEMBER_STATUSES.failed,
        backend: actionResult.backend,
        backendStatus: actionResult.backend_status,
        lastError: sanitizedLastError ?? BACKEND_FAILED_ERROR_CODE,
        updatedAt: attemptedAt
      });
      this.appendLifecycleTransitionEvent({
        input,
        fromStatus: currentStatus,
        toStatus: MEMBER_STATUSES.failed,
        classification,
        safety,
        actionResult,
        createdAt: attemptedAt
      });

      return {
        status: "failed",
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendFailed,
        error_code: BACKEND_FAILED_ERROR_CODE,
        backend: this.buildBackendResultFromAction(
          backendDescription,
          actionResult,
          sanitizedLastError ?? BACKEND_FAILED_ERROR_CODE,
          backendDescription.capabilities.canResume
        ),
        lifecycle: buildLifecycleMetadataResult(classification, safety),
        debug: {
          prompt_present: false,
          safety_status: safety.status,
          backend_action: "resume_attempted"
        }
      };
    }

    this.updateRunLifecycle({
      input,
      classification,
      safety,
      actionResult,
      memberStatus: currentStatus,
      runStatus: currentStatus,
      backend: actionResult.backend,
      backendStatus: actionResult.backend_status,
      lastError:
        sanitizedLastError ??
        (actionResult.status === "not_resumable"
          ? BACKEND_RESUME_METADATA_MISSING_ERROR_CODE
          : BACKEND_UNAVAILABLE_ERROR_CODE),
      updatedAt: attemptedAt
    });

    return {
      status: currentStatus,
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      error_code: BACKEND_UNAVAILABLE_ERROR_CODE,
      backend: this.buildBackendResultFromAction(
        backendDescription,
        actionResult,
        sanitizedLastError ?? BACKEND_UNAVAILABLE_ERROR_CODE,
        backendDescription.capabilities.canResume
      ),
      lifecycle: buildLifecycleMetadataResult(classification, safety),
      debug: {
        prompt_present: false,
        safety_status: safety.status,
        backend_action: "resume_attempted"
      }
    };
  }

  private prepareSafety(
    input: StartScheduledRunInput,
    backendDescription: ExecutionBackendDescription,
    classification: WorkClassification
  ): WorkspaceSafetyResult {
    if (!isFileModifyingWork(classification)) {
      return this.workspaceSafetyService.prepareWorkspace({
        work_classification: classification,
        leaderWorkspaceRoot: input.identity.workspaceRoot,
        backendCapabilities: toWorkspaceBackendCapabilities(
          backendDescription.capabilities
        )
      });
    }

    return this.workspaceSafetyService.prepareWorkspace({
      work_classification: classification,
      leaderWorkspaceRoot: input.identity.workspaceRoot,
      backendCapabilities: toWorkspaceBackendCapabilities(
        backendDescription.capabilities
      ),
      isolation: normalizeOptionalText(input.isolation),
      workspace_path:
        normalizeOptionalText(input.workspace_path) ??
        inferWorkspacePathFromCwd(input),
      review_diff_artifact_path: normalizeOptionalText(
        input.review_diff_artifact_path
      ),
      declared_output_path: normalizeOptionalText(input.declared_output_path),
      base_revision: normalizeOptionalText(input.base_revision)
    });
  }

  private markWorkspaceReviewRequired(
    input: StartScheduledRunInput,
    classification: WorkClassification,
    safety: WorkspaceSafetyResult
  ): void {
    const updatedAt = new Date().toISOString();
    this.updateRunLifecycle({
      input,
      classification,
      safety,
      memberStatus: MEMBER_STATUSES.scheduled,
      runStatus: MEMBER_STATUSES.scheduled,
      backend: this.executionBackend.describeBackend().backend,
      backendStatus: RUN_BACKEND_STATUSES.notStarted,
      lastError: WORKSPACE_ISOLATION_ERROR_CODE,
      updatedAt
    });
    this.appendEvent({
      input,
      eventType: EVENT_TYPES.workspaceReviewRequired,
      errorCode: WORKSPACE_ISOLATION_ERROR_CODE,
      payload: {
        teammate_id: input.teammate_id,
        run_id: input.run_id,
        delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        error_code: WORKSPACE_ISOLATION_ERROR_CODE,
        work_classification: classification,
        isolation_kind: safety.isolation_kind,
        review_status: RUN_REVIEW_STATUSES.needsReview,
        prompt_present: input.prompt_present
      },
      createdAt: updatedAt
    });
  }

  private updateRunLifecycle(input: {
    input: LifecycleRunContextInput;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    actionResult?: ExecutionBackendActionResult;
    memberStatus: string;
    runStatus: string;
    backend: string;
    backendStatus: RunBackendStatus;
    lastError: string | null;
    updatedAt: string;
  }): void {
    const tx = this.options.db.transaction(() => {
      const runMetadata = this.readRunMetadata(input.input.run_id);
      const memberMetadata = this.readMemberMetadata(input.input.member_id);
      const backendFields = this.readRunBackendFields(input.input.run_id);
      const lifecycleMetadata = buildLifecycleMetadataJson({
        classification: input.classification,
        safety: input.safety,
        actionResult: input.actionResult
      });
      const executionAvailable =
        input.actionResult?.status === "started" ||
        input.actionResult?.status === "resumed";
      const teammateExecutionImplemented = input.actionResult !== undefined;

      this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.members}
            SET status = ?,
                metadata_json = ?
            WHERE member_id = ?
          `
        )
        .run(
          input.memberStatus,
          JSON.stringify({
            ...memberMetadata,
            ...lifecycleMetadata,
            backend_status: input.backendStatus,
            execution_available: executionAvailable,
            teammate_execution_implemented: teammateExecutionImplemented
          }),
          input.input.member_id
        );

      this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.runs}
            SET status = ?,
                backend = ?,
                workspace_path = ?,
                metadata_json = ?,
                updated_at = ?,
                last_error = ?,
                backend_status = ?,
                backend_run_id = ?,
                backend_thread_id = ?,
                backend_process_id = ?,
                started_at = COALESCE(?, started_at),
                ended_at = COALESCE(?, ended_at),
                work_classification = ?,
                isolation_kind = ?,
                base_revision = ?,
                review_status = ?
            WHERE run_id = ?
          `
        )
        .run(
          input.runStatus,
          input.backend,
          input.safety.status === "ready" ? input.safety.workspace_path ?? null : null,
          JSON.stringify({
            ...runMetadata,
            ...lifecycleMetadata,
            backend_status: input.backendStatus,
            backend_run_id:
              input.actionResult?.backend_run_id ??
              backendFields.backend_run_id,
            backend_thread_id:
              input.actionResult?.thread_id ?? backendFields.backend_thread_id,
            backend_process_id:
              input.actionResult?.process_id ??
              backendFields.backend_process_id,
            backend_metadata: sanitizeMetadata(input.actionResult?.metadata),
            execution_available: executionAvailable,
            teammate_execution_implemented: teammateExecutionImplemented
          }),
          input.updatedAt,
          input.lastError,
          input.backendStatus,
          input.actionResult?.backend_run_id ?? backendFields.backend_run_id,
          input.actionResult?.thread_id ?? backendFields.backend_thread_id,
          input.actionResult?.process_id ?? backendFields.backend_process_id,
          input.actionResult?.started_at ?? null,
          input.actionResult?.ended_at ?? null,
          input.classification,
          input.safety.isolation_kind,
          input.safety.status === "ready" ? input.safety.base_revision ?? null : null,
          input.safety.review_status,
          input.input.run_id
        );
    });

    tx();
  }

  private readRunMetadata(runId: string): Record<string, unknown> {
    const row = this.options.db
      .prepare(
        `SELECT metadata_json FROM ${TABLE_NAMES.runs} WHERE run_id = ? LIMIT 1`
      )
      .get(runId) as RunMetadataRow | undefined;

    return parseJsonObject(row?.metadata_json);
  }

  private readMemberMetadata(memberId: string): Record<string, unknown> {
    const row = this.options.db
      .prepare(
        `SELECT metadata_json FROM ${TABLE_NAMES.members} WHERE member_id = ? LIMIT 1`
      )
      .get(memberId) as MemberMetadataRow | undefined;

    return parseJsonObject(row?.metadata_json);
  }

  private readRunBackendFields(runId: string): RunBackendFieldsRow {
    const row = this.options.db
      .prepare(
        `
          SELECT
            backend_run_id,
            backend_thread_id,
            backend_process_id
          FROM ${TABLE_NAMES.runs}
          WHERE run_id = ?
          LIMIT 1
        `
      )
      .get(runId) as RunBackendFieldsRow | undefined;

    return {
      backend_run_id: row?.backend_run_id ?? null,
      backend_thread_id: row?.backend_thread_id ?? null,
      backend_process_id: row?.backend_process_id ?? null
    };
  }

  private findDeliveryRun(input: DeliveryLifecycleInput): DeliveryRunRow | null {
    if (normalizeOptionalText(input.run_id)) {
      return this.findRunById(input.run_id ?? "");
    }

    return (
      (this.options.db
        .prepare(
          `
            SELECT *
            FROM ${TABLE_NAMES.runs}
            WHERE team_id = ?
              AND member_id = ?
            ORDER BY created_at DESC, run_id DESC
            LIMIT 1
          `
        )
        .get(input.team_id, input.recipient_member_id) as
        | DeliveryRunRow
        | undefined) ?? null
    );
  }

  private findRunById(runId: string): DeliveryRunRow | null {
    return (
      (this.options.db
        .prepare(
          `
            SELECT *
            FROM ${TABLE_NAMES.runs}
            WHERE run_id = ?
            LIMIT 1
          `
        )
        .get(runId) as DeliveryRunRow | undefined) ?? null
    );
  }

  private buildStartInputFromDeliveryRun(
    input: DeliveryLifecycleInput,
    run: DeliveryRunRow
  ): StartScheduledRunInput {
    const metadata = parseJsonObject(run.metadata_json);
    const prompt = optionalStringFromMetadata(metadata.prompt);

    return {
      team_id: input.team_id,
      team_name: input.team_name,
      member_id: input.recipient_member_id,
      run_id: run.run_id,
      teammate_id: input.teammate_id,
      prompt_present:
        metadata.prompt_present === true || Boolean(normalizeOptionalText(prompt)),
      prompt,
      mode: optionalStringFromMetadata(metadata.mode),
      description: optionalStringFromMetadata(metadata.description),
      cwd: optionalStringFromMetadata(metadata.cwd),
      isolation: optionalStringFromMetadata(metadata.isolation),
      workspace_path:
        normalizeOptionalText(run.workspace_path) ??
        optionalStringFromMetadata(metadata.workspace_path),
      review_diff_artifact_path: optionalStringFromMetadata(
        metadata.review_diff_artifact_path
      ),
      declared_output_path: optionalStringFromMetadata(
        metadata.declared_output_path
      ),
      base_revision:
        normalizeOptionalText(run.base_revision) ??
        optionalStringFromMetadata(metadata.base_revision),
      identity: input.identity
    };
  }

  private updateResumeUnavailable(input: {
    input: ResumeRunInput;
    run: DeliveryRunRow;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    backendDescription: ExecutionBackendDescription;
    currentStatus: "scheduled" | "idle" | "stopped" | "failed" | "stale";
    lastError: string;
  }): void {
    this.updateRunLifecycle({
      input: input.input,
      classification: input.classification,
      safety: input.safety,
      memberStatus: input.currentStatus,
      runStatus: input.currentStatus,
      backend: input.run.backend ?? input.backendDescription.backend,
      backendStatus:
        input.run.backend_status ?? input.backendDescription.backend_status,
      lastError: input.lastError,
      updatedAt: new Date().toISOString()
    });
  }

  private buildResumeUnavailableResult(input: {
    input: ResumeRunInput;
    backendDescription: ExecutionBackendDescription;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    currentStatus: "scheduled" | "idle" | "stopped" | "failed" | "stale";
    lastError?: string | null;
  }): LifecycleActionResult {
    return {
      status: input.currentStatus,
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      error_code: BACKEND_UNAVAILABLE_ERROR_CODE,
      backend: {
        status: input.backendDescription.backend_status,
        backend: input.backendDescription.backend,
        execution_available: input.backendDescription.capabilities.canResume,
        teammate_execution_implemented:
          input.backendDescription.teammateExecutionImplemented,
        limitation: input.backendDescription.limitation,
        last_error: input.lastError ?? undefined
      },
      lifecycle: buildLifecycleMetadataResult(
        input.classification,
        input.safety
      ),
      debug: {
        prompt_present: false,
        safety_status: input.safety.status,
        backend_action: "not_attempted"
      }
    };
  }

  private buildDeliveryResult(input: {
    input: DeliveryLifecycleInput;
    deliveryStatus: MessageDeliveryStatus;
    errorCode?: LifecycleDeliveryResult["error_code"];
    backendDescription: ExecutionBackendDescription;
    lifecycle: LifecycleMetadataResult;
    backendAction: LifecycleDebugResult["backend_action"];
    runId?: string;
  }): LifecycleDeliveryResult {
    return {
      delivery_status: input.deliveryStatus,
      message_row_status: MESSAGE_ROW_STATUSES.queued,
      error_code: input.errorCode,
      backend: {
        status: input.backendDescription.backend_status,
        backend: input.backendDescription.backend,
        execution_available:
          input.input.recipient_status === MEMBER_STATUSES.scheduled
            ? input.backendDescription.capabilities.canStart
            : input.backendDescription.capabilities.canResume,
        teammate_execution_implemented:
          input.backendDescription.teammateExecutionImplemented,
        limitation: input.backendDescription.limitation,
        last_error:
          input.errorCode === undefined
            ? undefined
            : input.backendDescription.limitation ?? input.errorCode
      },
      lifecycle: input.lifecycle,
      debug: {
        prompt_present: false,
        safety_status: "not_required",
        backend_action: input.backendAction,
        message_id: input.input.message_id,
        run_id: input.runId,
        recipient_status: input.input.recipient_status
      }
    };
  }

  private buildDeliveryResultFromAction(input: {
    input: DeliveryLifecycleInput;
    runId: string;
    actionResult: LifecycleActionResult;
    deliveryStatus: MessageDeliveryStatus;
  }): LifecycleDeliveryResult {
    return {
      delivery_status: input.deliveryStatus,
      message_row_status: MESSAGE_ROW_STATUSES.queued,
      error_code: input.actionResult.error_code,
      backend: input.actionResult.backend,
      lifecycle: input.actionResult.lifecycle,
      debug: {
        ...input.actionResult.debug,
        message_id: input.input.message_id,
        run_id: input.runId,
        recipient_status: input.input.recipient_status
      }
    };
  }

  private appendBackendStartAttemptedEvent(input: {
    input: StartScheduledRunInput;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    actionResult: ExecutionBackendActionResult;
    lastError: string | null;
    createdAt: string;
  }): void {
    this.appendEvent({
      input: input.input,
      eventType: TEAMMATE_BACKEND_START_ATTEMPTED_EVENT_TYPE,
      errorCode:
        input.actionResult.status === "backend_failed"
          ? BACKEND_FAILED_ERROR_CODE
          : null,
      payload: {
        teammate_id: input.input.teammate_id,
        run_id: input.input.run_id,
        backend: input.actionResult.backend,
        backend_status: input.actionResult.backend_status,
        delivery_status: input.actionResult.delivery_status,
        action_status: input.actionResult.status,
        work_classification: input.classification,
        isolation_kind: input.safety.isolation_kind,
        review_status: input.safety.review_status,
        workspace_path:
          input.safety.status === "ready" ? input.safety.workspace_path : null,
        review_diff_artifact_path:
          input.safety.status === "ready"
            ? input.safety.review_diff_artifact_path
            : null,
        base_revision:
          input.safety.status === "ready" ? input.safety.base_revision : null,
        prompt_present: input.input.prompt_present,
        last_error: input.lastError
      },
      createdAt: input.createdAt
    });
  }

  private appendBackendResumeAttemptedEvent(input: {
    input: ResumeRunInput;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    actionResult: ExecutionBackendActionResult;
    lastError: string | null;
    createdAt: string;
  }): void {
    this.appendEvent({
      input: input.input,
      eventType: TEAMMATE_BACKEND_RESUME_ATTEMPTED_EVENT_TYPE,
      errorCode:
        input.actionResult.status === "backend_failed"
          ? BACKEND_FAILED_ERROR_CODE
          : null,
      payload: {
        teammate_id: input.input.teammate_id,
        run_id: input.input.run_id,
        message_id: input.input.message_id,
        task_id: normalizeOptionalText(input.input.task_id),
        backend: input.actionResult.backend,
        backend_status: input.actionResult.backend_status,
        delivery_status: input.actionResult.delivery_status,
        action_status: input.actionResult.status,
        previous_status: input.input.recipient_status,
        work_classification: input.classification,
        isolation_kind: input.safety.isolation_kind,
        review_status: input.safety.review_status,
        prompt_present: false,
        summary_present: Boolean(normalizeOptionalText(input.input.summary)),
        last_error: input.lastError
      },
      createdAt: input.createdAt
    });
  }

  private appendLifecycleTransitionEvent(input: {
    input: LifecycleRunContextInput;
    fromStatus: string;
    toStatus: string;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    actionResult: ExecutionBackendActionResult;
    createdAt: string;
  }): void {
    this.appendEvent({
      input: input.input,
      eventType: TEAMMATE_LIFECYCLE_TRANSITION_EVENT_TYPE,
      errorCode:
        input.toStatus === MEMBER_STATUSES.failed ? BACKEND_FAILED_ERROR_CODE : null,
      payload: {
        teammate_id: input.input.teammate_id,
        run_id: input.input.run_id,
        from_status: input.fromStatus,
        to_status: input.toStatus,
        backend: input.actionResult.backend,
        backend_status: input.actionResult.backend_status,
        work_classification: input.classification,
        isolation_kind: input.safety.isolation_kind,
        review_status: input.safety.review_status,
        workspace_path:
          input.safety.status === "ready" ? input.safety.workspace_path : null,
        review_diff_artifact_path:
          input.safety.status === "ready"
            ? input.safety.review_diff_artifact_path
            : null,
        prompt_present: input.input.prompt_present
      },
      createdAt: input.createdAt
    });
  }

  private appendEvent(input: {
    input: LifecycleRunContextInput;
    eventType: string;
    errorCode?: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.options.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.events} (
            event_id,
            team_id,
            actor_member_id,
            workspace_root,
            actor_caller_key,
            event_type,
            error_code,
            payload_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        randomUUID(),
        input.input.team_id,
        input.input.member_id,
        input.input.identity.workspaceRoot,
        input.input.identity.callerKey,
        input.eventType,
        input.errorCode ?? null,
        JSON.stringify(input.payload),
        input.createdAt
      );
  }

  private buildScheduledResult(input: {
    backendDescription: ExecutionBackendDescription;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    deliveryStatus: MessageDeliveryStatus;
    errorCode: LifecycleActionResult["error_code"];
    lastError?: string | null;
    promptPresent: boolean;
  }): LifecycleActionResult {
    return {
      status: "scheduled",
      delivery_status: input.deliveryStatus,
      error_code: input.errorCode,
      backend: {
        status: input.backendDescription.backend_status,
        backend: input.backendDescription.backend,
        execution_available: input.backendDescription.capabilities.canStart,
        teammate_execution_implemented:
          input.backendDescription.teammateExecutionImplemented,
        last_error: input.lastError ?? undefined
      },
      lifecycle: buildLifecycleMetadataResult(input.classification, input.safety),
      debug: {
        prompt_present: input.promptPresent,
        safety_status: input.safety.status,
        backend_action: "not_attempted"
      }
    };
  }

  private buildBackendResultFromAction(
    backendDescription: ExecutionBackendDescription,
    actionResult: ExecutionBackendActionResult,
    lastError: string | null,
    executionAvailable = backendDescription.capabilities.canStart
  ): LifecycleBackendResult {
    const pane = extractPaneMetadata(actionResult.metadata);

    return {
      status: actionResult.backend_status,
      backend: actionResult.backend,
      execution_available: executionAvailable,
      teammate_execution_implemented:
        backendDescription.teammateExecutionImplemented,
      pane: pane ?? undefined,
      backend_run_id: actionResult.backend_run_id,
      thread_id: actionResult.thread_id,
      process_id: actionResult.process_id,
      workspace_path: actionResult.workspace_path,
      last_error: lastError ?? undefined
    };
  }
}

function isFileModifyingWork(classification: WorkClassification): boolean {
  return (
    classification === WORK_CLASSIFICATIONS.artifactWriting ||
    classification === WORK_CLASSIFICATIONS.codeImplementation
  );
}

function isStartSafe(
  safety: WorkspaceSafetyResult,
  classification: WorkClassification
): safety is WorkspaceSafetyReadyResult {
  if (safety.status !== "ready") {
    return false;
  }

  if (safety.isolation_kind === ISOLATION_KINDS.declaredOutputPath) {
    return (
      classification === WORK_CLASSIFICATIONS.artifactWriting &&
      Boolean(safety.declared_output_path)
    );
  }

  if (safety.review_status !== PENDING_REVIEW_STATUS) {
    return false;
  }

  if (safety.isolation_kind === ISOLATION_KINDS.gitWorktree) {
    return Boolean(safety.workspace_path && safety.base_revision);
  }

  return (
    safety.isolation_kind === ISOLATION_KINDS.reviewDiff &&
    Boolean(safety.review_diff_artifact_path && safety.base_revision)
  );
}

function buildLifecycleMetadataResult(
  classification: WorkClassification,
  safety: WorkspaceSafetyResult
): LifecycleMetadataResult {
  return {
    work_classification: classification,
    isolation_kind: safety.isolation_kind,
    review_status: safety.review_status,
    workspace_path: safety.status === "ready" ? safety.workspace_path : undefined,
    review_diff_artifact_path:
      safety.status === "ready" ? safety.review_diff_artifact_path : undefined,
    declared_output_path:
      safety.status === "ready" ? safety.declared_output_path : undefined,
    base_revision: safety.status === "ready" ? safety.base_revision : undefined
  };
}

function defaultSafetyResult(): WorkspaceSafetyResult {
  return {
    status: "not_required",
    isolation_kind: ISOLATION_KINDS.none,
    review_status: RUN_REVIEW_STATUSES.none
  };
}

function defaultLifecycleMetadataResult(): LifecycleMetadataResult {
  return buildLifecycleMetadataResult(
    WORK_CLASSIFICATIONS.readOnly,
    defaultSafetyResult()
  );
}

function buildLifecycleMetadataJson(input: {
  classification: WorkClassification;
  safety: WorkspaceSafetyResult;
  actionResult?: ExecutionBackendActionResult;
}): Record<string, unknown> {
  return {
    work_classification: input.classification,
    isolation_kind: input.safety.isolation_kind,
    review_status: input.safety.review_status,
    workspace_path:
      input.safety.status === "ready" ? input.safety.workspace_path ?? null : null,
    review_diff_artifact_path:
      input.safety.status === "ready"
        ? input.safety.review_diff_artifact_path ?? null
        : null,
    declared_output_path:
      input.safety.status === "ready"
        ? input.safety.declared_output_path ?? null
        : null,
    base_revision:
      input.safety.status === "ready" ? input.safety.base_revision ?? null : null,
    backend_delivery_status: input.actionResult?.delivery_status ?? null
  };
}

function resolveRunClassification(run: DeliveryRunRow): WorkClassification {
  const metadata = parseJsonObject(run.metadata_json);
  const candidate =
    normalizeOptionalText(run.work_classification) ??
    optionalStringFromMetadata(metadata.work_classification);

  return isWorkClassification(candidate)
    ? candidate
    : WORK_CLASSIFICATIONS.readOnly;
}

function buildSafetyResultFromRun(run: DeliveryRunRow): WorkspaceSafetyResult {
  const metadata = parseJsonObject(run.metadata_json);
  const classification = resolveRunClassification(run);
  if (!isFileModifyingWork(classification)) {
    return defaultSafetyResult();
  }

  const isolationKind = resolveIsolationKind(
    normalizeOptionalText(run.isolation_kind) ??
      optionalStringFromMetadata(metadata.isolation_kind)
  );
  const reviewStatus = resolveRunReviewStatus(
    normalizeOptionalText(run.review_status) ??
      optionalStringFromMetadata(metadata.review_status)
  );
  const workspacePath =
    normalizeOptionalText(run.workspace_path) ??
    optionalStringFromMetadata(metadata.workspace_path);
  const reviewDiffArtifactPath = optionalStringFromMetadata(
    metadata.review_diff_artifact_path
  );
  const declaredOutputPath = optionalStringFromMetadata(
    metadata.declared_output_path
  );
  const baseRevision =
    normalizeOptionalText(run.base_revision) ??
    optionalStringFromMetadata(metadata.base_revision);

  if (isolationKind === ISOLATION_KINDS.gitWorktree && workspacePath) {
    return {
      status: "ready",
      isolation_kind: ISOLATION_KINDS.gitWorktree,
      workspace_path: workspacePath,
      base_revision: baseRevision ?? undefined,
      review_status: reviewStatus
    };
  }

  if (isolationKind === ISOLATION_KINDS.reviewDiff && reviewDiffArtifactPath) {
    return {
      status: "ready",
      isolation_kind: ISOLATION_KINDS.reviewDiff,
      review_diff_artifact_path: reviewDiffArtifactPath,
      base_revision: baseRevision ?? undefined,
      review_status: reviewStatus
    };
  }

  if (
    isolationKind === ISOLATION_KINDS.declaredOutputPath &&
    declaredOutputPath
  ) {
    return {
      status: "ready",
      isolation_kind: ISOLATION_KINDS.declaredOutputPath,
      declared_output_path: declaredOutputPath,
      review_status: reviewStatus
    };
  }

  return {
    status: "blocked",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
    error_code: WORKSPACE_ISOLATION_ERROR_CODE,
    isolation_kind: ISOLATION_KINDS.none,
    review_status: RUN_REVIEW_STATUSES.needsReview
  };
}

function normalizeRecipientLifecycleStatus(
  status: string
): "scheduled" | "idle" | "stopped" | "failed" | "stale" {
  if (status === MEMBER_STATUSES.scheduled) {
    return MEMBER_STATUSES.scheduled;
  }
  if (status === MEMBER_STATUSES.stopped) {
    return MEMBER_STATUSES.stopped;
  }
  if (status === MEMBER_STATUSES.failed) {
    return MEMBER_STATUSES.failed;
  }
  if (status === MEMBER_STATUSES.stale) {
    return MEMBER_STATUSES.stale;
  }

  return MEMBER_STATUSES.idle;
}

function hasDurableResumeMetadata(run: DeliveryRunRow): boolean {
  return Boolean(
    backendIdFromRunOrMetadata(run, "backend_run_id") ||
      backendIdFromRunOrMetadata(run, "backend_thread_id") ||
      backendIdFromRunOrMetadata(run, "backend_process_id")
  );
}

function backendIdFromRunOrMetadata(
  run: DeliveryRunRow,
  key: "backend_run_id" | "backend_thread_id" | "backend_process_id"
): string | null {
  const columnValue = {
    backend_run_id: run.backend_run_id,
    backend_thread_id: run.backend_thread_id,
    backend_process_id: run.backend_process_id
  }[key];

  return (
    normalizeOptionalText(columnValue) ??
    optionalStringFromMetadata(parseJsonObject(run.metadata_json)[key])
  );
}

function buildResumeContextMetadata(
  input: ResumeRunInput,
  run: DeliveryRunRow
): Record<string, unknown> {
  return {
    message_id: input.message_id,
    task_id: normalizeOptionalText(input.task_id),
    summary: normalizeOptionalText(input.summary),
    summary_present: Boolean(normalizeOptionalText(input.summary)),
    previous_status: input.recipient_status,
    backend_run_id: backendIdFromRunOrMetadata(run, "backend_run_id"),
    backend_thread_id: backendIdFromRunOrMetadata(run, "backend_thread_id"),
    backend_process_id: backendIdFromRunOrMetadata(run, "backend_process_id")
  };
}

function coerceBackendActionException(
  error: unknown,
  backendDescription: ExecutionBackendDescription,
  fallbackDeliveryStatus: MessageDeliveryStatus
): ExecutionBackendActionResult {
  return {
    status: "backend_failed",
    delivery_status: fallbackDeliveryStatus,
    backend: backendDescription.backend,
    backend_status: RUN_BACKEND_STATUSES.failed,
    last_error:
      sanitizeText(errorToMessage(error), null) ?? BACKEND_FAILED_ERROR_CODE
  };
}

function buildResumeTrigger(
  input: ResumeRunInput,
  occurredAt: string
): ExecutionTrigger {
  return {
    kind: input.trigger_kind ?? (input.task_id ? "task_assignment" : "message"),
    message_id: input.message_id,
    task_id: normalizeOptionalText(input.task_id) ?? undefined,
    occurred_at: occurredAt,
    reason: "persisted_message_available",
    metadata: {
      summary_present: Boolean(normalizeOptionalText(input.summary))
    }
  };
}

function isWorkClassification(
  value: string | null
): value is WorkClassification {
  return (
    value !== null &&
    (Object.values(WORK_CLASSIFICATIONS) as string[]).includes(value)
  );
}

function resolveIsolationKind(value: string | null): IsolationKind {
  return value !== null &&
    (Object.values(ISOLATION_KINDS) as string[]).includes(value)
    ? (value as IsolationKind)
    : ISOLATION_KINDS.none;
}

function resolveRunReviewStatus(value: string | null): RunReviewStatus {
  return value !== null &&
    (Object.values(RUN_REVIEW_STATUSES) as string[]).includes(value)
    ? (value as RunReviewStatus)
    : RUN_REVIEW_STATUSES.none;
}

function optionalStringFromMetadata(value: unknown): string | null {
  return typeof value === "string" ? normalizeOptionalText(value) : null;
}

function toWorkspaceBackendCapabilities(
  capabilities: ExecutionBackendCapabilities
): WorkspaceBackendCapabilities {
  const extendedCapabilities = capabilities as ExecutionBackendCapabilities & {
    supportsReviewDiff?: boolean;
  };

  return {
    canStart: capabilities.canStart,
    supportsWorkspaces: capabilities.supportsWorkspaces,
    supportsReviewDiff: extendedCapabilities.supportsReviewDiff === true
  };
}

function inferWorkspacePathFromCwd(
  input: StartScheduledRunInput
): string | null {
  if (normalizeOptionalText(input.isolation) !== "worktree") {
    return null;
  }

  return normalizeOptionalText(input.cwd);
}

function sanitizeText(
  value: string | null | undefined,
  prompt: string | null | undefined
): string | null {
  const normalized = normalizeOptionalText(value);
  const secretPrompt = normalizeOptionalText(prompt);
  if (!normalized) {
    return null;
  }

  let sanitized = normalized;
  if (secretPrompt && sanitized.includes(secretPrompt)) {
    sanitized = sanitized.replaceAll(secretPrompt, PROMPT_REDACTION);
  }

  return sanitized.replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]");
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sanitizeMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }

  return sanitizeMetadataRecord(metadata);
}

const SENSITIVE_METADATA_PATTERN =
  /prompt|message|body|description|notes|task|payload|transcript/i;

function sanitizeMetadataRecord(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]) => {
      if (SENSITIVE_METADATA_PATTERN.test(key)) {
        return [];
      }

      const sanitizedValue = sanitizeMetadataValue(value);
      return sanitizedValue === undefined ? [] : [[key, sanitizedValue]];
    })
  );
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (typeof value === "string") {
    const sanitized = sanitizeText(value, null);
    if (!sanitized || SENSITIVE_METADATA_PATTERN.test(sanitized)) {
      return undefined;
    }

    return sanitized;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeMetadataValue(item))
      .filter((item) => item !== undefined);
  }

  if (isRecord(value)) {
    return sanitizeMetadataRecord(value);
  }

  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    value === null
  ) {
    return value;
  }

  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
