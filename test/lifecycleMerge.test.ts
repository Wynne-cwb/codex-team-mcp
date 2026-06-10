import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, TABLE_NAMES } from "../src/state/schema.js";

const tempRoots: string[] = [];
const SECRET_MERGE_PROMPT = "SECRET_PHASE12_MERGE_PROMPT";

interface MergeRunRow {
  run_id: string;
  review_status: string | null;
  merge_commit: string | null;
  merged_at: string | null;
  merged_by_caller_key: string | null;
  worktree_branch: string | null;
  merge_conflict_files_json: string | null;
  workspace_path: string | null;
  base_revision: string | null;
  metadata_json: string;
}

interface EventRow {
  event_type: string;
  payload_json: string;
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
  const leaderRoot = createTempRoot("codex-team-lcmerge-leader-");
  execGit(leaderRoot, ["init"]);
  execGit(leaderRoot, ["config", "user.email", "test@example.com"]);
  execGit(leaderRoot, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(leaderRoot, "tracked.txt"), "base\n");
  execGit(leaderRoot, ["add", "tracked.txt"]);
  execGit(leaderRoot, ["commit", "-m", "base"]);
  return leaderRoot;
}

class FakeWorkspaceBackend implements ExecutionBackend {
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
        supportsOsSandbox: true
      }
    };
  }

  startRun(context: ExecutionRunContext) {
    return {
      status: "started" as const,
      delivery_status: "backend_start_attempted" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const,
      backend_run_id: "thread-merge",
      thread_id: "thread-merge",
      workspace_path: context.workspace_path ?? undefined,
      started_at: "2026-06-10T00:00:00.000Z",
      ended_at: "2026-06-10T00:00:01.000Z",
      turn_completed: true,
      final_backend_status: "idle" as const,
      metadata: { sandbox_mode: "workspace-write" }
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
    caller: normalizeCallerMetadata({ sessionId: "merge-session" })
  });
}

function startWorktreeRun(
  leaderRoot: string,
  member: string
): {
  identity: WorkspaceScopedCallerIdentity;
  adapter: DurableStateAdapter;
  statePath: string;
  db: Database.Database;
  runId: string;
  workspacePath: string;
} {
  const identity = createIdentity(leaderRoot);
  const adapter = new DurableStateAdapter({
    stateRoot: createTempRoot("codex-team-lcmerge-state-"),
    workspaceRoot: identity.workspaceRoot
  });
  const statePath = adapter.describeStateRoot().stateRoot;
  const db = adapter.getDatabase();
  new TeamService({ db, statePath }).createTeam({
    teamName: "Alpha Team",
    description: "Merge test team",
    identity
  });

  const result = new AgentService({
    db,
    statePath,
    executionBackend: new FakeWorkspaceBackend()
  }).createAgent({
    name: member,
    teamName: "alpha-team",
    mode: "code",
    prompt: `implement feature ${SECRET_MERGE_PROMPT}`,
    description: "code implementation",
    identity
  });

  const run = readRun(db);
  expect(run.review_status).toBe("pending_review");
  expect(run.workspace_path).toBeTruthy();
  return {
    identity,
    adapter,
    statePath,
    db,
    runId: result.run_id,
    workspacePath: String(run.workspace_path)
  };
}

function readRun(db: Database.Database): MergeRunRow {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} ORDER BY created_at, run_id`)
    .get() as MergeRunRow;
}

function readEvents(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `SELECT event_type, payload_json FROM ${TABLE_NAMES.events} ORDER BY created_at, event_id`
    )
    .all() as EventRow[];
}

// Inject a pane marker into backend_metadata so we can prove the targeted merge
// UPDATE never rewrites metadata_json (regresses neither R3 nor G-1).
function seedPaneMarker(db: Database.Database, runId: string): void {
  const run = readRun(db);
  const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;
  metadata.backend_metadata = {
    pane: {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      session_name: "codex-team:alpha",
      pane_id: "%1"
    }
  };
  db.prepare(`UPDATE ${TABLE_NAMES.runs} SET metadata_json = ? WHERE run_id = ?`).run(
    JSON.stringify(metadata),
    runId
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("LifecycleService.mergeWorktree (D-04, real temp git)", () => {
  it("merges a worktree branch, persists merge metadata, cleans up, and preserves backend_metadata", () => {
    const leaderRoot = createTempGitLeader();
    const ctx = startWorktreeRun(leaderRoot, "builder");
    seedPaneMarker(ctx.db, ctx.runId);

    // Teammate writes a new file in the isolated worktree.
    writeFileSync(
      path.join(ctx.workspacePath, "feature.txt"),
      "implemented by teammate\n"
    );

    const lifecycle = new LifecycleService({ db: ctx.db, statePath: ctx.statePath });
    const outcome = lifecycle.mergeWorktree({
      run_id: ctx.runId,
      identity: ctx.identity,
      teammate_id: "builder@alpha-team",
      team_name: "alpha-team"
    });

    expect(outcome.status).toBe("merged");
    expect(outcome.merge_commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(outcome.cleanup).toBe("removed");

    const run = readRun(ctx.db);
    expect(run.review_status).toBe("merged");
    expect(run.merge_commit).toBe(outcome.merge_commit);
    expect(run.merged_at).toBeTruthy();
    expect(run.merged_by_caller_key).toBe(ctx.identity.callerKey);

    // O-2: clean worktree removed; leader now carries the teammate's change.
    expect(existsSync(ctx.workspacePath)).toBe(false);
    expect(existsSync(path.join(leaderRoot, "feature.txt"))).toBe(true);

    // R3/G-1: targeted UPDATE did NOT rewrite metadata_json — pane marker intact.
    const metadata = JSON.parse(run.metadata_json) as Record<string, unknown>;
    const backendMetadata = metadata.backend_metadata as Record<string, unknown>;
    expect((backendMetadata.pane as Record<string, unknown>).pane_id).toBe("%1");

    // Auditable event chain.
    const events = readEvents(ctx.db);
    const types = events.map((row) => row.event_type);
    expect(types).toContain(EVENT_TYPES.workspaceMergeRequested);
    expect(types).toContain(EVENT_TYPES.workspaceMergeCompleted);
    const cleaned = events.find(
      (row) => row.event_type === EVENT_TYPES.workspaceWorktreeCleaned
    );
    expect(JSON.parse(cleaned?.payload_json ?? "{}").cleanup_status).toBe("removed");

    // Redaction: no prompt/secret/diff content in any event payload.
    expect(JSON.stringify(events)).not.toContain(SECRET_MERGE_PROMPT);
    expect(JSON.stringify(events)).not.toContain("implemented by teammate");

    ctx.adapter.close();
  });

  it("fails closed on conflict: merge_conflict status, conflict files, leader clean, worktree preserved", () => {
    const leaderRoot = createTempGitLeader();
    const ctx = startWorktreeRun(leaderRoot, "writer");

    // Worktree edits tracked.txt; leader advances HEAD with a conflicting edit.
    writeFileSync(path.join(ctx.workspacePath, "tracked.txt"), "worktree change\n");
    writeFileSync(path.join(leaderRoot, "tracked.txt"), "leader change\n");
    execGit(leaderRoot, ["add", "tracked.txt"]);
    execGit(leaderRoot, ["commit", "-m", "leader conflicting change"]);

    const lifecycle = new LifecycleService({ db: ctx.db, statePath: ctx.statePath });
    const outcome = lifecycle.mergeWorktree({
      run_id: ctx.runId,
      identity: ctx.identity,
      teammate_id: "writer@alpha-team"
    });

    expect(outcome.status).toBe("conflict");
    expect(outcome.conflict_files).toContain("tracked.txt");

    const run = readRun(ctx.db);
    expect(run.review_status).toBe("merge_conflict");
    expect(JSON.parse(run.merge_conflict_files_json ?? "[]")).toContain("tracked.txt");

    // Leader rolled back clean; worktree preserved.
    expect(execGit(leaderRoot, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(ctx.workspacePath)).toBe(true);

    const types = readEvents(ctx.db).map((row) => row.event_type);
    expect(types).toContain(EVENT_TYPES.workspaceMergeConflict);

    ctx.adapter.close();
  });

  it("escalates to human, preserving the worktree and recording an auditable event", () => {
    const leaderRoot = createTempGitLeader();
    const ctx = startWorktreeRun(leaderRoot, "escalator");
    writeFileSync(path.join(ctx.workspacePath, "feature.txt"), "wip\n");

    const lifecycle = new LifecycleService({ db: ctx.db, statePath: ctx.statePath });
    const outcome = lifecycle.escalateWorktree({
      run_id: ctx.runId,
      identity: ctx.identity,
      teammate_id: "escalator@alpha-team"
    });

    expect(outcome.status).toBe("escalated");
    expect(outcome.review_status).toBe("escalated_to_human");

    const run = readRun(ctx.db);
    expect(run.review_status).toBe("escalated_to_human");
    // No destructive action: worktree preserved.
    expect(existsSync(ctx.workspacePath)).toBe(true);

    const types = readEvents(ctx.db).map((row) => row.event_type);
    expect(types).toContain(EVENT_TYPES.workspaceMergeEscalated);

    ctx.adapter.close();
  });

  it("rejects a non-isolated run with a precise error and no side-effects", () => {
    const leaderRoot = createTempGitLeader();
    const identity = createIdentity(leaderRoot);
    const adapter = new DurableStateAdapter({
      stateRoot: createTempRoot("codex-team-lcmerge-state-"),
      workspaceRoot: identity.workspaceRoot
    });
    const statePath = adapter.describeStateRoot().stateRoot;
    const db = adapter.getDatabase();
    new TeamService({ db, statePath }).createTeam({
      teamName: "Alpha Team",
      description: "Merge test team",
      identity
    });

    // A read-only run never reaches isolation, so it is not a valid merge target.
    new AgentService({
      db,
      statePath,
      executionBackend: new FakeWorkspaceBackend()
    }).createAgent({
      name: "Reader",
      teamName: "alpha-team",
      mode: "read",
      prompt: "read only",
      description: "read",
      identity
    });
    const run = readRun(db);

    const lifecycle = new LifecycleService({ db, statePath });
    const outcome = lifecycle.mergeWorktree({ run_id: run.run_id, identity });

    expect(outcome.status).toBe("error");
    expect(outcome.error_code).toBe("merge_target_not_isolated");

    adapter.close();
  });
});
