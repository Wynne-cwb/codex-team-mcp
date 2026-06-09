import type { ExecutionBackendDescription } from "./adapters/execution.js";
import { createExecutionBackendFromOptions } from "./adapters/paneExecutionBackend.js";
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
}

interface DiagnosticsPaneSummary extends PaneStatusSummary {
  messageSummary: DiagnosticsMessageSummary;
  taskSummary: DiagnosticsTaskSummary;
  workspaceReviewSummary: DiagnosticsWorkspaceReviewSummary;
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
  last_error: string | null;
}

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
    const reconciliationSummary = new ReconciliationService({
      db,
      statePath: state.stateRoot,
      executionBackend
    }).reconcileWorkspace({
      workspaceRoot: state.workspaceRoot,
      actorCallerKey: caller.callerKey,
      mode: "report"
    });

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
          COALESCE(SUM(CASE WHEN runs.workspace_path IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_workspace_path
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?
      `
    )
    .get(
      RUN_REVIEW_STATUSES.pendingReview,
      RUN_REVIEW_STATUSES.needsReview,
      workspaceRoot
    ) as DiagnosticsWorkspaceReviewSummary | undefined;

  return {
    pending_review: row?.pending_review ?? 0,
    needs_review: row?.needs_review ?? 0,
    with_workspace_path: row?.with_workspace_path ?? 0
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
          runs.last_error
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?
        ORDER BY runs.updated_at DESC, runs.run_id DESC
      `
    )
    .all(workspaceRoot) as Array<
    Omit<DiagnosticsRunDebugRow, "changed_files" | "last_error"> & {
      changed_files_json: string | null;
      last_error: string | null;
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
    last_error: sanitizeDebugText(row.last_error)
  }));
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
