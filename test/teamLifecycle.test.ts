import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { ContextResolver } from "../src/services/contextResolver.js";
import { TeamService } from "../src/services/teamService.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  ACTIVE_BINDING_STATUSES,
  COMPONENT_NAMES,
  EVENT_TYPES,
  MEMBER_STATUSES,
  TEAM_STATUSES
} from "../src/state/schema.js";

const tempRoots: string[] = [];

interface TeamRow {
  team_id: string;
  canonical_name: string;
  requested_name: string;
  description: string | null;
  status: string;
  workspace_root: string;
  lead_agent_id: string;
  created_by_caller_key: string;
  created_at: string;
  metadata_json: string;
}

interface MemberRow {
  member_id: string;
  team_id: string;
  display_name: string;
  role: string;
  agent_type: string | null;
  model_hint: string | null;
  status: string;
  caller_key: string | null;
  workspace_root: string;
  metadata_json: string;
}

interface ActiveBindingRow {
  binding_key: string;
  workspace_root: string;
  caller_key: string;
  team_id: string;
  status: string;
  fallback_used: number;
  metadata_json: string;
}

interface EventRow {
  event_type: string;
  error_code: string | null;
  team_id: string | null;
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-lifecycle-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(
  workspaceRoot: string,
  metadata: unknown = { sessionId: "session-1", threadId: "thread-1" }
): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(metadata)
  });
}

function createService(adapter: DurableStateAdapter): TeamService {
  return new TeamService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  });
}

function readTeam(db: Database.Database, canonicalName: string): TeamRow {
  return db
    .prepare("SELECT * FROM teams WHERE canonical_name = ?")
    .get(canonicalName) as TeamRow;
}

function readMember(db: Database.Database, memberId: string): MemberRow {
  return db
    .prepare("SELECT * FROM members WHERE member_id = ?")
    .get(memberId) as MemberRow;
}

function readActiveBinding(
  db: Database.Database,
  bindingKey: string
): ActiveBindingRow {
  return db
    .prepare("SELECT * FROM active_bindings WHERE binding_key = ?")
    .get(bindingKey) as ActiveBindingRow;
}

function eventTypes(db: Database.Database): string[] {
  return db
    .prepare("SELECT event_type FROM events ORDER BY created_at, event_id")
    .all()
    .map((row) => (row as { event_type: string }).event_type);
}

function insertMember(
  db: Database.Database,
  input: {
    memberId: string;
    teamId: string;
    displayName: string;
    role: string;
    status: string;
    workspaceRoot: string;
  }
): void {
  db.prepare(
    `
      INSERT INTO members (
        member_id,
        team_id,
        display_name,
        role,
        status,
        workspace_root,
        joined_at,
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    input.memberId,
    input.teamId,
    input.displayName,
    input.role,
    input.status,
    input.workspaceRoot,
    "2026-06-03T00:00:10.000Z",
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
        binding_key,
        workspace_root,
        caller_key,
        team_id,
        status,
        fallback_used,
        metadata_json,
        created_at,
        updated_at
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
    JSON.stringify({
      observedMetadata: identity.observedMetadata,
      fallbackUsed: identity.fallbackUsed
    }),
    "2026-06-03T00:00:11.000Z",
    "2026-06-03T00:00:11.000Z"
  );
}

function events(db: Database.Database): EventRow[] {
  return db
    .prepare("SELECT event_type, error_code, team_id FROM events ORDER BY created_at")
    .all() as EventRow[];
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("TeamService.createTeam", () => {
  it("creates a durable team with canonical result shape and leader identity", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });

    const result = createService(adapter).createTeam({
      teamName: "Alpha Team",
      description: "Primary research team",
      identity,
      agentType: "planner",
      modelHint: "gpt-5"
    });

    expect(result).toMatchObject({
      team_name: "alpha-team",
      state_path: adapter.describeStateRoot().stateRoot,
      lead_agent_id: "team-lead@alpha-team",
      status: "created",
      active_binding: {
        binding_key: identity.bindingKey,
        workspace_root: identity.workspaceRoot,
        caller_key: identity.callerKey,
        status: ACTIVE_BINDING_STATUSES.active,
        fallback_used: false
      }
    });

    const db = adapter.getDatabase();
    const team = readTeam(db, "alpha-team");
    expect(team).toMatchObject({
      requested_name: "Alpha Team",
      canonical_name: "alpha-team",
      description: "Primary research team",
      status: TEAM_STATUSES.active,
      workspace_root: identity.workspaceRoot,
      lead_agent_id: "team-lead@alpha-team",
      created_by_caller_key: identity.callerKey
    });
    expect(team.created_at).not.toBe("");
    expect(JSON.parse(team.metadata_json)).toMatchObject({
      observedMetadata: { sessionId: "session-1", threadId: "thread-1" },
      fallbackUsed: false,
      agentType: "planner",
      modelHint: "gpt-5"
    });

    const leader = readMember(db, `leader:${team.team_id}`);
    expect(leader).toMatchObject({
      member_id: `leader:${team.team_id}`,
      team_id: team.team_id,
      role: "leader",
      agent_type: "planner",
      model_hint: "gpt-5",
      status: "active",
      caller_key: identity.callerKey,
      workspace_root: identity.workspaceRoot
    });
    expect(JSON.parse(leader.metadata_json)).toMatchObject({
      observedMetadata: { sessionId: "session-1", threadId: "thread-1" },
      fallbackUsed: false,
      publicLeadAgentId: "team-lead@alpha-team"
    });

    const binding = readActiveBinding(db, identity.bindingKey);
    expect(binding).toMatchObject({
      binding_key: identity.bindingKey,
      workspace_root: identity.workspaceRoot,
      caller_key: identity.callerKey,
      team_id: team.team_id,
      status: ACTIVE_BINDING_STATUSES.active,
      fallback_used: 0
    });
    expect(JSON.parse(binding.metadata_json)).toMatchObject({
      observedMetadata: { sessionId: "session-1", threadId: "thread-1" },
      fallbackUsed: false
    });

    expect(
      db
        .prepare(
          "SELECT component FROM component_initializations WHERE team_id = ? ORDER BY component"
        )
        .all(team.team_id)
        .map((row) => (row as { component: string }).component)
    ).toEqual(Object.values(COMPONENT_NAMES).sort());
    expect(eventTypes(db)).toEqual(
      expect.arrayContaining([
        EVENT_TYPES.teamCreated,
        EVENT_TYPES.leaderRegistered,
        EVENT_TYPES.activeBindingUpdated,
        EVENT_TYPES.componentInitialized
      ])
    );
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = ?")
        .get(EVENT_TYPES.componentInitialized)
    ).toMatchObject({ count: Object.values(COMPONENT_NAMES).length });
    expect(
      db
        .prepare(
          "SELECT DISTINCT actor_member_id AS actorMemberId FROM events WHERE team_id = ? ORDER BY actor_member_id"
        )
        .all(team.team_id)
    ).toEqual([{ actorMemberId: `leader:${team.team_id}` }]);

    adapter.close();
  });

  it("resolves requested name conflicts to unique canonical names", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    const service = createService(adapter);

    const first = service.createTeam({ teamName: "Alpha Team", identity });
    const second = service.createTeam({ teamName: "Alpha Team", identity });

    expect(first.team_name).toBe("alpha-team");
    expect(second.team_name).toBe("alpha-team-2");
    expect(
      adapter
        .getDatabase()
        .prepare("SELECT canonical_name FROM teams ORDER BY canonical_name")
        .all()
        .map((row) => (row as { canonical_name: string }).canonical_name)
    ).toEqual(["alpha-team", "alpha-team-2"]);
    expect(eventTypes(adapter.getDatabase())).toContain(
      EVENT_TYPES.teamNameConflictResolved
    );

    adapter.close();
  });

  it("persists teams and active bindings across adapter restarts", () => {
    const stateRoot = createTempStateRoot();
    const identity = createIdentity("/workspace/project", {
      sessionId: "restart-session"
    });
    const firstAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identity.workspaceRoot
    });

    createService(firstAdapter).createTeam({
      teamName: "Restart Team",
      identity
    });
    firstAdapter.close();

    const reopenedAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identity.workspaceRoot
    });
    const resolved = new ContextResolver(reopenedAdapter.getDatabase()).resolveTeam({
      identity
    });

    expect(resolved).toMatchObject({
      ok: true,
      team: {
        teamName: "restart-team",
        workspaceRoot: identity.workspaceRoot,
        leadAgentId: "team-lead@restart-team",
        resolution: "active_binding"
      }
    });
    expect(readActiveBinding(reopenedAdapter.getDatabase(), identity.bindingKey)).toMatchObject({
      status: ACTIVE_BINDING_STATUSES.active
    });

    reopenedAdapter.close();
  });
});

describe("TeamService.archiveTeam", () => {
  it("archives an explicit team, invalidates active bindings, and preserves audit events", () => {
    const identity = createIdentity("/workspace/project");
    const secondaryIdentity = createIdentity("/workspace/project", {
      sessionId: "session-2"
    });
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    const service = createService(adapter);
    service.createTeam({ teamName: "Archive Team", identity });
    const team = readTeam(adapter.getDatabase(), "archive-team");
    insertActiveBinding(adapter.getDatabase(), secondaryIdentity, team.team_id);

    const result = service.archiveTeam({
      teamName: "archive-team",
      identity,
      reason: "phase complete"
    });

    expect(result).toMatchObject({
      status: "archived",
      team_name: "archive-team",
      invalidated_bindings: 2
    });
    expect(readTeam(adapter.getDatabase(), "archive-team")).toMatchObject({
      status: TEAM_STATUSES.archived,
      archive_reason: "phase complete"
    });
    expect(
      adapter
        .getDatabase()
        .prepare("SELECT COUNT(*) AS count FROM active_bindings WHERE status = ?")
        .get(ACTIVE_BINDING_STATUSES.active)
    ).toMatchObject({ count: 0 });
    expect(eventTypes(adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        EVENT_TYPES.teamDeleteRequested,
        EVENT_TYPES.teamArchived,
        EVENT_TYPES.activeBindingInvalidated
      ])
    );
    expect(
      events(adapter.getDatabase()).filter(
        (event) => event.event_type === EVENT_TYPES.activeBindingInvalidated
      )
    ).toHaveLength(2);

    adapter.close();
  });

  it("archives an explicit team when the user provides the original requested name", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    const service = createService(adapter);
    service.createTeam({ teamName: "Alpha Team", identity });

    const result = service.archiveTeam({
      teamName: "Alpha Team",
      identity,
      reason: "original requested name"
    });

    expect(result).toMatchObject({
      status: "archived",
      team_name: "alpha-team",
      invalidated_bindings: 1
    });
    expect(readTeam(adapter.getDatabase(), "alpha-team")).toMatchObject({
      status: TEAM_STATUSES.archived,
      archive_reason: "original requested name"
    });

    adapter.close();
  });

  it("archives the caller active team when teamName is omitted", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    const service = createService(adapter);
    service.createTeam({ teamName: "Implicit Team", identity });

    const result = service.archiveTeam({
      identity,
      reason: "done"
    });

    expect(result).toMatchObject({
      status: "archived",
      team_name: "implicit-team",
      invalidated_bindings: 1
    });
    expect(readTeam(adapter.getDatabase(), "implicit-team").status).toBe(
      TEAM_STATUSES.archived
    );

    adapter.close();
  });

  it("blocks archive while active or running non-leader members exist", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    const service = createService(adapter);
    service.createTeam({ teamName: "Blocked Team", identity });
    const team = readTeam(adapter.getDatabase(), "blocked-team");
    insertMember(adapter.getDatabase(), {
      memberId: "builder@blocked-team",
      teamId: team.team_id,
      displayName: "Builder",
      role: "teammate",
      status: MEMBER_STATUSES.active,
      workspaceRoot: identity.workspaceRoot
    });
    insertMember(adapter.getDatabase(), {
      memberId: "runner@blocked-team",
      teamId: team.team_id,
      displayName: "Runner",
      role: "teammate",
      status: MEMBER_STATUSES.running,
      workspaceRoot: identity.workspaceRoot
    });

    const result = service.archiveTeam({
      teamName: "blocked-team",
      identity,
      reason: "cleanup"
    });

    expect(result).toMatchObject({
      status: "blocked",
      team_name: "blocked-team",
      blocking_members: [
        {
          member_id: "builder@blocked-team",
          status: MEMBER_STATUSES.active
        },
        {
          member_id: "runner@blocked-team",
          status: MEMBER_STATUSES.running
        }
      ]
    });
    expect(readTeam(adapter.getDatabase(), "blocked-team").status).toBe(
      TEAM_STATUSES.active
    );
    expect(readActiveBinding(adapter.getDatabase(), identity.bindingKey).status).toBe(
      ACTIVE_BINDING_STATUSES.active
    );
    expect(eventTypes(adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        EVENT_TYPES.teamDeleteRequested,
        EVENT_TYPES.teamDeleteBlocked
      ])
    );
    expect(eventTypes(adapter.getDatabase())).not.toContain(EVENT_TYPES.teamArchived);

    adapter.close();
  });

  it("leaves archived teams rejected by the context resolver", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    const service = createService(adapter);
    service.createTeam({ teamName: "Resolver Team", identity });

    service.archiveTeam({
      teamName: "resolver-team",
      identity,
      reason: "done"
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({
      teamName: "resolver-team",
      identity
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "team_archived"
    });
    expect(events(adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: EVENT_TYPES.resolverError,
          error_code: "team_archived"
        })
      ])
    );

    adapter.close();
  });
});
