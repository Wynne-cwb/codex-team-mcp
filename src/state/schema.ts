export const TABLE_NAMES = {
  schemaMigrations: "schema_migrations",
  teams: "teams",
  members: "members",
  activeBindings: "active_bindings",
  componentInitializations: "component_initializations",
  messages: "messages",
  tasks: "tasks",
  taskEdges: "task_edges",
  taskEvents: "task_events",
  runs: "runs",
  events: "events"
} as const;

export type TableName = (typeof TABLE_NAMES)[keyof typeof TABLE_NAMES];

export const TEAM_STATUSES = {
  active: "active",
  archived: "archived"
} as const;

export type TeamStatus = (typeof TEAM_STATUSES)[keyof typeof TEAM_STATUSES];

export const MEMBER_STATUSES = {
  active: "active",
  scheduled: "scheduled",
  running: "running",
  idle: "idle",
  stopped: "stopped",
  failed: "failed",
  stale: "stale",
  archived: "archived"
} as const;

export type MemberStatus = (typeof MEMBER_STATUSES)[keyof typeof MEMBER_STATUSES];

export const RUN_BACKEND_STATUSES = {
  notStarted: "not_started",
  starting: "starting",
  running: "running",
  idle: "idle",
  stopped: "stopped",
  failed: "failed",
  stale: "stale",
  unknown: "unknown"
} as const;

export type RunBackendStatus =
  (typeof RUN_BACKEND_STATUSES)[keyof typeof RUN_BACKEND_STATUSES];

export const MESSAGE_ROW_STATUSES = {
  queued: "queued"
} as const;

export type MessageRowStatus =
  (typeof MESSAGE_ROW_STATUSES)[keyof typeof MESSAGE_ROW_STATUSES];

export const MESSAGE_DELIVERY_STATUSES = {
  queuedForNextTurn: "queued_for_next_turn",
  queuedWhileIdle: "queued_while_idle",
  backendStartAttempted: "backend_start_attempted",
  backendResumeAttempted: "backend_resume_attempted",
  backendUnavailable: "backend_unavailable",
  backendFailed: "backend_failed",
  recipientStale: "recipient_stale"
} as const;

export type MessageDeliveryStatus =
  (typeof MESSAGE_DELIVERY_STATUSES)[keyof typeof MESSAGE_DELIVERY_STATUSES];

export const WORK_CLASSIFICATIONS = {
  readOnly: "read_only",
  reviewOnly: "review_only",
  artifactWriting: "artifact_writing",
  codeImplementation: "code_implementation"
} as const;

export type WorkClassification =
  (typeof WORK_CLASSIFICATIONS)[keyof typeof WORK_CLASSIFICATIONS];

export const ISOLATION_KINDS = {
  none: "none",
  declaredOutputPath: "declared_output_path",
  gitWorktree: "git_worktree",
  sandbox: "sandbox",
  reviewDiff: "review_diff"
} as const;

export type IsolationKind = (typeof ISOLATION_KINDS)[keyof typeof ISOLATION_KINDS];

export const RUN_REVIEW_STATUSES = {
  none: "none",
  pendingReview: "pending_review",
  needsReview: "needs_review",
  merged: "merged",
  preserved: "preserved",
  // Phase 12 (D-04): TL-driven merge outcomes. `merge_conflict` records a
  // fail-closed conflict (worktree preserved, leader rolled back clean);
  // `escalated_to_human` records an explicit hand-off when the TL Agent cannot
  // resolve a merge autonomously (worktree preserved, no destructive action).
  mergeConflict: "merge_conflict",
  escalated: "escalated_to_human"
} as const;

export type RunReviewStatus =
  (typeof RUN_REVIEW_STATUSES)[keyof typeof RUN_REVIEW_STATUSES];

export const TASK_STATUSES = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed"
} as const;

export type TaskStatus = (typeof TASK_STATUSES)[keyof typeof TASK_STATUSES];

export const ACTIVE_BINDING_STATUSES = {
  active: "active",
  invalidated: "invalidated"
} as const;

export type ActiveBindingStatus =
  (typeof ACTIVE_BINDING_STATUSES)[keyof typeof ACTIVE_BINDING_STATUSES];

export const COMPONENT_NAMES = {
  inbox: "inbox",
  tasks: "tasks",
  runs: "runs",
  events: "events"
} as const;

export type ComponentName = (typeof COMPONENT_NAMES)[keyof typeof COMPONENT_NAMES];

export const EVENT_TYPES = {
  teamCreated: "team_created",
  teamNameConflictResolved: "team_name_conflict_resolved",
  leaderRegistered: "leader_registered",
  activeBindingUpdated: "active_binding_updated",
  componentInitialized: "component_initialized",
  explicitTeamAccessed: "explicit_team_accessed",
  teamDeleteRequested: "team_delete_requested",
  teamDeleteBlocked: "team_delete_blocked",
  teamArchived: "team_archived",
  activeBindingInvalidated: "active_binding_invalidated",
  toolValidationFailed: "tool_validation_failed",
  resolverError: "resolver_error",
  teammateCreated: "teammate_created",
  teammateRunScheduled: "teammate_run_scheduled",
  teammateCreationRejected: "teammate_creation_rejected",
  messageSent: "message_sent",
  messageQueued: "message_queued",
  messageSendFailed: "message_send_failed",
  messageSendUnsupported: "message_send_unsupported",
  taskCreated: "task_created",
  taskUpdated: "task_updated",
  taskAssigned: "task_assigned",
  taskNoteAdded: "task_note_added",
  taskMetadataUpdated: "task_metadata_updated",
  taskDependencyUpdated: "task_dependency_updated",
  taskUpdateFailed: "task_update_failed",
  teammateLifecycleTransition: "teammate_lifecycle_transition",
  teammateBackendStartAttempted: "teammate_backend_start_attempted",
  teammateBackendResumeAttempted: "teammate_backend_resume_attempted",
  teammateBackendFailed: "teammate_backend_failed",
  teammateReconciled: "teammate_reconciled",
  teammateMarkedStale: "teammate_marked_stale",
  teammateRunCompleted: "teammate_run_completed",
  workspaceIsolationCreated: "workspace_isolation_created",
  workspaceReviewRequired: "workspace_review_required",
  // Phase 12 (D-04): auditable TL-driven worktree merge lifecycle. Merge and
  // escalate are explicit TL actions (NOT silent auto-merge); each appends an
  // auditable event. `workspaceWorktreeCleaned` records O-2 cleanup outcome.
  workspaceMergeRequested: "workspace_merge_requested",
  workspaceMergeCompleted: "workspace_merge_completed",
  workspaceMergeConflict: "workspace_merge_conflict",
  workspaceMergeEscalated: "workspace_merge_escalated",
  workspaceWorktreeCleaned: "workspace_worktree_cleaned"
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export const ERROR_EVENT_TYPES = {
  toolValidationFailed: EVENT_TYPES.toolValidationFailed,
  resolverError: EVENT_TYPES.resolverError
} as const;

export type ErrorEventType = (typeof ERROR_EVENT_TYPES)[keyof typeof ERROR_EVENT_TYPES];
