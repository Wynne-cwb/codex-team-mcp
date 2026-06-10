/**
 * Phase 12 SC#3 end-to-end acceptance walkthrough (D-02 deterministic surrogate).
 *
 * Uses a FAKE execution backend + a REAL temp git leader repo / worktree / merge
 * — it never shells out to real codex/tmux, so it is deterministic in CI. The
 * maintainer's real-codex + real-git UAT (D-02 proof-first) is documented in the
 * phase SUMMARY and is NOT replaced by this automated walkthrough.
 *
 * Chain covered: TeamCreate → Agent (isolated worktree start, sandbox overlay) →
 * real file write in the worktree → durable backend metadata → SendMessage resume
 * → TeamDiagnostics → TL TeamMerge review→merge (+ O-2 cleanup) → conflict path →
 * human-escalation path → unavailable-with-remediation → pane fallback. The whole
 * chain asserts redaction (no prompt / secret / diff content leaks).
 */
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
import { ScaffoldExecutionBackend } from "../src/adapters/execution.js";
import type {
  PaneBackendMetadata,
  PaneBackendRegistry,
  PaneLaunchResult,
  PaneReconcileResult
} from "../src/adapters/paneBackend.js";
import { buildDiagnosticsPayload } from "../src/diagnostics.js";
import { normalizeCallerMetadata } from "../src/context/caller.js";
import { AgentService } from "../src/services/agentService.js";
import { buildWorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";
import { LifecycleService } from "../src/services/lifecycleService.js";
import { TeamService } from "../src/services/teamService.js";
import { WorkspaceSafetyService } from "../src/services/workspaceSafetyService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { COMPATIBILITY_TOOLS, TARGET_CLAUDE_TOOLS } from "../src/tools/registry.js";
import { EVENT_TYPES, MEMBER_STATUSES, TABLE_NAMES } from "../src/state/schema.js";

const tempRoots: string[] = [];
const SECRET_WALKTHROUGH_PROMPT = "SECRET_PHASE12_WALKTHROUGH_PROMPT";

interface RunRow {
  run_id: string;
  status: string;
  member_id: string | null;
  isolation_kind: string | null;
  review_status: string | null;
  workspace_path: string | null;
  base_revision: string | null;
  worktree_branch: string | null;
  backend_thread_id: string | null;
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
  const leaderRoot = createTempRoot("codex-team-accept-leader-");
  execGit(leaderRoot, ["init"]);
  execGit(leaderRoot, ["config", "user.email", "test@example.com"]);
  execGit(leaderRoot, ["config", "user.name", "Codex Test"]);
  writeFileSync(path.join(leaderRoot, "tracked.txt"), "base\n");
  execGit(leaderRoot, ["add", "tracked.txt"]);
  execGit(leaderRoot, ["commit", "-m", "base"]);
  return leaderRoot;
}

class FakeWalkthroughBackend implements ExecutionBackend {
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
      backend_run_id: "thread-accept",
      thread_id: "thread-accept",
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
      status: "resumed" as const,
      delivery_status: "backend_resume_attempted" as const,
      backend: "codex_cli_exec",
      backend_status: "idle" as const,
      backend_run_id: "thread-accept",
      thread_id: "thread-accept",
      started_at: "2026-06-10T00:01:00.000Z",
      ended_at: "2026-06-10T00:01:01.000Z",
      turn_completed: true,
      final_backend_status: "idle" as const
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

class FakeUnavailablePaneBackend implements PaneBackendRegistry {
  describeAvailability(): PaneBackendMetadata {
    return {
      mode: "pane",
      backend_type: "tmux",
      availability_status: "unavailable",
      degradation_reason: "tmux command unavailable"
    };
  }

  createPane(): PaneLaunchResult {
    throw new Error("createPane must not be called when terminal is unavailable");
  }

  resumePane(): PaneLaunchResult {
    throw new Error("resumePane must not be called when terminal is unavailable");
  }

  reconcilePane(context: ExecutionRunContext): PaneReconcileResult {
    return { status: "unsupported", pane: this.describeAvailability(), deleted: false };
  }
}

function createIdentity(workspaceRoot: string): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata({ sessionId: "accept-session" })
  });
}

interface Harness {
  identity: WorkspaceScopedCallerIdentity;
  adapter: DurableStateAdapter;
  statePath: string;
  db: Database.Database;
  leaderRoot: string;
}

function setupHarness(): Harness {
  const leaderRoot = createTempGitLeader();
  const identity = createIdentity(leaderRoot);
  const adapter = new DurableStateAdapter({
    stateRoot: createTempRoot("codex-team-accept-state-"),
    workspaceRoot: identity.workspaceRoot
  });
  const statePath = adapter.describeStateRoot().stateRoot;
  new TeamService({ db: adapter.getDatabase(), statePath }).createTeam({
    teamName: "Alpha Team",
    description: "Acceptance walkthrough team",
    identity
  });
  return { identity, adapter, statePath, db: adapter.getDatabase(), leaderRoot };
}

function createWorktreeTeammate(
  harness: Harness,
  name: string
): { runId: string; memberId: string; teammateId: string; run: RunRow } {
  const result = new AgentService({
    db: harness.db,
    statePath: harness.statePath,
    executionBackend: new FakeWalkthroughBackend()
  }).createAgent({
    name,
    teamName: "alpha-team",
    mode: "code",
    prompt: `implement feature ${SECRET_WALKTHROUGH_PROMPT}`,
    description: "code implementation",
    identity: harness.identity
  });
  return {
    runId: result.run_id,
    memberId: String(result.debug.internal_member_id),
    teammateId: result.teammate_id,
    run: readRunById(harness.db, result.run_id)
  };
}

function readRunById(db: Database.Database, runId: string): RunRow {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} WHERE run_id = ?`)
    .get(runId) as RunRow;
}

function readEventTypes(db: Database.Database): string[] {
  return (
    db
      .prepare(`SELECT event_type FROM ${TABLE_NAMES.events} ORDER BY created_at, event_id`)
      .all() as Array<{ event_type: string }>
  ).map((row) => row.event_type);
}

function serializeAllEvents(db: Database.Database): string {
  return JSON.stringify(
    db.prepare(`SELECT payload_json FROM ${TABLE_NAMES.events}`).all()
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Phase 12 execution acceptance walkthrough (SC#3, deterministic)", () => {
  it("runs the file-modifying chain: worktree start → write → resume → diagnostics → TL merge → cleanup", () => {
    const harness = setupHarness();

    // 1–2. TeamCreate (setup) + Agent isolated worktree start with sandbox overlay.
    const teammate = createWorktreeTeammate(harness, "Builder");
    expect(teammate.run.isolation_kind).toBe("git_worktree");
    expect(teammate.run.review_status).toBe("pending_review");
    expect(teammate.run.workspace_path).toBeTruthy();
    expect(teammate.run.base_revision).toBeTruthy();
    expect(teammate.run.worktree_branch).toMatch(/^codex-team\/alpha-team\/builder\//);
    expect(JSON.parse(teammate.run.metadata_json).sandbox_overlay).toBe(true);
    expect(readEventTypes(harness.db)).toContain(
      EVENT_TYPES.workspaceIsolationCreated
    );
    const workspacePath = String(teammate.run.workspace_path);

    // 3. Real file write in the worktree → inspectWorkspace detects changes.
    writeFileSync(path.join(workspacePath, "feature.txt"), "implemented by builder\n");
    const inspection = new WorkspaceSafetyService().inspectWorkspace({
      workspace_path: workspacePath,
      base_revision: teammate.run.base_revision
    });
    expect(inspection.status).toBe("changes_detected");
    expect(inspection.review_status).toBe("needs_review");
    expect(inspection.changed_files_json).toContain("feature.txt");

    // 4. Durable backend metadata captured.
    expect(teammate.run.backend_thread_id).toBe("thread-accept");
    expect(teammate.run.status).toBe(MEMBER_STATUSES.idle);

    // 5. SendMessage resume (idle teammate) → honest resume path, no mid-turn claim.
    const lifecycle = new LifecycleService({
      db: harness.db,
      statePath: harness.statePath,
      executionBackend: new FakeWalkthroughBackend()
    });
    const resume = lifecycle.resumeRun({
      team_id: readTeamId(harness.db, teammate.runId),
      team_name: "alpha-team",
      member_id: teammate.memberId,
      run_id: teammate.runId,
      teammate_id: teammate.teammateId,
      prompt_present: false,
      message_id: "msg-accept-1",
      recipient_status: MEMBER_STATUSES.idle,
      trigger_kind: "message",
      identity: harness.identity
    });
    expect(resume.delivery_status).toBe("backend_resume_attempted");
    expect(readEventTypes(harness.db)).toContain(
      EVENT_TYPES.teammateBackendResumeAttempted
    );

    // 6. Real TeamDiagnostics (default + include_debug).
    const diagnostics = buildDiagnosticsPayload({
      stateRoot: harness.statePath,
      workspaceRoot: harness.identity.workspaceRoot,
      callerMetadata: { sessionId: "accept-session" },
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(diagnostics.workspaceReviewSummary.with_workspace_path).toBeGreaterThanOrEqual(1);
    const debugRun = (diagnostics.debug?.runs ?? []).find(
      (row) => row.run_id === teammate.runId
    );
    expect(debugRun?.worktree_branch).toMatch(/^codex-team\/alpha-team\/builder\//);

    // 7. TL TeamMerge review → merge.
    const review = lifecycle.reviewWorktree({
      run_id: teammate.runId,
      identity: harness.identity,
      teammate_id: teammate.teammateId
    });
    expect(review.status).toBe("reviewed");
    expect(review.changed_files).toContain("feature.txt");

    const merge = lifecycle.mergeWorktree({
      run_id: teammate.runId,
      identity: harness.identity,
      teammate_id: teammate.teammateId,
      team_name: "alpha-team"
    });
    expect(merge.status).toBe("merged");
    expect(merge.cleanup).toBe("removed");
    expect(existsSync(path.join(harness.leaderRoot, "feature.txt"))).toBe(true);
    expect(existsSync(workspacePath)).toBe(false);

    const eventTypes = readEventTypes(harness.db);
    expect(eventTypes).toContain(EVENT_TYPES.workspaceMergeRequested);
    expect(eventTypes).toContain(EVENT_TYPES.workspaceMergeCompleted);
    expect(eventTypes).toContain(EVENT_TYPES.workspaceWorktreeCleaned);

    // Post-merge diagnostics reflect the merged outcome.
    const postMerge = buildDiagnosticsPayload({
      stateRoot: harness.statePath,
      workspaceRoot: harness.identity.workspaceRoot,
      callerMetadata: { sessionId: "accept-session" },
      includeDebug: true,
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    expect(postMerge.workspaceReviewSummary.merged).toBeGreaterThanOrEqual(1);

    // Redaction across the whole durable chain.
    expect(serializeAllEvents(harness.db)).not.toContain(SECRET_WALKTHROUGH_PROMPT);
    expect(serializeAllEvents(harness.db)).not.toContain("implemented by builder");
    expect(JSON.stringify(diagnostics)).not.toContain(SECRET_WALKTHROUGH_PROMPT);

    harness.adapter.close();
  });

  it("fails closed on a merge conflict and supports human escalation", () => {
    const harness = setupHarness();
    const teammate = createWorktreeTeammate(harness, "Writer");
    const workspacePath = String(teammate.run.workspace_path);

    // Conflicting edits: worktree vs an advanced leader HEAD.
    writeFileSync(path.join(workspacePath, "tracked.txt"), "worktree change\n");
    writeFileSync(path.join(harness.leaderRoot, "tracked.txt"), "leader change\n");
    execGit(harness.leaderRoot, ["add", "tracked.txt"]);
    execGit(harness.leaderRoot, ["commit", "-m", "leader conflicting change"]);

    const lifecycle = new LifecycleService({
      db: harness.db,
      statePath: harness.statePath,
      executionBackend: new FakeWalkthroughBackend()
    });

    const conflict = lifecycle.mergeWorktree({
      run_id: teammate.runId,
      identity: harness.identity,
      teammate_id: teammate.teammateId
    });
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflict_files).toContain("tracked.txt");
    // Leader rolled back clean; worktree preserved for resolution.
    expect(execGit(harness.leaderRoot, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(workspacePath)).toBe(true);
    expect(readRunById(harness.db, teammate.runId).review_status).toBe("merge_conflict");

    // Escalate to a human (no destructive action; worktree preserved).
    const escalate = lifecycle.escalateWorktree({
      run_id: teammate.runId,
      identity: harness.identity,
      teammate_id: teammate.teammateId
    });
    expect(escalate.status).toBe("escalated");
    expect(readRunById(harness.db, teammate.runId).review_status).toBe(
      "escalated_to_human"
    );
    expect(existsSync(workspacePath)).toBe(true);

    const eventTypes = readEventTypes(harness.db);
    expect(eventTypes).toContain(EVENT_TYPES.workspaceMergeConflict);
    expect(eventTypes).toContain(EVENT_TYPES.workspaceMergeEscalated);

    harness.adapter.close();
  });

  it("blocks file-modifying work with a visible remediation surface when no backend is available", () => {
    const harness = setupHarness();

    // ScaffoldExecutionBackend = no execution backend (unavailable).
    const result = new AgentService({
      db: harness.db,
      statePath: harness.statePath,
      executionBackend: new ScaffoldExecutionBackend()
    }).createAgent({
      name: "Blocked",
      teamName: "alpha-team",
      mode: "code",
      prompt: `implement ${SECRET_WALKTHROUGH_PROMPT}`,
      description: "code implementation",
      identity: harness.identity
    });

    // The run never starts a real backend; it stays scheduled/blocked.
    expect(result.status).not.toBe("idle");
    expect(readRunById(harness.db, result.run_id).status).toBe(
      MEMBER_STATUSES.scheduled
    );

    const diagnostics = buildDiagnosticsPayload({
      stateRoot: harness.statePath,
      workspaceRoot: harness.identity.workspaceRoot,
      callerMetadata: { sessionId: "accept-session" },
      targetClaudeTools: TARGET_CLAUDE_TOOLS,
      registeredTools: COMPATIBILITY_TOOLS
    });
    // Honest unavailable surface + remediation guidance (the backend limitation).
    expect(diagnostics.execution.status).toBe("scheduled_only");
    expect(String(diagnostics.execution.limitation)).toContain("unsupported");
    const blocked = diagnostics.teammates.find(
      (mate) => mate.display_name === "Blocked"
    );
    expect(blocked?.status).toBe("unavailable");

    expect(JSON.stringify(diagnostics)).not.toContain(SECRET_WALKTHROUGH_PROMPT);

    harness.adapter.close();
  });

  it("keeps the core run and merge unaffected when the pane backend is unavailable (pane fallback)", () => {
    const harness = setupHarness();

    const result = new AgentService({
      db: harness.db,
      statePath: harness.statePath,
      executionBackend: new FakeWalkthroughBackend(),
      paneMode: { enabled: true },
      paneBackend: new FakeUnavailablePaneBackend()
    }).createAgent({
      name: "Paney",
      teamName: "alpha-team",
      mode: "code",
      prompt: `implement ${SECRET_WALKTHROUGH_PROMPT}`,
      description: "code implementation",
      identity: harness.identity
    });

    // Core run is unaffected by the unavailable pane: it still ran to completion
    // in an isolated worktree.
    expect(result.status).toBe("idle");
    const run = readRunById(harness.db, result.run_id);
    expect(run.isolation_kind).toBe("git_worktree");

    // A degraded/unavailable pane marker is recorded — never affecting the core run.
    const pane = (JSON.parse(run.metadata_json).backend_metadata as Record<string, unknown>)
      ?.pane as Record<string, unknown> | undefined;
    expect(pane?.availability_status).toBe("unavailable");

    // The merge still works despite the pane being unavailable.
    writeFileSync(path.join(String(run.workspace_path), "feature.txt"), "impl\n");
    const lifecycle = new LifecycleService({
      db: harness.db,
      statePath: harness.statePath,
      executionBackend: new FakeWalkthroughBackend(),
      paneMode: { enabled: true },
      paneBackend: new FakeUnavailablePaneBackend()
    });
    const merge = lifecycle.mergeWorktree({
      run_id: result.run_id,
      identity: harness.identity,
      teammate_id: result.teammate_id
    });
    expect(merge.status).toBe("merged");

    harness.adapter.close();
  });
});

function readTeamId(db: Database.Database, runId: string): string {
  const row = db
    .prepare(`SELECT team_id FROM ${TABLE_NAMES.runs} WHERE run_id = ?`)
    .get(runId) as { team_id: string };
  return row.team_id;
}
