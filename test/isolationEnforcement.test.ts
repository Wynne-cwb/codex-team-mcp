/**
 * Phase 12 ISOL-01 / ISOL-02 enforcement assertions.
 *
 * ISOL-01: a file-modifying run with NO concrete isolation worktree is blocked
 *   — worktree-capable backends fail closed (never redirect to the leader) and
 *   non-worktree-capable backends stay blocked.
 * ISOL-02: before any leader working-tree impact (the TL merge), the run already
 *   records base_revision / changed files / review status; the merge action
 *   appends auditable events and persists the merge/conflict/escalate state.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ExecutionBackend,
  ExecutionBackendDescription,
  ExecutionRunContext
} from "../src/adapters/execution.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { LifecycleService } from "../src/services/lifecycleService.js";
import { TeamService } from "../src/services/teamService.js";
import { WorkspaceSafetyService } from "../src/services/workspaceSafetyService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, MEMBER_STATUSES, TABLE_NAMES } from "../src/state/schema.js";

const tempRoots: string[] = [];

interface RunRow {
  run_id: string;
  status: string;
  isolation_kind: string | null;
  review_status: string | null;
  workspace_path: string | null;
  base_revision: string | null;
  last_error: string | null;
}

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function execGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function createTempGitLeader(): string {
  const leaderRoot = createTempRoot("codex-team-isol-leader-");
  execGit(leaderRoot, ["init"]);
  execGit(leaderRoot, ["config", "user.email", "test@example.com"]);
  execGit(leaderRoot, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(leaderRoot, "tracked.txt"), "base\n");
  execGit(leaderRoot, ["add", "tracked.txt"]);
  execGit(leaderRoot, ["commit", "-m", "base"]);
  return leaderRoot;
}

function fakeBackend(supportsWorkspaces: boolean): ExecutionBackend {
  return {
    describeBackend(): ExecutionBackendDescription {
      return {
        status: "available",
        teammateExecutionImplemented: true,
        backend: "codex_cli_exec",
        backend_status: "running",
        capabilities: {
          canStart: true,
          canResume: true,
          canReconcile: true,
          supportsWorkspaces
        }
      };
    },
    startRun(context: ExecutionRunContext) {
      return {
        status: "started" as const,
        delivery_status: "backend_start_attempted" as const,
        backend: "codex_cli_exec",
        backend_status: "idle" as const,
        backend_run_id: "thread-isol",
        thread_id: "thread-isol",
        workspace_path: context.workspace_path ?? undefined,
        started_at: "2026-06-10T00:00:00.000Z",
        ended_at: "2026-06-10T00:00:01.000Z",
        turn_completed: true,
        final_backend_status: "idle" as const
      };
    },
    resumeRun() {
      return {
        status: "not_resumable" as const,
        delivery_status: "backend_unavailable" as const,
        backend: "codex_cli_exec",
        backend_status: "not_started" as const,
        last_error: "resume not exercised"
      };
    },
    reconcileRun() {
      return {
        status: "idle" as const,
        backend: "codex_cli_exec",
        backend_status: "idle" as const
      };
    }
  };
}

function createIdentity(workspaceRoot: string): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata({ sessionId: "isol-session" })
  });
}

function setup(workspaceRoot: string) {
  const identity = createIdentity(workspaceRoot);
  const adapter = new DurableStateAdapter({
    stateRoot: createTempRoot("codex-team-isol-state-"),
    workspaceRoot: identity.workspaceRoot
  });
  const statePath = adapter.describeStateRoot().stateRoot;
  const db = adapter.getDatabase();
  new TeamService({ db, statePath }).createTeam({
    teamName: "Alpha Team",
    description: "Isolation enforcement team",
    identity
  });
  return { identity, adapter, statePath, db };
}

function readRun(db: Database.Database): RunRow {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} ORDER BY created_at, run_id`)
    .get() as RunRow;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ISOL-01: file-modifying work without concrete isolation is blocked", () => {
  it("fails closed for a worktree-capable backend when no worktree can be created (non-git leader)", () => {
    // A non-git leader: createIsolatedWorktree fails, so the run must stay blocked
    // and NEVER be redirected to the leader tree.
    const nonGitLeader = createTempRoot("codex-team-isol-nongit-");
    const { identity, adapter, statePath, db } = setup(nonGitLeader);

    const result = new AgentService({
      db,
      statePath,
      executionBackend: fakeBackend(true)
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "code",
      prompt: "implement the feature",
      description: "code implementation",
      identity
    });

    expect(result.status).not.toBe("idle");
    const run = readRun(db);
    expect(run.status).toBe(MEMBER_STATUSES.scheduled);
    expect(run.workspace_path).toBeNull();
    expect(run.last_error).toBe("workspace_isolation_required");
    expect(run.review_status).toBe("needs_review");
    // The leader tree was never touched (no git repo materialized).
    expect(existsSync(path.join(nonGitLeader, ".git"))).toBe(false);

    // The specific fail-closed reason is surfaced on the auditable event: the
    // TARGET repo could not be resolved (no cwd hint + container is not a repo).
    const reviewEvent = db
      .prepare(
        `SELECT payload_json FROM ${TABLE_NAMES.events} WHERE event_type = ? ORDER BY created_at, event_id`
      )
      .get(EVENT_TYPES.workspaceReviewRequired) as
      | { payload_json: string }
      | undefined;
    expect(reviewEvent).toBeDefined();
    expect(JSON.parse(reviewEvent?.payload_json ?? "{}").reason).toContain(
      "workspace_target_repo_unresolved"
    );

    adapter.close();
  });

  it("blocks file-modifying work on a non-worktree-capable backend", () => {
    const { identity, adapter, statePath, db } = setup("/workspace/isol-noworktree");

    const result = new AgentService({
      db,
      statePath,
      executionBackend: fakeBackend(false)
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "code",
      prompt: "implement the feature",
      description: "code implementation",
      identity
    });

    expect(result.status).not.toBe("idle");
    const run = readRun(db);
    expect(run.status).toBe(MEMBER_STATUSES.scheduled);
    expect(run.workspace_path).toBeNull();
    expect(run.last_error).toBe("workspace_isolation_required");

    adapter.close();
  });
});

describe("ISOL-02: leader impact is preceded by recorded metadata + auditable merge", () => {
  it("records base_revision / changed files / review status before any TL merge and audits the merge", () => {
    const leaderRoot = createTempGitLeader();
    const { identity, adapter, statePath, db } = setup(leaderRoot);

    new AgentService({
      db,
      statePath,
      executionBackend: fakeBackend(true)
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "code",
      prompt: "implement the feature",
      description: "code implementation",
      identity
    });

    const run = readRun(db);
    // BEFORE any leader impact: isolation + base_revision + review status recorded.
    expect(run.isolation_kind).toBe("git_worktree");
    expect(run.base_revision).toBeTruthy();
    expect(run.review_status).toBe("pending_review");
    expect(run.workspace_path).toBeTruthy();

    // Changed files are observable via real git inspection before merge.
    writeFileSync(path.join(String(run.workspace_path), "feature.txt"), "impl\n");
    const inspection = new WorkspaceSafetyService().inspectWorkspace({
      workspace_path: String(run.workspace_path),
      base_revision: run.base_revision
    });
    expect(inspection.changed_files_json).toContain("feature.txt");

    // The TL merge is the FIRST leader-affecting action, and it is auditable.
    const lifecycle = new LifecycleService({
      db,
      statePath,
      executionBackend: fakeBackend(true)
    });
    const merge = lifecycle.mergeWorktree({ run_id: run.run_id, identity });
    expect(merge.status).toBe("merged");
    expect(readRun(db).review_status).toBe("merged");

    const eventTypes = (
      db
        .prepare(
          `SELECT event_type FROM ${TABLE_NAMES.events} ORDER BY created_at, event_id`
        )
        .all() as Array<{ event_type: string }>
    ).map((row) => row.event_type);
    expect(eventTypes).toContain(EVENT_TYPES.workspaceMergeRequested);
    expect(eventTypes).toContain(EVENT_TYPES.workspaceMergeCompleted);

    adapter.close();
  });
});
