import { readFileSync } from "node:fs";

import type { ExecutionBackend, ExecutionBackendDescription } from "./adapters/execution.js";
import {
  codexExecLogPath,
  extractCodexDeliverable
} from "./adapters/codexCliExecutionBackend.js";
import { locateRolloutSessionId } from "./adapters/codexRolloutLocator.js";
import { readRolloutStatus } from "./adapters/codexRolloutReader.js";
import {
  createExecutionBackendFromOptions,
  extractPaneMetadata
} from "./adapters/paneExecutionBackend.js";
import {
  describeTerminalContext,
  type PaneBackendCommandRunner,
  type TerminalContext
} from "./adapters/paneBackend.js";
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
import { canonicalizeTeamName } from "./services/teamNames.js";
import { LifecycleService, type DeliveryDrainHook } from "./services/lifecycleService.js";
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
  // Debug-only terminal-context probe (D-02): injectable for deterministic tests.
  // Defaults to process.env + the real bounded it2 command runner, the same env
  // source the pane backend uses, so production reflects the live MCP process.
  terminalEnv?: NodeJS.ProcessEnv;
  terminalCommandRunner?: PaneBackendCommandRunner;
  // Phase 17 (UAT focus filters): scope the output to the caller's ACTIVE team by
  // default instead of dumping every team/run/message in the workspace. All
  // optional — defaults are applied in resolveDiagnosticsScope.
  teamName?: string;
  currentTeamOnly?: boolean;
  includeArchived?: boolean;
  includeHistory?: boolean;
  maxEvents?: number;
  maxRuns?: number;
  maxMessages?: number;
  messagesSince?: string;
  teammateId?: string;
}

// Phase 17 focus-filter caps. Defaults keep the live view bounded; explicit caps
// are clamped to a sane range so a caller can never request an unbounded dump.
const DIAGNOSTICS_CAP_MIN = 1;
const DIAGNOSTICS_CAP_MAX = 500;
const DEFAULT_MAX_EVENTS = 20;
const DEFAULT_MAX_RUNS = 10;
const DEFAULT_MAX_MESSAGES = 20;

type DiagnosticsScopeMode =
  | "single_team"
  | "multi_team"
  | "known_teams_fallback";

// Resolved focus filter, threaded (read-only) through every team-scoped read so
// the output focuses on ONE team unless explicitly widened.
interface DiagnosticsScope {
  mode: DiagnosticsScopeMode;
  teamId: string | null;
  teamName: string | null;
  teammateMemberId: string | null;
  teammateIdRequested: string | null;
  currentTeamOnly: boolean;
  includeArchived: boolean;
  includeHistory: boolean;
  maxEvents: number;
  maxRuns: number;
  maxMessages: number;
  messagesSince: string | null;
  fallbackReason: string | null;
}

// Mutable truncation accumulator: read functions set these when a cap dropped
// rows, so truncation is always VISIBLE in the payload (never silent).
interface DiagnosticsTruncation {
  events_returned: number;
  events_truncated: boolean;
  runs_returned: number;
  runs_truncated: boolean;
  messages_matched: number;
  messages_returned: number;
  messages_truncated: boolean;
}

// Public-facing scope echo + truncation markers attached to the payload.
interface DiagnosticsScopeReport {
  mode: DiagnosticsScopeMode;
  team_id: string | null;
  team_name: string | null;
  current_team_only: boolean;
  include_archived: boolean;
  include_history: boolean;
  teammate_id: string | null;
  fallback_reason: string | null;
  caps: {
    max_events: number;
    max_runs: number;
    max_messages: number;
    messages_since: string | null;
  };
  events_returned: number;
  events_truncated: boolean;
  runs_returned: number;
  runs_truncated: boolean;
  messages_matched: number;
  messages_returned: number;
  messages_truncated: boolean;
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
  // Phase 17: echo of the active focus filter + truncation markers.
  scope: DiagnosticsScopeReport;
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
    // D-02: terminal-context booleans only (no env values, no it2 stdout).
    terminalContext: TerminalContext;
  };
}

// Phase 16: construct the turn-boundary delivery drain hook for ReconciliationService.
// Returns undefined when pane mode is off (no pane to nudge), so non-pane diagnostics
// are completely unaffected. The hook is best-effort: a drain failure is swallowed so
// it can never break the finalize reconcile.
function buildDeliveryDrainHook(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  statePath: string,
  options: DiagnosticsPayloadOptions
): DeliveryDrainHook | undefined {
  if (options.paneMode?.enabled !== true) {
    return undefined;
  }

  return (input) => {
    try {
      const lifecycle = new LifecycleService({
        db,
        statePath,
        executionBackend: createExecutionBackendFromOptions(options),
        paneMode: options.paneMode
      });
      lifecycle.drainPendingDeliveries({
        teamId: input.teamId,
        teamName: input.teamName,
        recipientMemberId: input.recipientMemberId,
        identity: buildWorkspaceScopedCallerIdentity({
          workspaceRoot: input.workspaceRoot,
          caller: {
            callerKey: input.actorCallerKey,
            observedMetadata: {},
            fallbackUsed: false
          }
        })
      });
    } catch {
      // Best-effort: never break reconcile on a drain error.
    }
  };
}

export function buildDiagnosticsPayload(options: DiagnosticsPayloadOptions = {}): DiagnosticsPayload {
  const registeredTools = options.registeredTools ?? [];
  const caller = normalizeCallerMetadata(options.callerMetadata);
  const stateAdapter = new DurableStateAdapter(options);

  try {
    const db = stateAdapter.getDatabase();
    const baseState = describeDurableState(stateAdapter);
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: baseState.workspaceRoot,
      caller
    });
    // Phase 17: resolve the focus filter ONCE (read-only) and thread it through
    // every team-scoped read. `detail` is false only in the no-active-team
    // fallback, where we surface a compact "known teams" list (so the user can
    // pick) instead of a blank or misleading dump.
    const scope = resolveDiagnosticsScope({ db, identity, options });
    const detail = scope.mode !== "known_teams_fallback";
    const truncation: DiagnosticsTruncation = {
      events_returned: 0,
      events_truncated: false,
      runs_returned: 0,
      runs_truncated: false,
      messages_matched: 0,
      messages_returned: 0,
      messages_truncated: false
    };

    const state = buildDiagnosticsState({
      baseState,
      db,
      identity,
      scope,
      detail,
      truncation
    });
    const executionBackend = createExecutionBackendFromOptions(options);
    const lifecycleSummary = detail
      ? readLifecycleSummary(db, state.workspaceRoot, scope)
      : emptyLifecycleSummary();
    const runSummary = detail
      ? readRunSummary(db, state.workspaceRoot, scope)
      : emptyRunSummary();
    const workspaceReviewSummary = detail
      ? readWorkspaceReviewSummary(db, state.workspaceRoot, scope)
      : emptyWorkspaceReviewSummary();
    const paneMessageSummary = detail
      ? readPaneMessageSummary(db, state.workspaceRoot, scope)
      : emptyMessageSummary();
    const paneStatusSummary = detail
      ? readPaneStatusSummary(db, state.workspaceRoot, {
          paneModeEnabled: options.paneMode?.enabled === true,
          includeDebug: options.includeDebug === true,
          teamId: scope.teamId ?? undefined,
          teammateMemberId: scope.teammateMemberId ?? undefined
        })
      : emptyPaneStatusSummary(options.paneMode?.enabled === true);
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
    // Phase 16: when pane mode is enabled, inject the turn-boundary delivery drain so
    // the finalize-on-poll markRunTerminal (a pane teammate's turn boundary) delivers
    // its pending inbox nudges. Gated on pane mode (the nudge target is a pane); the
    // drain itself is a further no-op without a live pane / durable resume metadata,
    // so a detached or pane-less run is unaffected.
    const deliveryDrain = buildDeliveryDrainHook(db, state.stateRoot, options);
    const reconciliationSummary = new ReconciliationService({
      db,
      statePath: state.stateRoot,
      executionBackend,
      deliveryDrain
    }).reconcileWorkspace({
      workspaceRoot: state.workspaceRoot,
      actorCallerKey: caller.callerKey,
      mode: "finalize"
    });
    const teammates = detail
      ? readTeammateStatuses(db, state.workspaceRoot, scope)
      : [];
    const metadataDiagnostics =
      options.includeDebug === true && detail
        ? buildMetadataDiagnostics(db, state.workspaceRoot, executionBackend, scope)
        : null;
    // Compute the debug runs BEFORE building the return object so the run cap's
    // truncation markers are recorded before toScopeReport snapshots them (object
    // literal properties evaluate top-to-bottom, and `scope` precedes `debug`).
    const debugBlock =
      options.includeDebug === true
        ? {
            callerMetadataType: typeof options.callerMetadata,
            runs: detail
              ? readRunDebugRows(db, state.workspaceRoot, scope, truncation)
              : [],
            terminalContext: describeTerminalContext({
              env: options.terminalEnv,
              commandRunner: options.terminalCommandRunner
            })
          }
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
      scope: toScopeReport(scope, truncation),
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
      ...(debugBlock ? { debug: debugBlock } : {})
    };
  } finally {
    stateAdapter.close();
  }
}

// Phase 17: resolve the focus filter. Precedence:
//   1. explicit team_name (selects that team, even a non-active one);
//   2. multi-team when the caller explicitly widens (current_team_only:false OR
//      include_history:true);
//   3. DEFAULT: the caller's ACTIVE team (active binding, else TL-injected member
//      identity for a teammate caller);
//   4. no active team + no team_name → compact "known teams" fallback (not blank).
// Purely read-only: it never appends events (unlike ContextResolver), so a poll
// does not pollute the event log it is reporting on.
function resolveDiagnosticsScope(input: {
  db: ReturnType<DurableStateAdapter["getDatabase"]>;
  identity: NormalizedCallerIdentityLike;
  options: DiagnosticsPayloadOptions;
}): DiagnosticsScope {
  const { db, identity, options } = input;
  const currentTeamOnly = options.currentTeamOnly ?? true;
  const includeArchived = options.includeArchived ?? false;
  const includeHistory = options.includeHistory ?? false;
  const base = {
    currentTeamOnly,
    includeArchived,
    includeHistory,
    maxEvents: clampCap(options.maxEvents, DEFAULT_MAX_EVENTS),
    maxRuns: clampCap(options.maxRuns, DEFAULT_MAX_RUNS),
    maxMessages: clampCap(options.maxMessages, DEFAULT_MAX_MESSAGES),
    messagesSince: normalizeIsoTimestamp(options.messagesSince),
    teammateIdRequested: optionalText(options.teammateId) ?? null
  } as const;

  // 1. Explicit team selection.
  const requestedTeamName = optionalText(options.teamName);
  if (requestedTeamName) {
    const team = findTeamByNameForDiagnostics(
      db,
      requestedTeamName,
      identity.workspaceRoot,
      includeArchived
    );
    if (team) {
      return {
        ...base,
        mode: "single_team",
        teamId: team.teamId,
        teamName: team.teamName,
        teammateMemberId: resolveTeammateMemberId(
          db,
          team.teamId,
          base.teammateIdRequested
        ),
        fallbackReason: null
      };
    }
    return {
      ...base,
      mode: "known_teams_fallback",
      teamId: null,
      teamName: null,
      teammateMemberId: null,
      fallbackReason: "team_name_not_found"
    };
  }

  // 2. Explicitly widened to multi-team output.
  if (!currentTeamOnly || includeHistory) {
    return {
      ...base,
      mode: "multi_team",
      teamId: null,
      teamName: null,
      teammateMemberId: null,
      fallbackReason: null
    };
  }

  // 3. Default: focus on the caller's active team.
  const active = resolveActiveTeamForDiagnostics(db, identity);
  if (active) {
    return {
      ...base,
      mode: "single_team",
      teamId: active.teamId,
      teamName: active.teamName,
      teammateMemberId: resolveTeammateMemberId(
        db,
        active.teamId,
        base.teammateIdRequested
      ),
      fallbackReason: null
    };
  }

  // 4. No active team to focus on → compact known-teams fallback (not blank).
  return {
    ...base,
    mode: "known_teams_fallback",
    teamId: null,
    teamName: null,
    teammateMemberId: null,
    fallbackReason: "no_active_team"
  };
}

// Minimal identity shape used by scope resolution (the full identity from
// buildWorkspaceScopedCallerIdentity satisfies it).
interface NormalizedCallerIdentityLike {
  workspaceRoot: string;
  callerKey: string;
  bindingKey: string;
  observedMetadata: Record<string, string>;
}

// Read-only resolution of the caller's active team: the active binding first
// (zero behavior change for the TL and existing callers), then the TL-injected
// member identity (a co-located teammate MCP has no binding of its own). The
// team's workspace must match the caller's. Returns null when neither resolves.
function resolveActiveTeamForDiagnostics(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  identity: NormalizedCallerIdentityLike
): { teamId: string; teamName: string } | null {
  const binding = readActiveBinding(db, identity.bindingKey);
  if (
    binding &&
    binding.workspace_root === identity.workspaceRoot &&
    binding.caller_key === identity.callerKey
  ) {
    return { teamId: binding.team_id, teamName: binding.team_name };
  }

  const memberId = identity.observedMetadata.codexTeamMemberId;
  if (memberId) {
    const row = db
      .prepare(
        `
          SELECT
            teams.team_id AS teamId,
            teams.canonical_name AS teamName
          FROM ${TABLE_NAMES.members} AS members
          JOIN ${TABLE_NAMES.teams} AS teams
            ON teams.team_id = members.team_id
          WHERE members.member_id = ?
            AND teams.workspace_root = ?
          LIMIT 1
        `
      )
      .get(memberId, identity.workspaceRoot) as
      | { teamId: string; teamName: string }
      | undefined;
    if (row) {
      return row;
    }
  }

  return null;
}

// Resolve team_name → team row. A team_name explicitly selects a team even if it
// is not the active one. Archived teams resolve only when include_archived is set.
function findTeamByNameForDiagnostics(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  rawTeamName: string,
  workspaceRoot: string,
  includeArchived: boolean
): { teamId: string; teamName: string } | null {
  let canonical: string;
  try {
    canonical = canonicalizeTeamName(rawTeamName);
  } catch {
    return null;
  }

  const row = db
    .prepare(
      `
        SELECT
          team_id AS teamId,
          canonical_name AS teamName,
          status
        FROM ${TABLE_NAMES.teams}
        WHERE workspace_root = ?
          AND canonical_name = ?
        LIMIT 1
      `
    )
    .get(workspaceRoot, canonical) as
    | { teamId: string; teamName: string; status: string }
    | undefined;

  if (!row) {
    return null;
  }
  if (row.status === TEAM_STATUSES.archived && !includeArchived) {
    return null;
  }
  return { teamId: row.teamId, teamName: row.teamName };
}

// Resolve a teammate reference (public id, member id, or display name) to a
// member id within the selected team — mirroring the merge handler's accepted
// forms. Returns the raw reference when unresolved so a bad teammate_id filters
// to NOTHING (signposting "no such teammate") rather than silently to everything.
function resolveTeammateMemberId(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  teamId: string,
  reference: string | null
): string | null {
  if (!reference) {
    return null;
  }

  const row = db
    .prepare(
      `
        SELECT member_id AS memberId
        FROM ${TABLE_NAMES.members}
        WHERE team_id = ?
          AND (
            member_id = ?
            OR json_extract(metadata_json, '$.publicTeammateId') = ?
            OR lower(display_name) = lower(?)
          )
        LIMIT 1
      `
    )
    .get(teamId, reference, reference, reference) as
    | { memberId: string }
    | undefined;

  return row?.memberId ?? reference;
}

// Clamp an integer cap to [1, 500]; non-finite / missing falls back to the
// default. Floors fractional inputs so a cap is always a whole row count.
function clampCap(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const floored = Math.floor(value);
  if (floored < DIAGNOSTICS_CAP_MIN) {
    return DIAGNOSTICS_CAP_MIN;
  }
  if (floored > DIAGNOSTICS_CAP_MAX) {
    return DIAGNOSTICS_CAP_MAX;
  }
  return floored;
}

// Accept only a parseable ISO-8601 timestamp; anything else is ignored (no
// filter) rather than silently dropping all rows.
function normalizeIsoTimestamp(value: string | undefined): string | null {
  const trimmed = optionalText(value);
  if (!trimmed) {
    return null;
  }
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

// Team filter clause for queries that JOIN teams; empty when not single-team.
function teamFilterClause(
  scope: DiagnosticsScope,
  teamsAlias = "teams"
): { sql: string; params: string[] } {
  if (scope.teamId) {
    return { sql: ` AND ${teamsAlias}.team_id = ?`, params: [scope.teamId] };
  }
  return { sql: "", params: [] };
}

function toScopeReport(
  scope: DiagnosticsScope,
  truncation: DiagnosticsTruncation
): DiagnosticsScopeReport {
  return {
    mode: scope.mode,
    team_id: scope.teamId,
    team_name: scope.teamName,
    current_team_only: scope.currentTeamOnly,
    include_archived: scope.includeArchived,
    include_history: scope.includeHistory,
    teammate_id: scope.teammateIdRequested,
    fallback_reason: scope.fallbackReason,
    caps: {
      max_events: scope.maxEvents,
      max_runs: scope.maxRuns,
      max_messages: scope.maxMessages,
      messages_since: scope.messagesSince
    },
    events_returned: truncation.events_returned,
    events_truncated: truncation.events_truncated,
    runs_returned: truncation.runs_returned,
    runs_truncated: truncation.runs_truncated,
    messages_matched: truncation.messages_matched,
    messages_returned: truncation.messages_returned,
    messages_truncated: truncation.messages_truncated
  };
}

function emptyLifecycleSummary(): DiagnosticsLifecycleSummary {
  return { total: 0, by_status: {} };
}

function emptyRunSummary(): DiagnosticsRunSummary {
  return { total: 0, by_status: {}, by_backend_status: {}, stale: 0 };
}

function emptyWorkspaceReviewSummary(): DiagnosticsWorkspaceReviewSummary {
  return {
    pending_review: 0,
    needs_review: 0,
    with_workspace_path: 0,
    merged: 0,
    merge_conflict: 0,
    escalated: 0
  };
}

function emptyMessageSummary(): DiagnosticsMessageSummary {
  return { total: 0, queued: 0, by_delivery_status: {} };
}

function emptyPaneStatusSummary(paneModeEnabled: boolean): PaneStatusSummary {
  return {
    enabled: paneModeEnabled,
    total: 0,
    attachable: 0,
    available: 0,
    unavailable: 0,
    degraded: 0,
    by_backend_type: {},
    by_availability_status: {},
    recent: [],
    panes: []
  };
}

function readLifecycleSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): DiagnosticsLifecycleSummary {
  const byStatus = readCountsByStatus({
    db,
    workspaceRoot,
    tableName: TABLE_NAMES.members,
    statusColumn: "members.status",
    scope
  });

  return {
    total: Object.values(byStatus).reduce((total, count) => total + count, 0),
    by_status: byStatus
  };
}

function readRunSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): DiagnosticsRunSummary {
  const byStatus = readCountsByStatus({
    db,
    workspaceRoot,
    tableName: TABLE_NAMES.runs,
    statusColumn: "runs.status",
    scope
  });
  const byBackendStatus = readRunCountsByBackendStatus(db, workspaceRoot, scope);

  return {
    total: Object.values(byStatus).reduce((total, count) => total + count, 0),
    by_status: byStatus,
    by_backend_status: byBackendStatus,
    stale: byStatus[MEMBER_STATUSES.stale] ?? 0
  };
}

function readWorkspaceReviewSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): DiagnosticsWorkspaceReviewSummary {
  const teamFilter = teamFilterClause(scope);
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
        WHERE teams.workspace_root = ?${teamFilter.sql}
      `
    )
    .get(
      RUN_REVIEW_STATUSES.pendingReview,
      RUN_REVIEW_STATUSES.needsReview,
      RUN_REVIEW_STATUSES.merged,
      RUN_REVIEW_STATUSES.mergeConflict,
      RUN_REVIEW_STATUSES.escalated,
      workspaceRoot,
      ...teamFilter.params
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
  scope: DiagnosticsScope;
}): Record<string, number> {
  const teamFilter = teamFilterClause(input.scope);
  const rows = input.db
    .prepare(
      `
        SELECT
          ${input.statusColumn} AS status,
          COUNT(*) AS count
        FROM ${input.tableName}
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = ${input.tableName}.team_id
        WHERE teams.workspace_root = ?${teamFilter.sql}
        GROUP BY ${input.statusColumn}
        ORDER BY ${input.statusColumn}
      `
    )
    .all(input.workspaceRoot, ...teamFilter.params) as Array<{
    status: string;
    count: number;
  }>;

  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function readRunCountsByBackendStatus(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): Record<string, number> {
  const teamFilter = teamFilterClause(scope);
  const rows = db
    .prepare(
      `
        SELECT
          COALESCE(runs.backend_status, 'unknown') AS backend_status,
          COUNT(*) AS count
        FROM ${TABLE_NAMES.runs} AS runs
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = runs.team_id
        WHERE teams.workspace_root = ?${teamFilter.sql}
        GROUP BY COALESCE(runs.backend_status, 'unknown')
        ORDER BY backend_status
      `
    )
    .all(workspaceRoot, ...teamFilter.params) as Array<{
    backend_status: string;
    count: number;
  }>;

  return Object.fromEntries(rows.map((row) => [row.backend_status, row.count]));
}

function readRunDebugRows(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope,
  truncation: DiagnosticsTruncation
): DiagnosticsRunDebugRow[] {
  const teamFilter = teamFilterClause(scope);
  const memberSql = scope.teammateMemberId ? " AND runs.member_id = ?" : "";
  const memberParams = scope.teammateMemberId ? [scope.teammateMemberId] : [];
  // Fetch one more than the cap to detect (and mark) truncation; newest first.
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
        WHERE teams.workspace_root = ?${teamFilter.sql}${memberSql}
        ORDER BY runs.updated_at DESC, runs.run_id DESC
        LIMIT ?
      `
    )
    .all(
      workspaceRoot,
      ...teamFilter.params,
      ...memberParams,
      scope.maxRuns + 1
    ) as Array<
    Omit<
      DiagnosticsRunDebugRow,
      "changed_files" | "last_error" | "merge_status" | "final_message"
    > & {
      changed_files_json: string | null;
      last_error: string | null;
      metadata_json: string | null;
    }
  >;

  const truncated = rows.length > scope.maxRuns;
  const capped = truncated ? rows.slice(0, scope.maxRuns) : rows;
  truncation.runs_returned = capped.length;
  truncation.runs_truncated = truncated;

  return capped.map((row) => ({
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
  const backendMetadata =
    typeof metadata.backend_metadata === "object" &&
    metadata.backend_metadata !== null &&
    !Array.isArray(metadata.backend_metadata)
      ? (metadata.backend_metadata as Record<string, unknown>)
      : undefined;
  const persistedPath = backendMetadata
    ? optionalText(backendMetadata.exec_log_path)
    : undefined;
  const logPath =
    persistedPath ?? codexExecLogPath(input.workspaceRoot, input.runId);

  let raw: string | null = null;
  try {
    raw = extractCodexDeliverable(readFileSync(logPath, "utf8"));
  } catch {
    raw = null;
  }

  // Pane-hosted runs (full codex TUI) write no `codex exec --json` log; their
  // deliverable lives in the codex rollout transcript, whose path is persisted at
  // start (backend_metadata.rollout_path). Fall back to it ONLY when a rollout
  // path is recorded — detached runs never set it, so their behavior is unchanged.
  if (!raw) {
    const rolloutPath = backendMetadata
      ? optionalText(backendMetadata.rollout_path)
      : undefined;
    if (rolloutPath) {
      raw = readRolloutStatus({ rolloutPath }).deliverable ?? null;
    }
  }

  // Final fallback: pane-hosted runs whose rollout_path was NOT captured at start
  // (e.g. the FIRST teammate's cold-start codex wrote session_meta AFTER the bounded
  // startRun poll window) have no persisted rollout_path — yet their transcript still
  // exists. RELOCATE it by the run's UNIQUE worktree cwd (metadata.workspace_path,
  // which IS persisted), the same way reconcile does, then read the deliverable.
  // Privacy-preserving: the locator reads only each candidate's session_meta first
  // line. Detached runs set no workspace_path under pane mode, so this is a no-op
  // for them and their behavior is unchanged.
  if (!raw) {
    const workspaceCwd = optionalText(metadata.workspace_path);
    if (workspaceCwd) {
      const located = locateRolloutSessionId({ workspaceCwd });
      if (located) {
        raw = readRolloutStatus({ rolloutPath: located.rollout_path }).deliverable ?? null;
      }
    }
  }

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
  workspaceRoot: string,
  scope: DiagnosticsScope
): DiagnosticsTeammateStatus[] {
  const teamFilter = teamFilterClause(scope);
  const memberSql = scope.teammateMemberId ? " AND members.member_id = ?" : "";
  const memberParams = scope.teammateMemberId ? [scope.teammateMemberId] : [];
  // Archived teammates are excluded by default; include_archived opts them in.
  const archivedSql = scope.includeArchived ? "" : " AND members.status != ?";
  const archivedParams = scope.includeArchived ? [] : [MEMBER_STATUSES.archived];
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
        WHERE teams.workspace_root = ?${teamFilter.sql}
          AND members.role = 'teammate'${memberSql}${archivedSql}
        ORDER BY members.joined_at ASC, runs.updated_at DESC, runs.run_id DESC
      `
    )
    .all(
      workspaceRoot,
      ...teamFilter.params,
      ...memberParams,
      ...archivedParams
    ) as TeammateStatusRow[];

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
  executionBackend: ExecutionBackend,
  scope: DiagnosticsScope
): DiagnosticsMetadataDiagnostics | null {
  const teamFilter = teamFilterClause(scope);
  const memberSql = scope.teammateMemberId ? " AND runs.member_id = ?" : "";
  const memberParams = scope.teammateMemberId ? [scope.teammateMemberId] : [];
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
        WHERE teams.workspace_root = ?${teamFilter.sql}${memberSql}
        ORDER BY runs.updated_at DESC, runs.run_id DESC
      `
    )
    .all(workspaceRoot, ...teamFilter.params, ...memberParams) as MetadataDiagnosticsRunRow[];

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

function buildDiagnosticsState(input: {
  baseState: DurableStateRootDescription;
  db: ReturnType<DurableStateAdapter["getDatabase"]>;
  identity: NormalizedCallerIdentityLike;
  scope: DiagnosticsScope;
  detail: boolean;
  truncation: DiagnosticsTruncation;
}): DurableDiagnosticsState {
  const { baseState, db, identity, scope, detail, truncation } = input;
  // knownTeams ALWAYS surfaces (single-team: just the selected team; multi-team
  // and the no-active-team fallback: the full list so the user can pick a
  // team_name). The per-team detail (messages/tasks/events) is suppressed in the
  // fallback so the output stays compact instead of dumping the whole workspace.
  return {
    ...baseState,
    activeBinding: readActiveBinding(db, identity.bindingKey),
    knownTeams: readKnownTeams(db, baseState.workspaceRoot, scope),
    messageSummary: detail
      ? readMessageSummary(db, baseState.workspaceRoot, scope, truncation)
      : emptyMessageSummary(),
    taskSummary: detail
      ? readTaskSummary(db, baseState.workspaceRoot, scope)
      : { total: 0, by_status: {}, assigned: 0, blocked: 0 },
    recentEvents: detail
      ? readRecentEventsForWorkspace(db, baseState.workspaceRoot, scope, truncation)
      : []
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
  workspaceRoot: string,
  scope: DiagnosticsScope
): DiagnosticsKnownTeam[] {
  // Single-team: just the explicitly selected team (any status — it was chosen
  // on purpose). Otherwise the full workspace list, archived only when opted in.
  const clauses = ["workspace_root = ?"];
  const params: string[] = [workspaceRoot];
  if (scope.teamId) {
    clauses.push("team_id = ?");
    params.push(scope.teamId);
  } else if (!scope.includeArchived) {
    clauses.push("status != ?");
    params.push(TEAM_STATUSES.archived);
  }

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
        WHERE ${clauses.join(" AND ")}
        ORDER BY canonical_name
      `
    )
    .all(...params) as DiagnosticsKnownTeam[];
}

interface MessageFilterRow {
  status: string;
  delivery_status: string;
  metadata_json: string | null;
}

// Shared message filters: team (single-team), teammate (recipient OR sender),
// and the messages_since ISO lower bound. Param order matches the clause order.
function buildMessageFilters(scope: DiagnosticsScope): {
  sql: string;
  params: string[];
} {
  let sql = "";
  const params: string[] = [];
  if (scope.teamId) {
    sql += " AND teams.team_id = ?";
    params.push(scope.teamId);
  }
  if (scope.teammateMemberId) {
    sql += " AND (messages.recipient_member_id = ? OR messages.sender_member_id = ?)";
    params.push(scope.teammateMemberId, scope.teammateMemberId);
  }
  if (scope.messagesSince) {
    sql += " AND messages.created_at >= ?";
    params.push(scope.messagesSince);
  }
  return { sql, params };
}

// Aggregate a newest-first message row set into the summary, applying the
// max_messages cap and (when a truncation accumulator is supplied) recording how
// many rows matched vs were returned. D-02: counts/statuses only — never bodies.
function aggregateMessageRows(
  rows: MessageFilterRow[],
  scope: DiagnosticsScope,
  truncation?: DiagnosticsTruncation
): DiagnosticsMessageSummary {
  const matched = rows.length;
  const capped = rows.slice(0, scope.maxMessages);
  if (truncation) {
    truncation.messages_matched = matched;
    truncation.messages_returned = capped.length;
    truncation.messages_truncated = matched > capped.length;
  }

  const byDeliveryStatus: Record<string, number> = {};
  let queued = 0;
  for (const row of capped) {
    byDeliveryStatus[row.delivery_status] =
      (byDeliveryStatus[row.delivery_status] ?? 0) + 1;
    // `queued` now counts rows still genuinely in the queued state — the status
    // column converges to `delivered` / `read` once a row is delivered / pulled, so
    // this no longer over-reports every row as queued (the v1.2 observability fix).
    // Delivered / read rows are still fully represented via total + by_delivery_status.
    if (row.status === MESSAGE_ROW_STATUSES.queued) {
      queued += 1;
    }
  }

  return {
    total: capped.length,
    queued,
    by_delivery_status: byDeliveryStatus
  };
}

function readMessageSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope,
  truncation: DiagnosticsTruncation
): DiagnosticsMessageSummary {
  const filters = buildMessageFilters(scope);
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
        WHERE teams.workspace_root = ?${filters.sql}
        ORDER BY messages.created_at DESC, messages.message_id DESC
      `
    )
    .all(workspaceRoot, ...filters.params) as MessageFilterRow[];

  return aggregateMessageRows(rows, scope, truncation);
}

function readPaneMessageSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): DiagnosticsMessageSummary {
  const filters = buildMessageFilters(scope);
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
        WHERE teams.workspace_root = ?${filters.sql}
        ORDER BY messages.created_at DESC, messages.message_id DESC
      `
    )
    .all(workspaceRoot, ...filters.params) as MessageFilterRow[];
  // The pane message view excludes task-assignment rows (they surface in the task
  // summary). The cap is applied AFTER that exclusion. Truncation for the message
  // listing is tracked by the canonical state.messageSummary, not this view.
  const explicitMessageRows = rows.filter(
    (row) => parseJsonObject(row.metadata_json).message_type !== "task_assignment"
  );

  return aggregateMessageRows(explicitMessageRows, scope);
}

function readTaskSummary(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): DiagnosticsTaskSummary {
  const teamFilter = teamFilterClause(scope);
  const totals = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN tasks.owner_member_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS assigned
        FROM ${TABLE_NAMES.tasks} AS tasks
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = tasks.team_id
        WHERE teams.workspace_root = ?${teamFilter.sql}
      `
    )
    .get(workspaceRoot, ...teamFilter.params) as
    | { total: number; assigned: number }
    | undefined;

  return {
    total: totals?.total ?? 0,
    by_status: readTaskCountsByStatus(db, workspaceRoot, scope),
    assigned: totals?.assigned ?? 0,
    blocked: readBlockedTaskCount(db, workspaceRoot, scope)
  };
}

function readTaskCountsByStatus(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): Record<string, number> {
  const teamFilter = teamFilterClause(scope);
  const rows = db
    .prepare(
      `
        SELECT
          tasks.status,
          COUNT(*) AS count
        FROM ${TABLE_NAMES.tasks} AS tasks
        JOIN ${TABLE_NAMES.teams} AS teams
          ON teams.team_id = tasks.team_id
        WHERE teams.workspace_root = ?${teamFilter.sql}
        GROUP BY tasks.status
        ORDER BY tasks.status
      `
    )
    .all(workspaceRoot, ...teamFilter.params) as Array<{
    status: string;
    count: number;
  }>;

  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function readBlockedTaskCount(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope
): number {
  const teamFilter = teamFilterClause(scope);
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
        WHERE teams.workspace_root = ?${teamFilter.sql}
          AND blocker.status != ?
      `
    )
    .get(workspaceRoot, ...teamFilter.params, TASK_STATUSES.completed) as
    | { blocked: number }
    | undefined;

  return row?.blocked ?? 0;
}

function readRecentEventsForWorkspace(
  db: ReturnType<DurableStateAdapter["getDatabase"]>,
  workspaceRoot: string,
  scope: DiagnosticsScope,
  truncation: DiagnosticsTruncation
): DiagnosticsRecentEvent[] {
  // Single-team: restrict to the team's own events (events.team_id). The events
  // table carries its own team_id/workspace_root, so no JOIN is needed. Fetch one
  // beyond the cap to detect (and mark) truncation; newest first.
  const teamSql = scope.teamId ? " AND team_id = ?" : "";
  const teamParams = scope.teamId ? [scope.teamId] : [];
  const rows = db
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
        WHERE workspace_root = ?${teamSql}
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?
      `
    )
    .all(workspaceRoot, ...teamParams, scope.maxEvents + 1) as DiagnosticsRecentEvent[];

  const truncated = rows.length > scope.maxEvents;
  const events = truncated ? rows.slice(0, scope.maxEvents) : rows;
  truncation.events_returned = events.length;
  truncation.events_truncated = truncated;
  return events;
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
