import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { FALLBACK_CALLER_KEY, normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import {
  CONTEXT_RESOLVER_ERROR_CODES,
  ContextResolver
} from "../src/services/contextResolver.js";
import { TeamService } from "../src/services/teamService.js";
import { canonicalizeTeamName } from "../src/services/teamNames.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { ACTIVE_BINDING_STATUSES, EVENT_TYPES, TEAM_STATUSES } from "../src/state/schema.js";

const tempRoots: string[] = [];

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-context-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(
  workspaceRoot: string,
  metadata: unknown = { sessionId: "session-1" }
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
        team_id,
        canonical_name,
        requested_name,
        description,
        status,
        workspace_root,
        lead_agent_id,
        created_by_caller_key,
        created_at,
        archived_at,
        metadata_json
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
    "2026-06-03T00:00:00.000Z",
    input.status === TEAM_STATUSES.archived ? "2026-06-03T00:00:01.000Z" : null,
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
    JSON.stringify({ observedMetadata: identity.observedMetadata }),
    "2026-06-03T00:00:02.000Z",
    "2026-06-03T00:00:02.000Z"
  );
}

function resolverErrorEvents(db: Database.Database): Array<{
  event_type: string;
  error_code: string | null;
  team_id: string | null;
  actor_caller_key: string;
  workspace_root: string;
}> {
  return db
    .prepare(
      `
        SELECT event_type, error_code, team_id, actor_caller_key, workspace_root
        FROM events
        WHERE event_type = ?
        ORDER BY created_at, event_id
      `
    )
    .all(EVENT_TYPES.resolverError) as Array<{
    event_type: string;
    error_code: string | null;
    team_id: string | null;
    actor_caller_key: string;
    workspace_root: string;
  }>;
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("workspace-scoped caller identity", () => {
  it("builds a stable binding key for the same normalized workspace and caller", () => {
    const caller = normalizeCallerMetadata({ sessionId: "session-1" });
    const workspaceRoot = path.join("/workspace", "project");

    const first = buildWorkspaceScopedCallerIdentity({
      workspaceRoot,
      caller
    });
    const second = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: path.join(workspaceRoot, "..", "project"),
      caller
    });

    expect(first.workspaceRoot).toBe(path.resolve(workspaceRoot));
    expect(second.workspaceRoot).toBe(path.resolve(workspaceRoot));
    expect(first.bindingKey).toBe(second.bindingKey);
    expect(first.bindingKey).toMatch(/^workspace:[a-f0-9]{64}\|caller:/);
    expect(first.callerKey).toBe("codex-team:sessionId:session-1");
    expect(first.fallbackUsed).toBe(false);
    expect(first.observedMetadata).toEqual({ sessionId: "session-1" });
  });

  it("changes the binding key when the workspace changes", () => {
    const caller = normalizeCallerMetadata({ sessionId: "session-1" });

    const first = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace/alpha",
      caller
    });
    const second = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace/beta",
      caller
    });

    expect(first.bindingKey).not.toBe(second.bindingKey);
  });

  it("changes the binding key when the caller changes", () => {
    const first = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace/project",
      caller: normalizeCallerMetadata({ sessionId: "session-1" })
    });
    const second = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace/project",
      caller: normalizeCallerMetadata({ sessionId: "session-2" })
    });

    expect(first.bindingKey).not.toBe(second.bindingKey);
  });

  it("preserves fallback caller markers in the workspace-scoped identity", () => {
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace/project",
      caller: normalizeCallerMetadata()
    });

    expect(identity.callerKey).toBe(FALLBACK_CALLER_KEY);
    expect(identity.fallbackUsed).toBe(true);
    expect(identity.observedMetadata).toEqual({});
  });

  it("uses fallback caller identity for request-only and client-only metadata", () => {
    const requestOnly = normalizeCallerMetadata({ requestId: "req-1" });
    const clientOnly = normalizeCallerMetadata({ clientName: "codex" });
    const requestAndClient = normalizeCallerMetadata({
      requestId: "req-1",
      clientName: "codex"
    });

    expect(requestOnly).toEqual({
      callerKey: FALLBACK_CALLER_KEY,
      observedMetadata: { requestId: "req-1" },
      fallbackUsed: true
    });
    expect(requestOnly.callerKey).not.toBe("codex-team:requestId:req-1");

    expect(clientOnly).toEqual({
      callerKey: FALLBACK_CALLER_KEY,
      observedMetadata: { clientName: "codex" },
      fallbackUsed: true
    });
    expect(clientOnly.callerKey).not.toBe("codex-team:clientName:codex");

    expect(requestAndClient).toEqual({
      callerKey: FALLBACK_CALLER_KEY,
      observedMetadata: { requestId: "req-1", clientName: "codex" },
      fallbackUsed: true
    });
  });

  it("uses stable session and thread metadata for durable caller identity", () => {
    const sessionCaller = normalizeCallerMetadata({
      sessionId: "session-1",
      requestId: "req-1",
      clientName: "codex"
    });
    const threadCaller = normalizeCallerMetadata({
      threadId: "thread-1",
      clientName: "codex"
    });

    expect(sessionCaller).toEqual({
      callerKey: "codex-team:sessionId:session-1",
      observedMetadata: {
        sessionId: "session-1",
        requestId: "req-1",
        clientName: "codex"
      },
      fallbackUsed: false
    });
    expect(threadCaller).toEqual({
      callerKey: "codex-team:threadId:thread-1",
      observedMetadata: { threadId: "thread-1", clientName: "codex" },
      fallbackUsed: false
    });
  });
});

describe("ContextResolver", () => {
  it("uses TeamCreate canonicalization for explicit requested names", () => {
    expect(canonicalizeTeamName("Alpha Team")).toBe("alpha-team");

    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });

    new TeamService({
      db: adapter.getDatabase(),
      statePath: adapter.describeStateRoot().stateRoot
    }).createTeam({
      teamName: "Alpha Team",
      identity
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({
      teamName: "Alpha Team",
      identity
    });

    expect(result).toMatchObject({
      ok: true,
      team: {
        teamName: "alpha-team",
        workspaceRoot: identity.workspaceRoot,
        resolution: "explicit"
      }
    });

    adapter.close();
  });

  it("audits explicit access to a non-archived team in the same workspace", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-alpha-id",
      canonicalName: "alpha",
      workspaceRoot: identity.workspaceRoot,
      createdByCallerKey: identity.callerKey
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({
      teamName: "alpha",
      identity
    });

    expect(result).toMatchObject({
      ok: true,
      team: {
        teamId: "team-alpha-id",
        teamName: "alpha",
        workspaceRoot: identity.workspaceRoot,
        resolution: "explicit"
      }
    });
    expect(
      adapter
        .getDatabase()
        .prepare("SELECT event_type, team_id, actor_caller_key FROM events")
        .all()
    ).toEqual([
      {
        event_type: EVENT_TYPES.explicitTeamAccessed,
        team_id: "team-alpha-id",
        actor_caller_key: identity.callerKey
      }
    ]);

    adapter.close();
  });

  it("infers the active team through the workspace-scoped binding key", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-active-id",
      canonicalName: "active",
      workspaceRoot: identity.workspaceRoot,
      createdByCallerKey: identity.callerKey
    });
    insertActiveBinding(adapter.getDatabase(), identity, "team-active-id");

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: true,
      team: {
        teamId: "team-active-id",
        teamName: "active",
        workspaceRoot: identity.workspaceRoot,
        resolution: "active_binding"
      }
    });

    adapter.close();
  });

  it("records no_active_team when omitted resolution has no binding", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.noActiveTeam
    });
    expect(resolverErrorEvents(adapter.getDatabase())).toEqual([
      expect.objectContaining({
        error_code: CONTEXT_RESOLVER_ERROR_CODES.noActiveTeam,
        team_id: null,
        actor_caller_key: identity.callerKey,
        workspace_root: identity.workspaceRoot
      })
    ]);

    adapter.close();
  });

  it("rejects explicit archived teams and records team_archived", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-archived-id",
      canonicalName: "archived",
      workspaceRoot: identity.workspaceRoot,
      createdByCallerKey: identity.callerKey,
      status: TEAM_STATUSES.archived
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({
      teamName: "archived",
      identity
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.teamArchived
    });
    expect(resolverErrorEvents(adapter.getDatabase())).toEqual([
      expect.objectContaining({
        error_code: CONTEXT_RESOLVER_ERROR_CODES.teamArchived,
        team_id: "team-archived-id"
      })
    ]);

    adapter.close();
  });

  it("rejects active bindings that point at archived teams", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-bound-archived-id",
      canonicalName: "bound-archived",
      workspaceRoot: identity.workspaceRoot,
      createdByCallerKey: identity.callerKey,
      status: TEAM_STATUSES.archived
    });
    insertActiveBinding(adapter.getDatabase(), identity, "team-bound-archived-id");

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.archivedActiveTeam
    });
    expect(resolverErrorEvents(adapter.getDatabase())).toEqual([
      expect.objectContaining({
        error_code: CONTEXT_RESOLVER_ERROR_CODES.archivedActiveTeam,
        team_id: "team-bound-archived-id"
      })
    ]);

    adapter.close();
  });

  it("does not resolve explicit teams from a different workspace", () => {
    const identity = createIdentity("/workspace/current");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-other-workspace-id",
      canonicalName: "shared-name",
      workspaceRoot: path.resolve("/workspace/other"),
      createdByCallerKey: identity.callerKey
    });

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({
      teamName: "shared-name",
      identity
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.teamNotFound
    });
    expect(resolverErrorEvents(adapter.getDatabase())).toEqual([
      expect.objectContaining({
        error_code: CONTEXT_RESOLVER_ERROR_CODES.teamNotFound,
        team_id: null
      })
    ]);

    adapter.close();
  });

  it("resolves same canonical names to the current workspace under a shared state root", () => {
    const stateRoot = createTempStateRoot();
    const identityA = createIdentity("/workspace/alpha", { sessionId: "alpha" });
    const identityB = createIdentity("/workspace/beta", { sessionId: "beta" });
    const adapterA = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identityA.workspaceRoot
    });
    const adapterB = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identityB.workspaceRoot
    });

    const teamA = new TeamService({
      db: adapterA.getDatabase(),
      statePath: adapterA.describeStateRoot().stateRoot
    }).createTeam({
      teamName: "Alpha Team",
      identity: identityA
    });
    const teamB = new TeamService({
      db: adapterB.getDatabase(),
      statePath: adapterB.describeStateRoot().stateRoot
    }).createTeam({
      teamName: "Alpha Team",
      identity: identityB
    });

    expect(teamA.team_name).toBe("alpha-team");
    expect(teamB.team_name).toBe("alpha-team");
    expect(teamA.active_binding.team_id).not.toBe(teamB.active_binding.team_id);

    const resolvedA = new ContextResolver(adapterA.getDatabase()).resolveTeam({
      teamName: "Alpha Team",
      identity: identityA
    });
    const resolvedB = new ContextResolver(adapterB.getDatabase()).resolveTeam({
      teamName: "Alpha Team",
      identity: identityB
    });

    expect(resolvedA).toMatchObject({
      ok: true,
      team: {
        teamId: teamA.active_binding.team_id,
        teamName: "alpha-team",
        workspaceRoot: identityA.workspaceRoot
      }
    });
    expect(resolvedB).toMatchObject({
      ok: true,
      team: {
        teamId: teamB.active_binding.team_id,
        teamName: "alpha-team",
        workspaceRoot: identityB.workspaceRoot
      }
    });

    adapterA.close();
    adapterB.close();
  });

  it("rejects ambiguous omitted fallback resolution", () => {
    const identity = createIdentity("/workspace/project", null);
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-fallback-one-id",
      canonicalName: "fallback-one",
      workspaceRoot: identity.workspaceRoot,
      createdByCallerKey: FALLBACK_CALLER_KEY
    });
    insertTeam(adapter.getDatabase(), {
      teamId: "team-fallback-two-id",
      canonicalName: "fallback-two",
      workspaceRoot: identity.workspaceRoot,
      createdByCallerKey: FALLBACK_CALLER_KEY
    });
    insertActiveBinding(adapter.getDatabase(), identity, "team-fallback-one-id");

    const result = new ContextResolver(adapter.getDatabase()).resolveTeam({ identity });

    expect(result).toMatchObject({
      ok: false,
      errorCode: CONTEXT_RESOLVER_ERROR_CODES.ambiguousActiveTeam
    });
    expect(resolverErrorEvents(adapter.getDatabase())).toEqual([
      expect.objectContaining({
        error_code: CONTEXT_RESOLVER_ERROR_CODES.ambiguousActiveTeam,
        team_id: null
      })
    ]);

    adapter.close();
  });
});
