import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
import { WorkspaceSafetyService } from "../src/services/workspaceSafetyService.js";
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
  worktree_branch: string | null;
  metadata_json: string;
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
  const leaderRoot = createTempRoot("codex-team-enforce-leader-");
  execGit(leaderRoot, ["init"]);
  execGit(leaderRoot, ["config", "user.email", "test@example.com"]);
  execGit(leaderRoot, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(leaderRoot, "tracked.txt"), "base\n");
  execGit(leaderRoot, ["add", "tracked.txt"]);
  execGit(leaderRoot, ["commit", "-m", "base"]);
  return leaderRoot;
}

// A workspaces-capable backend with an OS sandbox; one-shot completion so the
// run is finalized to idle (mirrors codex_cli_exec). supportsOsSandbox toggles
// the optional overlay (D-01).
class FakeWorkspaceBackend implements ExecutionBackend {
  constructor(private readonly supportsOsSandbox: boolean) {}

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
        supportsWorkspaces: true,
        supportsOsSandbox: this.supportsOsSandbox
      }
    };
  }

  startRun(context: ExecutionRunContext) {
    return {
      status: "started" as const,
      delivery_status: "backend_start_attempted" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const,
      backend_run_id: "thread-enforce",
      thread_id: "thread-enforce",
      workspace_path: context.workspace_path ?? undefined,
      started_at: "2026-06-10T00:00:00.000Z",
      ended_at: "2026-06-10T00:00:01.000Z",
      turn_completed: true,
      final_backend_status: "idle" as const,
      metadata: this.supportsOsSandbox ? { sandbox_mode: "workspace-write" } : {}
    };
  }

  resumeRun() {
    return {
      status: "not_resumable" as const,
      delivery_status: "backend_unavailable" as const,
      backend: "codex_cli_exec",
      backend_status: "not_started" as const,
      last_error: "resume not exercised"
    };
  }

  reconcileRun() {
    return {
      status: "idle" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const
    };
  }
}

function createIdentity(workspaceRoot: string): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata({ sessionId: "enforce-session" })
  });
}

function setup(leaderRoot: string) {
  const identity = createIdentity(leaderRoot);
  const adapter = new DurableStateAdapter({
    stateRoot: createTempRoot("codex-team-enforce-state-"),
    workspaceRoot: identity.workspaceRoot
  });
  const statePath = adapter.describeStateRoot().stateRoot;
  new TeamService({ db: adapter.getDatabase(), statePath }).createTeam({
    teamName: "Alpha Team",
    description: "Enforcement test team",
    identity
  });
  return { identity, adapter, statePath, db: adapter.getDatabase() };
}

function readRun(db: ReturnType<DurableStateAdapter["getDatabase"]>): RunRow {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} ORDER BY created_at, run_id`)
    .get() as RunRow;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("WorkspaceSafetyService D-01 enforcement", () => {
  const service = new WorkspaceSafetyService();
  const leaderRoot = "/workspace/project";
  const outsideWorktree = "/tmp/codex-team-worktrees/builder-run1";

  it("does NOT return review_diff start-safe for a worktree-capable backend (review-diff downgraded)", () => {
    const result = service.prepareWorkspace({
      work_classification: "code_implementation",
      leaderWorkspaceRoot: leaderRoot,
      backendCapabilities: {
        supportsWorkspaces: true,
        supportsReviewDiff: true
      },
      review_diff_artifact_path: "/tmp/review-diff.patch",
      base_revision: "abc123"
    });

    // Worktree-capable backend + only review_diff (no worktree) → blocked, never
    // a review_diff main isolation.
    expect(result.status).toBe("blocked");
    expect(result.isolation_kind).not.toBe("review_diff");
  });

  it("records sandbox_overlay on top of the worktree when supportsOsSandbox is true", () => {
    const result = service.prepareWorkspace({
      work_classification: "code_implementation",
      leaderWorkspaceRoot: leaderRoot,
      backendCapabilities: {
        supportsWorkspaces: true,
        supportsOsSandbox: true
      },
      workspace_path: outsideWorktree,
      base_revision: "abc123",
      sandbox_mode: "workspace-write"
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.isolation_kind).toBe("git_worktree");
    expect(result.sandbox_overlay).toBe(true);
    expect(result.sandbox_mode).toBe("workspace-write");
  });

  it("keeps the worktree ready WITHOUT sandbox_overlay when supportsOsSandbox is false (non-gating)", () => {
    const result = service.prepareWorkspace({
      work_classification: "code_implementation",
      leaderWorkspaceRoot: leaderRoot,
      backendCapabilities: {
        supportsWorkspaces: true,
        supportsOsSandbox: false
      },
      workspace_path: outsideWorktree,
      base_revision: "abc123"
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.isolation_kind).toBe("git_worktree");
    expect(result.sandbox_overlay).toBeUndefined();
  });

  it("PRESERVES review_diff main isolation for a NON-worktree-capable backend (R1)", () => {
    const result = service.prepareWorkspace({
      work_classification: "code_implementation",
      leaderWorkspaceRoot: leaderRoot,
      backendCapabilities: {
        supportsWorkspaces: false,
        supportsReviewDiff: true
      },
      review_diff_artifact_path: "/tmp/review-diff.patch",
      base_revision: "abc123"
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      return;
    }
    expect(result.isolation_kind).toBe("review_diff");
    expect(result.review_status).toBe("pending_review");
  });
});

describe("LifecycleService D-01 worktree-required enforcement (real temp git leader)", () => {
  it("auto-creates a worktree for a file-modifying run that only supplied a review_diff path", () => {
    const leaderRoot = createTempGitLeader();
    const { identity, adapter, statePath, db } = setup(leaderRoot);
    const backend = new FakeWorkspaceBackend(true);

    const result = new AgentService({ db, statePath, executionBackend: backend }).createAgent(
      {
        name: "Builder",
        teamName: "alpha-team",
        mode: "code",
        prompt: "Implement the feature",
        description: "code implementation",
        reviewDiffArtifactPath: "/tmp/review-diff.patch",
        identity
      }
    );

    expect(result.status).toBe("idle");

    const run = readRun(db);
    // The tightening: review-diff alone no longer bypasses worktree creation.
    expect(run.isolation_kind).toBe("git_worktree");
    expect(run.review_status).toBe("pending_review");
    expect(run.workspace_path).toBeTruthy();
    // Worktree path is OUTSIDE the leader tree.
    const relativeToLeader = path.relative(leaderRoot, String(run.workspace_path));
    expect(
      relativeToLeader.startsWith("..") || path.isAbsolute(relativeToLeader)
    ).toBe(true);
    // Branch persisted (ISOL-02) + sandbox overlay recorded (D-01).
    expect(run.worktree_branch).toMatch(/^codex-team\/alpha-team\/builder\//);
    expect(JSON.parse(run.metadata_json).sandbox_overlay).toBe(true);

    adapter.close();
  });

  it("does NOT record sandbox_overlay when the backend lacks an OS sandbox (non-gating)", () => {
    const leaderRoot = createTempGitLeader();
    const { identity, adapter, statePath, db } = setup(leaderRoot);
    const backend = new FakeWorkspaceBackend(false);

    const result = new AgentService({ db, statePath, executionBackend: backend }).createAgent(
      {
        name: "Builder",
        teamName: "alpha-team",
        mode: "code",
        prompt: "Implement the feature",
        description: "code implementation",
        identity
      }
    );

    expect(result.status).toBe("idle");

    const run = readRun(db);
    expect(run.isolation_kind).toBe("git_worktree");
    expect(run.workspace_path).toBeTruthy();
    expect(JSON.parse(run.metadata_json).sandbox_overlay).toBe(false);

    adapter.close();
  });
});
