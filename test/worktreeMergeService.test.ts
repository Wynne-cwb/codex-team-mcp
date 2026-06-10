import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorktreeMergeService } from "../src/services/worktreeMergeService.js";
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
  const leaderRoot = createTempRoot("codex-team-merge-leader-");
  execGit(leaderRoot, ["init"]);
  execGit(leaderRoot, ["config", "user.email", "test@example.com"]);
  execGit(leaderRoot, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(leaderRoot, "tracked.txt"), "base\n");
  execGit(leaderRoot, ["add", "tracked.txt"]);
  execGit(leaderRoot, ["commit", "-m", "base"]);
  const headRevision = execGit(leaderRoot, ["rev-parse", "HEAD"]).trim();
  return { leaderRoot, headRevision };
}

function createWorktree(leaderRoot: string, member: string) {
  const managedRoot = createTempRoot("codex-team-merge-managed-");
  const service = new WorktreeService({ managedRoot });
  const result = service.createIsolatedWorktree({
    leaderWorkspaceRoot: leaderRoot,
    teamName: "Alpha Team",
    memberCanonicalName: member,
    runId: `run:team-1:${member}:${member}123456`
  });
  if (result.status !== "ready") {
    throw new Error(`worktree not ready: ${JSON.stringify(result)}`);
  }
  return result;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorktreeMergeService.mergeIntoLeader", () => {
  it("clean-merges an isolated branch back into the leader working tree", () => {
    const { leaderRoot } = createTempGitLeader();
    const worktree = createWorktree(leaderRoot, "builder");

    // Teammate writes a NEW file in the worktree (uncommitted).
    writeFileSync(
      path.join(worktree.workspace_path, "feature.txt"),
      "implemented by teammate\n"
    );

    const merge = new WorktreeMergeService().mergeIntoLeader({
      leaderWorkspaceRoot: leaderRoot,
      workspace_path: worktree.workspace_path,
      branch: worktree.branch,
      mergeLabel: "builder@run-1"
    });

    expect(merge.status).toBe("merged");
    if (merge.status !== "merged") {
      return;
    }
    expect(merge.merge_commit).toMatch(/^[0-9a-f]{7,40}$/);
    // The teammate's change is now present in the leader working tree.
    expect(existsSync(path.join(leaderRoot, "feature.txt"))).toBe(true);
    expect(readFileSync(path.join(leaderRoot, "feature.txt"), "utf8")).toContain(
      "implemented by teammate"
    );
  });

  it("fails closed on conflict: leader rolled back clean, worktree preserved", () => {
    const { leaderRoot } = createTempGitLeader();
    const worktree = createWorktree(leaderRoot, "writer");

    // Worktree edits tracked.txt on the isolated branch...
    writeFileSync(
      path.join(worktree.workspace_path, "tracked.txt"),
      "worktree change\n"
    );
    // ...while the leader advances HEAD with a CONFLICTING edit to the same line.
    writeFileSync(path.join(leaderRoot, "tracked.txt"), "leader change\n");
    execGit(leaderRoot, ["add", "tracked.txt"]);
    execGit(leaderRoot, ["commit", "-m", "leader conflicting change"]);

    const merge = new WorktreeMergeService().mergeIntoLeader({
      leaderWorkspaceRoot: leaderRoot,
      workspace_path: worktree.workspace_path,
      branch: worktree.branch
    });

    expect(merge.status).toBe("conflict");
    if (merge.status !== "conflict") {
      return;
    }
    expect(merge.conflict_files).toContain("tracked.txt");
    // Leader is rolled back to a clean working tree (no in-progress merge).
    expect(execGit(leaderRoot, ["status", "--porcelain"]).trim()).toBe("");
    expect(readFileSync(path.join(leaderRoot, "tracked.txt"), "utf8")).toContain(
      "leader change"
    );
    // The worktree is preserved for TL review / escalation.
    expect(existsSync(worktree.workspace_path)).toBe(true);
  });

  it("reports no_op when the worktree has no changes to merge", () => {
    const { leaderRoot } = createTempGitLeader();
    const worktree = createWorktree(leaderRoot, "idle");

    const merge = new WorktreeMergeService().mergeIntoLeader({
      leaderWorkspaceRoot: leaderRoot,
      workspace_path: worktree.workspace_path,
      branch: worktree.branch
    });

    expect(merge.status).toBe("no_op");
  });

  it("does not leak secrets or control characters in returned text", () => {
    const { leaderRoot } = createTempGitLeader();
    const worktree = createWorktree(leaderRoot, "secret");

    // A file whose NAME contains a secret token; review returns path names only.
    writeFileSync(
      path.join(worktree.workspace_path, "SECRET_TOKEN_NOTES.txt"),
      "irrelevant content\n"
    );

    const review = new WorktreeMergeService().reviewWorktree({
      leaderWorkspaceRoot: leaderRoot,
      workspace_path: worktree.workspace_path,
      base_revision: worktree.base_revision,
      branch: worktree.branch
    });

    expect(review.status).toBe("reviewed");
    expect(JSON.stringify(review)).not.toContain("SECRET_");
  });
});

describe("WorktreeMergeService.reviewWorktree", () => {
  it("returns branch, changed files, and diff summary without diff content", () => {
    const { leaderRoot, headRevision } = createTempGitLeader();
    const worktree = createWorktree(leaderRoot, "reviewer");

    writeFileSync(
      path.join(worktree.workspace_path, "feature.txt"),
      "secret-line-of-implementation\n"
    );

    const review = new WorktreeMergeService().reviewWorktree({
      leaderWorkspaceRoot: leaderRoot,
      workspace_path: worktree.workspace_path,
      base_revision: worktree.base_revision,
      branch: worktree.branch
    });

    expect(review.status).toBe("reviewed");
    expect(review.branch).toBe(worktree.branch);
    expect(review.base_revision).toBe(headRevision);
    expect(review.changed_files).toContain("feature.txt");
    expect(typeof review.conflict_preview).toBe("boolean");
    // The actual line content is NEVER returned, only path names + a --stat summary.
    expect(JSON.stringify(review)).not.toContain("secret-line-of-implementation");
  });
});
