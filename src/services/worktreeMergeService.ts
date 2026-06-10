import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Git-only merge service for the TL-driven worktree merge flow (D-04).
 *
 * Like WorktreeService, this class performs ONLY git subprocess operations and
 * returns structured, sanitized results — all DB side-effects (review_status /
 * merge columns + auditable events) are owned by LifecycleService, so this
 * service stays unit-testable against a real temp git repo with no database.
 *
 * Redaction (P5 D-19): only file path NAMES + commit SHAs + enum statuses are
 * ever returned — never diff content / prompt / message body / task text.
 *
 * Safety (D-04 / P5 D-15 partial override): merge is an explicit TL action, not
 * a silent background auto-merge. On conflict the leader is rolled back clean
 * (`git merge --abort`) and the worktree is preserved (fail-closed); the caller
 * may then escalate to a human. No destructive action is ever taken on the
 * isolated worktree by this service.
 */

const SECRET_PATTERN = /SECRET_[A-Z0-9_]+/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export type GitRunner = (cwd: string, args: readonly string[]) => string;

export interface WorktreeMergeServiceOptions {
  /** Injectable git runner (defaults to execFileSync) for deterministic tests. */
  gitRunner?: GitRunner;
}

export interface ReviewWorktreeInput {
  leaderWorkspaceRoot: string;
  /**
   * The TARGET repo the worktree branch is reviewed/merged against (where the
   * conflict preview + rev-list run). For a multi-repo container this is the
   * CHILD repo; falls back to leaderWorkspaceRoot for v1.1 single-repo runs.
   */
  repoRoot?: string | null;
  workspace_path: string;
  base_revision?: string | null;
  branch?: string | null;
}

export interface ReviewWorktreeResult {
  status: "reviewed" | "blocked";
  branch?: string;
  base_revision?: string;
  changed_files?: string[];
  diff_summary?: string;
  conflict_preview?: boolean;
  reason?: string;
}

export interface MergeWorktreeInput {
  leaderWorkspaceRoot: string;
  /**
   * The TARGET repo the worktree branch is merged BACK INTO. For a multi-repo
   * container this is the CHILD repo; falls back to leaderWorkspaceRoot for
   * v1.1 single-repo runs.
   */
  repoRoot?: string | null;
  workspace_path: string;
  branch?: string | null;
  /** A short, NON-sensitive label (e.g. member@run) used in the commit message. */
  mergeLabel?: string | null;
}

export type MergeWorktreeResult =
  | { status: "merged"; branch: string; merge_commit: string }
  | { status: "conflict"; branch: string; conflict_files: string[] }
  | { status: "no_op"; branch: string }
  | { status: "blocked"; reason: string; branch?: string };

interface GitExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export class WorktreeMergeService {
  private readonly gitRunner: GitRunner;

  constructor(options: WorktreeMergeServiceOptions = {}) {
    this.gitRunner =
      options.gitRunner ??
      ((cwd, args) =>
        execFileSync("git", [...args], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }));
  }

  reviewWorktree(input: ReviewWorktreeInput): ReviewWorktreeResult {
    const repoRoot = resolveRepoRoot(input.repoRoot, input.leaderWorkspaceRoot);
    const workspacePath = normalizeText(input.workspace_path);
    if (!workspacePath) {
      return { status: "blocked", reason: "missing_workspace_path" };
    }

    const branchResult = this.resolveBranch(workspacePath, input.branch);
    if (!branchResult.ok) {
      return { status: "blocked", reason: branchResult.reason };
    }
    const branch = branchResult.branch;
    const baseRevision = normalizeText(input.base_revision);

    // Changed files = uncommitted working-tree changes ∪ committed branch diff.
    const status = this.execGit(workspacePath, ["status", "--short"]);
    if (!status.ok) {
      return {
        status: "blocked",
        branch,
        base_revision: baseRevision ?? undefined,
        reason: sanitizeText(status.stderr) || "git_status_failed"
      };
    }
    const statusFiles = parseStatusChangedFiles(status.stdout);
    const committedFiles = baseRevision
      ? parseLineList(
          this.execGit(workspacePath, [
            "diff",
            "--name-only",
            `${baseRevision}...HEAD`
          ]).stdout
        )
      : [];
    const changedFiles = Array.from(
      new Set([...statusFiles, ...committedFiles].map(sanitizeText).filter(Boolean))
    ).sort();
    const diffStat = baseRevision
      ? this.execGit(workspacePath, ["diff", "--stat", `${baseRevision}...HEAD`])
          .stdout
      : "";
    const diffSummary = sanitizeText(diffStat) || undefined;

    const conflictPreview = this.previewConflict(repoRoot, branch);

    return {
      status: "reviewed",
      branch,
      base_revision: baseRevision ?? undefined,
      changed_files: changedFiles,
      diff_summary: diffSummary,
      conflict_preview: conflictPreview
    };
  }

  mergeIntoLeader(input: MergeWorktreeInput): MergeWorktreeResult {
    const repoRoot = resolveRepoRoot(input.repoRoot, input.leaderWorkspaceRoot);
    const workspacePath = normalizeText(input.workspace_path);
    if (!workspacePath) {
      return { status: "blocked", reason: "missing_workspace_path" };
    }

    const branchResult = this.resolveBranch(workspacePath, input.branch);
    if (!branchResult.ok) {
      return { status: "blocked", reason: branchResult.reason };
    }
    const branch = branchResult.branch;

    // 1. Stage + commit the teammate's uncommitted work ONTO the isolated branch
    //    (never the leader). "nothing to commit" is fine — the branch may already
    //    carry committed work.
    const add = this.execGit(workspacePath, ["add", "-A"]);
    if (!add.ok) {
      return {
        status: "blocked",
        branch,
        reason: sanitizeText(add.stderr) || "git_add_failed"
      };
    }
    const commit = this.execGit(workspacePath, [
      "commit",
      "-m",
      `codex-team worktree commit: ${sanitizeLabel(input.mergeLabel) ?? branch}`
    ]);
    if (!commit.ok && !isNothingToCommit(commit)) {
      return {
        status: "blocked",
        branch,
        reason: sanitizeText(commit.stderr) || "git_commit_failed"
      };
    }

    // 2. Nothing to merge (branch has no commits beyond the target repo HEAD) →
    //    no_op.
    const revList = this.execGit(repoRoot, [
      "rev-list",
      "--count",
      `HEAD..${branch}`
    ]);
    if (revList.ok && revList.stdout.trim() === "0") {
      return { status: "no_op", branch };
    }

    // 3. TL-triggered merge into the TARGET repo working tree (auditable --no-ff
    //    commit). On conflict, roll the target repo back clean and preserve the
    //    worktree (fail-closed).
    const merge = this.execGit(repoRoot, [
      "merge",
      "--no-ff",
      branch,
      "-m",
      `codex-team merge: ${sanitizeLabel(input.mergeLabel) ?? branch}`
    ]);

    if (merge.ok) {
      const head = this.execGit(repoRoot, ["rev-parse", "HEAD"]);
      return {
        status: "merged",
        branch,
        merge_commit: head.ok ? head.stdout.trim() : ""
      };
    }

    const conflictFiles = parseLineList(
      this.execGit(repoRoot, [
        "diff",
        "--name-only",
        "--diff-filter=U"
      ]).stdout
    )
      .map(sanitizeText)
      .filter(Boolean);

    // Always restore the target repo to a clean state, regardless of conflict vs
    // other git failure. abort is best-effort.
    this.execGit(repoRoot, ["merge", "--abort"]);

    if (conflictFiles.length > 0) {
      return { status: "conflict", branch, conflict_files: conflictFiles };
    }

    return {
      status: "blocked",
      branch,
      reason: sanitizeText(merge.stderr) || "git_merge_failed"
    };
  }

  private resolveBranch(
    workspacePath: string,
    branch: string | null | undefined
  ): { ok: true; branch: string } | { ok: false; reason: string } {
    const provided = normalizeText(branch);
    if (provided) {
      return { ok: true, branch: provided };
    }
    const head = this.execGit(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const derived = head.ok ? head.stdout.trim() : "";
    if (!derived || derived === "HEAD") {
      return { ok: false, reason: "branch_unresolved" };
    }
    return { ok: true, branch: derived };
  }

  // Best-effort, non-destructive conflict prediction via `git merge-tree`. Any
  // interpretation failure simply reports false (the authoritative conflict
  // handling happens at merge time with abort).
  private previewConflict(repoRoot: string, branch: string): boolean {
    const writeTree = this.execGit(repoRoot, [
      "merge-tree",
      "--write-tree",
      "HEAD",
      branch
    ]);
    if (writeTree.ok) {
      return /CONFLICT|^<<<<<<</m.test(writeTree.stdout);
    }
    // Modern git exits non-zero (status 1) on conflict with --write-tree.
    if (writeTree.status === 1) {
      return true;
    }
    return false;
  }

  private execGit(cwd: string, args: readonly string[]): GitExecResult {
    try {
      const stdout = this.gitRunner(cwd, args);
      return { ok: true, stdout: stdout ?? "", stderr: "", status: 0 };
    } catch (error) {
      const err = error as {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        status?: number;
      };
      return {
        ok: false,
        stdout: bufferToString(err.stdout),
        stderr: bufferToString(err.stderr),
        status: typeof err.status === "number" ? err.status : null
      };
    }
  }
}

function isNothingToCommit(result: GitExecResult): boolean {
  const combined = `${result.stdout} ${result.stderr}`.toLowerCase();
  return (
    combined.includes("nothing to commit") ||
    combined.includes("nothing added to commit") ||
    combined.includes("no changes added to commit")
  );
}

function parseStatusChangedFiles(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3).trim())
    .map((filePath) => {
      const renameSeparatorIndex = filePath.indexOf(" -> ");
      return renameSeparatorIndex >= 0
        ? filePath.slice(renameSeparatorIndex + 4).trim()
        : filePath;
    })
    .filter((filePath) => filePath.length > 0);
}

function parseLineList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function bufferToString(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : value.toString("utf8");
}

function normalizeText(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "";
}

// The repo the worktree branch is reviewed/merged against. Prefers the run's
// persisted target repo root (multi-repo container → child repo) and falls back
// to the coordination root for v1.1 single-repo runs.
function resolveRepoRoot(
  repoRoot: string | null | undefined,
  leaderWorkspaceRoot: string
): string {
  return path.resolve(normalizeText(repoRoot) || leaderWorkspaceRoot);
}

// Commit/merge messages carry only a caller-supplied label; strip secrets and
// control chars and never accept newlines (single-line message only).
function sanitizeLabel(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  return (
    normalized
      .replace(SECRET_PATTERN, "[redacted_secret]")
      .replace(CONTROL_CHAR_PATTERN, "")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 200) || null
  );
}

function sanitizeText(value: string): string {
  return value
    .replace(SECRET_PATTERN, "[redacted_secret]")
    .replace(CONTROL_CHAR_PATTERN, "")
    .trim();
}
