import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import {
  ContextResolver,
  type ContextResolverErrorCode
} from "./contextResolver.js";
import { canonicalizeTeamName } from "./teamNames.js";
import {
  ACTIVE_BINDING_STATUSES,
  COMPONENT_NAMES,
  EVENT_TYPES,
  MEMBER_STATUSES,
  TABLE_NAMES,
  TEAM_STATUSES
} from "../state/schema.js";

export interface TeamServiceOptions {
  db: Database.Database;
  statePath: string;
}

export interface TeamCreateInput {
  teamName: string;
  description?: string;
  identity: WorkspaceScopedCallerIdentity;
  agentType?: string;
  modelHint?: string;
}

export interface TeamCreateResult {
  team_name: string;
  state_path: string;
  lead_agent_id: string;
  active_binding: {
    binding_key: string;
    workspace_root: string;
    caller_key: string;
    team_id: string;
    status: typeof ACTIVE_BINDING_STATUSES.active;
    fallback_used: boolean;
  };
  status: "created";
  debug?: Record<string, unknown>;
}

export interface TeamDeleteInput {
  teamName?: string;
  identity: WorkspaceScopedCallerIdentity;
  reason?: string;
}

export type TeamDeleteResult =
  | {
      status: "archived";
      team_name: string;
      invalidated_bindings: number;
    }
  | {
      status: "blocked";
      team_name: string;
      blocking_members: BlockingMember[];
    };

export class TeamArchiveResolutionError extends Error {
  constructor(
    readonly errorCode: ContextResolverErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TeamArchiveResolutionError";
  }
}

interface CreatedTeamRecord {
  teamId: string;
  canonicalName: string;
  requestedName: string;
  description: string | null;
  leadAgentId: string;
  leaderMemberId: string;
  createdAt: string;
  conflictResolved: boolean;
  baseCanonicalName: string;
}

interface ResolvedArchiveTeam {
  teamId: string;
  teamName: string;
  leadAgentId: string;
  leaderMemberId: string;
}

interface BlockingMember {
  member_id: string;
  display_name: string;
  status: string;
}

interface ActiveBindingForArchive {
  binding_key: string;
  workspace_root: string;
  caller_key: string;
}

interface ArchiveTeamRow {
  team_id: string;
  canonical_name: string;
  status: string;
  lead_agent_id: string;
}

export class TeamService {
  constructor(private readonly options: TeamServiceOptions) {}

  createTeam(input: TeamCreateInput): TeamCreateResult {
    const tx = this.options.db.transaction((transactionInput: TeamCreateInput) => {
      const team = this.insertUniqueTeam(transactionInput);
      this.insertLeaderMember(team, transactionInput);
      this.upsertActiveBinding(team, transactionInput);
      this.seedComponentInitializations(team, transactionInput.identity);
      this.appendCreateEvents(team, transactionInput);

      return {
        team_name: team.canonicalName,
        state_path: this.options.statePath,
        lead_agent_id: team.leadAgentId,
        active_binding: {
          binding_key: transactionInput.identity.bindingKey,
          workspace_root: transactionInput.identity.workspaceRoot,
          caller_key: transactionInput.identity.callerKey,
          team_id: team.teamId,
          status: ACTIVE_BINDING_STATUSES.active,
          fallback_used: transactionInput.identity.fallbackUsed
        },
        status: "created" as const
      };
    });

    return tx(input);
  }

  archiveTeam(input: TeamDeleteInput): TeamDeleteResult {
    const resolved = new ContextResolver(this.options.db).resolveTeam({
      teamName: input.teamName,
      identity: input.identity
    });

    if (!resolved.ok) {
      const archivedTeam = this.findArchivedTeamForIdempotentArchive(input);
      if (archivedTeam) {
        return {
          status: "archived",
          team_name: archivedTeam.canonical_name,
          invalidated_bindings: 0
        };
      }

      throw new TeamArchiveResolutionError(resolved.errorCode, resolved.message);
    }

    const tx = this.options.db.transaction((transactionInput: TeamDeleteInput) =>
      this.archiveResolvedTeam(
        {
          teamId: resolved.team.teamId,
          teamName: resolved.team.teamName,
          leadAgentId: resolved.team.leadAgentId,
          leaderMemberId: buildLeaderMemberId(resolved.team.teamId)
        },
        transactionInput
      )
    );

    return tx(input);
  }

  private insertUniqueTeam(input: TeamCreateInput): CreatedTeamRecord {
    const requestedName = input.teamName;
    const baseCanonicalName = canonicalizeTeamName(requestedName);
    const description = normalizeOptionalText(input.description);

    for (let suffix = 1; ; suffix += 1) {
      const canonicalName =
        suffix === 1 ? baseCanonicalName : `${baseCanonicalName}-${suffix}`;
      const teamId = randomUUID();
      const createdAt = new Date().toISOString();
      const leadAgentId = `team-lead@${canonicalName}`;
      const leaderMemberId = buildLeaderMemberId(teamId);

      try {
        this.options.db
          .prepare(
            `
              INSERT INTO ${TABLE_NAMES.teams} (
                team_id,
                canonical_name,
                requested_name,
                description,
                status,
                workspace_root,
                lead_agent_id,
                created_by_caller_key,
                created_at,
                metadata_json
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            teamId,
            canonicalName,
            requestedName,
            description,
            TEAM_STATUSES.active,
            input.identity.workspaceRoot,
            leadAgentId,
            input.identity.callerKey,
            createdAt,
            JSON.stringify(buildLifecycleMetadata(input))
          );

        return {
          teamId,
          canonicalName,
          requestedName,
          description,
          leadAgentId,
          leaderMemberId,
          createdAt,
          conflictResolved: suffix > 1,
          baseCanonicalName
        };
      } catch (error) {
        if (!isUniqueTeamNameError(error)) {
          throw error;
        }
      }
    }
  }

  private insertLeaderMember(team: CreatedTeamRecord, input: TeamCreateInput): void {
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
        team.leaderMemberId,
        team.teamId,
        "Team Lead",
        "leader",
        normalizeOptionalText(input.agentType),
        normalizeOptionalText(input.modelHint),
        MEMBER_STATUSES.active,
        input.identity.callerKey,
        input.identity.workspaceRoot,
        team.createdAt,
        JSON.stringify({
          ...buildLifecycleMetadata(input),
          publicLeadAgentId: team.leadAgentId
        })
      );
  }

  private upsertActiveBinding(team: CreatedTeamRecord, input: TeamCreateInput): void {
    this.options.db
      .prepare(
        `
          INSERT INTO ${TABLE_NAMES.activeBindings} (
            binding_key,
            workspace_root,
            caller_key,
            team_id,
            status,
            fallback_used,
            metadata_json,
            created_at,
            updated_at,
            invalidated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(binding_key) DO UPDATE SET
            workspace_root = excluded.workspace_root,
            caller_key = excluded.caller_key,
            team_id = excluded.team_id,
            status = excluded.status,
            fallback_used = excluded.fallback_used,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at,
            invalidated_at = NULL
        `
      )
      .run(
        input.identity.bindingKey,
        input.identity.workspaceRoot,
        input.identity.callerKey,
        team.teamId,
        ACTIVE_BINDING_STATUSES.active,
        input.identity.fallbackUsed ? 1 : 0,
        JSON.stringify({
          observedMetadata: input.identity.observedMetadata,
          fallbackUsed: input.identity.fallbackUsed
        }),
        team.createdAt,
        team.createdAt
      );
  }

  private seedComponentInitializations(
    team: CreatedTeamRecord,
    identity: WorkspaceScopedCallerIdentity
  ): void {
    const insertComponent = this.options.db.prepare(
      `
        INSERT INTO ${TABLE_NAMES.componentInitializations} (
          team_id,
          component,
          initialized_at,
          metadata_json
        )
        VALUES (?, ?, ?, ?)
      `
    );

    for (const component of Object.values(COMPONENT_NAMES)) {
      insertComponent.run(
        team.teamId,
        component,
        team.createdAt,
        JSON.stringify({
          initializedBy: identity.callerKey
        })
      );
    }
  }

  private appendCreateEvents(team: CreatedTeamRecord, input: TeamCreateInput): void {
    if (team.conflictResolved) {
      this.appendEvent({
        teamId: team.teamId,
        actorMemberId: team.leaderMemberId,
        identity: input.identity,
        eventType: EVENT_TYPES.teamNameConflictResolved,
        payload: {
          requested_name: team.requestedName,
          base_canonical_name: team.baseCanonicalName,
          resolved_team_name: team.canonicalName
        },
        createdAt: team.createdAt
      });
    }

    this.appendEvent({
      teamId: team.teamId,
      actorMemberId: team.leaderMemberId,
      identity: input.identity,
      eventType: EVENT_TYPES.teamCreated,
      payload: {
        requested_name: team.requestedName,
        team_name: team.canonicalName
      },
      createdAt: team.createdAt
    });
    this.appendEvent({
      teamId: team.teamId,
      actorMemberId: team.leaderMemberId,
      identity: input.identity,
      eventType: EVENT_TYPES.leaderRegistered,
      payload: {
        lead_agent_id: team.leadAgentId,
        role: "leader"
      },
      createdAt: team.createdAt
    });
    this.appendEvent({
      teamId: team.teamId,
      actorMemberId: team.leaderMemberId,
      identity: input.identity,
      eventType: EVENT_TYPES.activeBindingUpdated,
      payload: {
        binding_key: input.identity.bindingKey,
        fallback_used: input.identity.fallbackUsed
      },
      createdAt: team.createdAt
    });

    for (const component of Object.values(COMPONENT_NAMES)) {
      this.appendEvent({
        teamId: team.teamId,
        actorMemberId: team.leaderMemberId,
        identity: input.identity,
        eventType: EVENT_TYPES.componentInitialized,
        payload: { component },
        createdAt: team.createdAt
      });
    }
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

  private archiveResolvedTeam(
    team: ResolvedArchiveTeam,
    input: TeamDeleteInput
  ): TeamDeleteResult {
    const currentTeam = this.findTeamForArchive(team.teamId);
    if (!currentTeam) {
      throw new Error("Team was not found.");
    }

    if (currentTeam.status === TEAM_STATUSES.archived) {
      return {
        status: "archived",
        team_name: currentTeam.canonical_name,
        invalidated_bindings: 0
      };
    }

    const archivedAt = new Date().toISOString();
    this.appendEvent({
      teamId: team.teamId,
      actorMemberId: team.leaderMemberId,
      identity: input.identity,
      eventType: EVENT_TYPES.teamDeleteRequested,
      payload: {
        team_name: team.teamName,
        reason: normalizeOptionalText(input.reason)
      },
      createdAt: archivedAt
    });

    const blockers = this.findBlockingMembers(team.teamId);
    if (blockers.length > 0) {
      this.appendEvent({
        teamId: team.teamId,
        actorMemberId: team.leaderMemberId,
        identity: input.identity,
        eventType: EVENT_TYPES.teamDeleteBlocked,
        payload: {
          team_name: team.teamName,
          blocking_members: blockers
        },
        createdAt: archivedAt
      });

      return {
        status: "blocked",
        team_name: team.teamName,
        blocking_members: blockers
      };
    }

    const activeBindings = this.findActiveBindingsForTeam(team.teamId);

    this.options.db
      .prepare(
        `
          UPDATE ${TABLE_NAMES.teams}
          SET status = ?,
              archived_at = ?,
              archive_reason = ?
          WHERE team_id = ?
        `
      )
      .run(
        TEAM_STATUSES.archived,
        archivedAt,
        normalizeOptionalText(input.reason),
        team.teamId
      );

    this.options.db
      .prepare(
        `
          UPDATE ${TABLE_NAMES.activeBindings}
          SET status = ?,
              updated_at = ?,
              invalidated_at = ?
          WHERE team_id = ?
            AND status = ?
        `
      )
      .run(
        ACTIVE_BINDING_STATUSES.invalidated,
        archivedAt,
        archivedAt,
        team.teamId,
        ACTIVE_BINDING_STATUSES.active
      );

    this.appendEvent({
      teamId: team.teamId,
      actorMemberId: team.leaderMemberId,
      identity: input.identity,
      eventType: EVENT_TYPES.teamArchived,
      payload: {
        team_name: team.teamName,
        invalidated_bindings: activeBindings.length
      },
      createdAt: archivedAt
    });

    for (const binding of activeBindings) {
      this.appendEvent({
        teamId: team.teamId,
        actorMemberId: team.leaderMemberId,
        identity: input.identity,
        eventType: EVENT_TYPES.activeBindingInvalidated,
        payload: {
          binding_key: binding.binding_key,
          binding_workspace_root: binding.workspace_root,
          binding_caller_key: binding.caller_key
        },
        createdAt: archivedAt
      });
    }

    return {
      status: "archived",
      team_name: team.teamName,
      invalidated_bindings: activeBindings.length
    };
  }

  private findTeamForArchive(teamId: string): ArchiveTeamRow | undefined {
    return this.options.db
      .prepare(
        `
          SELECT team_id, canonical_name, status, lead_agent_id
          FROM ${TABLE_NAMES.teams}
          WHERE team_id = ?
          LIMIT 1
        `
      )
      .get(teamId) as ArchiveTeamRow | undefined;
  }

  private findArchivedTeamForIdempotentArchive(
    input: TeamDeleteInput
  ): ArchiveTeamRow | undefined {
    if (input.teamName === undefined) {
      return undefined;
    }

    return this.options.db
      .prepare(
        `
          SELECT team_id, canonical_name, status, lead_agent_id
          FROM ${TABLE_NAMES.teams}
          WHERE canonical_name = ?
            AND workspace_root = ?
            AND status = ?
          LIMIT 1
        `
      )
      .get(
        canonicalizeTeamName(input.teamName),
        input.identity.workspaceRoot,
        TEAM_STATUSES.archived
      ) as ArchiveTeamRow | undefined;
  }

  private findBlockingMembers(teamId: string): BlockingMember[] {
    return this.options.db
      .prepare(
        `
          SELECT
            member_id,
            display_name,
            status
          FROM ${TABLE_NAMES.members}
          WHERE team_id = ?
            AND role != ?
            AND status IN (?, ?)
          ORDER BY member_id
        `
      )
      .all(
        teamId,
        "leader",
        MEMBER_STATUSES.active,
        MEMBER_STATUSES.running
      ) as BlockingMember[];
  }

  private findActiveBindingsForTeam(teamId: string): ActiveBindingForArchive[] {
    return this.options.db
      .prepare(
        `
          SELECT binding_key, workspace_root, caller_key
          FROM ${TABLE_NAMES.activeBindings}
          WHERE team_id = ?
            AND status = ?
          ORDER BY binding_key
        `
      )
      .all(teamId, ACTIVE_BINDING_STATUSES.active) as ActiveBindingForArchive[];
  }
}

function buildLifecycleMetadata(input: TeamCreateInput): Record<string, unknown> {
  return {
    observedMetadata: input.identity.observedMetadata,
    fallbackUsed: input.identity.fallbackUsed,
    ...(normalizeOptionalText(input.agentType)
      ? { agentType: normalizeOptionalText(input.agentType) }
      : {}),
    ...(normalizeOptionalText(input.modelHint)
      ? { modelHint: normalizeOptionalText(input.modelHint) }
      : {})
  };
}

function normalizeOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function buildLeaderMemberId(teamId: string): string {
  return `leader:${teamId}`;
}

function isUniqueTeamNameError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed") &&
    error.message.includes("teams.workspace_root") &&
    error.message.includes("teams.canonical_name")
  );
}
