import { readFileSync } from "node:fs";

import type { ExecutionBackend, ExecutionBackendDescription } from "./adapters/execution.js";
import {
  codexExecLogPath,
  extractCodexDeliverable
} from "./adapters/codexCliExecutionBackend.js";
import {
  createExecutionBackendFromOptions,
  extractPaneMetadata
} from "./adapters/paneExecutionBackend.js";
import {
  DurableStateAdapter,
  type DurableStateRootDescription,
  type StateRootDescription
} from "./adapters/state.js";
import {
  FALLBACK_CALLER_KEY,
  normalizeCallerMetadata,
  type NormalizedCallerMetadata
} from "./context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "./services/callerIdentity.js";
import {
  readPaneStatusSummary,
  type PaneStatusSummary
} from "./services/paneStatusService.js";
import { ReconciliationService, type ReconciliationSummary } from "./services/reconciliationService.js";
import {
  ACTIVE_BINDING_STATUSES,
  MEMBER_STATUSES,
  MESSAGE_ROW_STATUSES,
  RUN_BACKEND_STATUSES,
  RUN_REVIEW_STATUSES,
  TABLE_NAMES,
  TASK_STATUSES,
  TEAM_STATUSES
} from "./state/schema.js";
import type { CodexTeamServerOptions, ToolMapping } from "./types.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

export interface DiagnosticsPayloadOptions extends CodexTeamServerOptions {
  callerMetadata?: unknown;
  includeDebug?: boolean;
  targetClaudeTools?: readonly string[];
  registeredTools?: readonly ToolMapping[];
}

interface DiagnosticsActiveBinding {
  binding_key: string;
  workspace_root: string;
  caller_key: string;
  team_id: string;
  team_name: string;
  status: string;
  fallback_used: boolean;
}

interface DiagnosticsKnownTeam {
  team_id: string;
  team_name: string;
  status: string;
  workspace_root: string;
  lead_agent_id: string;
  created_at: string;
}

interface DiagnosticsRecentEvent {
  event_id: string;
  team_id: string | null;
  actor_member_id: string | null;
  workspace_root: string;
  actor_caller_key: string;
  event_type: string;
  error_code: string | null;
  created_at: string;
}

interface DiagnosticsMessageSummary {
  total: number;
  queued: number;
  by_delivery_status: Record<string, number>;
}

interface DiagnosticsTaskSummary {
  total: number;
  by_status: Record<string, number>;
  assigned: number;
  blocked: number;
}

interface DiagnosticsLifecycleSummary {
  total: number;
  by_status: Record<string, number>;
}

interface DiagnosticsRunSummary {
  total: number;
  by_status: Record<string, number>;
  by_backend_status: Record<string, number>;
  stale: number;
}

interface DiagnosticsWorkspaceReviewSummary {
  pending_review: number;
  needs_review: number;
  with_workspace_path: number;
  // Phase 12 (D-04): TL-driven merge outcome counts.
  merged: number;
  merge_conflict: number;
  escalated: number;
}

interface DiagnosticsPaneSummary extends PaneStatusSummary {
  messageSummary: DiagnosticsMessageSummary;
  taskSummary: DiagnosticsTaskSummary;
  workspaceReviewSummary: DiagnosticsWorkspaceReviewSummary;
}

// OBS-01 / D-02: one row per TeamMate with its real, durable backend status.
// Names + status + concise flags only — NEVER raw prompt / message / task text /
// unsanitized metadata (the per-run detail stays behind include_debug).
interface DiagnosticsTeammateStatus {
  teammate_id?: string;
  member_id: string;
  display_name: string;
  status: string;
  attached: boolean;
  needs_review: boolean;
  // Deliverable capture: a SHORT, sanitized preview of the run's final agent
  // output (extracted on demand from the per-run codex log). Present only when a
  // deliverable exists; full text is exposed under include_debug (run.final_message).
  result_preview?: string;
}

// OBS-02: enriched, sanitized metadata diagnostics surfaced only under
// include_debug when a run reported codex_session_metadata_unavailable.
interface DiagnosticsMetadataDiagnostics {
  missing_metadata_source: string;
  observed_keys: string[];
  selected_backend: string;
  remediation: string[];
}

interface DiagnosticsRunDebugRow {
  run_id: string;
  member_id: string | null;
  backend: string | null;
  backend_status: string | null;
  backend_run_id: string | null;
  backend_thread_id: string | null;
  backend_process_id: string | null;
  workspace_path: string | null;
  base_revision: string | null;
  review_status: string | null;
  changed_files: string[];
  // Phase 12 (D-04): worktree branch + merge audit (debug-only, sanitized).
  // merge_status is the review_status when it is a merge-related value, else null.
  worktree_branch: string | null;
  merge_status: string | null;
  merge_commit: string | null;
  last_error: string | null;
  // Deliverable capture (debug-only): the run's final agent output text,
  // sanitized + prompt-redacted + bounded. Extracted on demand from the per-run
  // codex JSONL log (never stored in the DB). Null when no deliverable exists.
  final_message: string | null;
}

// Bounds: the default teammate view shows a short preview; include_debug shows
// the (still bounded) full deliverable. Neither stores raw text in the DB.
const DELIVERABLE_PREVIEW_MAX_LENGTH = 280;
const DELIVERABLE_FULL_MAX_LENGTH = 4000;

const MERGE_RELATED_REVIEW_STATUSES = new Set<string>([
  RUN_REVIEW_STATUSES.merged,
  RUN_REVIEW_STATUSES.mergeConflict,
  RUN_REVIEW_STATUSES.escalated
]);

type DurableDiagnosticsState = Omit<DurableStateRootDescription, "recentEvents"> & {
  activeBinding: DiagnosticsActiveBinding | null;
  knownTeams: DiagnosticsKnownTeam[];
  messageSummary: DiagnosticsMessageSummary;
  taskSummary: DiagnosticsTaskSummary;
  recentEvents: DiagnosticsRecentEvent[];
};

type DiagnosticsStateDescription =
  | Exclude<StateRootDescription, DurableStateRootDescription>
  | DurableDiagnosticsState;

export interface DiagnosticsPayload {
  package: {
    name: string;
    version: string;
  };
  tools: {
    targetClaudeTools: string[];
    registeredTools: string[];
    mapping: Array<{
      claudeToolName: string;
      codexToolName: string;
      description: string;
      status: string;
      nextPhase: string;
    }>;
  };
  state: DiagnosticsStateDescription;
  execution: ExecutionBackendDescription;
  teammates: DiagnosticsTeammateStatus[];
  lifecycleSummary: DiagnosticsLifecycleSummary;
  runSummary: DiagnosticsRunSummary;
  workspaceReviewSummary: DiagnosticsWorkspaceReviewSummary;
  paneSummary: DiagnosticsPaneSummary;
  reconciliationSummary: ReconciliationSummary;
  caller: NormalizedCallerMetadata;
  fallbackCallerKey: "codex-team:anonymous-local";
  phase:
    | "05-lifecycle-isolation-and-status"
    | "07-pane-style-teammate-ui-and-terminal-backends";
  metadataDiagnostics?: DiagnosticsMetadataDiagnostics;
  debug?: {
    callerMetadataType: string;
    runs: DiagnosticsRunDebugRow[];
  };
}

export function buildDiagnosticsPayload(options: DiagnosticsPayloadOptions = {}): DiagnosticsPayload {
  const registeredTools = options.registeredTools ?? [];
  const caller = normalizeCallerMetadata(options.callerMetadata);
  const stateAdapter = new DurableStateAdapter(options);

  try {
    const state = buildDiagnosticsState(stateAdapter, caller);
    const db = stateAdapter.getDatabase();
    const executionBackend = createExecutionBackendFromOptions(options);
    const lifecycleSummary = readLifecycleSummary(
      db,
      state.workspaceRoot
    );
    const runSummary = readRunSummary(db, state.workspaceRoot);
    const workspaceReviewSummary = readWorkspaceReviewSummary(
      db,
      state.workspaceRoot
    );
    const paneMessageSummary = readPaneMessageSummary(db, state.workspaceRoot);
    const paneStatusSummary = readPaneStatusSummary(db, state.workspaceRoot, {
      paneModeEnabled: options.paneMode?.enabled === true,
      includeDebug: options.includeDebug === true
    });
    // Finalize-on-poll (finalize mode): with the async/detached codex_cli_exec
    // backend, startRun returns `running` and the real task finishes in the
    // background. TeamDiagnostics is the live reconcile trigger — "finalize" mode
    // promotes a finished detached run out of `running` (idle on turn.completed,
    // failed on turn.failed/crash) via markRunTerminal, while a still-running
    // detached run stays `running` (active reconcile). It is otherwise READ-ONLY:
    // it never marks runs stale, never runs the workspace-inspection mutation loop
    // (which would clobber already-resolved merge review statuses), and never emits
    // generic per-run reconciled events — preserving the diagnostics read-only
    // contract. This runs BEFORE readTeammateStatuses so the teammate rows +
    // deliverable preview reflect the freshly finalized status. Idempotent: reconcile
    // only iterates running runs, so a run already finalized to idle/failed is not
    // re-finalized and emits no duplicate completion event.
    const reconciliationSummary = new ReconciliationService({
      db,
      statePath: state.stateRoot,
      executionBackend
    }).reconcileWorkspace({
      workspaceRoot: state.workspaceRoot,
      actorCallerKey: caller.callerKey,
      mode: "finalize"
    });
    const teammates = readTeammateStatuses(db, state.workspaceRoot);
    const metadataDiagnostics =
      options.includeDebug === true
        ? buildMetadataDiagnostics(db, state.workspaceRoot, executionBackend)
        : null;

    return {
      package: {
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION
      },
      tools: {
        targetClaudeTools: [...(options.targetClaudeTools ?? [])],
        registeredTools: registeredTools.map((tool) => tool.codexToolName),
        mapping: registeredTools.map((tool) => ({
          claudeToolName: tool.claudeToolName,
          codexToolName: tool.codexToolName,
          description: tool.description,
          status: tool.status,
          nextPhase: tool.nextPhase
        }))
      },
      state,
      execution: executionBackend.describeBackend(),
      teammates,
      lifecycleSummary,
      runSummary,
      workspaceReviewSummary,
      paneSummary: {
        ...paneStatusSummary,
        messageSummary: paneMessageSummary,
        taskSummary: state.taskSummary,
        workspaceReviewSummary
      },
      reconciliationSummary,
      caller,
      fallbackCallerKey: FALLBACK_CALLER_KEY,
      phase:
        options.paneMode?.enabled === true
          ? "07-pane-style-teammate-ui-and-terminal-backends"
          : "05-lifecycle-isolation-and-status",
      ...(metadataDiagnostics ? { metadataDiagnostics } : {}),
      ...(options.includeDebug
        ? {
            debug: {
              callerMetadataType: typeof options.callerMetadata,
              runs: readRunDebugRows(db, state.workspaceRoot)
            }
          }
        : {})
    };
  } finally {
    stateAdapter.close();
  }
}

function readLifecycleSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsLifecycleSummary {
  const byStatus = readCountsByStatus({
    db,
    workspaceRoot,
    tableName: TABLE_NAMES.members,
    statusColumn: "members.status"
  });

  return {
    total: Object.values(byStatus).reduce((total, count) => total + count, 0),
    by_status: byStatus
  };
}

function readRunSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsRunSummary {
  const byStatus = readCountsByStatus({
    db,
    workspaceRoot,
    tableName: TABLE_NAMES.runs,
    statusColumn: "runs.status"
  });
  const byBackendStatus = readRunCountsByBackendStatus(db, workspaceRoot);

  return {
    total: Object.values(byStatus).reduce((total, count) => total + count, 0),
    by_status: byStatus,
    by_backend_status: byBackendStatus,
    stale: byStatus[MEMBER_STATUSES.stale] ?? 0
  };
}

function readWorkspaceReviewSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsWorkspaceReviewSummary {
  const row = db
    .prepare(
      `
        SELECT
          COALESCE(SUM(CASE WHEN runs.review_status = ? THEN 1 ELSE 0 END), 0) AS pending_review,
          COALESCE(SUM(CASE WHEN runs.review_status = ? THEN 1 ELSE 0 END), 0) AS needs_review,
          COALESCE(SUM(CASE WHEN runs.workspace_path IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_workspace_path,
          COALESCE(SUM(CASE WHEN runs.review_status = ? THEN 1 ELSE 0 END), 0) AS merged,
          COALESCE(SUM(CASE WHEN runs.review_status = ? THEN 1 ELSE 0 END), 0) AS merge_conflict,
          COALESCE(SUM(CASE WHEN runs.review_status = ? THEN 1 ELSE 0 END), 0) AS escalated
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?
      `
    )
    .get(
      RUN_REVIEW_STATUSES.pendingReview,
      RUN_REVIEW_STATUSES.needsReview,
      RUN_REVIEW_STATUSES.merged,
      RUN_REVIEW_STATUSES.mergeConflict,
      RUN_REVIEW_STATUSES.escalated,
      workspaceRoot
    ) as DiagnosticsWorkspaceReviewSummary | undefined;

  return {
    pending_review: row?.pending_review ?? 0,
    needs_review: row?.needs_review ?? 0,
    with_workspace_path: row?.with_workspace_path ?? 0,
    merged: row?.merged ?? 0,
    merge_conflict: row?.merge_conflict ?? 0,
    escalated: row?.escalated ?? 0
  };
}

function readCountsByStatus(input: {
  db: ReturnType<DurableStateAdapter["getDatabase"]>;
  workspaceRoot: string;
  tableName: string;
  statusColumn: string;
}): Record<string, number> {
  const rows = input.db
    .prepare(
      `
        SELECT
          ${input.statusColumn} AS status,
          COUNT(*) AS count
        FROM ${input.tableName}
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = ${input.tableName}.team_id
        WHERE teams.workspace_root = ?
        GROUP BY ${input.statusColumn}
        ORDER BY ${input.statusColumn}
      `
    )
    .all(input.workspaceRoot) as Array<{ status: string; count: number }>;

  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function readRunCountsByBackendStatus(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): Record<string, number> {
  const rows = db
    .prepare(
      `
        SELECT
          COALESCE(runs.backend_status, 'unknown') AS backend_status,
          COUNT(*) AS count
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?
        GROUP BY COALESCE(runs.backend_status, 'unknown')
        ORDER BY backend_status
      `
    )
    .all(workspaceRoot) as Array<{ backend_status: string; count: number }>;

  return Object.fromEntries(rows.map((row) => [row.backend_status, row.count]));
}

function readRunDebugRows(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsRunDebugRow[] {
  const rows = db
    .prepare(
      `
        SELECT
          runs.run_id,
          runs.member_id,
          runs.backend,
          runs.backend_status,
          runs.backend_run_id,
          runs.backend_thread_id,
          runs.backend_process_id,
          runs.workspace_path,
          runs.base_revision,
          runs.review_status,
          runs.changed_files_json,
          runs.worktree_branch,
          runs.merge_commit,
          runs.last_error,
          runs.metadata_json
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?
        ORDER BY runs.updated_at DESC, runs.run_id DESC
      `
    )
    .all(workspaceRoot) as Array<
    Omit<
      DiagnosticsRunDebugRow,
      "changed_files" | "last_error" | "merge_status" | "final_message"
    > & {
      changed_files_json: string | null;
      last_error: string | null;
      metadata_json: string | null;
    }
  >;

  return rows.map((row) => ({
    run_id: row.run_id,
    member_id: row.member_id,
    backend: row.backend,
    backend_status: row.backend_status,
    backend_run_id: row.backend_run_id,
    backend_thread_id: row.backend_thread_id,
    backend_process_id: row.backend_process_id,
    workspace_path: row.workspace_path,
    base_revision: row.base_revision,
    review_status: row.review_status,
    changed_files: parseChangedFiles(row.changed_files_json),
    worktree_branch: sanitizeDebugText(row.worktree_branch),
    merge_status:
      row.review_status && MERGE_RELATED_REVIEW_STATUSES.has(row.review_status)
        ? row.review_status
        : null,
    merge_commit: sanitizeDebugText(row.merge_commit),
    last_error: sanitizeDebugText(row.last_error),
    final_message: readRunDeliverable({
      metadataJson: row.metadata_json,
      runId: row.run_id,
      workspaceRoot,
      maxLength: DELIVERABLE_FULL_MAX_LENGTH
    })
  }));
}

// Deliverable capture: extract the run's final agent output from its per-run
// codex JSONL log (on demand — never stored in the DB), then sanitize +
// prompt-redact + bound. The log path is the one persisted at start
// (backend_metadata.exec_log_path) or the deterministic reconstruction from
// workspace_root + run_id. Returns null when no log / no deliverable.
function readRunDeliverable(input: {
  metadataJson: string | null;
  runId: string;
  workspaceRoot: string;
  maxLength: number;
}): string | null {
  const metadata = parseJsonObject(input.metadataJson);
  const backendMetadata = metadata.backend_metadata;
  const persistedPath =
    typeof backendMetadata === "object" &&
    backendMetadata !== null &&
    !Array.isArray(backendMetadata)
      ? optionalText((backendMetadata as Record<string, unknown>).exec_log_path)
      : undefined;
  const logPath =
    persistedPath ?? codexExecLogPath(input.workspaceRoot, input.runId);

  let content: string;
  try {
    content = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }

  const raw = extractCodexDeliverable(content);
  if (!raw) {
    return null;
  }

  return sanitizeDeliverable(raw, optionalText(metadata.prompt), input.maxLength);
}

// D-02: the surfaced deliverable is sanitized — redact the run's own prompt if it
// is echoed back, strip SECRET_ tokens + control chars, and bound the length.
function sanitizeDeliverable(
  value: string,
  prompt: string | undefined,
  maxLength: number
): string | null {
  let sanitized = value;
  if (prompt && prompt.length > 0 && sanitized.includes(prompt)) {
    sanitized = sanitized.split(prompt).join("[redacted_prompt]");
  }
  sanitized = sanitized
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .trim();

  if (sanitized.length === 0) {
    return null;
  }

  return sanitized.length > maxLength
    ? `${sanitized.slice(0, maxLength)}…`
    : sanitized;
}

const CODEX_SESSION_METADATA_UNAVAILABLE = "codex_session_metadata_unavailable";

// Durable last_error signals that mean the backend never started (OBS-01
// `unavailable`). pane_backend_unavailable carries a `:reason` suffix, so it is
// matched as a prefix.
const UNAVAILABLE_LAST_ERROR_SIGNALS = new Set<string>([
  CODEX_SESSION_METADATA_UNAVAILABLE,
  "execution_backend_unavailable",
  "backend_unavailable"
]);

const REMEDIATION_STEPS: readonly string[] = [
  "Enable real execution: set CODEX_TEAM_EXECUTION=1 so the codex backend captures a durable thread_id.",
  "Ensure `codex` is on PATH (codex exec --help exits 0).",
  "Provide an isolated worktree (--cd) for file-modifying work."
];

interface TeammateStatusRow {
  member_id: string;
  display_name: string;
  member_status: string;
  member_metadata_json: string | null;
  run_id: string | null;
  run_backend_status: string | null;
  run_review_status: string | null;
  run_metadata_json: string | null;
  run_last_error: string | null;
}

interface MetadataDiagnosticsRunRow {
  backend: string | null;
  backend_status: string | null;
  backend_run_id: string | null;
  backend_thread_id: string | null;
  backend_process_id: string | null;
  workspace_path: string | null;
  review_status: string | null;
  last_error: string | null;
  metadata_json: string | null;
}

// OBS-01 / D-02: per-TeamMate real backend status from durable columns
// (members.status ∪ runs.backend_status ∪ derived). Reads durable state only —
// never live backend — so CI without tmux/codex stays deterministic.
function readTeammateStatuses(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsTeammateStatus[] {
  const rows = db
    .prepare(
      `
        SELECT
          members.member_id,
          members.display_name,
          members.status AS member_status,
          members.metadata_json AS member_metadata_json,
          runs.run_id AS run_id,
          runs.backend_status AS run_backend_status,
          runs.review_status AS run_review_status,
          runs.metadata_json AS run_metadata_json,
          runs.last_error AS run_last_error
        FROM ${TABLE_NAMES.members} AS members
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = members.team_id
        LEFT JOIN ${TABLE_NAMES.runs} AS runs
          ON runs.member_id = members.member_id
        WHERE teams.workspace_root = ?
          AND members.role = 'teammate'
          AND members.status != ?
        ORDER BY members.joined_at ASC, runs.updated_at DESC, runs.run_id DESC
      `
    )
    .all(workspaceRoot, MEMBER_STATUSES.archived) as TeammateStatusRow[];

  const seen = new Set<string>();
  const teammates: DiagnosticsTeammateStatus[] = [];

  for (const row of rows) {
    // The LEFT JOIN can emit multiple rows when a member has several runs;
    // ordering puts the most recent run first, so keep the first occurrence.
    if (seen.has(row.member_id)) {
      continue;
    }
    seen.add(row.member_id);

    const runMetadata = parseJsonObject(row.run_metadata_json);
    const pane = extractPaneMetadata(runMetadata);
    const attached =
      pane !== null &&
      pane.availability_status === "available" &&
      Boolean(pane.pane_id ?? pane.session_name);
    const needsReview =
      row.run_review_status === RUN_REVIEW_STATUSES.needsReview ||
      row.run_review_status === RUN_REVIEW_STATUSES.pendingReview;
    const memberMetadata = parseJsonObject(row.member_metadata_json);
    const teammateId = optionalText(memberMetadata.publicTeammateId);
    const resultPreview = row.run_id
      ? readRunDeliverable({
          metadataJson: row.run_metadata_json,
          runId: row.run_id,
          workspaceRoot,
          maxLength: DELIVERABLE_PREVIEW_MAX_LENGTH
        })
      : null;

    teammates.push({
      ...(teammateId ? { teammate_id: teammateId } : {}),
      member_id: row.member_id,
      display_name: sanitizeDebugText(row.display_name) ?? "",
      status: mapMemberToObsStatus(
        row.member_status,
        row.run_backend_status,
        row.run_last_error
      ),
      attached,
      needs_review: needsReview,
      ...(resultPreview ? { result_preview: resultPreview } : {})
    });
  }

  return teammates;
}

function mapMemberToObsStatus(
  memberStatus: string,
  backendStatus: string | null,
  lastError: string | null
): string {
  switch (memberStatus) {
    case MEMBER_STATUSES.running:
    case MEMBER_STATUSES.idle:
    case MEMBER_STATUSES.stopped:
    case MEMBER_STATUSES.failed:
    case MEMBER_STATUSES.stale:
      return memberStatus;
    case MEMBER_STATUSES.scheduled:
      if (isUnavailableSignal(lastError)) {
        return "unavailable";
      }
      if (backendStatus === RUN_BACKEND_STATUSES.starting) {
        return "starting";
      }
      // A scheduled run that never started a real backend is unavailable.
      return "unavailable";
    default:
      return mapBackendStatusToObs(backendStatus);
  }
}

function mapBackendStatusToObs(backendStatus: string | null): string {
  switch (backendStatus) {
    case RUN_BACKEND_STATUSES.starting:
      return "starting";
    case RUN_BACKEND_STATUSES.running:
      return "running";
    case RUN_BACKEND_STATUSES.idle:
      return "idle";
    case RUN_BACKEND_STATUSES.stopped:
      return "stopped";
    case RUN_BACKEND_STATUSES.failed:
      return "failed";
    case RUN_BACKEND_STATUSES.stale:
      return "stale";
    case RUN_BACKEND_STATUSES.notStarted:
      return "unavailable";
    default:
      return backendStatus ?? "unavailable";
  }
}

function isUnavailableSignal(lastError: string | null): boolean {
  if (!lastError) {
    return false;
  }
  if (UNAVAILABLE_LAST_ERROR_SIGNALS.has(lastError)) {
    return true;
  }
  return lastError.startsWith("pane_backend_unavailable");
}

// OBS-02: build the enriched (sanitized) metadata diagnostics block when a run
// surfaced codex_session_metadata_unavailable. Returns null when no run matches,
// preserving the existing payload shape for unaffected workspaces.
function buildMetadataDiagnostics(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  executionBackend: ExecutionBackend
): DiagnosticsMetadataDiagnostics | null {
  const rows = db
    .prepare(
      `
        SELECT
          runs.backend,
          runs.backend_status,
          runs.backend_run_id,
          runs.backend_thread_id,
          runs.backend_process_id,
          runs.workspace_path,
          runs.review_status,
          runs.last_error,
          runs.metadata_json
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?
        ORDER BY runs.updated_at DESC, runs.run_id DESC
      `
    )
    .all(workspaceRoot) as MetadataDiagnosticsRunRow[];

  const match = rows.find((row) => {
    if (row.last_error === CODEX_SESSION_METADATA_UNAVAILABLE) {
      return true;
    }
    const pane = extractPaneMetadata(parseJsonObject(row.metadata_json));
    return Boolean(
      pane?.degradation_reason?.includes(CODEX_SESSION_METADATA_UNAVAILABLE)
    );
  });

  if (!match) {
    return null;
  }

  // Only static, sanitized backend column NAMES that are non-empty for this run
  // (never their values). backend/backend_status are always present on this path.
  const observedKeys = (
    [
      ["backend", match.backend],
      ["backend_status", match.backend_status],
      ["backend_run_id", match.backend_run_id],
      ["backend_thread_id", match.backend_thread_id],
      ["backend_process_id", match.backend_process_id],
      ["workspace_path", match.workspace_path],
      ["review_status", match.review_status]
    ] as Array<[string, string | null]>
  )
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key]) => key);

  if (observedKeys.length === 0) {
    observedKeys.push("backend", "backend_status");
  }

  return {
    missing_metadata_source:
      "durable codex thread/session id (backend_thread_id) was not captured for this run",
    observed_keys: observedKeys,
    selected_backend:
      optionalText(match.backend) ?? executionBackend.describeBackend().backend,
    remediation: [...REMEDIATION_STEPS]
  };
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildDiagnosticsState(
  stateAdapter: DurableStateAdapter,
  caller: NormalizedCallerMetadata
): DurableDiagnosticsState {
  const state = describeDurableState(stateAdapter);
  const identity = buildWorkspaceScopedCallerIdentity({
    workspaceRoot: state.workspaceRoot,
    caller
  });

  return {
    ...state,
    activeBinding: readActiveBinding(stateAdapter.getDatabase(), identity.bindingKey),
    knownTeams: readKnownTeams(stateAdapter.getDatabase(), state.workspaceRoot),
    messageSummary: readMessageSummary(stateAdapter.getDatabase(), state.workspaceRoot),
    taskSummary: readTaskSummary(stateAdapter.getDatabase(), state.workspaceRoot),
    recentEvents: readRecentEventsForWorkspace(
      stateAdapter.getDatabase(),
      state.workspaceRoot
    )
  };
}

function describeDurableState(
  stateAdapter: DurableStateAdapter
): DurableStateRootDescription {
  const state = stateAdapter.describeStateRoot();
  if (state.status !== "durable") {
    throw new Error("TeamDiagnostics requires durable state in Phase 2.");
  }

  return state;
}

function readActiveBinding(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  bindingKey: string
): DiagnosticsActiveBinding | null {
  const row = db
    .prepare(
      `
        SELECT
          active_bindings.binding_key,
          active_bindings.workspace_root,
          active_bindings.caller_key,
          active_bindings.team_id,
          teams.canonical_name AS team_name,
          active_bindings.status,
          active_bindings.fallback_used
        FROM ${TABLE_NAMES.activeBindings} AS active_bindings
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = active_bindings.team_id
        WHERE active_bindings.binding_key = ?
          AND active_bindings.status = ?
        LIMIT 1
      `
    )
    .get(bindingKey, ACTIVE_BINDING_STATUSES.active) as
    | (Omit<DiagnosticsActiveBinding, "fallback_used"> & { fallback_used: number })
    | undefined;

  if (!row) {
    return null;
  }

  return {
    ...row,
    fallback_used: row.fallback_used === 1
  };
}

function readKnownTeams(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsKnownTeam[] {
  return db
    .prepare(
      `
        SELECT
          team_id,
          canonical_name AS team_name,
          status,
          workspace_root,
          lead_agent_id,
          created_at
        FROM ${TABLE_NAMES.teams}
        WHERE workspace_root = ?
          AND status != ?
        ORDER BY canonical_name
      `
    )
    .all(workspaceRoot, TEAM_STATUSES.archived) as DiagnosticsKnownTeam[];
}

function readMessageSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsMessageSummary {
  const totals = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN messages.status = ? THEN 1 ELSE 0 END), 0) AS queued
        FROM ${TABLE_NAMES.messages} AS messages
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = messages.team_id
        WHERE teams.workspace_root = ?
      `
    )
    .get(MESSAGE_ROW_STATUSES.queued, workspaceRoot) as
    | { total: number; queued: number }
    | undefined;

  return {
    total: totals?.total ?? 0,
    queued: totals?.queued ?? 0,
    by_delivery_status: readMessageCountsByDeliveryStatus(db, workspaceRoot)
  };
}

function readMessageCountsByDeliveryStatus(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): Record<string, number> {
  const rows = db
    .prepare(
      `
        SELECT
          COALESCE(messages.delivery_status, 'unknown') AS delivery_status,
          COUNT(*) AS count
        FROM ${TABLE_NAMES.messages} AS messages
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = messages.team_id
        WHERE teams.workspace_root = ?
        GROUP BY COALESCE(messages.delivery_status, 'unknown')
        ORDER BY delivery_status
      `
    )
    .all(workspaceRoot) as Array<{ delivery_status: string; count: number }>;

  return Object.fromEntries(rows.map((row) => [row.delivery_status, row.count]));
}

function readPaneMessageSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsMessageSummary {
  const rows = db
    .prepare(
      `
        SELECT
          messages.status,
          COALESCE(messages.delivery_status, 'unknown') AS delivery_status,
          messages.metadata_json
        FROM ${TABLE_NAMES.messages} AS messages
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = messages.team_id
        WHERE teams.workspace_root = ?
        ORDER BY messages.created_at DESC, messages.message_id DESC
      `
    )
    .all(workspaceRoot) as Array<{
    status: string;
    delivery_status: string;
    metadata_json: string;
  }>;
  const explicitMessageRows = rows.filter(
    (row) => parseJsonObject(row.metadata_json).message_type !== "task_assignment"
  );
  const byDeliveryStatus: Record<string, number> = {};

  for (const row of explicitMessageRows) {
    byDeliveryStatus[row.delivery_status] =
      (byDeliveryStatus[row.delivery_status] ?? 0) + 1;
  }

  return {
    total: explicitMessageRows.length,
    queued: explicitMessageRows.filter(
      (row) => row.status === MESSAGE_ROW_STATUSES.queued
    ).length,
    by_delivery_status: byDeliveryStatus
  };
}

function readTaskSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsTaskSummary {
  const totals = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN tasks.owner_member_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS assigned
        FROM ${TABLE_NAMES.tasks} AS tasks
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = tasks.team_id
        WHERE teams.workspace_root = ?
      `
    )
    .get(workspaceRoot) as { total: number; assigned: number } | undefined;

  return {
    total: totals?.total ?? 0,
    by_status: readTaskCountsByStatus(db, workspaceRoot),
    assigned: totals?.assigned ?? 0,
    blocked: readBlockedTaskCount(db, workspaceRoot)
  };
}

function readTaskCountsByStatus(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): Record<string, number> {
  const rows = db
    .prepare(
      `
        SELECT
          tasks.status,
          COUNT(*) AS count
        FROM ${TABLE_NAMES.tasks} AS tasks
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = tasks.team_id
        WHERE teams.workspace_root = ?
        GROUP BY tasks.status
        ORDER BY tasks.status
      `
    )
    .all(workspaceRoot) as Array<{ status: string; count: number }>;

  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function readBlockedTaskCount(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(DISTINCT blocked.task_id) AS blocked
        FROM ${TABLE_NAMES.tasks} AS blocked
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = blocked.team_id
        JOIN ${TABLE_NAMES.taskEdges} AS task_edges
          ON task_edges.team_id = blocked.team_id
          AND task_edges.target_task_id = blocked.task_id
          AND task_edges.edge_type = 'blocks'
        JOIN ${TABLE_NAMES.tasks} AS blocker
          ON blocker.task_id = task_edges.source_task_id
        WHERE teams.workspace_root = ?
          AND blocker.status != ?
      `
    )
    .get(workspaceRoot, TASK_STATUSES.completed) as { blocked: number } | undefined;

  return row?.blocked ?? 0;
}

function readRecentEventsForWorkspace(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string
): DiagnosticsRecentEvent[] {
  return db
    .prepare(
      `
        SELECT
          event_id,
          team_id,
          actor_member_id,
          workspace_root,
          actor_caller_key,
          event_type,
          error_code,
          created_at
        FROM ${TABLE_NAMES.events}
        WHERE workspace_root = ?
        ORDER BY created_at DESC, event_id DESC
        LIMIT 10
      `
    )
    .all(workspaceRoot) as DiagnosticsRecentEvent[];
}

function parseChangedFiles(changedFilesJson: string | null): string[] {
  if (!changedFilesJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(changedFilesJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
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

function sanitizeDebugText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]")
    .replace(/Sensitive [^"]+/g, "[redacted_sensitive]");
}
