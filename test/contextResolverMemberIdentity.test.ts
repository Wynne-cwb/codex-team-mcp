import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import {
  CONTEXT_RESOLVER_ERROR_CODES,
  ContextResolver
} from "../src/services/contextResolver.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  ACTIVE_BINDING_STATUSES,
  MEMBER_STATUSES,
  TEAM_STATUSES
} from "../src/state/schema.js";

const tempRoots: string[] = [];

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-member-identity-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(
  workspaceRoot: string,
  metadata: unknown
): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(metadata)
  });
}

function insertTeam(
  db: Database.Database,
  input: {
    teamId: string;
    canonicalName: string;
    workspaceRoot: string;
    createdByCallerKey: string;
    status?: string;
  }
): void {
  db.prepare(
    `
      INSERT INTO teams (
        team_id, canonical_name, requested_name, description, status,
        workspace_root, lead_agent_id, created_by_caller_key, created_at,
        archived_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    input.teamId,
    input.canonicalName,
    input.canonicalName,
    "Test team",
    input.status ?? TEAM_STATUSES.active,
    input.workspaceRoot,
    `team-lead@${input.canonicalName}`,
    input.createdByCallerKey,
    "2026-06-11T00:00:00.000Z",
    input.status === TEAM_STATUSES.archived ? "2026-06-11T00:00:01.000Z" : null,
    "{}"
  );
}

function insertMember(
  db: Database.Database,
  input: {
    memberId: string;
    teamId: string;
    workspaceRoot: string;
    role?: string;
    status?: string;
  }
): void {
  db.prepare(
    `
      INSERT INTO members (
        member_id, team_id, display_name, role, status, workspace_root,
        joined_at, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    input.memberId,
    input.teamId,
    "Builder",
    input.role ?? "teammate",
    input.status ?? MEMBER_STATUSES.active,
    input.workspaceRoot,
    "2026-06-11T00:00:00.000Z",
    "{}"
  );
}

function insertActiveBinding(
  db: Database.Database,
  identity: WorkspaceScopedCallerIdentity,
  teamId: string
): void {
  db.prepare(
    `
      INSERT INTO active_bindings (
        binding_key, workspace_root, caller_key, team_id, status,
        fallback_used, metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    identity.bindingKey,
    identity.workspaceRoot,
    identity.callerKey,
    teamId,
    ACTIVE_BINDING_STATUSES.active,
    identity.fallbackUsed ? 1 : 0,
    "{}",
    "2026-06-11T00:00:02.000Z",
    "2026-06-11T00:00:02.000Z"
  );
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("ContextResolver member-identity team resolution (D-Q6 / Phase 13)", () => {
  it("resolves the team from the caller's member id when there is no active binding", () => {
    const workspaceRoot = path.resolve("/workspace/project");
    const memberId = "teammate:team-alpha:builder";
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-alpha",
      canonicalName: "alpha-team",
      workspaceRoot,
      createdByCallerKey: "codex-team:sessionId:lead-session"
    });
    insertMember(adapter.getDatabase(), {
      memberId,
      teamId: "team-alpha",
      workspaceRoot
    });

    // Distinct session => NO active binding for this caller.
    const identity = createIdentity(workspaceRoot, {
      sessionId: "teammate-session",
      codexTeamMemberId: memberId,
      codexTeamMemberRole: "teammate"
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: true,
      team: {
        teamId: "team-alpha",
        teamName: "alpha-team",
        workspaceRoot,
        resolution: "member_identity"
      }
    });

    adapter.close();
  });

  it("rejects a member whose team is in a DIFFERENT workspace with cross_workspace_team", () => {
    const currentWorkspace = path.resolve("/workspace/current");
    const otherWorkspace = path.resolve("/workspace/other");
    const memberId = "teammate:team-other:builder";
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: currentWorkspace
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-other",
      canonicalName: "other-team",
      workspaceRoot: otherWorkspace,
      createdByCallerKey: "codex-team:sessionId:lead-session"
    });
    insertMember(adapter.getDatabase(), {
      memberId,
      teamId: "team-other",
      workspaceRoot: otherWorkspace
    });

    const identity = createIdentity(currentWorkspace, {
      sessionId: "teammate-session",
      codexTeamMemberId: memberId,
      codexTeamMemberRole: "teammate"
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.crossWorkspaceTeam
    });

    adapter.close();
  });

  it("falls through to no_active_team when no member id and no binding (unchanged)", () => {
    const workspaceRoot = path.resolve("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot
    });

    const identity = createIdentity(workspaceRoot, { sessionId: "lonely-session" });
    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.noActiveTeam
    });

    adapter.close();
  });

  it("falls through to no_active_team when the member id does not resolve to a team", () => {
    const workspaceRoot = path.resolve("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot
    });

    const identity = createIdentity(workspaceRoot, {
      sessionId: "teammate-session",
      codexTeamMemberId: "teammate:ghost:nobody",
      codexTeamMemberRole: "teammate"
    });
    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.noActiveTeam
    });

    adapter.close();
  });

  it("lets an active binding WIN over the member identity when both are present", () => {
    const workspaceRoot = path.resolve("/workspace/project");
    const boundMemberId = "teammate:team-bound:builder";
    const otherMemberId = "teammate:team-elsewhere:builder";
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-bound",
      canonicalName: "bound-team",
      workspaceRoot,
      createdByCallerKey: "codex-team:sessionId:lead-session"
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-elsewhere",
      canonicalName: "elsewhere-team",
      workspaceRoot,
      createdByCallerKey: "codex-team:sessionId:lead-session"
    });
    insertMember(adapter.getDatabase(), {
      memberId: otherMemberId,
      teamId: "team-elsewhere",
      workspaceRoot
    });

    const identity = createIdentity(workspaceRoot, {
      sessionId: "bound-session",
      codexTeamMemberId: otherMemberId,
      codexTeamMemberRole: "teammate"
    });
    insertActiveBinding(adapter.getDatabase(), identity, "team-bound");

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: true,
      team: {
        teamId: "team-bound",
        teamName: "bound-team",
        resolution: "active_binding"
      }
    });

    adapter.close();
  });

  it("rejects a member whose team is archived with an archived error", () => {
    const workspaceRoot = path.resolve("/workspace/project");
    const memberId = "teammate:team-archived:builder";
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-archived",
      canonicalName: "archived-team",
      workspaceRoot,
      createdByCallerKey: "codex-team:sessionId:lead-session",
      status: TEAM_STATUSES.archived
    });
    insertMember(adapter.getDatabase(), {
      memberId,
      teamId: "team-archived",
      workspaceRoot
    });

    const identity = createIdentity(workspaceRoot, {
      sessionId: "teammate-session",
      codexTeamMemberId: memberId,
      codexTeamMemberRole: "teammate"
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.archivedActiveTeam
    });

    adapter.close();
  });
});
