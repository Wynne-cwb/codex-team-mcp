import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  execGit(leaderRoot, ["init"]);
  execGit(leaderRoot, ["config", "user.email", "test@example.com"]);
  execGit(leaderRoot, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(leaderRoot, "tracked.txt"), "base\n");
  execGit(leaderRoot, ["add", "tracked.txt"]);
  execGit(leaderRoot, ["commit", "-m", "base"]);
  const headRevision = execGit(leaderRoot, ["rev-parse", "HEAD"]).trim();
  return { leaderRoot, headRevision };
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
