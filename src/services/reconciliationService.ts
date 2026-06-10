import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  ExecutionBackend,
  ExecutionBackendReconcileResult,
  ExecutionRunContext
} from "../adapters/execution.js";
import { ScaffoldExecutionBackend } from "../adapters/execution.js";
import { extractPaneMetadata } from "../adapters/paneExecutionBackend.js";
import {
  EVENT_TYPES,
  MEMBER_STATUSES,
  MESSAGE_ROW_STATUSES,
  RUN_BACKEND_STATUSES,
  RUN_REVIEW_STATUSES,
  TABLE_NAMES,
  type RunBackendStatus,
  type RunReviewStatus
} from "../state/schema.js";
import {
  WorkspaceSafetyService,
  type WorkspaceInspectionResult
} from "./workspaceSafetyService.js";

export interface ReconciliationServiceOptions {
  db: Database.Database;
  statePath: string;
  executionBackend?: ExecutionBackend;
  workspaceSafetyService?: WorkspaceSafetyService;
}

export interface ReconcileWorkspaceInput {
  workspaceRoot: string;
  actorCallerKey?: string | null;
  // - "apply"    : full reconcile (default) — finalize terminal runs, mark stale,
  //                inspect + mutate workspaces, append per-run reconciled events.
  // - "report"   : read-only — observe + count, never mutate (inspection still runs
  //                read-only for the review counts).
  // - "finalize" : finalize-on-poll (TeamDiagnostics live trigger) — ONLY promote a
  //                running detached run that reconciled to a terminal state
  //                (idle/failed) via markRunTerminal + its single completion event.
  //                Otherwise read-only with NO side effects: no markRunStale, no
  //                workspace-inspection mutation loop, no generic reconciled event.
  mode?: "apply" | "report" | "finalize";
}

export interface ReconciliationSummary {
  workspaceRoot: string;
  teams: number;
  runningRunsChecked: number;
  staleRunsMarked: number;
  orphanedQueuedMessages: number;
  missingRunLinks: number;
  orphanedRuns: number;
  reviewNeededWorkspaces: number;
  inspectedWorkspaces: number;
  workspaceInspectionFailures: number;
  eventsAppended: number;
}

interface TeamRow {
  team_id: string;
  canonical_name: string;
  workspace_root: string;
}

interface ReconciliationRunRow {
  run_id: string;
  team_id: string;
  canonical_name: string;
  workspace_root: string;
  member_id: string | null;
  member_status: string | null;
  member_metadata_json: string | null;
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
  work_classification: string | null;
  isolation_kind: string | null;
  base_revision: string | null;
  review_status: RunReviewStatus | null;
  changed_files_json: string | null;
  diff_summary: string | null;
}

interface CountRow {
  count: number;
}

const SYSTEM_RECONCILIATION_CALLER = "system:reconciliation";
const STALE_RECONCILE_STATUSES = new Set(["stale", "unsupported", "unknown"]);
// Terminal reconcile outcomes from an async (detached) backend: the background
// run finished (idle) or failed (turn.failed / crash). Distinct from the stale
// set so they finalize the member to a real terminal status rather than `stale`.
const TERMINAL_RECONCILE_STATUSES = new Set(["idle", "failed"]);
const TEAMMATE_MARKED_STALE_EVENT_TYPE =
  EVENT_TYPES.teammateMarkedStale satisfies "teammate_marked_stale";

export class ReconciliationService {
  private readonly executionBackend: ExecutionBackend;
  private readonly workspaceSafetyService: WorkspaceSafetyService;

  constructor(private readonly options: ReconciliationServiceOptions) {
    this.executionBackend =
      options.executionBackend ?? new ScaffoldExecutionBackend();
    this.workspaceSafetyService =
      options.workspaceSafetyService ?? new WorkspaceSafetyService();
  }

  reconcileWorkspace(input: ReconcileWorkspaceInput): ReconciliationSummary {
    const workspaceRoot = normalizeRequiredText(input.workspaceRoot);
    const actorCallerKey =
      normalizeOptionalText(input.actorCallerKey) ?? SYSTEM_RECONCILIATION_CALLER;
    const mode = input.mode ?? "apply";
    // Full-apply mutations (markRunStale, the workspace-inspection mutation loop, and
    // per-run reconciled events) run ONLY in "apply". "report" and "finalize" do not.
    const applyChanges = mode === "apply";
    // "finalize" additionally promotes terminal running runs (see markRunTerminal gate
    // below) and skips the workspace-inspection loop entirely.
    const finalizeOnly = mode === "finalize";
    const teams = this.readTeams(workspaceRoot);
    const reviewNeededRunIds = new Set(this.readReviewNeededRunIds(workspaceRoot));
    const runningRuns = this.readRunningRuns(workspaceRoot);
    let staleRunsMarked = 0;
    let inspectedWorkspaces = 0;
    let workspaceInspectionFailures = 0;
    let eventsAppended = 0;

    for (const run of runningRuns) {
      const reconcileResult = (() => {
        try {
          return this.executionBackend.reconcileRun(buildExecutionRunContext(run));
        } catch (error) {
          return coerceBackendReconcileException(error, run);
        }
      })();
      if (applyChanges) {
        this.appendReconciledEvent({
          run,
          result: reconcileResult,
          actorCallerKey,
          createdAt: new Date().toISOString()
        });
        eventsAppended += 1;
      }

      if (STALE_RECONCILE_STATUSES.has(reconcileResult.status)) {
        staleRunsMarked += 1;
        if (applyChanges) {
          this.markRunStale({
            run,
            result: reconcileResult,
            actorCallerKey,
            createdAt: new Date().toISOString()
          });
          eventsAppended += 1;
        }
      } else if (TERMINAL_RECONCILE_STATUSES.has(reconcileResult.status)) {
        // Async-execution completion (codex_cli_exec detached run): the backend
        // confirmed from the log + process liveness that a background run reached
        // a terminal state. Promote the run + member out of `running` to idle
        // (turn.completed) or failed (turn.failed / crash). `active` keeps the
        // Phase-5 running baseline; `stopped` is left untouched (no transition).
        // This is the ONLY mutation "finalize" mode performs (finalize-on-poll).
        if (applyChanges || finalizeOnly) {
          this.markRunTerminal({
            run,
            result: reconcileResult,
            actorCallerKey,
            createdAt: new Date().toISOString()
          });
          eventsAppended += 1;
        }
      }
    }

    // The workspace-inspection loop (read + mutate review_status / changed_files) is
    // skipped entirely in "finalize" mode: it must not run git inspection on every
    // diagnostics poll and must not clobber already-resolved review statuses
    // (merged/merge_conflict/escalated) for runs whose worktree was cleaned up.
    for (const run of finalizeOnly ? [] : this.readRunsWithWorkspacePath(workspaceRoot)) {
      inspectedWorkspaces += 1;
      const inspection = this.workspaceSafetyService.inspectWorkspace({
        workspace_path: run.workspace_path,
        base_revision: run.base_revision
      });

      if (inspection.status === "inspection_failed") {
        workspaceInspectionFailures += 1;
      }

      if (
        inspection.review_status === RUN_REVIEW_STATUSES.needsReview ||
        inspection.status === "inspection_failed"
      ) {
        reviewNeededRunIds.add(run.run_id);
      } else if (inspection.status === "clean") {
        reviewNeededRunIds.delete(run.run_id);
      }

      if (applyChanges) {
        this.updateWorkspaceInspection(run.run_id, inspection);
      }

      if (
        applyChanges &&
        (inspection.status === "changes_detected" ||
          inspection.status === "inspection_failed")
      ) {
        this.appendWorkspaceReviewRequiredEvent({
          run,
          inspection,
          actorCallerKey,
          createdAt: new Date().toISOString()
        });
        eventsAppended += 1;
      }
    }

    return {
      workspaceRoot,
      teams: teams.length,
      runningRunsChecked: runningRuns.length,
      staleRunsMarked,
      orphanedQueuedMessages: this.countOrphanedQueuedMessages(workspaceRoot),
      missingRunLinks: this.countMissingRunLinks(workspaceRoot),
      orphanedRuns: this.countOrphanedRuns(workspaceRoot),
      reviewNeededWorkspaces: reviewNeededRunIds.size,
      inspectedWorkspaces,
      workspaceInspectionFailures,
      eventsAppended
    };
  }

  private readTeams(workspaceRoot: string): TeamRow[] {
    return this.options.db
      .prepare(
        `
          SELECT team_id, canonical_name, workspace_root
          FROM ${TABLE_NAMES.teams}
          WHERE workspace_root = ?
        `
      )
      .all(workspaceRoot) as TeamRow[];
  }

  private readRunningRuns(workspaceRoot: string): ReconciliationRunRow[] {
    return this.readRunsByPredicate(
      workspaceRoot,
      `r.status = '${MEMBER_STATUSES.running}'`
    );
  }

  private readRunsWithWorkspacePath(workspaceRoot: string): ReconciliationRunRow[] {
    return this.readRunsByPredicate(workspaceRoot, "r.workspace_path IS NOT NULL");
  }

  private readRunsByPredicate(
    workspaceRoot: string,
    predicate: string
  ): ReconciliationRunRow[] {
    return this.options.db
      .prepare(
        `
          SELECT
            r.run_id,
            r.team_id,
            t.canonical_name,
            t.workspace_root,
            r.member_id,
            m.status AS member_status,
            m.metadata_json AS member_metadata_json,
            r.status,
            r.backend,
            r.workspace_path,
            r.metadata_json,
            r.last_error,
            r.backend_status,
            r.backend_run_id,
            r.backend_thread_id,
            r.backend_process_id,
            r.started_at,
            r.ended_at,
            r.work_classification,
            r.isolation_kind,
            r.base_revision,
            r.review_status,
            r.changed_files_json,
            r.diff_summary
          FROM ${TABLE_NAMES.runs} r
          INNER JOIN ${TABLE_NAMES.teams} t ON t.team_id = r.team_id
          LEFT JOIN ${TABLE_NAMES.members} m ON m.member_id = r.member_id
          WHERE t.workspace_root = ?
            AND ${predicate}
          ORDER BY r.updated_at, r.run_id
        `
      )
      .all(workspaceRoot) as ReconciliationRunRow[];
  }

  private readReviewNeededRunIds(workspaceRoot: string): string[] {
    return this.options.db
      .prepare(
        `
          SELECT r.run_id
          FROM ${TABLE_NAMES.runs} r
          INNER JOIN ${TABLE_NAMES.teams} t ON t.team_id = r.team_id
          WHERE t.workspace_root = ?
            AND r.review_status IN (
              '${RUN_REVIEW_STATUSES.pendingReview}',
              '${RUN_REVIEW_STATUSES.needsReview}'
            )
        `
      )
      .all(workspaceRoot)
      .map((row) => (row as { run_id: string }).run_id);
  }

  private countOrphanedQueuedMessages(workspaceRoot: string): number {
    return this.countRows(
      `
        SELECT COUNT(*) AS count
        FROM ${TABLE_NAMES.messages} msg
        INNER JOIN ${TABLE_NAMES.teams} t ON t.team_id = msg.team_id
        LEFT JOIN ${TABLE_NAMES.members} recipient
          ON recipient.member_id = msg.recipient_member_id
        WHERE t.workspace_root = ?
          AND msg.status = '${MESSAGE_ROW_STATUSES.queued}'
          AND (
            msg.recipient_member_id IS NULL
            OR recipient.member_id IS NULL
            OR recipient.status = '${MEMBER_STATUSES.archived}'
          )
      `,
      workspaceRoot
    );
  }

  private countMissingRunLinks(workspaceRoot: string): number {
    return this.countRows(
      `
        SELECT COUNT(*) AS count
        FROM ${TABLE_NAMES.members} member
        INNER JOIN ${TABLE_NAMES.teams} t ON t.team_id = member.team_id
        LEFT JOIN ${TABLE_NAMES.runs} run ON run.member_id = member.member_id
        WHERE t.workspace_root = ?
          AND member.role = 'teammate'
          AND member.status != '${MEMBER_STATUSES.archived}'
          AND run.run_id IS NULL
      `,
      workspaceRoot
    );
  }

  private countOrphanedRuns(workspaceRoot: string): number {
    return this.countRows(
      `
        SELECT COUNT(*) AS count
        FROM ${TABLE_NAMES.runs} run
        INNER JOIN ${TABLE_NAMES.teams} t ON t.team_id = run.team_id
        LEFT JOIN ${TABLE_NAMES.members} member
          ON member.member_id = run.member_id
        WHERE t.workspace_root = ?
          AND (
            run.member_id IS NULL
            OR member.member_id IS NULL
          )
      `,
      workspaceRoot
    );
  }

  private countRows(sql: string, workspaceRoot: string): number {
    const row = this.options.db.prepare(sql).get(workspaceRoot) as CountRow;
    return row.count;
  }

  private markRunStale(input: {
    run: ReconciliationRunRow;
    result: ExecutionBackendReconcileResult;
    actorCallerKey: string;
    createdAt: string;
  }): void {
    const now = input.createdAt;
    this.options.db
      .prepare(
        `
          UPDATE ${TABLE_NAMES.runs}
          SET status = ?,
              backend = COALESCE(?, backend),
              backend_status = ?,
              backend_run_id = COALESCE(?, backend_run_id),
              backend_thread_id = COALESCE(?, backend_thread_id),
              backend_process_id = COALESCE(?, backend_process_id),
              workspace_path = COALESCE(?, workspace_path),
              ended_at = COALESCE(?, ended_at),
              last_error = ?,
              last_reconciled_at = ?,
              updated_at = ?
          WHERE run_id = ?
        `
      )
      .run(
        MEMBER_STATUSES.stale,
        normalizeOptionalText(input.result.backend),
        input.result.backend_status,
        normalizeOptionalText(input.result.backend_run_id),
        normalizeOptionalText(input.result.thread_id),
        normalizeOptionalText(input.result.process_id),
        normalizeOptionalText(input.result.workspace_path),
        normalizeOptionalText(input.result.ended_at),
        redactRunSensitiveText(input.result.last_error, input.run),
        now,
        now,
        input.run.run_id
      );

    if (input.run.member_id) {
      this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.members}
            SET status = ?
            WHERE member_id = ?
          `
        )
        .run(MEMBER_STATUSES.stale, input.run.member_id);
    }

    this.appendEvent({
      teamId: input.run.team_id,
      actorMemberId: input.run.member_id,
      workspaceRoot: input.run.workspace_root,
      actorCallerKey: input.actorCallerKey,
      eventType: TEAMMATE_MARKED_STALE_EVENT_TYPE,
      payload: {
        run_id: input.run.run_id,
        member_id: input.run.member_id,
        previous_status: input.run.status,
        status: MEMBER_STATUSES.stale,
        reconcile_status: input.result.status,
        backend: input.result.backend,
        backend_status: input.result.backend_status,
        last_error: redactRunSensitiveText(input.result.last_error, input.run)
      },
      createdAt: input.createdAt
    });
  }

  // Finalize a background run that the backend confirmed reached a terminal state
  // (idle = turn.completed, failed = turn.failed / crash). Mirrors markRunStale's
  // targeted-column UPDATE pattern (never rewrites metadata_json), so the durable
  // backend ids / pane metadata are preserved. Captures a thread_id discovered in
  // the log (COALESCE — never clobbers an existing one, never fabricates).
  private markRunTerminal(input: {
    run: ReconciliationRunRow;
    result: ExecutionBackendReconcileResult;
    actorCallerKey: string;
    createdAt: string;
  }): void {
    const now = input.createdAt;
    const isFailure = input.result.status === "failed";
    const runStatus = isFailure ? MEMBER_STATUSES.failed : MEMBER_STATUSES.idle;
    const backendStatus = isFailure
      ? RUN_BACKEND_STATUSES.failed
      : RUN_BACKEND_STATUSES.idle;
    const lastError = isFailure
      ? redactRunSensitiveText(input.result.last_error, input.run)
      : null;

    this.options.db
      .prepare(
        `
          UPDATE ${TABLE_NAMES.runs}
          SET status = ?,
              backend = COALESCE(?, backend),
              backend_status = ?,
              backend_run_id = COALESCE(?, backend_run_id),
              backend_thread_id = COALESCE(?, backend_thread_id),
              backend_process_id = COALESCE(?, backend_process_id),
              workspace_path = COALESCE(?, workspace_path),
              ended_at = COALESCE(?, ended_at),
              last_error = ?,
              last_reconciled_at = ?,
              updated_at = ?
          WHERE run_id = ?
        `
      )
      .run(
        runStatus,
        normalizeOptionalText(input.result.backend),
        backendStatus,
        normalizeOptionalText(input.result.backend_run_id),
        normalizeOptionalText(input.result.thread_id),
        normalizeOptionalText(input.result.process_id),
        normalizeOptionalText(input.result.workspace_path),
        normalizeOptionalText(input.result.ended_at),
        lastError,
        now,
        now,
        input.run.run_id
      );

    if (input.run.member_id) {
      this.options.db
        .prepare(
          `
            UPDATE ${TABLE_NAMES.members}
            SET status = ?
            WHERE member_id = ?
          `
        )
        .run(runStatus, input.run.member_id);
    }

    this.appendEvent({
      teamId: input.run.team_id,
      actorMemberId: input.run.member_id,
      workspaceRoot: input.run.workspace_root,
      actorCallerKey: input.actorCallerKey,
      eventType: isFailure
        ? EVENT_TYPES.teammateBackendFailed
        : EVENT_TYPES.teammateRunCompleted,
      payload: {
        run_id: input.run.run_id,
        member_id: input.run.member_id,
        previous_status: input.run.status,
        status: runStatus,
        reconcile_status: input.result.status,
        backend: input.result.backend,
        backend_status: backendStatus,
        last_error: lastError
      },
      createdAt: input.createdAt
    });
  }

  private updateWorkspaceInspection(
    runId: string,
    inspection: WorkspaceInspectionResult
  ): void {
    const now = new Date().toISOString();
    this.options.db
      .prepare(
        `
          UPDATE ${TABLE_NAMES.runs}
          SET changed_files_json = ?,
              diff_summary = ?,
              review_status = ?,
              last_reconciled_at = ?,
              updated_at = ?,
              last_error = CASE
                WHEN ? = 'inspection_failed' THEN ?
                ELSE last_error
              END
          WHERE run_id = ?
        `
      )
      .run(
        inspection.changed_files_json,
        normalizeOptionalText(inspection.diff_summary),
        inspection.review_status,
        now,
        now,
        inspection.status,
        redactSensitiveText(inspection.error_message),
        runId
      );
  }

  private appendReconciledEvent(input: {
    run: ReconciliationRunRow;
    result: ExecutionBackendReconcileResult;
    actorCallerKey: string;
    createdAt: string;
  }): void {
    this.appendEvent({
      teamId: input.run.team_id,
      actorMemberId: input.run.member_id,
      workspaceRoot: input.run.workspace_root,
      actorCallerKey: input.actorCallerKey,
      eventType: EVENT_TYPES.teammateReconciled,
      payload: {
        run_id: input.run.run_id,
        member_id: input.run.member_id,
        previous_status: input.run.status,
        reconcile_status: input.result.status,
        backend: input.result.backend,
        backend_status: input.result.backend_status,
        last_error: redactRunSensitiveText(input.result.last_error, input.run)
      },
      createdAt: input.createdAt
    });
  }

  private appendWorkspaceReviewRequiredEvent(input: {
    run: ReconciliationRunRow;
    inspection: WorkspaceInspectionResult;
    actorCallerKey: string;
    createdAt: string;
  }): void {
    this.appendEvent({
      teamId: input.run.team_id,
      actorMemberId: input.run.member_id,
      workspaceRoot: input.run.workspace_root,
      actorCallerKey: input.actorCallerKey,
      eventType: EVENT_TYPES.workspaceReviewRequired,
      payload: {
        run_id: input.run.run_id,
        member_id: input.run.member_id,
        workspace_path: input.run.workspace_path,
        base_revision: input.run.base_revision,
        review_status: RUN_REVIEW_STATUSES.needsReview,
        inspection_status: input.inspection.status,
        changed_files: parseChangedFilesJson(input.inspection.changed_files_json),
        preserve_workspace: input.inspection.preserve_workspace,
        diff_summary: normalizeOptionalText(input.inspection.diff_summary),
        last_error: redactSensitiveText(input.inspection.error_message)
      },
      createdAt: input.createdAt
    });
  }

  private appendEvent(input: {
    teamId: string;
    actorMemberId: string | null;
    workspaceRoot: string;
    actorCallerKey: string;
    eventType: string;
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
            payload_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        `event:${randomUUID()}`,
        input.teamId,
        input.actorMemberId,
        input.workspaceRoot,
        input.actorCallerKey,
        input.eventType,
        JSON.stringify(input.payload),
        input.createdAt
      );
  }
}

function buildExecutionRunContext(run: ReconciliationRunRow): ExecutionRunContext {
  const runMetadata = parseJsonObject(run.metadata_json);
  const backendMetadata = backendMetadataFromRunMetadata(runMetadata);
  const pane = extractPaneMetadata(
    backendMetadata ? { backend_metadata: backendMetadata } : runMetadata
  );

  return {
    run_id: run.run_id,
    team_id: run.team_id,
    member_id: run.member_id,
    teammate_id: teammateIdFromMemberMetadata(run.member_metadata_json),
    team_name: run.canonical_name,
    workspace_root: run.workspace_root,
    prompt_present: runMetadata.prompt_present === true,
    work_classification: run.work_classification,
    isolation_kind: run.isolation_kind,
    workspace_path: run.workspace_path,
    metadata: {
      backend_status: run.backend_status,
      review_status: run.review_status,
      backend_run_id: backendIdFromRunOrMetadata(run, "backend_run_id"),
      backend_thread_id: backendIdFromRunOrMetadata(run, "backend_thread_id"),
      backend_process_id: backendIdFromRunOrMetadata(run, "backend_process_id"),
      backend_metadata: backendMetadata,
      pane: pane ?? undefined
    }
  };
}

function backendMetadataFromRunMetadata(
  metadata: Record<string, unknown>
): Record<string, unknown> | undefined {
  const backendMetadata = metadata.backend_metadata;
  return backendMetadata && typeof backendMetadata === "object" &&
    !Array.isArray(backendMetadata)
    ? (backendMetadata as Record<string, unknown>)
    : undefined;
}

function backendIdFromRunOrMetadata(
  run: ReconciliationRunRow,
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

function coerceBackendReconcileException(
  error: unknown,
  run: ReconciliationRunRow
): ExecutionBackendReconcileResult {
  return {
    status: "stale",
    backend: normalizeOptionalText(run.backend) ?? "unknown",
    backend_status: RUN_BACKEND_STATUSES.failed,
    last_error: redactRunSensitiveText(errorToMessage(error), run) ?? "backend_failed"
  };
}

function teammateIdFromMemberMetadata(metadataJson: string | null): string | undefined {
  const metadata = parseJsonObject(metadataJson);
  const publicTeammateId = metadata.publicTeammateId;
  return typeof publicTeammateId === "string" ? publicTeammateId : undefined;
}

function parseJsonObject(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optionalStringFromMetadata(value: unknown): string | null {
  return typeof value === "string" ? normalizeOptionalText(value) : null;
}

function parseChangedFilesJson(changedFilesJson: string): string[] {
  try {
    const parsed = JSON.parse(changedFilesJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeRequiredText(value: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error("workspaceRoot is required for reconciliation");
  }

  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function redactSensitiveText(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  return normalized.replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]");
}

function redactRunSensitiveText(
  value: string | null | undefined,
  run: ReconciliationRunRow
): string | null {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return null;
  }

  let sanitized = normalized;
  const prompt = optionalStringFromMetadata(parseJsonObject(run.metadata_json).prompt);
  if (prompt && sanitized.includes(prompt)) {
    sanitized = sanitized.replaceAll(prompt, "[redacted_prompt]");
  }

  return redactSensitiveText(sanitized);
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
