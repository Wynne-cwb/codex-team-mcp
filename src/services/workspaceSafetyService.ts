import { execFileSync } from "node:child_process";
import path from "node:path";

import {
  ISOLATION_KINDS,
  MESSAGE_DELIVERY_STATUSES,
  RUN_REVIEW_STATUSES,
  WORK_CLASSIFICATIONS,
  type IsolationKind,
  type MessageDeliveryStatus,
  type RunReviewStatus,
  type WorkClassification
} from "../state/schema.js";

export interface WorkspaceBackendCapabilities {
  canStart?: boolean;
  supportsWorkspaces?: boolean;
  supportsReviewDiff?: boolean;
  // Phase 12 (D-01): OS sandbox is an OPTIONAL, best-effort overlay on TOP of the
  // git worktree — never a gate. When true, the worktree isolation records
  // sandbox_overlay:true; absent/false leaves the worktree path unaffected.
  supportsOsSandbox?: boolean;
}

export interface WorkspaceSafetyInput {
  work_classification: WorkClassification;
  leaderWorkspaceRoot: string;
  backendCapabilities: WorkspaceBackendCapabilities;
  isolation?: string | null;
  workspace_path?: string | null;
  review_diff_artifact_path?: string | null;
  declared_output_path?: string | null;
  base_revision?: string | null;
  // Phase 12 (D-01): optional sandbox mode passthrough recorded alongside the
  // sandbox_overlay flag when the backend supports an OS sandbox.
  sandbox_mode?: string | null;
}

export type WorkspaceSafetyResult =
  | WorkspaceSafetyNotRequiredResult
  | WorkspaceSafetyReadyResult
  | WorkspaceSafetyBlockedResult;

export interface WorkspaceInspectionInput {
  workspace_path?: string | null;
  base_revision?: string | null;
}

export type WorkspaceInspectionStatus =
  | "not_available"
  | "clean"
  | "changes_detected"
  | "inspection_failed";

export interface WorkspaceInspectionResult {
  status: WorkspaceInspectionStatus;
  review_status: RunReviewStatus;
  preserve_workspace: boolean;
  changed_files_json: string;
  diff_summary?: string;
  error_code?: "git_inspection_failed";
  error_message?: string;
}

export interface WorkspaceSafetyNotRequiredResult {
  status: "not_required";
  isolation_kind: typeof ISOLATION_KINDS.none;
  review_status: typeof RUN_REVIEW_STATUSES.none;
}

export interface WorkspaceSafetyReadyResult {
  status: "ready";
  isolation_kind: IsolationKind;
  review_status: RunReviewStatus;
  workspace_path?: string;
  review_diff_artifact_path?: string;
  declared_output_path?: string;
  base_revision?: string;
  // Phase 12 (D-01): optional sandbox overlay metadata recorded on TOP of a git
  // worktree when the backend supports an OS sandbox. isolation_kind stays
  // git_worktree — the sandbox is an additive, non-gating layer.
  sandbox_overlay?: boolean;
  sandbox_mode?: string;
}

export interface WorkspaceSafetyBlockedResult {
  status: "blocked";
  delivery_status: MessageDeliveryStatus;
  error_code: "workspace_isolation_required";
  isolation_kind: typeof ISOLATION_KINDS.none;
  review_status: typeof RUN_REVIEW_STATUSES.needsReview;
}

export class WorkspaceSafetyService {
  inspectWorkspace(input: WorkspaceInspectionInput): WorkspaceInspectionResult {
    const workspacePath = normalizeConcretePath(input.workspace_path);
    if (!workspacePath) {
      return {
        status: "not_available",
        review_status: RUN_REVIEW_STATUSES.none,
        preserve_workspace: false,
        changed_files_json: JSON.stringify([])
      };
    }

    const baseRevision = normalizeConcreteText(input.base_revision);

    try {
      const statusOutput = runGitCommand(
        workspacePath,
        ["status", "--short"],
        "git status --short"
      );
      const statusChangedFiles = parseGitStatusChangedFiles(statusOutput);
      const diffChangedFiles = baseRevision
        ? parseLineList(
            runGitCommand(
              workspacePath,
              ["diff", "--name-only", `${baseRevision}...HEAD`],
              "git diff --name-only"
            )
          )
        : [];
      const diffSummary = baseRevision
        ? normalizeConcreteText(
            runGitCommand(
              workspacePath,
              ["diff", "--stat", `${baseRevision}...HEAD`],
              "git diff --stat"
            )
          ) ?? undefined
        : undefined;
      const changedFiles = Array.from(
        new Set([...statusChangedFiles, ...diffChangedFiles])
      ).sort();

      if (changedFiles.length > 0 || Boolean(diffSummary)) {
        return {
          status: "changes_detected",
          review_status: RUN_REVIEW_STATUSES.needsReview,
          preserve_workspace: true,
          changed_files_json: JSON.stringify(changedFiles),
          diff_summary: diffSummary
        };
      }

      return {
        status: "clean",
        review_status: RUN_REVIEW_STATUSES.none,
        preserve_workspace: false,
        changed_files_json: JSON.stringify([])
      };
    } catch (error) {
      return {
        status: "inspection_failed",
        review_status: RUN_REVIEW_STATUSES.needsReview,
        preserve_workspace: true,
        changed_files_json: JSON.stringify([]),
        error_code: "git_inspection_failed",
        error_message: sanitizeInspectionError(error)
      };
    }
  }

  prepareWorkspace(input: WorkspaceSafetyInput): WorkspaceSafetyResult {
    if (
      input.work_classification === WORK_CLASSIFICATIONS.readOnly ||
      input.work_classification === WORK_CLASSIFICATIONS.reviewOnly
    ) {
      return {
        status: "not_required",
        isolation_kind: ISOLATION_KINDS.none,
        review_status: RUN_REVIEW_STATUSES.none
      };
    }

    if (input.work_classification === WORK_CLASSIFICATIONS.artifactWriting) {
      const declaredOutputPath = normalizeConcretePath(
        input.declared_output_path
      );
      if (
        declaredOutputPath &&
        !isPathInsideOrEqual(declaredOutputPath, input.leaderWorkspaceRoot)
      ) {
        return {
          status: "ready",
          isolation_kind: ISOLATION_KINDS.declaredOutputPath,
          declared_output_path: declaredOutputPath,
          review_status: RUN_REVIEW_STATUSES.none
        };
      }

      const worktreeResult = this.prepareGitWorktree(input);
      if (worktreeResult) {
        return worktreeResult;
      }

      const reviewDiffResult = this.prepareReviewDiff(input);
      if (reviewDiffResult) {
        return reviewDiffResult;
      }

      return blockedWorkspaceSafetyResult();
    }

    if (input.work_classification === WORK_CLASSIFICATIONS.codeImplementation) {
      const worktreeResult = this.prepareGitWorktree(input);
      if (worktreeResult) {
        return worktreeResult;
      }

      const reviewDiffResult = this.prepareReviewDiff(input);
      if (reviewDiffResult) {
        return reviewDiffResult;
      }

      return blockedWorkspaceSafetyResult();
    }

    return blockedWorkspaceSafetyResult();
  }

  private prepareGitWorktree(
    input: WorkspaceSafetyInput
  ): WorkspaceSafetyReadyResult | null {
    const workspacePath = normalizeConcretePath(input.workspace_path);
    const baseRevision = normalizeConcreteText(input.base_revision);
    if (!workspacePath || !baseRevision) {
      return null;
    }

    if (isPathInsideOrEqual(workspacePath, input.leaderWorkspaceRoot)) {
      return null;
    }

    if (input.backendCapabilities.supportsWorkspaces !== true) {
      return null;
    }

    // D-01: OS sandbox is an optional overlay ON TOP of the worktree — recorded
    // as additive metadata, never replacing isolation_kind and never gating.
    const sandboxOverlay = input.backendCapabilities.supportsOsSandbox === true;
    const sandboxMode = normalizeConcreteText(input.sandbox_mode);

    return {
      status: "ready",
      isolation_kind: ISOLATION_KINDS.gitWorktree,
      workspace_path: workspacePath,
      base_revision: baseRevision,
      review_status: RUN_REVIEW_STATUSES.pendingReview,
      ...(sandboxOverlay ? { sandbox_overlay: true } : {}),
      ...(sandboxOverlay && sandboxMode ? { sandbox_mode: sandboxMode } : {})
    };
  }

  private prepareReviewDiff(
    input: WorkspaceSafetyInput
  ): WorkspaceSafetyReadyResult | null {
    // D-01: review-diff is no longer an independent main isolation for
    // worktree-capable backends — for those, the git worktree is the required
    // primary isolation and review-diff is downgraded to a pre-merge review
    // step (D-04). It remains a valid main isolation ONLY for
    // non-worktree-capable backends that declare supportsReviewDiff.
    if (input.backendCapabilities.supportsWorkspaces === true) {
      return null;
    }

    const reviewDiffArtifactPath = normalizeConcretePath(
      input.review_diff_artifact_path
    );
    const baseRevision = normalizeConcreteText(input.base_revision);
    if (
      !reviewDiffArtifactPath ||
      !baseRevision ||
      input.backendCapabilities.supportsReviewDiff !== true
    ) {
      return null;
    }

    return {
      status: "ready",
      isolation_kind: ISOLATION_KINDS.reviewDiff,
      review_diff_artifact_path: reviewDiffArtifactPath,
      base_revision: baseRevision,
      review_status: RUN_REVIEW_STATUSES.pendingReview
    };
  }
}

function blockedWorkspaceSafetyResult(): WorkspaceSafetyBlockedResult {
  return {
    status: "blocked",
    delivery_status: MESSAGE_DELIVERY_STATUSES.backendUnavailable,
    error_code: "workspace_isolation_required",
    isolation_kind: ISOLATION_KINDS.none,
    review_status: RUN_REVIEW_STATUSES.needsReview
  };
}

function normalizeConcretePath(value: string | null | undefined): string | null {
  const normalized = normalizeConcreteText(value);
  if (!normalized) {
    return null;
  }

  return path.resolve(normalized);
}

function normalizeConcreteText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
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

function runGitCommand(
  workspacePath: string,
  args: string[],
  commandLabel: string
): string {
  try {
    return execFileSync("git", args, {
      cwd: workspacePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    throw new Error(`${commandLabel} failed: ${sanitizeInspectionError(error)}`);
  }
}

function parseGitStatusChangedFiles(output: string): string[] {
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

function sanitizeInspectionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
