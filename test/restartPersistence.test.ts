import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { ContextResolver } from "../src/services/contextResolver.js";
import { MessageService } from "../src/services/messageService.js";
import { TeamService } from "../src/services/teamService.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import {
  ACTIVE_BINDING_STATUSES,
  MEMBER_STATUSES,
  TABLE_NAMES,
  TEAM_STATUSES
} from "../src/state/schema.js";

const tempRoots: string[] = [];

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-restart-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function insertTeam(db: Database.Database, identity: WorkspaceScopedCallerIdentity): void {
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
        metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "team-restart-id",
    "restartable",
    "restartable",
    "Restart persistence team",
    TEAM_STATUSES.active,
    identity.workspaceRoot,
    "team-lead@restartable",
    identity.callerKey,
    "2026-06-03T00:00:00.000Z",
    "{}"
  );
}

function insertActiveBinding(
  db: Database.Database,
  identity: WorkspaceScopedCallerIdentity
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
    "team-restart-id",
    ACTIVE_BINDING_STATUSES.active,
    0,
    JSON.stringify({ observedMetadata: identity.observedMetadata }),
    "2026-06-03T00:00:01.000Z",
    "2026-06-03T00:00:01.000Z"
  );
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("active binding restart persistence", () => {
  it("resolves an active binding through a fresh durable adapter instance", () => {
    const stateRoot = createTempStateRoot();
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace/project",
      caller: normalizeCallerMetadata({ sessionId: "restart-session" })
    });

    const firstAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identity.workspaceRoot
    });
    insertTeam(firstAdapter.getDatabase(), identity);
    insertActiveBinding(firstAdapter.getDatabase(), identity);
    firstAdapter.close();

    const restartedAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identity.workspaceRoot
    });

    const result = new ContextResolver(restartedAdapter.getDatabase()).resolveTeam({
      identity
    });

    expect(result).toMatchObject({
      ok: true,
      team: {
        teamId: "team-restart-id",
        teamName: "restartable",
        workspaceRoot: identity.workspaceRoot,
        resolution: "active_binding"
      }
    });

    restartedAdapter.close();
  });

  it("persists messages through a fresh durable adapter instance", () => {
    const stateRoot = createTempStateRoot();
    const identity = buildWorkspaceScopedCallerIdentity({
      workspaceRoot: "/workspace/project",
      caller: normalizeCallerMetadata({ sessionId: "phase-4-restart-session" })
    });

    const firstAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identity.workspaceRoot
    });
    const statePath = firstAdapter.describeStateRoot().stateRoot;
    const team = new TeamService({
      db: firstAdapter.getDatabase(),
      statePath
    }).createTeam({
      teamName: "Alpha Team",
      description: "Phase 4 restart persistence team",
      identity
    });
    const teammate = new AgentService({
      db: firstAdapter.getDatabase(),
      statePath
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: "Create restart persistence teammate",
      identity
    });

    if (teammate.status !== "scheduled") {
      throw new Error(`Expected scheduled TeamMate, got ${teammate.status}`);
    }

    firstAdapter
      .getDatabase()
      .prepare(`UPDATE ${TABLE_NAMES.members} SET status = ? WHERE member_id = ?`)
      .run(MEMBER_STATUSES.idle, teammate.debug.internal_member_id);

    const message = new MessageService({
      db: firstAdapter.getDatabase(),
      statePath
    }).sendMessage({
      teamName: "alpha-team",
      to: "Builder",
      message: "Persist this inbox row through restart",
      identity
    });
    firstAdapter.close();

    const restartedAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: identity.workspaceRoot
    });

    expect(message).toMatchObject({
      status: "backend_unavailable",
      persisted: true,
      message_id: expect.stringMatching(/^message:/)
    });
    expect(
      restartedAdapter
        .getDatabase()
        .prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAMES.messages}`)
        .get()
    ).toMatchObject({ count: 1 });
    expect(team.team_name).toBe("alpha-team");

    restartedAdapter.close();
  });
});
