/**
 * D-01 regression: production multi-repo CONTAINER layout.
 *
 * The leader/workspace root is a NON-git coordination container; the real git
 * repo is a CHILD directory. With the default (non-overridden) state root, the
 * durable state — and therefore the managed worktree storage
 * (<container>/.codex-team/state/worktrees-root/...) — lives INSIDE the
 * container yet OUTSIDE the target child repo. That is the correct isolation
 * boundary, but the legacy "worktree must be OUTSIDE the leader/container"
 * check wrongly rejected it, leaving file-modifying runs stuck at
 * not_started + workspace_isolation_required (isolation_kind=none).
 *
 * The existing isolationEnforcement.test.ts never reproduced this because it
 * forces `stateRoot` to an EXTERNAL temp dir, so the worktree was always
 * outside the leader regardless. This test pins the production layout: state
 * (hence worktree storage) lives INSIDE the container.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { TABLE_NAMES } from "../src/state/schema.js";

const tempRoots: string[] = [];

interface RunRow {
  run_id: string;
  status: string;
  isolation_kind: string | null;
  review_status: string | null;
  workspace_path: string | null;
  base_revision: string | null;
  worktree_repo_root: string | null;
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

/**
 * A non-git CONTAINER directory whose CHILD is a real git repo (the target
 * sub-repo). Mirrors the production multi-repo layout: the leader workspace is
 * a plain coordination directory, not itself a repo.
 */
function createContainerWithChildRepo(): { container: string; childRepo: string } {
  const container = createTempRoot("codex-team-container-");
  const childRepo = path.join(container, "child-repo");
  mkdirSync(childRepo);
  execGit(childRepo, ["init"]);
  execGit(childRepo, ["config", "user.email", "test@example.com"]);
  execGit(childRepo, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(childRepo, "tracked.txt"), "base\n");
  execGit(childRepo, ["add", "tracked.txt"]);
  execGit(childRepo, ["commit", "-m", "base"]);
  return { container, childRepo };
}

function fakeWorkspaceBackend(): ExecutionBackend {
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
          supportsWorkspaces: true
        }
      };
    },
    startRun(context: ExecutionRunContext) {
      return {
        status: "started" as const,
        delivery_status: "backend_start_attempted" as const,
        backend: "codex_cli_exec",
        backend_status: "idle" as const,
        backend_run_id: "thread-container",
        thread_id: "thread-container",
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
    caller: normalizeCallerMetadata({ sessionId: "container-session" })
  });
}

/**
 * IMPORTANT: do NOT pass `stateRoot` — let it default to
 * <container>/.codex-team/state so the managed worktree storage lives INSIDE
 * the container (the production layout that the old boundary check broke).
 */
function setup(container: string) {
  const identity = createIdentity(container);
  const adapter = new DurableStateAdapter({ workspaceRoot: identity.workspaceRoot });
  const statePath = adapter.describeStateRoot().stateRoot;
  const db = adapter.getDatabase();
  new TeamService({ db, statePath }).createTeam({
    teamName: "Alpha Team",
    description: "Container isolation team",
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

describe("D-01 multi-repo container layout: worktree stored inside container is valid isolation", () => {
  it("creates a git_worktree (inside container, outside child repo) instead of blocking with workspace_isolation_required", () => {
    const { container, childRepo } = createContainerWithChildRepo();
    const { identity, adapter, statePath, db } = setup(container);

    const result = new AgentService({
      db,
      statePath,
      executionBackend: fakeWorkspaceBackend()
    }).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "code",
      prompt: "implement",
      description: "code implementation",
      // The per-TeamMate target repo HINT: the CHILD git repo, not the container.
      cwd: childRepo,
      identity
    });

    // With the fix the run is no longer blocked on isolation: it starts and the
    // one-shot fake backend finalizes it to idle (success). Pre-fix this stuck at
    // scheduled/not_started with workspace_isolation_required.
    expect(result.status).toBe("idle");

    const run = readRun(db);

    // The regression: this layout previously blocked with isolation_kind=none.
    expect(run.last_error).not.toBe("workspace_isolation_required");
    expect(run.isolation_kind).toBe("git_worktree");
    expect(run.workspace_path).toBeTruthy();

    const workspacePath = String(run.workspace_path);
    // The managed worktree lives INSIDE the container (under .codex-team).
    const relativeToContainer = path.relative(container, workspacePath);
    expect(
      !relativeToContainer.startsWith("..") && !path.isAbsolute(relativeToContainer)
    ).toBe(true);
    expect(workspacePath).toContain(".codex-team");
    // ...yet remains OUTSIDE the target child repo (writes never land in its tree).
    const relativeToRepo = path.relative(childRepo, workspacePath);
    expect(
      relativeToRepo.startsWith("..") || path.isAbsolute(relativeToRepo)
    ).toBe(true);

    // The resolved TARGET repo (persisted on the run) points at the child repo.
    // realpathSync normalizes the macOS /tmp → /private/tmp symlink: the repo
    // root is resolved via `git rev-parse --show-toplevel` (symlink-resolved),
    // while childRepo retains the original mkdtemp path.
    expect(realpathSync(String(run.worktree_repo_root))).toBe(realpathSync(childRepo));

    adapter.close();
  });
});
