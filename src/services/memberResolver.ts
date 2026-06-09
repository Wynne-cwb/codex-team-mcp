import type Database from "better-sqlite3";

import type { WorkspaceScopedCallerIdentity } from "./callerIdentity.js";
import { buildPublicTeamMateId } from "./teamMemberNames.js";
import { MEMBER_STATUSES, TABLE_NAMES } from "../state/schema.js";

export type MemberReferencePurpose = "sender" | "recipient" | "owner";

export interface MemberResolverOptions {
  db: Database.Database;
  identity?: WorkspaceScopedCallerIdentity;
}

export interface ResolveMemberReferenceInput {
  teamId: string;
  teamName: string;
  reference?: string;
  purpose: MemberReferencePurpose;
  identity?: WorkspaceScopedCallerIdentity;
}

export interface ResolvedMember {
  member_id: string;
  display_name: string;
  role: string;
  status: string;
  public_id: string;
}

export type MemberResolutionResult =
  | {
      status: "resolved";
      member: ResolvedMember;
    }
  | {
      status: "missing" | "archived" | "ambiguous" | "cross_team";
      error_code?: string;
      members?: ResolvedMember[];
    };

interface MemberRow {
  member_id: string;
  display_name: string;
  role: string;
  status: string;
  publicTeammateId: string | null;
  publicLeadAgentId: string | null;
}

export class MemberResolver {
  constructor(private readonly options: MemberResolverOptions) {}

  resolveMemberReference(
    input: ResolveMemberReferenceInput
  ): MemberResolutionResult {
    const reference = normalizeOptionalReference(input.reference);

    if (reference === undefined && input.purpose === "sender") {
      return this.resolveDefaultSender(input);
    }

    if (reference === undefined) {
      return { status: "missing", error_code: "missing_member_reference" };
    }

    if (reference.includes("@")) {
      return this.resolvePublicMemberId(input, reference);
    }

    return this.resolveDisplayName(input, reference);
  }

  private resolveDefaultSender(
    input: ResolveMemberReferenceInput
  ): MemberResolutionResult {
    const identity = input.identity ?? this.options.identity;
    const observedMemberId = identity?.observedMetadata.codexTeamMemberId;
    if (observedMemberId) {
      const callerMember = this.findMemberById(input.teamId, observedMemberId);
      if (callerMember) {
        return this.resolveSingleRow(input.teamName, callerMember);
      }
    }

    const leaderMember = this.findMemberById(input.teamId, `leader:${input.teamId}`);
    if (!leaderMember) {
      return { status: "missing", error_code: "missing_leader_member" };
    }

    return this.resolveSingleRow(input.teamName, leaderMember);
  }

  private resolvePublicMemberId(
    input: ResolveMemberReferenceInput,
    reference: string
  ): MemberResolutionResult {
    const teamSuffix = reference.slice(reference.lastIndexOf("@") + 1);
    if (teamSuffix !== input.teamName) {
      return {
        status: "cross_team",
        error_code: "cross_team_member_reference"
      };
    }

    const rows = this.options.db
      .prepare(
        `
          SELECT
            member_id,
            display_name,
            role,
            status,
            json_extract(metadata_json, '$.publicTeammateId') AS publicTeammateId,
            json_extract(metadata_json, '$.publicLeadAgentId') AS publicLeadAgentId
          FROM ${TABLE_NAMES.members}
          WHERE team_id = ?
            AND (
              json_extract(metadata_json, '$.publicTeammateId') = ?
              OR json_extract(metadata_json, '$.publicLeadAgentId') = ?
            )
          ORDER BY member_id
        `
      )
      .all(input.teamId, reference, reference) as MemberRow[];

    return this.resolveRows(input.teamName, rows);
  }

  private resolveDisplayName(
    input: ResolveMemberReferenceInput,
    reference: string
  ): MemberResolutionResult {
    const rows = this.options.db
      .prepare(
        `
          SELECT
            member_id,
            display_name,
            role,
            status,
            json_extract(metadata_json, '$.publicTeammateId') AS publicTeammateId,
            json_extract(metadata_json, '$.publicLeadAgentId') AS publicLeadAgentId
          FROM ${TABLE_NAMES.members}
          WHERE team_id = ?
            AND lower(display_name) = lower(?)
          ORDER BY member_id
        `
      )
      .all(input.teamId, reference) as MemberRow[];

    return this.resolveRows(input.teamName, rows);
  }

  private findMemberById(teamId: string, memberId: string): MemberRow | undefined {
    return this.options.db
      .prepare(
        `
          SELECT
            member_id,
            display_name,
            role,
            status,
            json_extract(metadata_json, '$.publicTeammateId') AS publicTeammateId,
            json_extract(metadata_json, '$.publicLeadAgentId') AS publicLeadAgentId
          FROM ${TABLE_NAMES.members}
          WHERE team_id = ?
            AND member_id = ?
          LIMIT 1
        `
      )
      .get(teamId, memberId) as MemberRow | undefined;
  }

  private resolveRows(
    teamName: string,
    rows: MemberRow[]
  ): MemberResolutionResult {
    if (rows.length === 0) {
      return { status: "missing", error_code: "member_reference_not_found" };
    }

    const activeRows = rows.filter((row) => row.status !== MEMBER_STATUSES.archived);
    if (activeRows.length > 1) {
      return {
        status: "ambiguous",
        error_code: "ambiguous_member_reference",
        members: activeRows.map((row) => memberRowToResolvedMember(teamName, row))
      };
    }

    if (activeRows.length === 1) {
      return this.resolveSingleRow(teamName, activeRows[0]);
    }

    return {
      status: "archived",
      error_code: "archived_member_reference",
      members: rows.map((row) => memberRowToResolvedMember(teamName, row))
    };
  }

  private resolveSingleRow(
    teamName: string,
    row: MemberRow
  ): MemberResolutionResult {
    if (row.status === MEMBER_STATUSES.archived) {
      return {
        status: "archived",
        error_code: "archived_member_reference",
        members: [memberRowToResolvedMember(teamName, row)]
      };
    }

    return {
      status: "resolved",
      member: memberRowToResolvedMember(teamName, row)
    };
  }
}

function normalizeOptionalReference(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function memberRowToResolvedMember(
  teamName: string,
  row: MemberRow
): ResolvedMember {
  return {
    member_id: row.member_id,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    public_id: resolvePublicId(teamName, row)
  };
}

function resolvePublicId(teamName: string, row: MemberRow): string {
  if (row.publicTeammateId) {
    return row.publicTeammateId;
  }

  if (row.publicLeadAgentId) {
    return row.publicLeadAgentId;
  }

  if (row.member_id.startsWith("leader:")) {
    return `team-lead@${teamName}`;
  }

  const canonicalName = row.member_id.split(":").at(-1);
  return buildPublicTeamMateId(canonicalName ?? row.display_name, teamName);
}
