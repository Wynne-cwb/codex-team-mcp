import { execFileSync } from "node:child_process";
import path from "node:path";

import { WorkspaceSafetyService } from "./workspaceSafetyService.js";

const ISOLATION_REQUIRED_ERROR_CODE = "workspace_isolation_required";

export interface CreateIsolatedWorktreeInput {
  leaderWorkspaceRoot: string;
  teamName: string;
  memberCanonicalName: string;
  runId: string;
  /** Managed root OUTSIDE the leader tree under which worktrees are created. */
  managedRoot?: string;
}

export type CreateIsolatedWorktreeResult =
  | {
      status: "ready";
      workspace_path: string;
      base_revision: string;
      branch: string;
    }
  | {
      status: "blocked";
      error_code: typeof ISOLATION_REQUIRED_ERROR_CODE;
      reason: string;
    };

export interface RemoveWorktreeInput {
  leaderWorkspaceRoot: string;
  workspace_path: string;
  base_revision?: string | null;
}

export interface RemoveWorktreeResult {
  status: "removed" | "preserved" | "not_found";
  reason?: string;
}

export interface WorktreeServiceOptions {
  /** Default managed root (state-adjacent) when callers do not supply one. */
  managedRoot?: string;
  workspaceSafetyService?: WorkspaceSafetyService;
}

/**
 * Creates an isolated git worktree on an independent branch for file-modifying
 * runs (D-01). The worktree path is forced OUTSIDE the leader tree; on any git
 * failure (leader is not a repo / `worktree add` fails) the run is BLOCKED and
 * never redirected to the leader tree (ISOL-01). Cleanup helpers remove only
 * clean/orphaned worktrees and preserve changed ones for Phase 12 review.
 *
 * DB side-effects (the `workspace_isolation_created` event + run persistence)
 * are owned by LifecycleService; this service only returns data, so it stays
 * unit-testable without a database.
 */
export class WorktreeService {
  private readonly managedRoot: string | null;
  private readonly workspaceSafetyService: WorkspaceSafetyService;

  constructor(options: WorktreeServiceOptions = {}) {
    this.managedRoot = normalizeConcreteText(options.managedRoot);
    this.workspaceSafetyService =
      options.workspaceSafetyService ?? new WorkspaceSafetyService();
  }

  createIsolatedWorktree(
    input: CreateIsolatedWorktreeInput
  ): CreateIsolatedWorktreeResult {
    const leaderRoot = path.resolve(input.leaderWorkspaceRoot);

    let baseRevision: string;
    try {
      baseRevision = runGitCommand(leaderRoot, ["rev-parse", "HEAD"]).trim();
    } catch (error) {
      return blocked(`leader_not_a_git_repository: ${sanitizeText(errorToMessage(error))}`);
    }

    if (!baseRevision) {
      return blocked("base_revision_unavailable");
    }

    const teamSlug = slugify(input.teamName);
    const memberSlug = slugify(input.memberCanonicalName);
    const shortRunId = shortenRunId(input.runId);
    const managedRoot = path.resolve(
      normalizeConcreteText(input.managedRoot) ??
        this.managedRoot ??
        defaultManagedRoot(leaderRoot)
    );
    const workspacePath = path.join(
      managedRoot,
      "worktrees",
      teamSlug,
      `${memberSlug}-${shortRunId}`
    );

    // Hard boundary: writes must never land in (or under) the leader tree.
    if (isPathInsideOrEqual(workspacePath, leaderRoot)) {
      return blocked("workspace_path_inside_leader_tree");
    }

    const branch = `codex-team/${teamSlug}/${memberSlug}/${shortRunId}`;
    try {
      runGitCommand(leaderRoot, [
        "worktree",
        "add",
        "-b",
        branch,
        workspacePath,
        baseRevision
      ]);
    } catch (error) {
      return blocked(`worktree_add_failed: ${sanitizeText(errorToMessage(error))}`);
    }

    return {
      status: "ready",
      workspace_path: workspacePath,
      base_revision: baseRevision,
      branch
    };
  }

  /**
   * Removes a worktree ONLY when it is clean/unchanged. Worktrees with changes
   * are preserved for Phase 12 review.
   */
  removeWorktreeIfClean(input: RemoveWorktreeInput): RemoveWorktreeResult {
    const leaderRoot = path.resolve(input.leaderWorkspaceRoot);
    const workspacePath = normalizeConcreteText(input.workspace_path);
    if (!workspacePath) {
      return { status: "not_found", reason: "missing_workspace_path" };
    }

    const inspection = this.workspaceSafetyService.inspectWorkspace({
      workspace_path: workspacePath,
      base_revision: input.base_revision ?? null
    });

    if (inspection.status === "not_available") {
      return { status: "not_found", reason: "workspace_not_available" };
    }

    if (
      inspection.preserve_workspace ||
      inspection.status === "changes_detected" ||
      inspection.status === "inspection_failed"
    ) {
      return { status: "preserved", reason: inspection.status };
    }

    try {
      runGitCommand(leaderRoot, ["worktree", "remove", workspacePath]);
      return { status: "removed" };
    } catch (error) {
      return { status: "preserved", reason: sanitizeText(errorToMessage(error)) };
    }
  }

  pruneWorktrees(leaderWorkspaceRoot: string): void {
    try {
      runGitCommand(path.resolve(leaderWorkspaceRoot), ["worktree", "prune"]);
    } catch {
      // Best-effort cleanup; never throw raw output.
    }
  }
}

function blocked(reason: string): CreateIsolatedWorktreeResult {
  return {
    status: "blocked",
    error_code: ISOLATION_REQUIRED_ERROR_CODE,
    reason
  };
}

function defaultManagedRoot(leaderRoot: string): string {
  // Sibling of the leader, deterministic and OUTSIDE the leader tree. Production
  // callers (LifecycleService) supply a state-adjacent managedRoot instead.
  return path.join(
    path.dirname(leaderRoot),
    `${path.basename(leaderRoot)}-codex-team-worktrees`
  );
}

function runGitCommand(workspacePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspacePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function isPathInsideOrEqual(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(rootPath);
  const relativePath = path.relative(resolvedRoot, resolvedCandidate);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "codex-team";
}

function shortenRunId(runId: string): string {
  const tail = runId.split(":").at(-1) ?? runId;
  const slug = tail.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 12);
  return slug.length > 0 ? slug : "run";
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeConcreteText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function sanitizeText(value: string): string {
  return value
    .replace(/SECRET_[A-Z0-9_]+/g, "[redacted_secret]")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}
