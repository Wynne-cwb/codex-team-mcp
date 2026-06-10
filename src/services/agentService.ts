import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  type ExecutionBackend,
  ScaffoldExecutionBackend
} from "../adapters/execution.js";
import type { PaneBackendRegistry } from "../adapters/paneBackend.js";
import type { PaneModeOptions } from "../types.js";
import type {
  LifecycleActionResult,
  LifecycleBackendResult,
  LifecycleDebugResult,
  LifecycleMetadataResult
} from "./lifecycleService.js";
import { LifecycleService } from "./lifecycleService.js";
import { MessageService } from "./messageService.js";
import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import { ContextResolver, type TeamContextResolution } from "./contextResolver.js";
import {
  buildInternalTeamMateMemberId,
  buildPublicTeamMateId,
  canonicalizeTeamMateName,
  normalizeTeamMateDisplayName
} from "./teamMemberNames.js";
import {
  EVENT_TYPES,
  ISOLATION_KINDS,
  MEMBER_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  RUN_REVIEW_STATUSES,
  WORK_CLASSIFICATIONS,
  TABLE_NAMES,
  type MessageDeliveryStatus
} from "../state/schema.js";

const TEAMMATE_CREATED_EVENT_TYPE =
  EVENT_TYPES.teammateCreated satisfies "teammate_created";
const TEAMMATE_RUN_SCHEDULED_EVENT_TYPE =
  EVENT_TYPES.teammateRunScheduled satisfies "teammate_run_scheduled";
const TEAMMATE_CREATION_REJECTED_EVENT_TYPE =
  EVENT_TYPES.teammateCreationRejected satisfies "teammate_creation_rejected";

const BACKEND_STATUS_NOT_STARTED = "not_started";
const BACKEND_NAME = "none";
const NESTED_CREATION_UNPROVEN = "caller_not_proven_teammate";
const EXECUTION_BACKEND_UNAVAILABLE_ERROR_CODE = "execution_backend_unavailable";
const BACKEND_UNAVAILABLE_ERROR_CODE = "backend_unavailable";
// Real execution surfaces selected by the Phase-8 capability-ranked chain. D-04
// fires its loud error ONLY for these (the opted-in real backend). The default
// scaffold ("none") and Phase-7 pane transports ("tmux"/"iterm2") keep their
// quiet scheduled + backend_unavailable behavior.
const REAL_EXECUTION_BACKEND_NAMES = new Set<string>(["codex_cli_exec"]);
// D-04 explicit, actionable error: loud failure so the leader knows no real run
// started. Carries remediation; never leaks prompt/output (sanitized constant).
const EXECUTION_BACKEND_UNAVAILABLE_MESSAGE =
  "No real run started: the opted-in execution backend is unavailable on this machine. " +
  "The TeamMate team/member/run records are persisted, but no backend run was launched. " +
  "Remediation: ensure CODEX_TEAM_EXECUTION=1, make sure `codex` is on PATH (codex exec --help should exit 0), " +
  "and provide a worktree for file-modifying work so the backend can run with --cd.";

export interface AgentServiceOptions {
  db: Database.Database;
  statePath: string;
  executionBackend?: ExecutionBackend;
  // PANE-01 / D-01: forwarded to LifecycleService so a real Agent start can
  // overlay a visible pane when pane mode is enabled. paneBackend is an
  // injection seam for deterministic tests (CI has no real tmux/iTerm2).
  paneMode?: PaneModeOptions;
  paneBackend?: PaneBackendRegistry;
}

export interface AgentCreateInput {
  name?: string;
  teamName?: string;
  mode?: string;
  prompt?: string;
  description?: string;
  modelHint?: string;
  agentType?: string;
  subagentType?: string;
  runInBackground?: boolean;
  isolation?: string;
  cwd?: string;
  workspacePath?: string;
  reviewDiffArtifactPath?: string;
  declaredOutputPath?: string;
  baseRevision?: string;
  identity: WorkspaceScopedCallerIdentity;
}

export interface AgentOrdinarySubagentPathResult {
  status: "ordinary_subagent_path";
  not_handled_by_team_layer: true;
  reason: "missing_teammate_name";
}

export interface AgentScheduledResult {
  status: LifecycleActionResult["status"];
  teammate_id: string;
  team_name: string;
  display_name: string;
  run_id: string;
  backend: AgentScheduledBackend;
  delivery_status?: MessageDeliveryStatus;
  error_code?: LifecycleActionResult["error_code"];
  lifecycle?: LifecycleMetadataResult;
  debug: AgentScheduledDebug;
}

export type AgentScheduledBackend = LifecycleBackendResult;

export interface AgentScheduledDebug {
  internal_member_id: string;
  team_id: string;
  team_resolution: TeamContextResolution;
  caller_key: string;
  binding_key: string;
  fallback_used: boolean;
  nested_creation_enforcement: typeof NESTED_CREATION_UNPROVEN;
  lifecycle?: LifecycleDebugResult;
}

export interface AgentErrorResult {
  status: "error";
  error_code: string;
  message: string;
  not_handled_by_team_layer?: true;
  team_name?: string;
  teammate_id?: string;
}

export type AgentServiceResult =
  | AgentOrdinarySubagentPathResult
  | AgentScheduledResult
  | AgentErrorResult;

interface ResolvedCreationInput {
  input: AgentCreateInput;
  teamId: string;
  teamName: string;
  teamResolution: TeamContextResolution;
  canonicalName: string;
  displayName: string;
  publicTeammateId: string;
  internalMemberId: string;
  runId: string;
  createdAt: string;
}

interface MemberProofRow {
  memberId: string;
  role: string;
}

export class AgentService {
  constructor(private readonly options: AgentServiceOptions) {}

  createAgent(input: AgentCreateInput): AgentServiceResult {
    if (!input.name || input.name.trim().length === 0) {
      return {
        status: "ordinary_subagent_path",
        not_handled_by_team_layer: true,
        reason: "missing_teammate_name"
      };
    }

    const resolved = new ContextResolver(this.options.db).resolveTeam({
      teamName: input.teamName,
      identity: input.identity
    });

    if (!resolved.ok) {
      return {
        status: "error",
        error_code: resolved.errorCode,
        message: resolved.message,
        not_handled_by_team_layer: true
      };
    }

    const observedRole = input.identity.observedMetadata.codexTeamMemberRole;
    const callerMember = this.findCallerMemberInTeam(
      resolved.team.teamId,
      input.identity
    );
    const provenNonLeader =
      callerMember?.role !== undefined
        ? callerMember.role !== "leader"
        : observedRole !== undefined && observedRole !== "leader";

    if (provenNonLeader) {
      this.appendRejectionEvent({
        teamId: resolved.team.teamId,
        teamName: resolved.team.teamName,
        actorMemberId: callerMember?.memberId ?? null,
        identity: input.identity,
        errorCode: "agent_nested_teammate_rejected",
        payload: {
          reason: "nested_addressable_teammate_creation_rejected",
          caller_member_id: callerMember?.memberId ?? null,
          caller_member_role: callerMember?.role ?? observedRole
        }
      });

      return {
        status: "error",
        error_code: "agent_nested_teammate_rejected",
        message:
          "TeamMates cannot create nested addressable TeamMates in Phase 3.",
        team_name: resolved.team.teamName
      };
    }

    const displayName = normalizeTeamMateDisplayName(input.name);
    const canonicalName = canonicalizeTeamMateName(input.name);
    const publicTeammateId = buildPublicTeamMateId(
      canonicalName,
      resolved.team.teamName
    );
    const internalMemberId = buildInternalTeamMateMemberId(
      resolved.team.teamId,
      canonicalName
    );

    if (this.memberExists(internalMemberId)) {
      this.appendDuplicateRejectionEvent({
        teamId: resolved.team.teamId,
        teamName: resolved.team.teamName,
        identity: input.identity,
        publicTeammateId,
        canonicalName,
        displayName
      });

      return {
        status: "error",
        error_code: "agent_duplicate_teammate_name",
        message: "TeamMate name already exists in this team.",
        team_name: resolved.team.teamName,
        teammate_id: publicTeammateId
      };
    }

    const creation: ResolvedCreationInput = {
      input,
      teamId: resolved.team.teamId,
      teamName: resolved.team.teamName,
      teamResolution: resolved.team.resolution,
      canonicalName,
      displayName,
      publicTeammateId,
      internalMemberId,
      runId: `run:${resolved.team.teamId}:${canonicalName}:${randomUUID()}`,
      createdAt: new Date().toISOString()
    };

    const tx = this.options.db.transaction(
      (transactionInput: ResolvedCreationInput) => {
        this.insertMember(transactionInput);
        this.insertRun(transactionInput);
        this.appendCreationEvents(transactionInput);
        return this.buildScheduledResult(transactionInput);
      }
    );

    try {
      const scheduledResult = tx(creation);
      const lifecycleResult = this.createLifecycleService().startScheduledRun({
        team_id: creation.teamId,
        team_name: creation.teamName,
        member_id: creation.internalMemberId,
        run_id: creation.runId,
        teammate_id: creation.publicTeammateId,
        prompt_present: Boolean(input.prompt),
        prompt: input.prompt,
        mode: input.mode,
        description: input.description,
        cwd: input.cwd,
        isolation: input.isolation,
        workspace_path: input.workspacePath,
        review_diff_artifact_path: input.reviewDiffArtifactPath,
        declared_output_path: input.declaredOutputPath,
        base_revision: input.baseRevision,
        identity: input.identity
      });

      const merged = this.mergeLifecycleResult(scheduledResult, lifecycleResult);

      // D-03: a one-shot turn completed -> the member is idle; notify the lead
      // (sanitized, best-effort) so the next message/task can resume it (Phase 10).
      if (lifecycleResult.turn_completed === true) {
        this.notifyLeadOfCompletion(creation);
      }

      // D-04: an opted-in real backend was unavailable at start (records already
      // persisted) -> return a loud, actionable error. The default scaffold
      // ("none") and Phase-7 pane transports keep the quiet scheduled result
      // (Phase 5/7 baseline).
      if (
        lifecycleResult.error_code === BACKEND_UNAVAILABLE_ERROR_CODE &&
        REAL_EXECUTION_BACKEND_NAMES.has(lifecycleResult.backend.backend)
      ) {
        return {
          status: "error",
          error_code: EXECUTION_BACKEND_UNAVAILABLE_ERROR_CODE,
          message: EXECUTION_BACKEND_UNAVAILABLE_MESSAGE,
          team_name: creation.teamName,
          teammate_id: creation.publicTeammateId
        };
      }

      return merged;
    } catch (error) {
      if (!isUniqueMemberIdError(error)) {
        throw error;
      }

      this.appendDuplicateRejectionEvent({
        teamId: resolved.team.teamId,
        teamName: resolved.team.teamName,
        identity: input.identity,
        publicTeammateId,
        canonicalName,
        displayName
      });

      return {
        status: "error",
        error_code: "agent_duplicate_teammate_name",
        message: "TeamMate name already exists in this team.",
        team_name: resolved.team.teamName,
        teammate_id: publicTeammateId
      };
    }
  }

  private insertMember(creation: ResolvedCreationInput): void {
    this.options.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.members} (
            member_id,
            team_id,
            display_name,
            role,
            agent_type,
            model_hint,
            status,
            caller_key,
            workspace_root,
            joined_at,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        creation.internalMemberId,
        creation.teamId,
        creation.displayName,
        "teammate",
        normalizeOptionalText(creation.input.agentType) ??
          normalizeOptionalText(creation.input.subagentType),
        normalizeOptionalText(creation.input.modelHint),
        MEMBER_STATUSES.scheduled,
        creation.input.identity.callerKey,
        creation.input.identity.workspaceRoot,
        creation.createdAt,
        JSON.stringify(this.buildMemberMetadata(creation))
      );
  }

  private insertRun(creation: ResolvedCreationInput): void {
    this.options.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.runs} (
            run_id,
            team_id,
            member_id,
            status,
            backend,
            workspace_path,
            metadata_json,
            created_at,
            updated_at,
            last_error
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        creation.runId,
        creation.teamId,
        creation.internalMemberId,
        MEMBER_STATUSES.scheduled,
        BACKEND_NAME,
        null,
        JSON.stringify(this.buildRunMetadata(creation)),
        creation.createdAt,
        creation.createdAt,
        null
      );
  }

  private appendCreationEvents(creation: ResolvedCreationInput): void {
    this.appendEvent({
      teamId: creation.teamId,
      actorMemberId: creation.internalMemberId,
      identity: creation.input.identity,
      eventType: TEAMMATE_CREATED_EVENT_TYPE,
      payload: {
        teammate_id: creation.publicTeammateId,
        internal_member_id: creation.internalMemberId,
        display_name: creation.displayName,
        canonical_name: creation.canonicalName,
        status: MEMBER_STATUSES.scheduled
      },
      createdAt: creation.createdAt
    });
    this.appendEvent({
      teamId: creation.teamId,
      actorMemberId: creation.internalMemberId,
      identity: creation.input.identity,
      eventType: TEAMMATE_RUN_SCHEDULED_EVENT_TYPE,
      payload: {
        teammate_id: creation.publicTeammateId,
        run_id: creation.runId,
        backend: BACKEND_NAME,
        backend_status: "not_started",
        execution_available: false
      },
      createdAt: creation.createdAt
    });
  }

  private buildScheduledResult(
    creation: ResolvedCreationInput
  ): AgentScheduledResult {
    return {
      status: "scheduled",
      teammate_id: creation.publicTeammateId,
      team_name: creation.teamName,
      display_name: creation.displayName,
      run_id: creation.runId,
      backend: {
        status: BACKEND_STATUS_NOT_STARTED,
        backend: BACKEND_NAME,
        execution_available: false,
        teammate_execution_implemented: false
      },
      delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
      lifecycle: {
        work_classification: WORK_CLASSIFICATIONS.readOnly,
        isolation_kind: ISOLATION_KINDS.none,
        review_status: RUN_REVIEW_STATUSES.none
      },
      debug: {
        internal_member_id: creation.internalMemberId,
        team_id: creation.teamId,
        team_resolution: creation.teamResolution,
        caller_key: creation.input.identity.callerKey,
        binding_key: creation.input.identity.bindingKey,
        fallback_used: creation.input.identity.fallbackUsed,
        nested_creation_enforcement: NESTED_CREATION_UNPROVEN,
        lifecycle: {
          prompt_present: Boolean(creation.input.prompt),
          safety_status: "not_required",
          backend_action: "not_attempted"
        }
      }
    };
  }

  private createLifecycleService(): LifecycleService {
    return new LifecycleService({
      db: this.options.db,
      statePath: this.options.statePath,
      executionBackend:
        this.options.executionBackend ?? new ScaffoldExecutionBackend(),
      paneMode: this.options.paneMode,
      paneBackend: this.options.paneBackend
    });
  }

  // D-03 completion notification. The teammate sends a SANITIZED lifecycle
  // message to the team-lead (no prompt/output/task text). The lead is
  // role:"leader"/status:"active", so the message simply queues — there is NO
  // resume feedback loop. Best-effort: a notify failure never corrupts the
  // already-persisted idle state.
  private notifyLeadOfCompletion(creation: ResolvedCreationInput): void {
    try {
      const messageService = new MessageService({
        db: this.options.db,
        statePath: this.options.statePath,
        executionBackend: this.options.executionBackend
      });

      messageService.sendMessage({
        teamName: creation.teamName,
        from: creation.publicTeammateId,
        to: `team-lead@${creation.teamName}`,
        message: `TeamMate ${creation.displayName} completed its turn.`,
        summary: `${creation.displayName} completed its turn`,
        metadata: {
          message_type: "lifecycle_completion",
          teammate_id: creation.publicTeammateId,
          run_id: creation.runId
        },
        identity: creation.input.identity
      });
    } catch {
      // Best-effort only: the durable idle state + completion event are already
      // persisted by LifecycleService and must not be corrupted by notify errors.
    }
  }

  private mergeLifecycleResult(
    scheduledResult: AgentScheduledResult,
    lifecycleResult: LifecycleActionResult
  ): AgentScheduledResult {
    return {
      ...scheduledResult,
      status: lifecycleResult.status,
      delivery_status: lifecycleResult.delivery_status,
      error_code: lifecycleResult.error_code,
      backend: lifecycleResult.backend,
      lifecycle: lifecycleResult.lifecycle,
      debug: {
        ...scheduledResult.debug,
        lifecycle: lifecycleResult.debug
      }
    };
  }

  private buildMemberMetadata(
    creation: ResolvedCreationInput
  ): Record<string, unknown> {
    return cleanMetadata({
      publicTeammateId: creation.publicTeammateId,
      canonicalName: creation.canonicalName,
      backend_status: "not_started",
      execution_available: false,
      prompt_stored_in_run: Boolean(creation.input.prompt),
      nested_creation_enforcement: NESTED_CREATION_UNPROVEN,
      observedMetadata: creation.input.identity.observedMetadata,
      fallbackUsed: creation.input.identity.fallbackUsed,
      mode: normalizeOptionalText(creation.input.mode),
      description: normalizeOptionalText(creation.input.description),
      agentType: normalizeOptionalText(creation.input.agentType),
      subagentType: normalizeOptionalText(creation.input.subagentType),
      modelHint: normalizeOptionalText(creation.input.modelHint),
      runInBackground: creation.input.runInBackground,
      isolation: normalizeOptionalText(creation.input.isolation),
      cwd: normalizeOptionalText(creation.input.cwd),
      workspacePath: normalizeOptionalText(creation.input.workspacePath),
      reviewDiffArtifactPath: normalizeOptionalText(
        creation.input.reviewDiffArtifactPath
      ),
      declaredOutputPath: normalizeOptionalText(creation.input.declaredOutputPath),
      baseRevision: normalizeOptionalText(creation.input.baseRevision)
    });
  }

  private buildRunMetadata(
    creation: ResolvedCreationInput
  ): Record<string, unknown> {
    return cleanMetadata({
      backend_status: "not_started",
      execution_available: false,
      teammate_execution_implemented: false,
      publicTeammateId: creation.publicTeammateId,
      internalMemberId: creation.internalMemberId,
      canonicalName: creation.canonicalName,
      prompt: creation.input.prompt ?? null,
      prompt_present: Boolean(creation.input.prompt),
      description: normalizeOptionalText(creation.input.description),
      mode: normalizeOptionalText(creation.input.mode),
      cwd: normalizeOptionalText(creation.input.cwd),
      isolation: normalizeOptionalText(creation.input.isolation),
      workspace_path: normalizeOptionalText(creation.input.workspacePath),
      review_diff_artifact_path: normalizeOptionalText(
        creation.input.reviewDiffArtifactPath
      ),
      declared_output_path: normalizeOptionalText(
        creation.input.declaredOutputPath
      ),
      base_revision: normalizeOptionalText(creation.input.baseRevision),
      run_in_background: creation.input.runInBackground ?? false
    });
  }

  private findCallerMemberInTeam(
    teamId: string,
    identity: WorkspaceScopedCallerIdentity
  ): MemberProofRow | undefined {
    const observedMemberId = identity.observedMetadata.codexTeamMemberId;
    if (!observedMemberId) {
      return undefined;
    }

    return this.options.db
      .prepare(
        `
          SELECT member_id AS memberId, role
          FROM ${TABLE_NAMES.members}
          WHERE team_id = ?
            AND member_id = ?
          LIMIT 1
        `
      )
      .get(teamId, observedMemberId) as MemberProofRow | undefined;
  }

  private memberExists(memberId: string): boolean {
    const row = this.options.db
      .prepare(
        `
          SELECT member_id
          FROM ${TABLE_NAMES.members}
          WHERE member_id = ?
          LIMIT 1
        `
      )
      .get(memberId);

    return row !== undefined;
  }

  private appendDuplicateRejectionEvent(input: {
    teamId: string;
    teamName: string;
    identity: WorkspaceScopedCallerIdentity;
    publicTeammateId: string;
    canonicalName: string;
    displayName: string;
  }): void {
    this.appendRejectionEvent({
      teamId: input.teamId,
      teamName: input.teamName,
      actorMemberId: `leader:${input.teamId}`,
      identity: input.identity,
      errorCode: "agent_duplicate_teammate_name",
      payload: {
        teammate_id: input.publicTeammateId,
        canonical_name: input.canonicalName,
        display_name: input.displayName,
        reason: "duplicate_canonical_teammate_name"
      }
    });
  }

  private appendRejectionEvent(input: {
    teamId: string;
    teamName: string;
    actorMemberId: string | null;
    identity: WorkspaceScopedCallerIdentity;
    errorCode: string;
    payload: Record<string, unknown>;
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
        input.teamId,
        input.actorMemberId,
        input.identity.workspaceRoot,
        input.identity.callerKey,
        TEAMMATE_CREATION_REJECTED_EVENT_TYPE,
        input.errorCode,
        JSON.stringify({
          team_name: input.teamName,
          fallback_used: input.identity.fallbackUsed,
          ...input.payload
        }),
        new Date().toISOString()
      );
  }

  private appendEvent(input: {
    teamId: string;
    actorMemberId: string;
    identity: WorkspaceScopedCallerIdentity;
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
        randomUUID(),
        input.teamId,
        input.actorMemberId,
        input.identity.workspaceRoot,
        input.identity.callerKey,
        input.eventType,
        JSON.stringify(input.payload),
        input.createdAt
      );
  }
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function cleanMetadata(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

function isUniqueMemberIdError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("members.member_id")
  );
}
