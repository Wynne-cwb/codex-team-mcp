import { randomUUID } from "node:crypto";
import path from "node:path";

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
import { codexExecLogPath } from "../adapters/codexCliExecutionBackend.js";
import {
  createDefaultPaneBackendRegistry,
  type PaneBackendMetadata,
  type PaneBackendRegistry
} from "../adapters/paneBackend.js";
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
import type { PaneModeOptions } from "../types.js";
import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import {
  MessageInboxService,
  buildInboxNudge,
  inboxSenderPublicId
} from "./messageInboxService.js";
import {
  WorkspaceSafetyService,
  type WorkspaceBackendCapabilities,
  type WorkspaceInspectionResult,
  type WorkspaceSafetyReadyResult,
  type WorkspaceSafetyResult
} from "./workspaceSafetyService.js";
import {
  WorktreeService,
  type CreateIsolatedWorktreeResult
} from "./worktreeService.js";
import {
  WorktreeMergeService,
  type MergeWorktreeResult,
  type ReviewWorktreeResult
} from "./worktreeMergeService.js";

export interface LifecycleServiceOptions {
  db: Database.Database;
  statePath: string;
  executionBackend?: ExecutionBackend;
  workspaceSafetyService?: WorkspaceSafetyService;
  worktreeService?: WorktreeService;
  // Phase 12 (D-04): git-only merge service for the TL-driven worktree merge
  // flow. Injectable for deterministic tests.
  worktreeMergeService?: WorktreeMergeService;
  // PANE-01 / D-01: when pane mode is enabled the lifecycle overlays a visible
  // pane on top of a real run. paneBackend is injectable for deterministic tests.
  paneMode?: PaneModeOptions;
  paneBackend?: PaneBackendRegistry;
}

// Phase 12 (D-04): TL-driven worktree merge / escalate request + outcomes.
export interface MergeWorktreeRequest {
  run_id: string;
  identity: WorkspaceScopedCallerIdentity;
  teammate_id?: string;
  team_name?: string;
  /** Short, NON-sensitive label (e.g. member@run) for the merge commit message. */
  merge_label?: string | null;
}

export interface ReviewWorktreeOutcome extends ReviewWorktreeResult {
  run_id: string;
  error_code?: string;
}

export interface MergeWorktreeOutcome {
  status: "merged" | "conflict" | "no_op" | "blocked" | "error";
  run_id: string;
  review_status?: RunReviewStatus;
  branch?: string;
  merge_commit?: string;
  conflict_files?: string[];
  cleanup?: "removed" | "preserved" | "not_found";
  error_code?: string;
  reason?: string;
}

export interface EscalateWorktreeOutcome {
  status: "escalated" | "error";
  run_id: string;
  review_status?: RunReviewStatus;
  branch?: string;
  error_code?: string;
}

const MERGE_TARGET_NOT_ISOLATED_ERROR_CODE = "merge_target_not_isolated";
const MERGE_TARGET_NOT_FOUND_ERROR_CODE = "merge_target_not_found";

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
  // Phase 16 (notify + pull): the SHORT, length-bounded inbox NUDGE text (count +
  // distinct senders), threaded IN-MEMORY ONLY to the resume context so a pane-hosted
  // backend injects a bounded single line into the teammate's pane — NEVER the full
  // body (the recipient pulls bodies via CheckInbox). Never persisted to
  // runs.metadata_json / events / diagnostics. System lifecycle notices
  // (resume_failure_notice / lifecycle_completion) leave this unset.
  delivery_text?: string | null;
  task_id?: string | null;
  trigger_kind?: "message" | "task_assignment";
  run_id?: string | null;
  // Phase 10 (D10-3 recursion guard): system lifecycle notices
  // (resume_failure_notice / lifecycle_completion) must NEVER trigger resume —
  // they only queue. Set by MessageService for those message types.
  suppress_resume?: boolean;
  identity: WorkspaceScopedCallerIdentity;
}

export interface ResumeRunInput extends LifecycleRunContextInput {
  message_id: string;
  recipient_status: string;
  summary?: string | null;
  // Short inbox nudge text — see DeliveryLifecycleInput.delivery_text. Flows into the
  // in-memory resume context (buildResumeContextMetadata) only; never persisted.
  delivery_text?: string | null;
  task_id?: string | null;
  trigger_kind?: "message" | "task_assignment" | "manual";
}

export interface LifecycleDeliveryResult {
  delivery_status: MessageDeliveryStatus;
  message_row_status: typeof MESSAGE_ROW_STATUSES.queued;
  error_code?: LifecycleActionResult["error_code"] | "recipient_stale";
  // Phase 10: passthrough of a synchronous resume that ran a one-shot turn to
  // completion (turn_completed → member finalized to idle). Consumed by Wave 2
  // (MessageService) to notify the lead of resume completion.
  turn_completed?: boolean;
  final_status?: "idle";
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
  // Human-readable, sanitized remediation surfaced to the caller alongside a stable
  // error_code (the code stays the machine contract). Set for workspace_isolation_
  // required so the leader sees WHY isolation could not be prepared (e.g. the leader
  // workspace root is not a git repo) and HOW to fix it, instead of a bare code.
  error_detail?: string;
  // Set when a synchronous one-shot turn completed at start (D-06): the member is
  // finalized to `final_status` (idle) and the caller (AgentService) notifies the lead.
  turn_completed?: boolean;
  final_status?: "idle";
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

// Projection for the pane-teardown sweep: the columns needed to locate the pane, to
// write back the closed marker via a metadata_json-only UPDATE, to flip the run to a
// clean terminal `stopped` status + emit an auditable teammate_stopped event
// (team_id + workspace_root come from the joined team row), and to capture the
// worktree's FINAL changed_files at stop time (workspace_path + base_revision feed
// the shared inspectWorkspace path; null for detached non-worktree runs, which are
// skipped).
interface PaneTeardownRunRow {
  run_id: string;
  member_id: string | null;
  team_id: string;
  workspace_root: string;
  metadata_json: string;
  workspace_path: string | null;
  base_revision: string | null;
}

// Best-effort pane teardown summary. `attempted` counts available panes we tried
// to close; `closed` counts the ones whose close command succeeded.
export interface PaneTeardownSummary {
  attempted: number;
  closed: number;
}

// Phase 16: turn-boundary delivery drain input + outcome.
export interface DrainPendingDeliveriesInput {
  teamId: string;
  teamName: string;
  recipientMemberId: string;
  identity: WorkspaceScopedCallerIdentity;
}

export interface DrainPendingDeliveriesResult {
  status:
    | "delivered"
    | "recipient_running"
    | "no_live_pane"
    | "no_durable_metadata"
    | "nothing_pending"
    | "no_run"
    | "inject_failed"
    | "reentrant_skip";
  nudged: boolean;
  claimed_count: number;
  run_id?: string;
}

// Optional dependency injected into ReconciliationService so the turn boundary
// (markRunTerminal -> member idle) can fire the drain while keeping the service
// unit-testable. Best-effort: the hook must never throw into reconcile.
export type DeliveryDrainHook = (input: {
  teamId: string;
  teamName: string;
  recipientMemberId: string;
  workspaceRoot: string;
  actorCallerKey: string;
}) => void;

// Marker written to backend_metadata.pane.degradation_reason after a successful
// teardown so diagnostics / reconcile see the pane as intentionally closed.
const PANE_CLOSED_REASON = "pane_closed";
// Actor caller key stamped on the teammate_stopped event emitted by an intentional
// pane teardown (system action — there is no human caller in this side-effect path).
const SYSTEM_PANE_TEARDOWN_CALLER = "system:pane_teardown";

interface MemberMetadataRow {
  metadata_json: string;
}

interface RunBackendFieldsRow {
  backend_run_id: string | null;
  backend_thread_id: string | null;
  backend_process_id: string | null;
}

// Phase 12 (D-04): minimal run projection used by the TL-driven merge flow.
interface MergeTargetRow {
  run_id: string;
  team_id: string;
  member_id: string | null;
  isolation_kind: string | null;
  review_status: string | null;
  workspace_path: string | null;
  base_revision: string | null;
  worktree_branch: string | null;
  worktree_repo_root: string | null;
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
  last_resume_attempt_at: string | null;
  work_classification: WorkClassification | null;
  isolation_kind: IsolationKind | null;
  base_revision: string | null;
  review_status: RunReviewStatus | null;
}

const BACKEND_FAILED_ERROR_CODE = "backend_failed";
const BACKEND_UNAVAILABLE_ERROR_CODE = "backend_unavailable";
// PANE-02 degradation markers — pane unavailable / pane create failed. These
// only ever land in backend_metadata.pane; the core run is never affected.
const PANE_BACKEND_UNAVAILABLE_REASON = "pane_backend_unavailable";
const PANE_OVERLAY_DEGRADED_REASON = "pane_overlay_degraded";
const WORKSPACE_ISOLATION_ERROR_CODE = "workspace_isolation_required";
const BACKEND_RESUME_METADATA_MISSING_ERROR_CODE =
  "backend_resume_metadata_missing";
const PROMPT_REDACTION = "[redacted_prompt]";
// D10-4 debounce window: a burst of inbound messages to the same idle/stopped
// TeamMate triggers AT MOST one resume within this window. The timestamp is
// stamped AFTER the (synchronous) resume turn ends (10-RESEARCH §同步后端下的
// burst 实情) so the rest of the burst lands inside the window and is merged.
const RESUME_DEBOUNCE_WINDOW_MS = 10_000;
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
  private readonly worktreeService: WorktreeService;
  // Phase 12 (D-04): git-only merge service for the TL-driven worktree merge flow.
  private readonly worktreeMergeService: WorktreeMergeService;
  // PANE-01 / PANE-02: best-effort visibility overlay. undefined when pane mode
  // is off, so the overlay is a pure no-op and the core run is untouched.
  private readonly paneBackend: PaneBackendRegistry | undefined;
  // Phase 16: re-entrancy guard for the drain. A synchronous one-shot resume nudge
  // can finalize the member to idle and re-enter the finalizer drain hook; the nudge
  // creates no inbound rows so a nested drain has nothing new to do — skip it.
  private draining = false;

  constructor(private readonly options: LifecycleServiceOptions) {
    this.executionBackend =
      options.executionBackend ?? new ScaffoldExecutionBackend();
    this.workspaceSafetyService =
      options.workspaceSafetyService ?? new WorkspaceSafetyService();
    // Worktrees land under a state-adjacent managed root (OUTSIDE the leader
    // tree), so isolated work never touches the leader workspace.
    this.worktreeService =
      options.worktreeService ??
      new WorktreeService({
        managedRoot: path.join(options.statePath, "worktrees-root")
      });
    this.worktreeMergeService =
      options.worktreeMergeService ?? new WorktreeMergeService();
    this.paneBackend =
      options.paneBackend ??
      (options.paneMode?.enabled === true
        ? createDefaultPaneBackendRegistry({
            preferredBackend: options.paneMode.preferredBackend,
            sessionPrefix: options.paneMode.sessionPrefix
          })
        : undefined);
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
      // D10-3 recursion guard: a system lifecycle notice (resume_failure_notice /
      // lifecycle_completion) never resumes its recipient — it only queues. This
      // breaks the failure-notice -> resume -> failure-notice loop even when the
      // notice recipient is itself idle/stopped with durable metadata.
      if (input.suppress_resume === true) {
        return this.buildDeliveryResult({
          input,
          deliveryStatus: MESSAGE_DELIVERY_STATUSES.queuedWhileIdle,
          backendDescription,
          lifecycle: buildLifecycleMetadataResult(
            resolveRunClassification(run),
            buildSafetyResultFromRun(run)
          ),
          backendAction: "not_attempted",
          runId: run.run_id
        });
      }

      // D10-4 debounce: within the window, only the first message of a burst
      // resumes; the rest are merged (queued_while_idle, backend not attempted).
      const lastResumeMs = parseIsoMs(run.last_resume_attempt_at);
      if (
        lastResumeMs !== null &&
        Date.now() - lastResumeMs < RESUME_DEBOUNCE_WINDOW_MS
      ) {
        return this.buildDeliveryResult({
          input,
          deliveryStatus: MESSAGE_DELIVERY_STATUSES.queuedWhileIdle,
          backendDescription,
          lifecycle: buildLifecycleMetadataResult(
            resolveRunClassification(run),
            buildSafetyResultFromRun(run)
          ),
          backendAction: "not_attempted",
          runId: run.run_id
        });
      }

      // Phase 16 (claim-first): stamp delivered_at on THIS triggering row BEFORE the
      // resume so a finalizer / turn-boundary drain never re-nudges it. Only
      // delivered_at is touched here — delivery_status stays as the lifecycle reports
      // it (preserving the queued_while_idle row state on a resume failure). Reset on
      // a failed inject so a later drain retries.
      const inbox = new MessageInboxService(this.options.db);
      inbox.markDelivered(input.message_id, new Date().toISOString());

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
        // Phase 16 (notify + pull): in-memory passthrough of the SHORT inbox nudge
        // (NOT the full body) so a pane-hosted backend injects only a bounded, single
        // line into the live TUI. The full body is pulled later via CheckInbox.
        delivery_text: input.delivery_text,
        task_id: input.task_id,
        trigger_kind: input.trigger_kind,
        identity: input.identity
      });

      // Stamp the debounce timestamp AFTER the synchronous resume turn ends
      // (10-RESEARCH §同步后端下的 burst 实情). A targeted UPDATE that leaves the
      // run's lifecycle columns (just written by resumeRun) untouched.
      this.stampResumeAttempt(run.run_id, new Date().toISOString());

      // Inject failed -> un-stamp delivered_at so a later drain retries the row (the
      // existing D10-3 resume-failure notice still informs the sender).
      if (
        resumeResult.delivery_status !==
        MESSAGE_DELIVERY_STATUSES.backendResumeAttempted
      ) {
        inbox.unmarkDelivered(input.message_id);
      }

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
    const { safety, worktreeBranch, worktreeBlockedReason } = this.prepareSafety(
      input,
      backendDescription,
      classification
    );

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
      this.markWorkspaceReviewRequired(
        input,
        classification,
        safety,
        worktreeBlockedReason
      );
      return this.buildScheduledResult({
        backendDescription,
        classification,
        safety,
        deliveryStatus: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
        errorCode: WORKSPACE_ISOLATION_ERROR_CODE,
        errorDetail: buildWorkspaceIsolationRemediation(
          input.identity.workspaceRoot,
          worktreeBlockedReason,
          normalizeOptionalText(input.cwd)
        ),
        lastError: WORKSPACE_ISOLATION_ERROR_CODE,
        promptPresent: input.prompt_present
      });
    }

    const attemptedAt = new Date().toISOString();
    // Layout determinism for a PANE-HOSTED execution backend: when the execution
    // backend itself opens the teammate pane (full codex TUI), it needs the
    // team's already-open pane ids BEFORE startRun so it anchors the new split off
    // the latest live pane (panes stack vertically) instead of re-splitting the
    // leader. DB-derived (most-recent first); harmless/ignored by the detached
    // backend. The overlay path also computes this later for the detached case.
    const previousTeammatePaneIds = this.collectPreviousTeammatePaneIds(
      input.team_id,
      input.run_id
    );
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
      previousTeammatePaneIds,
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
        base_revision: safety.status === "ready" ? safety.base_revision : null,
        worktree_branch: worktreeBranch
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
      // PANE-01 / D-01: overlay a visible pane on the real started run
      // (best-effort, purely additive — never changes status/backend/thread_id).
      this.overlayVisiblePane(startContext, actionResult);

      // D-06 one-shot completion: a synchronous turn (codex exec) ran to
      // completion and exited at startRun return -> finalize the member to idle
      // (not left running) with a sanitized completion event.
      if (actionResult.turn_completed === true) {
        const finalBackendStatus =
          actionResult.final_backend_status ?? RUN_BACKEND_STATUSES.idle;
        const completedAt =
          actionResult.ended_at ?? actionResult.started_at ?? attemptedAt;

        this.updateRunLifecycle({
          input,
          classification,
          safety,
          actionResult,
          memberStatus: MEMBER_STATUSES.idle,
          runStatus: MEMBER_STATUSES.idle,
          backend: actionResult.backend,
          backendStatus: finalBackendStatus,
          lastError: null,
          updatedAt: completedAt
        });
        this.appendLifecycleTransitionEvent({
          input,
          fromStatus: MEMBER_STATUSES.scheduled,
          toStatus: MEMBER_STATUSES.idle,
          classification,
          safety,
          actionResult,
          createdAt: completedAt
        });
        this.appendRunCompletedEvent({
          input,
          classification,
          safety,
          actionResult,
          finalBackendStatus,
          createdAt: completedAt
        });

        // Phase 16 (turn boundary): a synchronous one-shot start just finalized the
        // member to idle — drain any pending deliveries (best-effort, no-op without a
        // live pane / durable metadata; the detached one-shot path is the target).
        this.drainAfterSynchronousIdle(input);

        return {
          status: "idle",
          delivery_status: actionResult.delivery_status,
          turn_completed: true,
          final_status: "idle",
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
      // PANE-01 / D-01: refresh/attach the visible pane for the resumed run
      // (best-effort, purely additive — never changes status/backend/thread_id).
      this.overlayVisiblePane(resumeContext, actionResult);

      // Phase 10 (closes Phase-9 leftover): a synchronous one-shot resume turn
      // (codex exec resume) ran to completion and exited at resumeRun return ->
      // finalize the member to idle (NOT left running), mirroring the start
      // completion path (D-06). Gated on turn_completed === true so backends that
      // resume into a live running session keep the Phase-5 ->running baseline.
      if (actionResult.turn_completed === true) {
        const finalBackendStatus =
          actionResult.final_backend_status ?? RUN_BACKEND_STATUSES.idle;
        const completedAt =
          actionResult.ended_at ?? actionResult.started_at ?? attemptedAt;

        this.updateRunLifecycle({
          input,
          classification,
          safety,
          actionResult,
          memberStatus: MEMBER_STATUSES.idle,
          runStatus: MEMBER_STATUSES.idle,
          backend: actionResult.backend,
          backendStatus: finalBackendStatus,
          lastError: null,
          updatedAt: completedAt
        });
        this.appendLifecycleTransitionEvent({
          input,
          fromStatus: currentStatus,
          toStatus: MEMBER_STATUSES.idle,
          classification,
          safety,
          actionResult,
          createdAt: completedAt
        });
        this.appendRunCompletedEvent({
          input,
          classification,
          safety,
          actionResult,
          finalBackendStatus,
          fromStatus: currentStatus,
          createdAt: completedAt
        });

        // Phase 16 (turn boundary): a synchronous one-shot resume just finalized the
        // member to idle — drain any pending deliveries. Re-entrancy-guarded: when
        // this resume IS the drain's own nudge, the nested drain is skipped (the
        // nudge created no inbound rows, so there is nothing new to deliver).
        this.drainAfterSynchronousIdle(input);

        return {
          status: "idle",
          // D10-5: resume success (including a one-shot turn completion) keeps
          // the honest "attempted" wording — it does NOT imply mid-turn injection.
          delivery_status: MESSAGE_DELIVERY_STATUSES.backendResumeAttempted,
          turn_completed: true,
          final_status: "idle",
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

  // Phase 12 (D-04): TL-driven, read-only review of an isolated worktree branch
  // before merging. Returns branch / base / changed file NAMES / a --stat
  // summary / conflict preview — NEVER diff content (P5 D-19).
  reviewWorktree(request: MergeWorktreeRequest): ReviewWorktreeOutcome {
    const run = this.readMergeTargetRun(request.run_id);
    const validation = validateMergeTarget(run);
    if (!validation.ok) {
      return {
        status: "blocked",
        run_id: request.run_id,
        error_code: validation.errorCode,
        reason: validation.errorCode
      };
    }

    const result = this.worktreeMergeService.reviewWorktree({
      leaderWorkspaceRoot: request.identity.workspaceRoot,
      // Review/merge run against the run's persisted TARGET repo (the real repo
      // the worktree was branched from), NOT the coordination/container root.
      repoRoot: resolveTargetRepoRoot(validation.run, request.identity),
      workspace_path: validation.run.workspace_path,
      base_revision: validation.run.base_revision,
      branch: validation.run.worktree_branch
    });

    return { ...result, run_id: request.run_id };
  }

  // Phase 12 (D-04, OVERRIDES P5 D-15 no-auto-merge): explicit, TL-triggered,
  // auditable merge of an isolated worktree branch back into the leader working
  // tree. NOT a silent background auto-merge. On conflict the leader is rolled
  // back clean and the worktree is preserved (fail-closed). Persistence uses
  // targeted column UPDATEs only — metadata_json (incl. backend_metadata.pane)
  // is never rewritten (regresses neither R3 nor G-1).
  mergeWorktree(request: MergeWorktreeRequest): MergeWorktreeOutcome {
    const run = this.readMergeTargetRun(request.run_id);
    const validation = validateMergeTarget(run);
    if (!validation.ok) {
      return {
        status: "error",
        run_id: request.run_id,
        error_code: validation.errorCode
      };
    }
    const target = validation.run;
    const eventContext = this.buildMergeEventContext(target, request);

    this.appendEvent({
      input: eventContext,
      eventType: EVENT_TYPES.workspaceMergeRequested,
      payload: {
        run_id: target.run_id,
        teammate_id: eventContext.teammate_id || undefined,
        branch: target.worktree_branch ?? undefined
      },
      createdAt: new Date().toISOString()
    });

    const result: MergeWorktreeResult = this.worktreeMergeService.mergeIntoLeader({
      leaderWorkspaceRoot: request.identity.workspaceRoot,
      // Merge BACK INTO the run's persisted TARGET repo (the real repo the
      // worktree was branched from), NOT the coordination/container root.
      repoRoot: resolveTargetRepoRoot(target, request.identity),
      workspace_path: target.workspace_path,
      branch: target.worktree_branch,
      mergeLabel: request.merge_label ?? (eventContext.teammate_id || null)
    });

    if (result.status === "merged") {
      const mergedAt = new Date().toISOString();
      this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.runs}
            SET review_status = ?,
                merge_commit = ?,
                merged_at = ?,
                merged_by_caller_key = ?,
                worktree_branch = COALESCE(?, worktree_branch),
                merge_conflict_files_json = NULL
            WHERE run_id = ?
          `
        )
        .run(
          RUN_REVIEW_STATUSES.merged,
          result.merge_commit,
          mergedAt,
          request.identity.callerKey,
          result.branch,
          target.run_id
        );
      this.appendEvent({
        input: eventContext,
        eventType: EVENT_TYPES.workspaceMergeCompleted,
        payload: {
          run_id: target.run_id,
          teammate_id: eventContext.teammate_id || undefined,
          branch: result.branch,
          merge_commit: result.merge_commit,
          review_status: RUN_REVIEW_STATUSES.merged
        },
        createdAt: mergedAt
      });
      const cleanup = this.cleanupMergedWorktree(target, eventContext);
      return {
        status: "merged",
        run_id: target.run_id,
        review_status: RUN_REVIEW_STATUSES.merged,
        branch: result.branch,
        merge_commit: result.merge_commit,
        cleanup
      };
    }

    if (result.status === "conflict") {
      const conflictFilesJson = JSON.stringify(result.conflict_files);
      this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.runs}
            SET review_status = ?,
                merge_conflict_files_json = ?,
                worktree_branch = COALESCE(?, worktree_branch)
            WHERE run_id = ?
          `
        )
        .run(
          RUN_REVIEW_STATUSES.mergeConflict,
          conflictFilesJson,
          result.branch,
          target.run_id
        );
      this.appendEvent({
        input: eventContext,
        eventType: EVENT_TYPES.workspaceMergeConflict,
        payload: {
          run_id: target.run_id,
          teammate_id: eventContext.teammate_id || undefined,
          branch: result.branch,
          conflict_files: result.conflict_files,
          review_status: RUN_REVIEW_STATUSES.mergeConflict
        },
        createdAt: new Date().toISOString()
      });
      // Worktree preserved (fail-closed) for TL resolution / escalation.
      return {
        status: "conflict",
        run_id: target.run_id,
        review_status: RUN_REVIEW_STATUSES.mergeConflict,
        branch: result.branch,
        conflict_files: result.conflict_files
      };
    }

    if (result.status === "no_op") {
      const cleanup = this.cleanupMergedWorktree(target, eventContext);
      return {
        status: "no_op",
        run_id: target.run_id,
        review_status: resolveRunReviewStatus(target.review_status),
        branch: result.branch,
        cleanup
      };
    }

    // blocked: a git failure that was not a content conflict. Preserve the
    // worktree, mark needs_review, and record a sanitized auditable event.
    this.stampReviewStatus(target.run_id, RUN_REVIEW_STATUSES.needsReview);
    this.appendEvent({
      input: eventContext,
      eventType: EVENT_TYPES.workspaceMergeConflict,
      errorCode: WORKSPACE_ISOLATION_ERROR_CODE,
      payload: {
        run_id: target.run_id,
        teammate_id: eventContext.teammate_id || undefined,
        branch: result.branch ?? target.worktree_branch ?? undefined,
        merge_status: "blocked",
        reason: sanitizeText(result.reason, null),
        review_status: RUN_REVIEW_STATUSES.needsReview
      },
      createdAt: new Date().toISOString()
    });
    return {
      status: "blocked",
      run_id: target.run_id,
      review_status: RUN_REVIEW_STATUSES.needsReview,
      branch: result.branch ?? target.worktree_branch ?? undefined,
      reason: sanitizeText(result.reason, null) ?? undefined
    };
  }

  // Phase 12 (D-04): explicit hand-off to a human when the TL Agent cannot
  // resolve a merge autonomously. Records escalated_to_human + an auditable
  // event and PRESERVES the worktree/branch — no destructive action.
  escalateWorktree(request: MergeWorktreeRequest): EscalateWorktreeOutcome {
    const run = this.readMergeTargetRun(request.run_id);
    const validation = validateMergeTarget(run);
    if (!validation.ok) {
      return {
        status: "error",
        run_id: request.run_id,
        error_code: validation.errorCode
      };
    }
    const target = validation.run;
    const eventContext = this.buildMergeEventContext(target, request);

    this.stampReviewStatus(target.run_id, RUN_REVIEW_STATUSES.escalated);
    this.appendEvent({
      input: eventContext,
      eventType: EVENT_TYPES.workspaceMergeEscalated,
      payload: {
        run_id: target.run_id,
        teammate_id: eventContext.teammate_id || undefined,
        branch: target.worktree_branch ?? undefined,
        review_status: RUN_REVIEW_STATUSES.escalated
      },
      createdAt: new Date().toISOString()
    });

    return {
      status: "escalated",
      run_id: target.run_id,
      review_status: RUN_REVIEW_STATUSES.escalated,
      branch: target.worktree_branch ?? undefined
    };
  }

  // O-2 (P5 D-10 fail-closed): after a successful merge / no-op, the worktree's
  // work is committed and merged, so the working tree is clean — remove it.
  // base_revision is intentionally null here so cleanliness is judged by
  // `git status --short` only (the committed branch diff is exactly what was
  // merged); any leftover uncommitted change preserves the worktree.
  private cleanupMergedWorktree(
    target: ValidatedMergeTarget,
    eventContext: LifecycleRunContextInput
  ): "removed" | "preserved" | "not_found" {
    // `git worktree remove`/`prune` must run against the repo that OWNS the
    // worktree (the run's persisted TARGET repo), which may be a child of the
    // container. Falls back to the coordination root for v1.1 single-repo runs.
    const repoRoot = resolveTargetRepoRoot(target, eventContext.identity);
    const removal = this.worktreeService.removeWorktreeIfClean({
      leaderWorkspaceRoot: eventContext.identity.workspaceRoot,
      repoRoot,
      workspace_path: target.workspace_path,
      base_revision: null
    });
    this.worktreeService.pruneWorktrees(repoRoot);
    this.appendEvent({
      input: eventContext,
      eventType: EVENT_TYPES.workspaceWorktreeCleaned,
      payload: {
        run_id: target.run_id,
        teammate_id: eventContext.teammate_id || undefined,
        cleanup_status: removal.status,
        reason: removal.reason ? sanitizeText(removal.reason, null) : undefined
      },
      createdAt: new Date().toISOString()
    });
    return removal.status;
  }

  private buildMergeEventContext(
    run: { team_id: string; member_id: string; run_id: string },
    request: MergeWorktreeRequest
  ): LifecycleRunContextInput {
    return {
      team_id: run.team_id,
      team_name: normalizeOptionalText(request.team_name) ?? "",
      member_id: run.member_id,
      run_id: run.run_id,
      teammate_id: normalizeOptionalText(request.teammate_id) ?? "",
      prompt_present: false,
      identity: request.identity
    };
  }

  private readMergeTargetRun(runId: string): MergeTargetRow | null {
    return (
      (this.options.db
        .prepare(
          `
            SELECT
              run_id,
              team_id,
              member_id,
              isolation_kind,
              review_status,
              workspace_path,
              base_revision,
              worktree_branch,
              worktree_repo_root
            FROM ${TABLE_NAMES.runs}
            WHERE run_id = ?
            LIMIT 1
          `
        )
        .get(runId) as MergeTargetRow | undefined) ?? null
    );
  }

  private stampReviewStatus(runId: string, reviewStatus: RunReviewStatus): void {
    this.options.db
      .prepare(
        `UPDATE ${TABLE_NAMES.runs} SET review_status = ? WHERE run_id = ?`
      )
      .run(reviewStatus, runId);
  }

  private prepareSafety(
    input: StartScheduledRunInput,
    backendDescription: ExecutionBackendDescription,
    classification: WorkClassification
  ): {
    safety: WorkspaceSafetyResult;
    worktreeBranch: string | null;
    worktreeBlockedReason: string | null;
  } {
    if (!isFileModifyingWork(classification)) {
      return {
        safety: this.workspaceSafetyService.prepareWorkspace({
          work_classification: classification,
          leaderWorkspaceRoot: input.identity.workspaceRoot,
          backendCapabilities: toWorkspaceBackendCapabilities(
            backendDescription.capabilities
          )
        }),
        worktreeBranch: null,
        worktreeBlockedReason: null
      };
    }

    // NOTE: `cwd` is NO LONGER a direct (unisolated) workspace_path — it is the
    // per-TeamMate TARGET repo HINT that feeds repo resolution + worktree
    // creation below. Only an explicit workspace_path is treated as a concrete,
    // already-isolated path.
    const resolvedWorkspacePath = normalizeOptionalText(input.workspace_path);
    const resolvedReviewDiff = normalizeOptionalText(
      input.review_diff_artifact_path
    );
    const resolvedDeclaredOutput = normalizeOptionalText(
      input.declared_output_path
    );

    let workspacePath = resolvedWorkspacePath;
    let baseRevision = normalizeOptionalText(input.base_revision);
    let worktreeBranch: string | null = null;
    let worktreeRepoRoot: string | null = null;
    let worktreeBlockedReason: string | null = null;

    // EXEC-04/D-01 (tightened in Phase 12): for a workspaces-capable backend the
    // git worktree is the REQUIRED primary isolation for every file-modifying
    // run. Auto-create an isolated worktree (independent branch, recorded base
    // revision) OUTSIDE the leader tree whenever there is no concrete worktree
    // workspace_path — review-diff alone no longer bypasses worktree creation
    // (it is downgraded to a pre-merge review step, D-04). A caller-supplied
    // declared_output_path (artifact_writing writing OUTSIDE the leader tree)
    // stays a legitimate isolation and is left untouched. On failure the run
    // stays blocked and is never redirected to the leader (ISOL-01, fail-closed).
    if (
      backendDescription.capabilities.supportsWorkspaces === true &&
      !resolvedWorkspacePath &&
      !resolvedDeclaredOutput
    ) {
      const created = this.worktreeService.createIsolatedWorktree({
        leaderWorkspaceRoot: input.identity.workspaceRoot,
        // The cwd repo HINT: resolves the TARGET repo (which may be a CHILD of a
        // non-repo container). Absent → the leader must itself be a repo (v1.1).
        cwd: normalizeOptionalText(input.cwd),
        teamName: input.team_name,
        memberCanonicalName: canonicalNameFromMemberId(input.member_id),
        runId: input.run_id
      });

      if (created.status === "ready") {
        workspacePath = created.workspace_path;
        baseRevision = created.base_revision;
        worktreeBranch = created.branch;
        worktreeRepoRoot = created.repo_root;
        // ISOL-02: persist the worktree branch + resolved TARGET repo root on
        // the run row (targeted UPDATEs, never rewrite metadata_json) so the TL
        // merge flow (D-04) and diagnostics resolve them. Mirrors
        // stampResumeAttempt.
        this.stampWorktreeBranch(input.run_id, created.branch);
        this.stampWorktreeRepoRoot(input.run_id, created.repo_root);
        this.appendWorkspaceIsolationCreatedEvent({
          input,
          classification,
          created
        });
      } else {
        // Fail-closed (ISOL-01): the TARGET repo could not be resolved (e.g.
        // workspace_target_repo_unresolved). Surface the sanitized reason; the
        // run stays BLOCKED below and is never run unisolated nor redirected
        // into the leader/container tree.
        worktreeBlockedReason = sanitizeText(created.reason, input.prompt);
      }
    }

    return {
      safety: this.workspaceSafetyService.prepareWorkspace({
        work_classification: classification,
        leaderWorkspaceRoot: input.identity.workspaceRoot,
        backendCapabilities: toWorkspaceBackendCapabilities(
          backendDescription.capabilities
        ),
        isolation: normalizeOptionalText(input.isolation),
        workspace_path: workspacePath,
        worktree_repo_root: worktreeRepoRoot,
        review_diff_artifact_path: resolvedReviewDiff,
        declared_output_path: resolvedDeclaredOutput,
        base_revision: baseRevision
      }),
      worktreeBranch,
      worktreeBlockedReason
    };
  }

  // PANE-01 / PANE-02 / D-01: best-effort, purely additive pane visibility
  // overlay over a real started/resumed run. When pane mode is enabled and a
  // supported terminal backend is available, create/attach a visible pane and
  // merge its attach metadata into actionResult.metadata.pane (persisted by
  // updateRunLifecycle into runs.metadata_json.backend_metadata.pane). It NEVER
  // touches the core run — status / backend_status / thread_id stay exactly as
  // the real backend returned. Any unavailability or error degrades to a pane
  // marker only (PANE-02), so durable team/message/task/event state is intact.
  private overlayVisiblePane(
    context: { run_id: string; team_id: string; member_id: string | null } & Record<
      string,
      unknown
    >,
    actionResult: ExecutionBackendActionResult
  ): void {
    if (!this.paneBackend || this.options.paneMode?.enabled !== true) {
      return;
    }

    // If the execution backend is itself a pane backend that already produced
    // pane metadata for this action, it owns the pane — never override it.
    if (extractPaneMetadata(actionResult.metadata)) {
      return;
    }

    // A previously-created pane for this run (e.g. created at start, now resuming).
    // Preserved so resume — whose backend metadata usually carries no pane —
    // never wipes or wrongly degrades an already-visible pane.
    const existingPane = this.readPersistedPane(context.run_id);
    const availability = this.safeDescribePaneAvailability();

    if (availability && availability.availability_status === "available") {
      // Resolve the per-run exec log so the visible pane tails it (PANE content).
      // Falls back to undefined (empty pane, prior behavior) when no path resolves.
      const command = this.resolvePaneCommand(context, actionResult);
      // Layout determinism (iTerm2): pass the team's already-open pane ids
      // (DB-derived, most-recent first) so the backend anchors the new teammate
      // split off the latest live pane and they stack vertically — instead of
      // every teammate re-splitting the leader because in-process state reset.
      const previousTeammatePaneIds = this.collectPreviousTeammatePaneIds(
        context.team_id,
        context.run_id
      );
      const launch = this.safeCreateVisiblePane(
        { ...context, previousTeammatePaneIds },
        command
      );
      if (launch.ok) {
        this.mergePaneMetadata(actionResult, launch.pane);
        return;
      }
      // Create failed: keep a previously-good pane rather than degrade it.
      if (existingPane && existingPane.availability_status === "available") {
        this.mergePaneMetadata(actionResult, existingPane);
        return;
      }
      this.mergePaneMetadata(actionResult, {
        ...launch.pane,
        availability_status: "degraded",
        degradation_reason:
          launch.pane.degradation_reason ?? PANE_OVERLAY_DEGRADED_REASON
      });
      return;
    }

    // Backend unavailable: keep a previously-created pane visible if we had one,
    // otherwise record an explicit unavailable marker (PANE-02). The core run is
    // never affected either way.
    if (existingPane && existingPane.availability_status === "available") {
      this.mergePaneMetadata(actionResult, existingPane);
      return;
    }
    this.mergePaneMetadata(actionResult, {
      mode: "pane",
      backend_type: availability?.backend_type ?? existingPane?.backend_type ?? "tmux",
      availability_status:
        availability?.availability_status === "degraded"
          ? "degraded"
          : "unavailable",
      degradation_reason:
        availability?.degradation_reason ?? PANE_BACKEND_UNAVAILABLE_REASON
    });
  }

  private readPersistedPane(runId: string): PaneBackendMetadata | null {
    const run = this.findRunById(runId);
    if (!run) {
      return null;
    }
    return extractPaneMetadata(parseJsonObject(run.metadata_json));
  }

  // Layout determinism (iTerm2): the ordered (most-recent first) list of this
  // team's already-open iTerm2 pane ids, derived from the durable DB. Handed to
  // the pane backend as context.previousTeammatePaneIds so it anchors a new
  // teammate split off the latest LIVE pane (panes stack vertically) instead of
  // re-splitting the leader. DB-sourced rather than in-process closure state
  // because the backend is re-instantiated on every Agent tool call, which reset
  // the old closure tracking and made every teammate split the leader. Only
  // `available` panes are returned — closed panes are marked unavailable
  // (markRunPaneClosed) and naturally excluded. Best-effort: any query failure
  // yields an empty list so the overlay degrades to the leader split, never throws.
  private collectPreviousTeammatePaneIds(
    teamId: string,
    currentRunId: string
  ): string[] {
    let rows: Array<{ run_id: string; metadata_json: string }>;
    try {
      rows = this.options.db
        .prepare(
          `
            SELECT run_id, metadata_json
            FROM ${TABLE_NAMES.runs}
            WHERE team_id = ? AND run_id != ?
            ORDER BY created_at DESC, run_id DESC
          `
        )
        .all(teamId, currentRunId) as Array<{
        run_id: string;
        metadata_json: string;
      }>;
    } catch {
      return [];
    }

    const paneIds: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const pane = extractPaneMetadata(parseJsonObject(row.metadata_json));
      if (
        pane &&
        pane.backend_type === "iterm2" &&
        pane.availability_status === "available" &&
        pane.pane_id &&
        !seen.has(pane.pane_id)
      ) {
        seen.add(pane.pane_id);
        paneIds.push(pane.pane_id);
      }
    }
    return paneIds;
  }

  private safeDescribePaneAvailability(): PaneBackendMetadata | null {
    try {
      return this.paneBackend?.describeAvailability() ?? null;
    } catch {
      return null;
    }
  }

  // Best-effort teardown of every available pane belonging to a team. Used by
  // TeamDelete. NON-GATING: any failure (no pane backend, a dead pane, a close
  // command error) is swallowed per-run so the originating TeamDelete is never
  // affected. Returns how many panes were attempted vs. successfully closed.
  closePanesForTeam(teamId: string): PaneTeardownSummary {
    return this.closePanesForRows(
      `SELECT r.run_id, r.member_id, r.team_id, t.workspace_root, r.metadata_json,
              r.workspace_path, r.base_revision
         FROM ${TABLE_NAMES.runs} r
         INNER JOIN ${TABLE_NAMES.teams} t ON t.team_id = r.team_id
        WHERE r.team_id = ?`,
      [teamId]
    );
  }

  // Best-effort teardown of a single member's panes. Used when the TL sends a
  // structured shutdown_request to a teammate. Same non-gating guarantees as
  // closePanesForTeam — the SendMessage persistence is never affected.
  closePanesForMember(teamId: string, memberId: string): PaneTeardownSummary {
    return this.closePanesForRows(
      `SELECT r.run_id, r.member_id, r.team_id, t.workspace_root, r.metadata_json,
              r.workspace_path, r.base_revision
         FROM ${TABLE_NAMES.runs} r
         INNER JOIN ${TABLE_NAMES.teams} t ON t.team_id = r.team_id
        WHERE r.team_id = ? AND r.member_id = ?`,
      [teamId, memberId]
    );
  }

  private closePanesForRows(
    query: string,
    params: ReadonlyArray<string>
  ): PaneTeardownSummary {
    // No pane backend -> nothing to tear down (pane mode off / not injected).
    if (!this.paneBackend) {
      return { attempted: 0, closed: 0 };
    }

    let attempted = 0;
    let closed = 0;
    let rows: PaneTeardownRunRow[];
    try {
      rows = this.options.db
        .prepare(query)
        .all(...params) as PaneTeardownRunRow[];
    } catch {
      // A failed query must not bubble up — teardown is purely additive.
      return { attempted: 0, closed: 0 };
    }

    for (const row of rows) {
      try {
        const metadata = parseJsonObject(row.metadata_json);
        const pane = extractPaneMetadata(metadata);
        // Skip rows with no live pane: missing pane, missing id, or already
        // marked unavailable (closed earlier / never opened).
        if (
          !pane ||
          !pane.pane_id ||
          pane.availability_status === "unavailable"
        ) {
          continue;
        }
        attempted += 1;
        const result = this.paneBackend.closePane(pane);
        if (result.ok) {
          closed += 1;
          // Metadata-only marker: pane unavailable + intentional-stop signal.
          this.markRunPaneClosed(row.run_id, metadata, pane);
          // BUG #4: an intentional teardown is a CLEAN stop, not a crash. Flip a
          // still-running run (and its member) to the terminal `stopped` status so
          // a later reconcile never re-classifies the gone pane as
          // `failed` / codex_pane_exited_without_completion, and emit a
          // teammate_stopped (NOT teammate_backend_failed) event. Guarded to
          // status='running' so an already-terminal run (e.g. a completed idle run
          // torn down at TeamDelete) keeps its real status.
          this.markRunStoppedByTeardown(row);
        }
      } catch {
        // Best-effort: a single run's failure never affects the others.
      }
    }

    return { attempted, closed };
  }

  // Targeted, metadata_json-ONLY update marking a run's pane as closed. Touches
  // no other column (workspace_path / review_status / merge_* are untouched so
  // the merge-audit flow keeps working). Mirrors the canonical pane location
  // (backend_metadata.pane); also rewrites a top-level metadata.pane if present.
  private markRunPaneClosed(
    runId: string,
    metadata: Record<string, unknown>,
    pane: PaneBackendMetadata
  ): void {
    const closedPane: PaneBackendMetadata = {
      ...pane,
      availability_status: "unavailable",
      degradation_reason: PANE_CLOSED_REASON
    };

    const backendMetadata = isRecord(metadata.backend_metadata)
      ? metadata.backend_metadata
      : {};
    const updatedMetadata: Record<string, unknown> = {
      ...metadata,
      // BUG #4: durable intentional-stop marker. Reconcile's gone-pane → failed path
      // checks this so an intentionally-closed pane is never re-classified as a crash
      // even if the status flip below did not persist (best-effort defense-in-depth).
      intentional_stop: true,
      backend_metadata: {
        ...backendMetadata,
        pane: closedPane
      }
    };
    if (isRecord(metadata.pane)) {
      updatedMetadata.pane = closedPane;
    }

    try {
      this.options.db
        .prepare(
          `UPDATE ${TABLE_NAMES.runs} SET metadata_json = ? WHERE run_id = ?`
        )
        .run(JSON.stringify(updatedMetadata), runId);
    } catch {
      // The pane is already closed in the terminal; failing to persist the
      // marker is non-fatal and must not surface to the caller.
    }
  }

  // BUG #4: flip an intentionally-torn-down RUNNING run (and its member) to the
  // clean terminal `stopped` status, then emit a teammate_stopped event. Guarded to
  // status='running' so it never downgrades an already-terminal run (a completed
  // idle run, a prior failure) — only the live runs that a later reconcile would
  // otherwise mis-read as a gone-pane crash are stopped. Touches ONLY status /
  // backend_status / ended_at / updated_at (workspace_path / review_status / merge_*
  // stay untouched, preserving the merge-audit contract). Best-effort + non-gating:
  // any failure is swallowed so the originating SendMessage / TeamDelete is never
  // affected.
  private markRunStoppedByTeardown(row: PaneTeardownRunRow): void {
    const now = new Date().toISOString();
    try {
      const update = this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.runs}
            SET status = ?,
                backend_status = ?,
                ended_at = COALESCE(ended_at, ?),
                updated_at = ?
            WHERE run_id = ? AND status = ?
          `
        )
        .run(
          MEMBER_STATUSES.stopped,
          RUN_BACKEND_STATUSES.stopped,
          now,
          now,
          row.run_id,
          MEMBER_STATUSES.running
        );

      // Not a running run (already terminal / scheduled) -> leave it (and its
      // member + events) untouched. Only a real running -> stopped transition is
      // recorded.
      if (update.changes === 0) {
        return;
      }

      if (row.member_id) {
        this.options.db
          .prepare(
            `UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ? AND status = ?`
          )
          .run(MEMBER_STATUSES.stopped, row.member_id, MEMBER_STATUSES.running);
      }

      // FIX #3: this teardown-stop is the run's FINAL terminal transition under
      // TeamDelete / shutdown_request. The reconcile-side capture
      // (ReconciliationService.captureChangedFilesAtTurnBoundary) never runs for a
      // run stopped this way, so without this call changed_files_json would keep the
      // pre-stop snapshot and go STALE (e.g. a late-delivered revert leaves the
      // worktree clean but diagnostics still lists the reverted file). Re-capture
      // the worktree's final state ONCE here, guarded by the same changes>0 success
      // gate as teammate_stopped so it only fires on a real running -> stopped flip.
      this.captureChangedFilesAtTeardown(row, now);

      this.appendTeammateStoppedEvent(row, now);
    } catch {
      // Best-effort: a status flip / event failure must never fail the teardown.
      // The metadata intentional-stop marker (markRunPaneClosed) still guards the
      // reconcile gone-pane path.
    }
  }

  // FIX #3: capture changed_files ONCE at the teardown-stop terminal transition so
  // it reflects the worktree's FINAL state at stop time. Mirrors the reconcile-side
  // ReconciliationService.captureChangedFilesAtTurnBoundary: reuses the SHARED
  // workspaceSafetyService.inspectWorkspace path and writes ONLY changed_files_json +
  // diff_summary via a scoped UPDATE (NEVER review_status / merge_* / workspace_path —
  // D-02: changed_files is a list of paths, no bodies). Only pane/worktree runs
  // (workspace_path set) are inspected; detached non-worktree runs are skipped.
  // Best-effort + bounded: try/catch around BOTH the inspection AND the UPDATE so any
  // failure degrades to leaving changed_files as-is and never breaks teardown.
  private captureChangedFilesAtTeardown(
    row: PaneTeardownRunRow,
    now: string
  ): void {
    if (!row.workspace_path) {
      return;
    }

    let inspection: WorkspaceInspectionResult;
    try {
      inspection = this.workspaceSafetyService.inspectWorkspace({
        workspace_path: row.workspace_path,
        base_revision: row.base_revision
      });
    } catch {
      // Defensive: inspectWorkspace already degrades internally, but a thrown error
      // must never break the teardown-stop transition.
      return;
    }

    try {
      this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.runs}
            SET changed_files_json = ?,
                diff_summary = COALESCE(?, diff_summary),
                updated_at = ?
            WHERE run_id = ?
          `
        )
        .run(
          inspection.changed_files_json,
          normalizeOptionalText(inspection.diff_summary),
          now,
          row.run_id
        );
    } catch {
      // Best-effort: a persistence failure leaves changed_files as-is.
    }
  }

  // Auditable record of an intentional teammate stop from a pane teardown. A system
  // action (no human caller), so the actor caller key is a system marker. Mirrors the
  // reconcile terminal events; explicitly NOT a teammate_backend_failed.
  private appendTeammateStoppedEvent(
    row: PaneTeardownRunRow,
    createdAt: string
  ): void {
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
        `event:${randomUUID()}`,
        row.team_id,
        row.member_id,
        row.workspace_root,
        SYSTEM_PANE_TEARDOWN_CALLER,
        EVENT_TYPES.teammateStopped,
        null,
        JSON.stringify({
          run_id: row.run_id,
          member_id: row.member_id,
          previous_status: MEMBER_STATUSES.running,
          status: MEMBER_STATUSES.stopped,
          reason: PANE_CLOSED_REASON,
          intentional_stop: true
        }),
        createdAt
      );
  }

  // Resolve the visibility command for a new pane: tail the run's codex exec log
  // so the pane shows live output. Prefers the path the backend already recorded
  // (actionResult.metadata.exec_log_path, then backend_metadata.exec_log_path),
  // and otherwise derives the canonical path from workspace_root + run_id. All
  // sources are validated to non-empty strings; unresolved -> undefined (the pane
  // opens empty, exactly as before — still best-effort).
  private resolvePaneCommand(
    context: { run_id: string } & Record<string, unknown>,
    actionResult: ExecutionBackendActionResult
  ): readonly string[] | undefined {
    const metadata = actionResult.metadata;
    const direct = optionalStringValue(metadata?.exec_log_path);
    const nested =
      metadata && isRecord(metadata.backend_metadata)
        ? optionalStringValue(metadata.backend_metadata.exec_log_path)
        : null;
    const runId = optionalStringValue(context.run_id);
    const logPath =
      direct ??
      nested ??
      (runId
        ? codexExecLogPath(optionalStringValue(context.workspace_root), runId)
        : null);
    return logPath ? ["tail", "-f", logPath] : undefined;
  }

  private safeCreateVisiblePane(
    context: {
      run_id: string;
      team_id: string;
      member_id: string | null;
    } & Record<string, unknown>,
    command?: readonly string[]
  ): { ok: boolean; pane: PaneBackendMetadata } {
    try {
      const launch = this.paneBackend!.createPane(
        context as unknown as Parameters<PaneBackendRegistry["createPane"]>[0],
        command
      );
      return { ok: launch.ok, pane: launch.pane };
    } catch (error) {
      return {
        ok: false,
        pane: {
          mode: "pane",
          backend_type: "tmux",
          availability_status: "degraded",
          degradation_reason:
            sanitizeText(errorToMessage(error), null) ?? PANE_OVERLAY_DEGRADED_REASON
        }
      };
    }
  }

  private mergePaneMetadata(
    actionResult: ExecutionBackendActionResult,
    pane: PaneBackendMetadata
  ): void {
    actionResult.metadata = {
      ...actionResult.metadata,
      pane
    };
  }

  private appendWorkspaceIsolationCreatedEvent(input: {
    input: StartScheduledRunInput;
    classification: WorkClassification;
    created: Extract<CreateIsolatedWorktreeResult, { status: "ready" }>;
  }): void {
    this.appendEvent({
      input: input.input,
      eventType: EVENT_TYPES.workspaceIsolationCreated,
      payload: {
        teammate_id: input.input.teammate_id,
        run_id: input.input.run_id,
        workspace_path: input.created.workspace_path,
        worktree_repo_root: input.created.repo_root,
        base_revision: input.created.base_revision,
        branch: input.created.branch,
        isolation_kind: ISOLATION_KINDS.gitWorktree,
        work_classification: input.classification
      },
      createdAt: new Date().toISOString()
    });
  }

  private appendRunCompletedEvent(input: {
    input: LifecycleRunContextInput;
    classification: WorkClassification;
    safety: WorkspaceSafetyResult;
    actionResult: ExecutionBackendActionResult;
    finalBackendStatus: RunBackendStatus;
    createdAt: string;
    // Defaults to scheduled (start one-shot completion path). The resume
    // completion path passes the real prior state (idle/stopped) for honesty.
    fromStatus?: string;
  }): void {
    // Lifecycle-only completion record (D-02): NO prompt/output/body fields.
    this.appendEvent({
      input: input.input,
      eventType: EVENT_TYPES.teammateRunCompleted,
      payload: {
        teammate_id: input.input.teammate_id,
        run_id: input.input.run_id,
        from_status: input.fromStatus ?? MEMBER_STATUSES.scheduled,
        to_status: MEMBER_STATUSES.idle,
        backend: input.actionResult.backend,
        backend_status: input.finalBackendStatus,
        work_classification: input.classification,
        isolation_kind: input.safety.isolation_kind,
        review_status: input.safety.review_status,
        started_at: input.actionResult.started_at ?? null,
        ended_at: input.actionResult.ended_at ?? null,
        last_error: null
      },
      createdAt: input.createdAt
    });
  }

  private markWorkspaceReviewRequired(
    input: StartScheduledRunInput,
    classification: WorkClassification,
    safety: WorkspaceSafetyResult,
    // When set (e.g. workspace_target_repo_unresolved), the SPECIFIC fail-closed
    // reason. The MCP-facing error_code stays the stable workspace_isolation_
    // required contract; the precise reason is surfaced in the auditable event.
    blockedReason: string | null = null
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
        reason: blockedReason ?? undefined,
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
      turn_completed: input.actionResult.turn_completed,
      final_status: input.actionResult.final_status,
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
    errorDetail?: string;
    lastError?: string | null;
    promptPresent: boolean;
  }): LifecycleActionResult {
    return {
      status: "scheduled",
      delivery_status: input.deliveryStatus,
      error_code: input.errorCode,
      ...(input.errorDetail ? { error_detail: input.errorDetail } : {}),
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

  // D10-4: targeted write of the resume debounce timestamp. Independent of
  // updateRunLifecycle (which does NOT touch this column), so stamping after the
  // resume turn never clobbers the lifecycle write and vice-versa.
  private stampResumeAttempt(runId: string, isoTime: string): void {
    this.options.db
      .prepare(
        `UPDATE ${TABLE_NAMES.runs} SET last_resume_attempt_at = ? WHERE run_id = ?`
      )
      .run(isoTime, runId);
  }

  // Phase 12 (ISOL-02): targeted write of the worktree branch (migration v6
  // column). Independent of updateRunLifecycle (which never touches this column),
  // mirroring stampResumeAttempt, so it never clobbers the lifecycle write.
  private stampWorktreeBranch(runId: string, branch: string): void {
    this.options.db
      .prepare(
        `UPDATE ${TABLE_NAMES.runs} SET worktree_branch = ? WHERE run_id = ?`
      )
      .run(branch, runId);
  }

  // Decoupling (migration v7): targeted write of the resolved TARGET repo root
  // (the real repo the worktree was branched from — may be a CHILD of a non-repo
  // container). Independent of updateRunLifecycle (which never touches this
  // column), mirroring stampWorktreeBranch, so it never clobbers the lifecycle
  // write. The merge/review flow reads it back to run git against the right repo.
  private stampWorktreeRepoRoot(runId: string, repoRoot: string): void {
    this.options.db
      .prepare(
        `UPDATE ${TABLE_NAMES.runs} SET worktree_repo_root = ? WHERE run_id = ?`
      )
      .run(repoRoot, runId);
  }

  // Phase 16 — TURN-BOUNDARY delivery drain. Delivers every pending message to a
  // recipient that is at a turn boundary (idle/stopped with a live pane + durable
  // resume metadata) by injecting ONE short, length-bounded inbox nudge — never the
  // body (notify + pull). Claim-first on the shared WAL DB makes it at-most-once and
  // multi-process race safe. NEVER injects into a running recipient (locked #1: no
  // mid-turn steer). Loop-free: a nudge sets delivered_at on every claimed row and
  // creates no inbound rows, so a re-drain finds nothing.
  drainPendingDeliveries(
    input: DrainPendingDeliveriesInput
  ): DrainPendingDeliveriesResult {
    if (this.draining) {
      return { status: "reentrant_skip", nudged: false, claimed_count: 0 };
    }
    this.draining = true;
    try {
      return this.drainPendingDeliveriesInner(input);
    } finally {
      this.draining = false;
    }
  }

  private drainPendingDeliveriesInner(
    input: DrainPendingDeliveriesInput
  ): DrainPendingDeliveriesResult {
    const run = this.findLatestRunForMember(
      input.teamId,
      input.recipientMemberId
    );
    if (!run) {
      return { status: "no_run", nudged: false, claimed_count: 0 };
    }

    const memberStatus =
      this.readMemberStatus(input.recipientMemberId) ?? run.status;

    // Locked #1: a running recipient has NOT reached its turn boundary — return
    // immediately, never mid-turn steer.
    if (memberStatus === MEMBER_STATUSES.running) {
      return {
        status: "recipient_running",
        nudged: false,
        claimed_count: 0,
        run_id: run.run_id
      };
    }
    if (
      memberStatus !== MEMBER_STATUSES.idle &&
      memberStatus !== MEMBER_STATUSES.stopped
    ) {
      return {
        status: "nothing_pending",
        nudged: false,
        claimed_count: 0,
        run_id: run.run_id
      };
    }

    // Reachability: a live pane + durable resume metadata. No live pane (detached
    // run, or pane closed) -> leave delivered_at NULL, do nothing destructive.
    const pane = extractPaneMetadata(parseJsonObject(run.metadata_json));
    if (
      !pane ||
      pane.availability_status !== "available" ||
      !normalizeOptionalText(pane.pane_id)
    ) {
      return {
        status: "no_live_pane",
        nudged: false,
        claimed_count: 0,
        run_id: run.run_id
      };
    }
    if (!hasDurableResumeMetadata(run)) {
      return {
        status: "no_durable_metadata",
        nudged: false,
        claimed_count: 0,
        run_id: run.run_id
      };
    }

    // Claim-first (atomic BEGIN IMMEDIATE, conditional delivered_at IS NULL): only
    // rows THIS process flipped are ours. A concurrent drain claims zero -> no
    // duplicate nudge, no double delivery.
    const inbox = new MessageInboxService(this.options.db);
    const claimed = inbox.claimDelivered(
      input.teamId,
      input.recipientMemberId,
      new Date().toISOString()
    );
    if (claimed.length === 0) {
      return {
        status: "nothing_pending",
        nudged: false,
        claimed_count: 0,
        run_id: run.run_id
      };
    }

    // ONE short nudge for the whole claimed batch: count + distinct sender public
    // ids. Bounded + independent of body size (buildInboxNudge).
    const nudge = buildInboxNudge(
      claimed.length,
      claimed.map((row) => inboxSenderPublicId(row, input.teamName))
    );

    const resumeResult = this.resumeRun({
      team_id: input.teamId,
      team_name: input.teamName,
      member_id: input.recipientMemberId,
      run_id: run.run_id,
      teammate_id: this.resolveMemberPublicId(
        input.recipientMemberId,
        input.teamName
      ),
      prompt_present: false,
      message_id: claimed[claimed.length - 1].message_id,
      recipient_status: memberStatus,
      delivery_text: nudge,
      trigger_kind: "message",
      identity: input.identity
    });

    const delivered =
      resumeResult.delivery_status ===
      MESSAGE_DELIVERY_STATUSES.backendResumeAttempted;
    if (!delivered) {
      // Inject failed -> compensating un-stamp so a later drain retries the batch.
      inbox.uncompensateDelivered(claimed.map((row) => row.message_id));
      return {
        status: "inject_failed",
        nudged: false,
        claimed_count: 0,
        run_id: run.run_id
      };
    }

    // Stamp the debounce timestamp AFTER injecting so a message arriving right after
    // the nudge does not immediately re-resume.
    this.stampResumeAttempt(run.run_id, new Date().toISOString());
    return {
      status: "delivered",
      nudged: true,
      claimed_count: claimed.length,
      run_id: run.run_id
    };
  }

  // Best-effort drain of EVERY recipient in a team that is already idle/stopped with
  // pending rows (the §1.4(a) tool-tail backstop). NON-GATING: any failure is
  // swallowed per-recipient so the originating tool is never affected. Does NOT run
  // the full finalize reconcile (that stays in TeamDiagnostics).
  drainTeamPendingDeliveries(input: {
    teamId: string;
    teamName: string;
    identity: WorkspaceScopedCallerIdentity;
  }): void {
    let recipients: string[];
    try {
      recipients = this.findRecipientsWithPendingDeliveries(input.teamId);
    } catch {
      return;
    }
    for (const recipientMemberId of recipients) {
      try {
        this.drainPendingDeliveries({
          teamId: input.teamId,
          teamName: input.teamName,
          recipientMemberId,
          identity: input.identity
        });
      } catch {
        // Best-effort: a single recipient's failure never affects the others.
      }
    }
  }

  // Internal turn-boundary hook for the two synchronous idle finalizers. Best-effort
  // and re-entrancy-guarded (drainPendingDeliveries skips when already draining).
  private drainAfterSynchronousIdle(input: {
    team_id: string;
    team_name: string;
    member_id: string;
    identity: WorkspaceScopedCallerIdentity;
  }): void {
    try {
      this.drainPendingDeliveries({
        teamId: input.team_id,
        teamName: input.team_name,
        recipientMemberId: input.member_id,
        identity: input.identity
      });
    } catch {
      // Best-effort: the synchronous finalize must never fail on a drain error.
    }
  }

  private findLatestRunForMember(
    teamId: string,
    memberId: string
  ): DeliveryRunRow | null {
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
        .get(teamId, memberId) as DeliveryRunRow | undefined) ?? null
    );
  }

  private readMemberStatus(memberId: string): string | null {
    const row = this.options.db
      .prepare(
        `SELECT status FROM ${TABLE_NAMES.members} WHERE member_id = ? LIMIT 1`
      )
      .get(memberId) as { status: string } | undefined;
    return row?.status ?? null;
  }

  // The recipient's public id (teammate_id) for the resume events. Mirrors
  // memberResolver.resolvePublicId: prefer the persisted publicTeammateId, then the
  // leader form, then the canonical-name fallback.
  private resolveMemberPublicId(memberId: string, teamName: string): string {
    const metadata = this.readMemberMetadata(memberId);
    const publicTeammateId = optionalStringFromMetadata(
      metadata.publicTeammateId
    );
    if (publicTeammateId) {
      return publicTeammateId;
    }
    const publicLeadAgentId = optionalStringFromMetadata(
      metadata.publicLeadAgentId
    );
    if (publicLeadAgentId) {
      return publicLeadAgentId;
    }
    if (memberId.startsWith("leader:")) {
      return `team-lead@${teamName}`;
    }
    return `${canonicalNameFromMemberId(memberId)}@${teamName}`;
  }

  // Distinct recipients in a team that are idle/stopped AND have at least one pending
  // (undelivered, non-suppress) row — the backstop work list. SELECTION GATE =
  // `delivered_at IS NULL` ONLY (the single source of truth); the prior
  // `status = 'queued'` predicate is dropped so the set stays IDENTICAL while the
  // status column converges, and so a compensating un-stamp (delivered_at -> NULL)
  // correctly re-surfaces the row for a retry.
  private findRecipientsWithPendingDeliveries(teamId: string): string[] {
    const rows = this.options.db
      .prepare(
        `
          SELECT DISTINCT m.recipient_member_id AS recipient_member_id
          FROM ${TABLE_NAMES.messages} m
          INNER JOIN ${TABLE_NAMES.members} mem
            ON mem.member_id = m.recipient_member_id
          WHERE m.team_id = ?
            AND m.delivered_at IS NULL
            AND mem.status IN (
              '${MEMBER_STATUSES.idle}',
              '${MEMBER_STATUSES.stopped}'
            )
            AND (
              json_extract(m.metadata_json, '$.message_type') IS NULL
              OR json_extract(m.metadata_json, '$.message_type') NOT IN (
                'resume_failure_notice',
                'lifecycle_completion'
              )
            )
        `
      )
      .all(teamId) as Array<{ recipient_member_id: string | null }>;

    return rows
      .map((row) => row.recipient_member_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
  }
}

function isFileModifyingWork(classification: WorkClassification): boolean {
  return (
    classification === WORK_CLASSIFICATIONS.artifactWriting ||
    classification === WORK_CLASSIFICATIONS.codeImplementation
  );
}

// Build the sanitized, actionable remediation surfaced on a workspace_isolation_
// required result. The error_code stays the stable machine contract; this string
// tells the leader the concrete cause (the worktree could not be created — usually
// because the leader workspace root is not a git repo) and the three fixes. The
// blocked reason is already sanitized by prepareSafety; the workspace root is the
// caller's own path (non-sensitive, already surfaced in diagnostics).
function buildWorkspaceIsolationRemediation(
  workspaceRoot: string,
  worktreeBlockedReason: string | null,
  cwd: string | null
): string {
  const reasonClause = worktreeBlockedReason
    ? ` Reason: ${worktreeBlockedReason}.`
    : "";
  const cwdClause = cwd
    ? `The Agent cwd '${cwd}' did not resolve to a git repository.`
    : `No Agent cwd was provided, so the leader workspace root '${workspaceRoot}' was used as the target repo — but it is not a git repository.`;
  return (
    "File-modifying TeamMate work requires an isolated git worktree, which could not be created. " +
    `${cwdClause}${reasonClause} ` +
    "Fix one of: (1) pass `cwd` on the Agent call pointing at your project's git repo; " +
    "(2) set CODEX_TEAM_WORKSPACE_ROOT to your project repo (and remove any `cwd` override in the MCP server config); " +
    "(3) launch codex from inside the project repo. Read-only / review-only work needs no worktree."
  );
}

type ValidatedMergeTarget = MergeTargetRow & {
  member_id: string;
  workspace_path: string;
  base_revision: string;
};

// Phase 12 (D-04): a run is a valid merge/escalate target only when it is an
// isolated git worktree with a concrete workspace_path + base_revision + member.
// Anything else returns a precise error_code and no destructive action.
function validateMergeTarget(
  run: MergeTargetRow | null
):
  | { ok: true; run: ValidatedMergeTarget }
  | { ok: false; errorCode: string } {
  if (!run) {
    return { ok: false, errorCode: MERGE_TARGET_NOT_FOUND_ERROR_CODE };
  }

  const workspacePath = normalizeOptionalText(run.workspace_path);
  const baseRevision = normalizeOptionalText(run.base_revision);
  const memberId = normalizeOptionalText(run.member_id);
  if (
    run.isolation_kind !== ISOLATION_KINDS.gitWorktree ||
    !workspacePath ||
    !baseRevision ||
    !memberId
  ) {
    return { ok: false, errorCode: MERGE_TARGET_NOT_ISOLATED_ERROR_CODE };
  }

  return {
    ok: true,
    run: {
      ...run,
      member_id: memberId,
      workspace_path: workspacePath,
      base_revision: baseRevision
    }
  };
}

// The repo a worktree run is merged/reviewed/cleaned against. Prefers the run's
// persisted TARGET repo root (multi-repo container → the real child repo the
// worktree was branched from) and falls back to the coordination root for v1.1
// single-repo runs (leader IS the repo) and pre-v7 runs with no stamped value.
function resolveTargetRepoRoot(
  run: { worktree_repo_root: string | null },
  identity: WorkspaceScopedCallerIdentity
): string {
  return normalizeOptionalText(run.worktree_repo_root) ?? identity.workspaceRoot;
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
    // D-01: optional sandbox overlay metadata recorded ON TOP of the git
    // worktree (isolation_kind stays git_worktree). sandbox_overlay is true only
    // when the backend declares supportsOsSandbox; the actual applied
    // sandbox_mode is also preserved under backend_metadata by the backend.
    sandbox_overlay:
      input.safety.status === "ready" && input.safety.sandbox_overlay === true
        ? true
        : false,
    sandbox_mode:
      input.safety.status === "ready" ? input.safety.sandbox_mode ?? null : null,
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
  // Thread the run's persisted pane metadata into the resume context so a
  // PANE-HOSTED execution backend can locate the teammate's already-open pane and
  // deliver the resume nudge into it. Harmless/ignored by the detached backend.
  const pane = extractPaneMetadata(parseJsonObject(run.metadata_json));
  return {
    message_id: input.message_id,
    task_id: normalizeOptionalText(input.task_id),
    summary: normalizeOptionalText(input.summary),
    summary_present: Boolean(normalizeOptionalText(input.summary)),
    // D-02: this metadata object is the IN-MEMORY input to resumeRun only — it is
    // never persisted (updateRunLifecycle writes only the returned
    // actionResult.metadata, i.e. `{ pane }`). Phase 16 (notify + pull): this carries
    // the SHORT inbox NUDGE (count + senders), NOT the full body — the body never
    // rides the resume context at all. Falls back to undefined when no nudge supplied.
    resume_delivery_text: normalizeOptionalText(input.delivery_text) ?? undefined,
    previous_status: input.recipient_status,
    backend_run_id: backendIdFromRunOrMetadata(run, "backend_run_id"),
    backend_thread_id: backendIdFromRunOrMetadata(run, "backend_thread_id"),
    backend_process_id: backendIdFromRunOrMetadata(run, "backend_process_id"),
    pane: pane ?? undefined,
    backend_metadata: pane ? { pane } : undefined
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
    supportsReviewDiff: extendedCapabilities.supportsReviewDiff === true,
    // D-01: OS sandbox is an optional overlay (non-gating). Read defensively —
    // absent/false backends simply skip the sandbox_overlay metadata.
    supportsOsSandbox: capabilities.supportsOsSandbox === true
  };
}

function canonicalNameFromMemberId(memberId: string): string {
  const tail = memberId.split(":").at(-1);
  return tail && tail.length > 0 ? tail : memberId;
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

// Coerces an unknown metadata/context value to a trimmed non-empty string, else
// null. Used to safely read exec_log_path (typed unknown) and context fields.
function optionalStringValue(value: unknown): string | null {
  return typeof value === "string" ? normalizeOptionalText(value) : null;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
