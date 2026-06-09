import { mkdtempSync, rmSync } from "node:fs";
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
import { TeamService } from "../src/services/teamService.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { EVENT_TYPES, MEMBER_STATUSES, TABLE_NAMES } from "../src/state/schema.js";
import type { WorkspaceScopedCallerIdentity } from "../src/services/callerIdentity.js";

const tempRoots: string[] = [];
const SECRET_PHASE5_PROMPT = "SECRET_PHASE5_PROMPT";

interface TeamRow {
  team_id: string;
  canonical_name: string;
  workspace_root: string;
}

interface MemberRow {
  member_id: string;
  team_id: string;
  display_name: string;
  role: string;
  agent_type: string | null;
  model_hint: string | null;
  status: string;
  caller_key: string | null;
  workspace_root: string;
  metadata_json: string;
}

interface RunRow {
  run_id: string;
  team_id: string;
  member_id: string | null;
  status: string;
  backend: string | null;
  workspace_path: string | null;
  metadata_json: string;
  last_error: string | null;
  backend_status: string | null;
  backend_run_id: string | null;
  backend_thread_id: string | null;
  backend_process_id: string | null;
  work_classification: string | null;
  isolation_kind: string | null;
  base_revision: string | null;
  review_status: string | null;
}

interface EventRow {
  event_type: string;
  error_code: string | null;
  payload_json: string;
}

function createTempStateRoot(): string {
  const stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-agent-service-"));
  tempRoots.push(stateRoot);
  return stateRoot;
}

function createIdentity(
  workspaceRoot: string,
  metadata: unknown = { sessionId: "session-1", threadId: "thread-1" }
): WorkspaceScopedCallerIdentity {
  return buildWorkspaceScopedCallerIdentity({
    workspaceRoot,
    caller: normalizeCallerMetadata(metadata)
  });
}

function createTeamService(adapter: DurableStateAdapter): TeamService {
  return new TeamService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot
  });
}

function createAgentService(
  adapter: DurableStateAdapter,
  executionBackend?: ExecutionBackend
): AgentService {
  return new AgentService({
    db: adapter.getDatabase(),
    statePath: adapter.describeStateRoot().stateRoot,
    executionBackend
  });
}

function createAlphaTeam(adapter: DurableStateAdapter, identity: WorkspaceScopedCallerIdentity) {
  return createTeamService(adapter).createTeam({
    teamName: "Alpha Team",
    description: "Agent service test team",
    identity
  });
}

function readTeam(db: Database.Database, canonicalName: string): TeamRow {
  return db
    .prepare(
      `SELECT team_id, canonical_name, workspace_root
       FROM ${TABLE_NAMES.teams}
       WHERE canonical_name = ?`
    )
    .get(canonicalName) as TeamRow;
}

function readMember(db: Database.Database, memberId: string): MemberRow {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.members} WHERE member_id = ?`)
    .get(memberId) as MemberRow;
}

function readRuns(db: Database.Database): RunRow[] {
  return db
    .prepare(`SELECT * FROM ${TABLE_NAMES.runs} ORDER BY created_at, run_id`)
    .all() as RunRow[];
}

function nonLeaderMemberCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM ${TABLE_NAMES.members}
       WHERE role != 'leader'`
    )
    .get() as { count: number };

  return row.count;
}

function runCount(db: Database.Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAMES.runs}`)
    .get() as { count: number };

  return row.count;
}

function eventRows(db: Database.Database): EventRow[] {
  return db
    .prepare(
      `SELECT event_type, error_code, payload_json
       FROM ${TABLE_NAMES.events}
       ORDER BY created_at, event_id`
    )
    .all() as EventRow[];
}

class FakeStartBackend implements ExecutionBackend {
  readonly startCalls: ExecutionRunContext[] = [];

  constructor(
    private readonly options: {
      supportsWorkspaces?: boolean;
      supportsReviewDiff?: boolean;
      action?: "started" | "backend_failed";
      lastError?: string;
      throwOnStart?: boolean;
    } = {}
  ) {}

  describeBackend(): ExecutionBackendDescription {
    const capabilities = {
      canStart: true,
      canResume: false,
      canReconcile: false,
      supportsWorkspaces: this.options.supportsWorkspaces === true,
      supportsReviewDiff: this.options.supportsReviewDiff === true
    } as ExecutionBackendDescription["capabilities"] & {
      supportsReviewDiff: boolean;
    };

    return {
      status: "available",
      teammateExecutionImplemented: true,
      backend: "fake",
      backend_status: "running",
      capabilities
    };
  }

  startRun(context: ExecutionRunContext) {
    this.startCalls.push(context);

    if (this.options.throwOnStart) {
      throw new Error(this.options.lastError ?? "fake backend start threw");
    }

    if (this.options.action === "backend_failed") {
      return {
        status: "backend_failed" as const,
        delivery_status: "backend_failed" as const,
        backend: "fake",
        backend_status: "failed" as const,
        last_error: this.options.lastError ?? "fake backend failed"
      };
    }

    return {
      status: "started" as const,
      delivery_status: "backend_start_attempted" as const,
      backend: "fake",
      backend_status: "running" as const,
      backend_run_id: "backend-run-1",
      thread_id: "thread-1",
      process_id: "process-1",
      workspace_path: context.workspace_path ?? undefined,
      started_at: "2026-06-05T00:00:00.000Z"
    };
  }

  resumeRun() {
    return {
      status: "unsupported" as const,
      delivery_status: "backend_unavailable" as const,
      backend: "fake",
      backend_status: "stopped" as const,
      last_error: "resume unsupported in test backend"
    };
  }

  reconcileRun() {
    return {
      status: "unsupported" as const,
      backend: "fake",
      backend_status: "unknown" as const
    };
  }
}

afterEach(() => {
  for (const stateRoot of tempRoots.splice(0)) {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

describe("AgentService.createAgent", () => {
  it("creates a scheduled TeamMate through explicit team_name", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);

    const result = createAgentService(adapter).createAgent({
      name: "Builder",
      teamName: "Alpha Team",
      mode: "write",
      prompt: "Implement the scheduled TeamMate contract",
      description: "Create the durable builder teammate",
      modelHint: "gpt-5",
      agentType: "developer",
      subagentType: "implementation",
      runInBackground: true,
      isolation: "worktree",
      cwd: "/workspace/project",
      identity
    });

    expect(result).toMatchObject({
      status: "scheduled",
      teammate_id: "builder@alpha-team",
      team_name: "alpha-team",
      display_name: "Builder",
      run_id: expect.stringMatching(/^run:/),
      backend: {
        status: "not_started",
        backend: "none",
        execution_available: false,
        teammate_execution_implemented: false
      },
      debug: {
        internal_member_id: expect.stringMatching(/^teammate:/),
        team_resolution: "explicit"
      }
    });

    const db = adapter.getDatabase();
    const member = readMember(db, String(result.debug.internal_member_id));
    expect(member).toMatchObject({
      role: "teammate",
      display_name: "Builder",
      agent_type: "developer",
      model_hint: "gpt-5",
      status: MEMBER_STATUSES.scheduled,
      caller_key: identity.callerKey,
      workspace_root: identity.workspaceRoot
    });
    expect(JSON.parse(member.metadata_json)).toMatchObject({
      publicTeammateId: "builder@alpha-team",
      canonicalName: "builder",
      backend_status: "not_started",
      execution_available: false,
      mode: "write",
      subagentType: "implementation",
      runInBackground: true,
      isolation: "worktree",
      cwd: "/workspace/project"
    });

    const runs = readRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      run_id: result.run_id,
      member_id: result.debug.internal_member_id,
      status: MEMBER_STATUSES.scheduled,
      backend: "none",
      workspace_path: null
    });
    expect(JSON.parse(runs[0]?.metadata_json ?? "{}")).toMatchObject({
      backend_status: "not_started",
      execution_available: false,
      teammate_execution_implemented: false,
      publicTeammateId: "builder@alpha-team",
      prompt_present: true
    });
    expect(eventRows(db)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: EVENT_TYPES.teammateCreated }),
        expect.objectContaining({ event_type: EVENT_TYPES.teammateRunScheduled })
      ])
    );

    adapter.close();
  });

  it("classifies code implementation work as isolated and pending review", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({ supportsWorkspaces: true });
    const workspacePath = "/tmp/codex-team-builder-worktree";

    const result = createAgentService(adapter, backend).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "implementation",
      prompt: SECRET_PHASE5_PROMPT,
      description: "Implement code in an isolated worktree",
      isolation: "worktree",
      workspacePath,
      baseRevision: "abc123",
      identity
    });

    expect(result).toMatchObject({
      status: "running",
      delivery_status: "backend_start_attempted",
      teammate_id: "builder@alpha-team",
      backend: {
        status: "running",
        backend: "fake",
        execution_available: true,
        teammate_execution_implemented: true,
        backend_run_id: "backend-run-1",
        workspace_path: path.resolve(workspacePath)
      },
      lifecycle: {
        work_classification: "code_implementation",
        isolation_kind: "git_worktree",
        workspace_path: path.resolve(workspacePath),
        base_revision: "abc123",
        review_status: "pending_review"
      }
    });
    expect(backend.startCalls).toHaveLength(1);
    expect(backend.startCalls[0]).toMatchObject({
      prompt_present: true,
      work_classification: "code_implementation",
      isolation_kind: "git_worktree",
      workspace_path: path.resolve(workspacePath)
    });
    expect(backend.startCalls[0]?.metadata).toMatchObject({
      prompt: SECRET_PHASE5_PROMPT,
      base_revision: "abc123"
    });

    const runs = readRuns(adapter.getDatabase());
    expect(runs[0]).toMatchObject({
      status: MEMBER_STATUSES.running,
      backend: "fake",
      workspace_path: path.resolve(workspacePath),
      backend_status: "running",
      backend_run_id: "backend-run-1",
      backend_thread_id: "thread-1",
      backend_process_id: "process-1",
      work_classification: "code_implementation",
      isolation_kind: "git_worktree",
      base_revision: "abc123",
      review_status: "pending_review"
    });
    expect(eventRows(adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: EVENT_TYPES.teammateBackendStartAttempted
        }),
        expect.objectContaining({
          event_type: EVENT_TYPES.teammateLifecycleTransition
        })
      ])
    );

    adapter.close();
  });

  it("blocks code implementation start when backend lacks workspace or review diff support", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({
      supportsWorkspaces: false,
      supportsReviewDiff: false
    });

    const result = createAgentService(adapter, backend).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "code",
      prompt: "Implement without supported isolation",
      description: "Implement code",
      isolation: "worktree",
      workspacePath: "/tmp/codex-team-builder-worktree",
      baseRevision: "abc123",
      identity
    });

    expect(backend.startCalls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "scheduled",
      delivery_status: "backend_unavailable",
      error_code: "workspace_isolation_required",
      lifecycle: {
        work_classification: "code_implementation",
        review_status: "needs_review"
      }
    });
    const runs = readRuns(adapter.getDatabase());
    expect(runs[0]).toMatchObject({
      status: MEMBER_STATUSES.scheduled,
      workspace_path: null,
      last_error: "workspace_isolation_required",
      work_classification: "code_implementation",
      review_status: "needs_review"
    });
    expect(runs[0]?.workspace_path).not.toBe(identity.workspaceRoot);
    expect(JSON.stringify(eventRows(adapter.getDatabase()))).toContain(
      "workspace_isolation_required"
    );

    adapter.close();
  });

  it("classifies mixed review and fix prompts as code implementation", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({ supportsWorkspaces: true });
    const workspacePath = "/tmp/codex-team-review-fix-worktree";

    const result = createAgentService(adapter, backend).createAgent({
      name: "Fixer",
      teamName: "alpha-team",
      prompt: "review this module and fix the bug",
      description: "audit the regression and patch the failing code",
      workspacePath,
      baseRevision: "abc123",
      identity
    });

    expect(backend.startCalls).toHaveLength(1);
    expect(backend.startCalls[0]).toMatchObject({
      work_classification: "code_implementation",
      isolation_kind: "git_worktree",
      workspace_path: path.resolve(workspacePath)
    });
    expect(result).toMatchObject({
      status: "running",
      delivery_status: "backend_start_attempted",
      lifecycle: {
        work_classification: "code_implementation",
        isolation_kind: "git_worktree",
        review_status: "pending_review"
      }
    });

    adapter.close();
  });

  it("blocks mixed review and fix prompts without concrete isolation", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({
      supportsWorkspaces: true,
      supportsReviewDiff: true
    });
    const prompt = `${SECRET_PHASE5_PROMPT} review this module and fix the bug`;

    const result = createAgentService(adapter, backend).createAgent({
      name: "Fixer",
      teamName: "alpha-team",
      prompt,
      description: "review the regression and patch it",
      identity
    });

    expect(backend.startCalls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "scheduled",
      delivery_status: "backend_unavailable",
      error_code: "workspace_isolation_required",
      lifecycle: {
        work_classification: "code_implementation",
        review_status: "needs_review"
      }
    });
    expect(readRuns(adapter.getDatabase())[0]).toMatchObject({
      status: MEMBER_STATUSES.scheduled,
      workspace_path: null,
      last_error: "workspace_isolation_required",
      work_classification: "code_implementation",
      review_status: "needs_review"
    });
    const serializedEvents = JSON.stringify(eventRows(adapter.getDatabase()));
    expect(serializedEvents).toContain("workspace_isolation_required");
    expect(serializedEvents).not.toContain(prompt);
    expect(serializedEvents).not.toContain(SECRET_PHASE5_PROMPT);

    adapter.close();
  });

  it("blocks mixed review and destructive write prompts without concrete isolation", () => {
    const cases = [
      "review this module and remove dead code",
      "audit and delete the obsolete file",
      "inspect then add tests",
      "read this module and rename the symbol",
      "review and make changes",
      "audit and build the migration",
      "review and write tests",
      "review and create tests",
      "audit and create a migration"
    ];

    for (const prompt of cases) {
      const identity = createIdentity("/workspace/project");
      const adapter = new DurableStateAdapter({
        stateRoot: createTempStateRoot(),
        workspaceRoot: identity.workspaceRoot
      });
      createAlphaTeam(adapter, identity);
      const backend = new FakeStartBackend({
        supportsWorkspaces: true,
        supportsReviewDiff: true
      });

      const result = createAgentService(adapter, backend).createAgent({
        name: `Fixer ${cases.indexOf(prompt)}`,
        teamName: "alpha-team",
        prompt,
        description: "review before changing files",
        identity
      });

      expect(backend.startCalls).toHaveLength(0);
      expect(result).toMatchObject({
        status: "scheduled",
        delivery_status: "backend_unavailable",
        error_code: "workspace_isolation_required",
        lifecycle: {
          work_classification: "code_implementation",
          review_status: "needs_review"
        }
      });
      expect(readRuns(adapter.getDatabase())[0]).toMatchObject({
        status: MEMBER_STATUSES.scheduled,
        last_error: "workspace_isolation_required",
        work_classification: "code_implementation",
        review_status: "needs_review"
      });

      adapter.close();
    }
  });

  it("classifies ambiguous prompts conservatively and blocks backend start", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({
      supportsWorkspaces: true,
      supportsReviewDiff: true
    });

    const result = createAgentService(adapter, backend).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: "make this better",
      description: "handle the problem in the module",
      identity
    });

    expect(backend.startCalls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "scheduled",
      delivery_status: "backend_unavailable",
      error_code: "workspace_isolation_required",
      lifecycle: {
        work_classification: "code_implementation",
        review_status: "needs_review"
      }
    });
    expect(readRuns(adapter.getDatabase())[0]).toMatchObject({
      status: MEMBER_STATUSES.scheduled,
      last_error: "workspace_isolation_required",
      work_classification: "code_implementation",
      review_status: "needs_review"
    });
    expect(JSON.stringify(eventRows(adapter.getDatabase()))).toContain(
      "workspace_isolation_required"
    );

    adapter.close();
  });

  it("blocks code implementation start when workspace support lacks a concrete workspace path", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({ supportsWorkspaces: true });

    const result = createAgentService(adapter, backend).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "implementation",
      prompt: "Implement without concrete workspace",
      description: "Implement code",
      isolation: "worktree",
      cwd: "/workspace/project",
      baseRevision: "abc123",
      identity
    });

    expect(backend.startCalls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "scheduled",
      delivery_status: "backend_unavailable",
      error_code: "workspace_isolation_required",
      lifecycle: {
        work_classification: "code_implementation",
        review_status: "needs_review"
      }
    });
    expect(readRuns(adapter.getDatabase())[0]).toMatchObject({
      workspace_path: null,
      last_error: "workspace_isolation_required"
    });

    adapter.close();
  });

  it("blocks code implementation start when review diff support lacks an artifact path", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({ supportsReviewDiff: true });

    const result = createAgentService(adapter, backend).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      mode: "code",
      prompt: "Implement without concrete review diff",
      description: "Implement code",
      baseRevision: "abc123",
      identity
    });

    expect(backend.startCalls).toHaveLength(0);
    expect(result).toMatchObject({
      status: "scheduled",
      delivery_status: "backend_unavailable",
      error_code: "workspace_isolation_required",
      lifecycle: {
        work_classification: "code_implementation",
        review_status: "needs_review"
      }
    });
    expect(JSON.stringify(eventRows(adapter.getDatabase()))).toContain(
      "workspace_isolation_required"
    );

    adapter.close();
  });

  it("starts a scheduled TeamMate when the backend supports start", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend();

    const result = createAgentService(adapter, backend).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      prompt: "Research current status",
      description: "read-only status check",
      identity
    });

    expect(backend.startCalls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "running",
      delivery_status: "backend_start_attempted",
      backend: {
        status: "running",
        backend: "fake",
        execution_available: true,
        teammate_execution_implemented: true
      },
      lifecycle: {
        work_classification: "read_only",
        isolation_kind: "none",
        review_status: "none"
      }
    });
    expect(readMember(adapter.getDatabase(), String(result.debug.internal_member_id))).toMatchObject({
      status: MEMBER_STATUSES.running
    });
    expect(readRuns(adapter.getDatabase())[0]).toMatchObject({
      status: MEMBER_STATUSES.running,
      backend: "fake",
      backend_status: "running"
    });

    adapter.close();
  });

  it("starts artifact writing with a declared output path outside the leader workspace", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend();
    const declaredOutputPath = "/tmp/codex-team-artifacts/status-report.md";

    const result = createAgentService(adapter, backend).createAgent({
      name: "Reporter",
      teamName: "alpha-team",
      prompt: "write a status report document",
      description: "produce a report artifact",
      declaredOutputPath,
      identity
    });

    expect(backend.startCalls).toHaveLength(1);
    expect(backend.startCalls[0]).toMatchObject({
      work_classification: "artifact_writing",
      isolation_kind: "declared_output_path",
      workspace_path: undefined,
      metadata: {
        declared_output_path: path.resolve(declaredOutputPath)
      }
    });
    expect(result).toMatchObject({
      status: "running",
      delivery_status: "backend_start_attempted",
      lifecycle: {
        work_classification: "artifact_writing",
        isolation_kind: "declared_output_path",
        declared_output_path: path.resolve(declaredOutputPath),
        review_status: "none"
      }
    });
    expect(JSON.parse(readRuns(adapter.getDatabase())[0]?.metadata_json ?? "{}")).toMatchObject({
      declared_output_path: path.resolve(declaredOutputPath),
      execution_available: true,
      teammate_execution_implemented: true
    });

    adapter.close();
  });

  it("keeps scheduled state when the default backend is unavailable", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);

    const result = createAgentService(adapter).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      prompt: "Research current status",
      description: "read-only status check",
      identity
    });

    expect(result).toMatchObject({
      status: "scheduled",
      delivery_status: "backend_unavailable",
      error_code: "backend_unavailable",
      backend: {
        status: "not_started",
        backend: "none",
        execution_available: false,
        teammate_execution_implemented: false
      },
      lifecycle: {
        work_classification: "read_only",
        isolation_kind: "none",
        review_status: "none"
      }
    });
    expect(readRuns(adapter.getDatabase())[0]).toMatchObject({
      status: MEMBER_STATUSES.scheduled,
      backend: "none",
      backend_status: "not_started"
    });

    adapter.close();
  });

  it("marks TeamMate failed when backend start fails", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({
      action: "backend_failed",
      lastError: "fake backend failed"
    });

    const result = createAgentService(adapter, backend).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      prompt: "Research current status",
      description: "read-only status check",
      identity
    });

    expect(backend.startCalls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failed",
      delivery_status: "backend_failed",
      error_code: "backend_failed",
      backend: {
        status: "failed",
        backend: "fake",
        last_error: "fake backend failed"
      }
    });
    expect(readMember(adapter.getDatabase(), String(result.debug.internal_member_id))).toMatchObject({
      status: MEMBER_STATUSES.failed
    });
    expect(readRuns(adapter.getDatabase())[0]).toMatchObject({
      status: MEMBER_STATUSES.failed,
      backend: "fake",
      backend_status: "failed",
      last_error: "fake backend failed"
    });

    adapter.close();
  });

  it("does not leak prompt text in lifecycle events", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({
      action: "backend_failed",
      lastError: `backend failed while handling ${SECRET_PHASE5_PROMPT}`
    });

    const result = createAgentService(adapter, backend).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      prompt: SECRET_PHASE5_PROMPT,
      description: "read-only status check",
      identity
    });

    expect(backend.startCalls).toHaveLength(1);
    expect(JSON.stringify(eventRows(adapter.getDatabase()))).not.toContain(
      SECRET_PHASE5_PROMPT
    );
    expect(JSON.stringify(result.debug)).not.toContain(SECRET_PHASE5_PROMPT);
    expect(JSON.stringify(result.backend)).not.toContain(SECRET_PHASE5_PROMPT);
    expect(JSON.stringify(eventRows(adapter.getDatabase()))).toContain(
      "[redacted_prompt]"
    );

    adapter.close();
  });

  it("converts thrown backend start into failed lifecycle state", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const backend = new FakeStartBackend({
      throwOnStart: true,
      lastError: `backend threw while handling ${SECRET_PHASE5_PROMPT}`
    });

    const result = createAgentService(adapter, backend).createAgent({
      name: "Researcher",
      teamName: "alpha-team",
      prompt: SECRET_PHASE5_PROMPT,
      description: "read-only status check",
      identity
    });

    expect(backend.startCalls).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failed",
      delivery_status: "backend_failed",
      error_code: "backend_failed",
      backend: {
        status: "failed",
        backend: "fake",
        last_error: expect.any(String)
      }
    });
    expect(nonLeaderMemberCount(adapter.getDatabase())).toBe(1);
    expect(runCount(adapter.getDatabase())).toBe(1);
    expect(readMember(adapter.getDatabase(), String(result.debug.internal_member_id))).toMatchObject({
      status: MEMBER_STATUSES.failed
    });
    const run = readRuns(adapter.getDatabase())[0];
    expect(run).toMatchObject({
      status: MEMBER_STATUSES.failed,
      backend: "fake",
      backend_status: "failed"
    });
    expect(run?.last_error).not.toContain(SECRET_PHASE5_PROMPT);
    expect(JSON.stringify(eventRows(adapter.getDatabase()))).not.toContain(
      SECRET_PHASE5_PROMPT
    );
    expect(JSON.stringify(result.debug)).not.toContain(SECRET_PHASE5_PROMPT);
    expect(JSON.stringify(result.backend)).not.toContain(SECRET_PHASE5_PROMPT);

    adapter.close();
  });

  it("creates a scheduled TeamMate through the active team binding", () => {
    const identity = createIdentity("/workspace/project", {
      sessionId: "active-session"
    });
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);

    const result = createAgentService(adapter).createAgent({
      name: "Builder",
      prompt: "Use active binding",
      description: "Active team path",
      identity
    });

    expect(result).toMatchObject({
      status: "scheduled",
      teammate_id: "builder@alpha-team",
      team_name: "alpha-team",
      display_name: "Builder",
      debug: {
        internal_member_id: expect.stringMatching(/^teammate:/),
        team_resolution: "active_binding"
      }
    });
    expect(nonLeaderMemberCount(adapter.getDatabase())).toBe(1);
    expect(runCount(adapter.getDatabase())).toBe(1);

    adapter.close();
  });

  it("stores internal member IDs separately from public teammate IDs across shared state roots", () => {
    const stateRoot = createTempStateRoot();
    const firstIdentity = createIdentity("/workspace/one", { sessionId: "one" });
    const secondIdentity = createIdentity("/workspace/two", { sessionId: "two" });
    const firstAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: firstIdentity.workspaceRoot
    });
    const secondAdapter = new DurableStateAdapter({
      stateRoot,
      workspaceRoot: secondIdentity.workspaceRoot
    });
    createAlphaTeam(firstAdapter, firstIdentity);
    createAlphaTeam(secondAdapter, secondIdentity);

    const first = createAgentService(firstAdapter).createAgent({
      name: "Builder",
      teamName: "Alpha Team",
      prompt: "Build in workspace one",
      identity: firstIdentity
    });
    const second = createAgentService(secondAdapter).createAgent({
      name: "Builder",
      teamName: "Alpha Team",
      prompt: "Build in workspace two",
      identity: secondIdentity
    });

    expect(first.teammate_id).toBe("builder@alpha-team");
    expect(second.teammate_id).toBe("builder@alpha-team");
    expect(first.debug.internal_member_id).not.toBe(second.debug.internal_member_id);
    expect(readMember(firstAdapter.getDatabase(), String(first.debug.internal_member_id))).toMatchObject({
      workspace_root: path.resolve("/workspace/one")
    });
    expect(readMember(secondAdapter.getDatabase(), String(second.debug.internal_member_id))).toMatchObject({
      workspace_root: path.resolve("/workspace/two")
    });

    firstAdapter.close();
    secondAdapter.close();
  });

  it("rejects duplicate canonical TeamMate names within one team", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    createAgentService(adapter).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: "First builder",
      identity
    });

    const duplicate = createAgentService(adapter).createAgent({
      name: "builder",
      teamName: "alpha-team",
      prompt: "Duplicate builder",
      identity
    });

    expect(duplicate).toMatchObject({
      status: "error",
      error_code: "agent_duplicate_teammate_name",
      team_name: "alpha-team",
      teammate_id: "builder@alpha-team"
    });
    expect(nonLeaderMemberCount(adapter.getDatabase())).toBe(1);
    expect(runCount(adapter.getDatabase())).toBe(1);
    expect(eventRows(adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: EVENT_TYPES.teammateCreationRejected,
          error_code: "agent_duplicate_teammate_name"
        })
      ])
    );

    adapter.close();
  });

  it("returns ordinary_subagent_path without member or run writes when name is omitted", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);

    const result = createAgentService(adapter).createAgent({
      teamName: "alpha-team",
      prompt: "Inspect only",
      description: "ordinary route",
      identity
    });

    expect(result).toMatchObject({
      status: "ordinary_subagent_path",
      not_handled_by_team_layer: true,
      reason: "missing_teammate_name"
    });
    expect(nonLeaderMemberCount(adapter.getDatabase())).toBe(0);
    expect(runCount(adapter.getDatabase())).toBe(0);
    expect(
      adapter
        .getDatabase()
        .prepare(`SELECT COUNT(*) AS count FROM ${TABLE_NAMES.members}`)
        .get()
    ).toMatchObject({ count: 1 });

    adapter.close();
  });

  it("returns ContextResolver errors when name is present but team context cannot resolve", () => {
    const identity = createIdentity("/workspace/project");
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });

    const result = createAgentService(adapter).createAgent({
      name: "Builder",
      prompt: "No active team exists",
      identity
    });

    expect(result).toMatchObject({
      status: "error",
      error_code: "no_active_team"
    });
    expect(nonLeaderMemberCount(adapter.getDatabase())).toBe(0);
    expect(runCount(adapter.getDatabase())).toBe(0);

    adapter.close();
  });

  it("rejects nested addressable TeamMate creation from a proven non-leader TeamMate caller", () => {
    const identity = createIdentity("/workspace/project", {
      sessionId: "leader-session"
    });
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const created = createAgentService(adapter).createAgent({
      name: "Builder",
      teamName: "alpha-team",
      prompt: "Create first TeamMate",
      identity
    });
    const teammateIdentity = createIdentity("/workspace/project", {
      sessionId: "teammate-session",
      codexTeamMemberId: created.debug.internal_member_id,
      codexTeamMemberRole: "teammate"
    });

    expect(teammateIdentity.callerKey).toBe(
      "codex-team:sessionId:teammate-session"
    );
    expect(teammateIdentity.observedMetadata).toMatchObject({
      sessionId: "teammate-session",
      codexTeamMemberId: created.debug.internal_member_id,
      codexTeamMemberRole: "teammate"
    });

    const nested = createAgentService(adapter).createAgent({
      name: "Reviewer",
      teamName: "alpha-team",
      prompt: "Nested addressable creation should fail",
      identity: teammateIdentity
    });

    expect(nested).toMatchObject({
      status: "error",
      error_code: "agent_nested_teammate_rejected",
      team_name: "alpha-team"
    });
    expect(nonLeaderMemberCount(adapter.getDatabase())).toBe(1);
    expect(runCount(adapter.getDatabase())).toBe(1);
    expect(eventRows(adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: EVENT_TYPES.teammateCreationRejected,
          error_code: "agent_nested_teammate_rejected"
        })
      ])
    );

    adapter.close();
  });

  it("rejects nested addressable TeamMate creation from role-only TeamMate metadata", () => {
    const identity = createIdentity("/workspace/project", {
      sessionId: "leader-session"
    });
    const adapter = new DurableStateAdapter({
      stateRoot: createTempStateRoot(),
      workspaceRoot: identity.workspaceRoot
    });
    createAlphaTeam(adapter, identity);
    const teammateIdentity = createIdentity("/workspace/project", {
      sessionId: "role-only-teammate-session",
      codexTeamMemberRole: "teammate"
    });

    const nested = createAgentService(adapter).createAgent({
      name: "Reviewer",
      teamName: "alpha-team",
      prompt: "Role-only nested addressable creation should fail",
      identity: teammateIdentity
    });

    expect(nested).toMatchObject({
      status: "error",
      error_code: "agent_nested_teammate_rejected",
      team_name: "alpha-team"
    });
    expect(nonLeaderMemberCount(adapter.getDatabase())).toBe(0);
    expect(runCount(adapter.getDatabase())).toBe(0);
    expect(eventRows(adapter.getDatabase())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: EVENT_TYPES.teammateCreationRejected,
          error_code: "agent_nested_teammate_rejected"
        })
      ])
    );

    adapter.close();
  });
});
