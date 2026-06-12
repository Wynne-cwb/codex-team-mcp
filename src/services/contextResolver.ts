import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import { canonicalizeTeamName } from "./teamNames.js";
import {
  ACTIVE_BINDING_STATUSES,
  EVENT_TYPES,
  TABLE_NAMES,
  TEAM_STATUSES
} from "../state/schema.js";

export const CONTEXT_RESOLVER_ERROR_CODES = {
  noActiveTeam: "no_active_team",
  teamNotFound: "team_not_found",
  teamArchived: "team_archived",
  archivedActiveTeam: "archived_active_team",
  ambiguousActiveTeam: "ambiguous_active_team",
  crossWorkspaceTeam: "cross_workspace_team"
} as const;

export type ContextResolverErrorCode =
  (typeof CONTEXT_RESOLVER_ERROR_CODES)[keyof typeof CONTEXT_RESOLVER_ERROR_CODES];

export type TeamContextResolution =
  | "explicit"
  | "active_binding"
  // Phase 13 (D-Q6): a self-identified teammate caller (no active binding of its
  // own) resolved its team from the TL-injected member id in observedMetadata.
  | "member_identity";

export interface ResolvedTeamContext {
  teamId: string;
  teamName: string;
  workspaceRoot: string;
  leadAgentId: string;
  resolution: TeamContextResolution;
}

export interface ResolveTeamInput {
  teamName?: string;
  identity: WorkspaceScopedCallerIdentity;
}

export type ResolveTeamResult =
  | {
      ok: true;
      team: ResolvedTeamContext;
    }
  | {
      ok: false;
      errorCode: ContextResolverErrorCode;
      message: string;
    };

interface TeamRow {
  teamId: string;
  teamName: string;
  status: string;
  workspaceRoot: string;
  leadAgentId: string;
}

interface ActiveBindingRow {
  bindingKey: string;
  workspaceRoot: string;
  callerKey: string;
  teamId: string;
  fallbackUsed: number;
}

interface CountRow {
  count: number;
}

export class ContextResolver {
  constructor(private readonly db: Database.Database) {}

  resolveTeam(input: ResolveTeamInput): ResolveTeamResult {
    if (input.teamName !== undefined) {
      return this.resolveExplicitTeam(input.teamName, input.identity);
    }

    // Active binding stays the first-choice resolution: zero behavior change for
    // the TL and every existing caller. Only when no binding exists do we try the
    // D-Q6 member-identity fallback (a co-located teammate MCP has its own
    // callerKey, hence no binding). A definitive member-identity outcome (ok,
    // cross-workspace, or archived) is returned; otherwise we fall through to the
    // unchanged no_active_team path.
    if (!this.findActiveBinding(input.identity.bindingKey)) {
      const memberResolution = this.resolveTeamFromMemberIdentity(input.identity);
      if (memberResolution) {
        return memberResolution;
      }
    }

    return this.resolveActiveBinding(input.identity);
  }

  // D-Q6: resolve the team from the caller's TL-injected member id
  // (observedMetadata.codexTeamMemberId). Returns null to fall through to
  // no_active_team when there is no member id, the member is unknown, or its team
  // is missing. Enforces the SAME guards as active-binding resolution: the team's
  // workspace_root must match the caller's workspace (else cross_workspace_team),
  // and an archived team yields the existing archived error. Security: the member
  // id is TL-injected per-launch (T-13-01); the workspace guard blocks reaching
  // teams outside the injected container root.
  private resolveTeamFromMemberIdentity(
    identity: WorkspaceScopedCallerIdentity
  ): ResolveTeamResult | null {
    const memberId = identity.observedMetadata.codexTeamMemberId;
    if (!memberId) {
      return null;
    }

    const teamId = this.findTeamIdByMemberId(memberId);
    if (!teamId) {
      return null;
    }

    const team = this.findTeamById(teamId);
    if (!team) {
      return null;
    }

    if (team.workspaceRoot !== identity.workspaceRoot) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.crossWorkspaceTeam,
        identity,
        message: "Member identity points at a team in a different workspace.",
        context: {
          team_workspace_root: team.workspaceRoot,
          resolved_team_id: team.teamId
        },
        teamId: team.teamId
      });
    }

    if (team.status === TEAM_STATUSES.archived) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.archivedActiveTeam,
        identity,
        message: "Member identity points at an archived team.",
        context: { resolved_team_id: team.teamId },
        teamId: team.teamId
      });
    }

    this.appendExplicitAccessEvent(team, identity);

    return {
      ok: true,
      team: toResolvedTeamContext(team, "member_identity")
    };
  }

  private resolveExplicitTeam(
    rawTeamName: string,
    identity: WorkspaceScopedCallerIdentity
  ): ResolveTeamResult {
    const teamName = canonicalizeTeamName(rawTeamName);
    const team = this.findTeamByName(teamName, identity.workspaceRoot);

    if (!team) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.teamNotFound,
        identity,
        message: "Team was not found.",
        context: { team_name: teamName },
        teamId: null
      });
    }

    if (team.status === TEAM_STATUSES.archived) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.teamArchived,
        identity,
        message: "Team is archived.",
        context: { team_name: teamName },
        teamId: team.teamId
      });
    }

    this.appendExplicitAccessEvent(team, identity);

    return {
      ok: true,
      team: toResolvedTeamContext(team, "explicit")
    };
  }

  private resolveActiveBinding(identity: WorkspaceScopedCallerIdentity): ResolveTeamResult {
    const binding = this.findActiveBinding(identity.bindingKey);

    if (!binding) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.noActiveTeam,
        identity,
        message: "No active team is bound to this workspace and caller.",
        context: { binding_key: identity.bindingKey },
        teamId: null
      });
    }

    if (
      binding.workspaceRoot !== identity.workspaceRoot ||
      binding.callerKey !== identity.callerKey
    ) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.crossWorkspaceTeam,
        identity,
        message: "Active binding does not match this workspace and caller.",
        context: {
          binding_workspace_root: binding.workspaceRoot,
          binding_caller_key: binding.callerKey
        },
        teamId: binding.teamId
      });
    }

    const team = this.findTeamById(binding.teamId);
    if (!team) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.teamNotFound,
        identity,
        message: "Active binding points at a missing team.",
        context: { bound_team_id: binding.teamId },
        teamId: binding.teamId
      });
    }

    if (team.workspaceRoot !== identity.workspaceRoot) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.crossWorkspaceTeam,
        identity,
        message: "Active binding points at a team in a different workspace.",
        context: {
          team_workspace_root: team.workspaceRoot,
          bound_team_id: team.teamId
        },
        teamId: team.teamId
      });
    }

    if (team.status === TEAM_STATUSES.archived) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.archivedActiveTeam,
        identity,
        message: "Active team is archived.",
        context: { bound_team_id: team.teamId },
        teamId: team.teamId
      });
    }

    if (identity.fallbackUsed && this.countFallbackTeams(identity) > 1) {
      return this.resolverError({
        code: CONTEXT_RESOLVER_ERROR_CODES.ambiguousActiveTeam,
        identity,
        message: "Fallback caller identity has multiple non-archived teams.",
        context: { binding_key: identity.bindingKey },
        teamId: null
      });
    }

    return {
      ok: true,
      team: toResolvedTeamContext(team, "active_binding")
    };
  }

  private findTeamByName(
    teamName: string,
    workspaceRoot: string
  ): TeamRow | undefined {
    return this.db
      .prepare(
        `
          SELECT
            team_id AS teamId,
            canonical_name AS teamName,
            status,
            workspace_root AS workspaceRoot,
            lead_agent_id AS leadAgentId
          FROM ${TABLE_NAMES.teams}
          WHERE workspace_root = ?
            AND canonical_name = ?
          LIMIT 1
        `
      )
      .get(workspaceRoot, teamName) as TeamRow | undefined;
  }

  private findTeamById(teamId: string): TeamRow | undefined {
    return this.db
      .prepare(
        `
          SELECT
            team_id AS teamId,
            canonical_name AS teamName,
            status,
            workspace_root AS workspaceRoot,
            lead_agent_id AS leadAgentId
          FROM ${TABLE_NAMES.teams}
          WHERE team_id = ?
          LIMIT 1
        `
      )
      .get(teamId) as TeamRow | undefined;
  }

  private findTeamIdByMemberId(memberId: string): string | undefined {
    const row = this.db
      .prepare(
        `
          SELECT team_id AS teamId
          FROM ${TABLE_NAMES.members}
          WHERE member_id = ?
          LIMIT 1
        `
      )
      .get(memberId) as { teamId: string } | undefined;

    return row?.teamId;
  }

  private findActiveBinding(bindingKey: string): ActiveBindingRow | undefined {
    return this.db
      .prepare(
        `
          SELECT
            binding_key AS bindingKey,
            workspace_root AS workspaceRoot,
            caller_key AS callerKey,
            team_id AS teamId,
            fallback_used AS fallbackUsed
          FROM ${TABLE_NAMES.activeBindings}
          WHERE binding_key = ?
            AND status = ?
          LIMIT 1
        `
      )
      .get(bindingKey, ACTIVE_BINDING_STATUSES.active) as ActiveBindingRow | undefined;
  }

  private countFallbackTeams(identity: WorkspaceScopedCallerIdentity): number {
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM ${TABLE_NAMES.teams}
          WHERE workspace_root = ?
            AND created_by_caller_key = ?
            AND status != ?
        `
      )
      .get(
        identity.workspaceRoot,
        identity.callerKey,
        TEAM_STATUSES.archived
      ) as CountRow | undefined;

    return row?.count ?? 0;
  }

  private appendExplicitAccessEvent(
    team: TeamRow,
    identity: WorkspaceScopedCallerIdentity
  ): void {
    this.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.events} (
            event_id,
            team_id,
            workspace_root,
            actor_caller_key,
            event_type,
            payload_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        randomUUID(),
        team.teamId,
        identity.workspaceRoot,
        identity.callerKey,
        EVENT_TYPES.explicitTeamAccessed,
        JSON.stringify({
          team_name: team.teamName,
          fallback_used: identity.fallbackUsed
        }),
        new Date().toISOString()
      );
  }

  private resolverError(input: {
    code: ContextResolverErrorCode;
    identity: WorkspaceScopedCallerIdentity;
    message: string;
    context: Record<string, unknown>;
    teamId: string | null;
  }): ResolveTeamResult {
    this.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.events} (
            event_id,
            team_id,
            workspace_root,
            actor_caller_key,
            event_type,
            error_code,
            payload_json,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        randomUUID(),
        input.teamId,
        input.identity.workspaceRoot,
        input.identity.callerKey,
        EVENT_TYPES.resolverError,
        input.code,
        JSON.stringify({
          fallback_used: input.identity.fallbackUsed,
          context: input.context
        }),
        new Date().toISOString()
      );

    return {
      ok: false,
      errorCode: input.code,
      message: input.message
    };
  }
}

function toResolvedTeamContext(
  team: TeamRow,
  resolution: TeamContextResolution
): ResolvedTeamContext {
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    workspaceRoot: team.workspaceRoot,
    leadAgentId: team.leadAgentId,
    resolution
  };
}
