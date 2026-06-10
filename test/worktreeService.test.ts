import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorktreeService } from "../src/services/worktreeService.js";

const tempRoots: string[] = [];

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

function createTempGitLeader(): { leaderRoot: string; headRevision: string } {
  const leaderRoot = createTempRoot("codex-team-worktree-leader-");
  initGitRepo(leaderRoot);
  const headRevision = execGit(leaderRoot, ["rev-parse", "HEAD"]).trim();
  return { leaderRoot, headRevision };
}

function initGitRepo(repoRoot: string): string {
  execGit(repoRoot, ["init"]);
  execGit(repoRoot, ["config", "user.email", "test@example.com"]);
  execGit(repoRoot, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(repoRoot, "tracked.txt"), "base\n");
  execGit(repoRoot, ["add", "tracked.txt"]);
  execGit(repoRoot, ["commit", "-m", "base"]);
  return execGit(repoRoot, ["rev-parse", "HEAD"]).trim();
}

// A multi-repo container: the container directory is a PLAIN dir (NOT a git
// repo); the real repo is a CHILD of it (e.g. <container>/admin-sms).
function createTempContainerWithChildRepo(): {
  container: string;
  childRepo: string;
  childHead: string;
} {
  const container = createTempRoot("codex-team-worktree-container-");
  const childRepo = path.join(container, "admin-sms");
  mkdirSync(childRepo, { recursive: true });
  const childHead = initGitRepo(childRepo);
  return { container, childRepo, childHead };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorktreeService.createIsolatedWorktree", () => {
  it("creates an isolated worktree on an independent branch outside the leader tree", () => {
    const { leaderRoot, headRevision } = createTempGitLeader();
    const managedRoot = createTempRoot("codex-team-worktree-managed-");
    const service = new WorktreeService({ managedRoot });

    const result = service.createIsolatedWorktree({
      leaderWorkspaceRoot: leaderRoot,
      teamName: "Alpha Team",
      memberCanonicalName: "builder",
      runId: "run:team-1:builder:abcdef123456"
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }

    expect(result.base_revision).toBe(headRevision);
    expect(result.branch).toMatch(/^codex-team\/alpha-team\/builder\//);
    // Worktree path is outside (and not under) the leader tree.
    const relativeToLeader = path.relative(leaderRoot, result.workspace_path);
    expect(relativeToLeader.startsWith("..") || path.isAbsolute(relativeToLeader)).toBe(true);
    expect(existsSync(result.workspace_path)).toBe(true);
    expect(existsSync(path.join(result.workspace_path, ".git"))).toBe(true);

    // The branch is a real, registered worktree of the leader repo.
    const worktreeList = execGit(leaderRoot, ["worktree", "list"]);
    expect(worktreeList).toContain(result.workspace_path);

    // Backward compat: no cwd → repo_root is the coordination root (leader IS
    // the repo), preserving v1.1 single-repo behavior.
    expect(path.resolve(result.repo_root)).toBe(path.resolve(leaderRoot));
  });

  it("resolves the TARGET repo from cwd when the container is NOT a git repo (multi-repo)", () => {
    const { container, childRepo, childHead } = createTempContainerWithChildRepo();
    const managedRoot = createTempRoot("codex-team-worktree-managed-");
    const service = new WorktreeService({ managedRoot });

    const result = service.createIsolatedWorktree({
      // Coordination root is the PLAIN container directory (NOT a repo)...
      leaderWorkspaceRoot: container,
      // ...and the cwd HINT points into the real CHILD repo.
      cwd: childRepo,
      teamName: "Alpha Team",
      memberCanonicalName: "builder",
      runId: "run:team-1:builder:child0001"
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }

    // Branch is off the CHILD repo HEAD and the resolved repo_root is the child
    // (compare realpaths — git resolves symlinks like /tmp → /private/tmp).
    expect(result.base_revision).toBe(childHead);
    expect(realpathSync(result.repo_root)).toBe(realpathSync(childRepo));

    // BOUNDARY: the worktree lives OUTSIDE the target (child) repo tree.
    const relativeToChild = path.relative(childRepo, result.workspace_path);
    expect(
      relativeToChild.startsWith("..") || path.isAbsolute(relativeToChild)
    ).toBe(true);

    // The worktree is a real, registered worktree of the CHILD repo (not the
    // container, which never became a repo).
    expect(execGit(childRepo, ["worktree", "list"])).toContain(
      result.workspace_path
    );
    expect(existsSync(path.join(container, ".git"))).toBe(false);
  });

  it("blocks fail-closed when the cwd hint is not inside any git repo", () => {
    const { container } = createTempContainerWithChildRepo();
    const nonRepoCwd = path.join(container, "not-a-repo");
    mkdirSync(nonRepoCwd, { recursive: true });
    const managedRoot = createTempRoot("codex-team-worktree-managed-");
    const service = new WorktreeService({ managedRoot });

    const result = service.createIsolatedWorktree({
      leaderWorkspaceRoot: container,
      cwd: nonRepoCwd,
      teamName: "Alpha Team",
      memberCanonicalName: "builder",
      runId: "run:team-1:builder:noooo001"
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.error_code).toBe("workspace_isolation_required");
    expect(result.reason).toContain("workspace_target_repo_unresolved");
    expect(existsSync(path.join(managedRoot, "worktrees"))).toBe(false);
  });

  it("blocks (and creates nothing in the leader tree) when the leader is not a git repo", () => {
    const nonGitLeader = createTempRoot("codex-team-worktree-nongit-");
    const managedRoot = createTempRoot("codex-team-worktree-managed-");
    const service = new WorktreeService({ managedRoot });

    const result = service.createIsolatedWorktree({
      leaderWorkspaceRoot: nonGitLeader,
      teamName: "Alpha Team",
      memberCanonicalName: "builder",
      runId: "run:team-1:builder:zzz999"
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.error_code).toBe("workspace_isolation_required");
    // No cwd + leader is not a repo → fail-closed with the decoupling reason.
    expect(result.reason).toContain("workspace_target_repo_unresolved");
    expect(existsSync(path.join(nonGitLeader, ".git"))).toBe(false);
    expect(existsSync(path.join(managedRoot, "worktrees"))).toBe(false);
  });

  it("removes a clean worktree but preserves one with changes", () => {
    const { leaderRoot } = createTempGitLeader();
    const managedRoot = createTempRoot("codex-team-worktree-managed-");
    const service = new WorktreeService({ managedRoot });

    const cleanResult = service.createIsolatedWorktree({
      leaderWorkspaceRoot: leaderRoot,
      teamName: "Alpha Team",
      memberCanonicalName: "cleaner",
      runId: "run:team-1:cleaner:clean01"
    });
    expect(cleanResult.status).toBe("ready");
    if (cleanResult.status !== "ready") {
      return;
    }

    const removeClean = service.removeWorktreeIfClean({
      leaderWorkspaceRoot: leaderRoot,
      workspace_path: cleanResult.workspace_path,
      base_revision: cleanResult.base_revision
    });
    expect(removeClean.status).toBe("removed");
    expect(existsSync(cleanResult.workspace_path)).toBe(false);

    const changedResult = service.createIsolatedWorktree({
      leaderWorkspaceRoot: leaderRoot,
      teamName: "Alpha Team",
      memberCanonicalName: "writer",
      runId: "run:team-1:writer:change1"
    });
    expect(changedResult.status).toBe("ready");
    if (changedResult.status !== "ready") {
      return;
    }
    writeFileSync(
      path.join(changedResult.workspace_path, "tracked.txt"),
      "changed by teammate\n"
    );

    const preserveChanged = service.removeWorktreeIfClean({
      leaderWorkspaceRoot: leaderRoot,
      workspace_path: changedResult.workspace_path,
      base_revision: changedResult.base_revision
    });
    expect(preserveChanged.status).toBe("preserved");
    expect(existsSync(changedResult.workspace_path)).toBe(true);
  });
});
