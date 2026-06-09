import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { normalizeCallerMetadata } from "../src/context/caller.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { ACTIVE_BINDING_STATUSES, EVENT_TYPES } from "../src/state/schema.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";

const tempRoots: string[] = [];

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-concurrency-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

function insertActiveBinding(
  adapter: DurableStateAdapter,
  identity: WorkspaceScopedCallerIdentity,
  teamId: string
): void {
  adapter
    .getDatabase()
    .prepare(
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
    )
    .run(
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
      "2026-06-03T00:00:01.000Z",
      "2026-06-03T00:00:01.000Z"
    );
}

describe("TeamService concurrency", () => {
  it("parallel creates for the same requested name produce unique canonical names", async () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = path.resolve("/workspace/project");
    const adapters = Array.from(
      { length: 6 },
      () => new DurableStateAdapter({ stateRoot, workspaceRoot })
    );

    try {
      const results = await Promise.all(
        adapters.map((adapter, index) =>
          Promise.resolve().then(() => {
            const identity = buildWorkspaceScopedCallerIdentity({
              workspaceRoot,
              caller: normalizeCallerMetadata({ sessionId: `session-${index}` })
            });

            return new TeamService({
              db: adapter.getDatabase(),
              statePath: adapter.describeStateRoot().stateRoot
            }).createTeam({
              teamName: "Alpha Team",
              identity
            });
          })
        )
      );

      const teamNames = results.map((result) => result.team_name);
      expect(new Set(teamNames).size).toBe(results.length);
      expect(teamNames).toContain("alpha-team");

      const verifier = new DurableStateAdapter({ stateRoot, workspaceRoot });
      const rows = verifier
        .getDatabase()
        .prepare("SELECT canonical_name FROM teams ORDER BY canonical_name")
        .all()
        .map((row) => (row as { canonical_name: string }).canonical_name);

      expect(new Set(rows).size).toBe(rows.length);
      expect(rows).toHaveLength(results.length);
      verifier.close();
    } finally {
      for (const adapter of adapters) {
        adapter.close();
      }
    }
  });

  it("allows different workspaces sharing one state root to use the same canonical name", () => {
    const stateRoot = createTempStateRoot();
    const workspaceA = path.resolve("/workspace/alpha");
    const workspaceB = path.resolve("/workspace/beta");
    const adapterA = new DurableStateAdapter({ stateRoot, workspaceRoot: workspaceA });
    const adapterB = new DurableStateAdapter({ stateRoot, workspaceRoot: workspaceB });

    try {
      const identityA = buildWorkspaceScopedCallerIdentity({
        workspaceRoot: workspaceA,
        caller: normalizeCallerMetadata({ sessionId: "workspace-a" })
      });
      const identityB = buildWorkspaceScopedCallerIdentity({
        workspaceRoot: workspaceB,
        caller: normalizeCallerMetadata({ sessionId: "workspace-b" })
      });

      const first = new TeamService({
        db: adapterA.getDatabase(),
        statePath: adapterA.describeStateRoot().stateRoot
      }).createTeam({
        teamName: "Alpha Team",
        identity: identityA
      });
      const second = new TeamService({
        db: adapterB.getDatabase(),
        statePath: adapterB.describeStateRoot().stateRoot
      }).createTeam({
        teamName: "Alpha Team",
        identity: identityB
      });

      expect(first.team_name).toBe("alpha-team");
      expect(second.team_name).toBe("alpha-team");
      expect(first.lead_agent_id).toBe("team-lead@alpha-team");
      expect(second.lead_agent_id).toBe("team-lead@alpha-team");
      expect(first.active_binding.team_id).not.toBe(second.active_binding.team_id);

      const rows = adapterA
        .getDatabase()
        .prepare(
          "SELECT workspace_root, canonical_name FROM teams ORDER BY workspace_root"
        )
        .all();
      expect(rows).toEqual([
        { workspace_root: workspaceA, canonical_name: "alpha-team" },
        { workspace_root: workspaceB, canonical_name: "alpha-team" }
      ]);
      const leaderRows = adapterA
        .getDatabase()
        .prepare(
          `
            SELECT member_id, team_id, metadata_json
            FROM members
            WHERE role = 'leader'
            ORDER BY workspace_root
          `
        )
        .all() as Array<{
        member_id: string;
        team_id: string;
        metadata_json: string;
      }>;

      expect(leaderRows).toHaveLength(2);
      expect(leaderRows.map((row) => row.member_id)).toEqual([
        `leader:${first.active_binding.team_id}`,
        `leader:${second.active_binding.team_id}`
      ]);
      expect(new Set(leaderRows.map((row) => row.member_id)).size).toBe(2);
      expect(
        leaderRows.map((row) => JSON.parse(row.metadata_json).publicLeadAgentId)
      ).toEqual(["team-lead@alpha-team", "team-lead@alpha-team"]);
    } finally {
      adapterA.close();
      adapterB.close();
    }
  });

  it("parallel archive attempts do not duplicate archive transitions or lose binding invalidation", async () => {
    const stateRoot = createTempStateRoot();
    const workspaceRoot = path.resolve("/workspace/project");
    const identities = Array.from({ length: 4 }, (_, index) =>
      buildWorkspaceScopedCallerIdentity({
        workspaceRoot,
        caller: normalizeCallerMetadata({ sessionId: `archive-${index}` })
      })
    );
    const setupAdapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    const created = new TeamService({
      db: setupAdapter.getDatabase(),
      statePath: setupAdapter.describeStateRoot().stateRoot
    }).createTeam({
      teamName: "Race Team",
      identity: identities[0]
    });
    const teamId = created.active_binding.team_id;
    for (const identity of identities.slice(1)) {
      insertActiveBinding(setupAdapter, identity, teamId);
    }
    setupAdapter.close();

    const adapters = identities.map(
      () => new DurableStateAdapter({ stateRoot, workspaceRoot })
    );

    try {
      const results = await Promise.all(
        adapters.map((adapter, index) =>
          Promise.resolve().then(() =>
            new TeamService({
              db: adapter.getDatabase(),
              statePath: adapter.describeStateRoot().stateRoot
            }).archiveTeam({
              teamName: "race-team",
              identity: identities[index],
              reason: "race finished"
            })
          )
        )
      );

      expect(results.every((result) => result.status === "archived")).toBe(true);
      expect(
        results.reduce(
          (total, result) =>
            total + (result.status === "archived" ? result.invalidated_bindings : 0),
          0
        )
      ).toBe(identities.length);

      const verifier = new DurableStateAdapter({ stateRoot, workspaceRoot });
      const db = verifier.getDatabase();
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM active_bindings WHERE status = ?")
          .get(ACTIVE_BINDING_STATUSES.active)
      ).toMatchObject({ count: 0 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = ?")
          .get(EVENT_TYPES.teamArchived)
      ).toMatchObject({ count: 1 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = ?")
          .get(EVENT_TYPES.activeBindingInvalidated)
      ).toMatchObject({ count: identities.length });
      verifier.close();
    } finally {
      for (const adapter of adapters) {
        adapter.close();
      }
    }
  });
});
