import { describe, expect, it } from "vitest";

import {
  type ExecutionBackend,
  type ExecutionRunContext,
  ScaffoldExecutionBackend
} from "../src/adapters/execution.js";

const runContext: ExecutionRunContext = {
  run_id: "run:test:1",
  team_id: "team-test-id",
  member_id: "member:test:1",
  teammate_id: "teammate@test-team",
  team_name: "test-team",
  workspace_root: "/workspace",
  prompt_present: true,
  work_classification: "read_only",
  isolation_kind: "none",
  workspace_path: null,
  metadata: {
    prompt_present: true
  }
};

describe("ExecutionBackend contract", () => {
  it("reports default backend lifecycle actions as unsupported", () => {
    const backend = new ScaffoldExecutionBackend();

    expect(backend.describeBackend()).toMatchObject({
      status: "scheduled_only",
      teammateExecutionImplemented: false,
      backend: "none",
      backend_status: "not_started",
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: false,
        supportsWorkspaces: false
      }
    });
    expect(backend.startRun(runContext)).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable",
      backend: "none",
      backend_status: "not_started"
    });
    expect(
      backend.resumeRun(runContext, {
        kind: "message",
        message_id: "message-test-id"
      })
    ).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable",
      backend: "none",
      backend_status: "not_started"
    });
    expect(backend.reconcileRun(runContext)).toMatchObject({
      status: "unsupported",
      backend: "none",
      backend_status: "not_started"
    });
  });

  it("does not fabricate backend identifiers", () => {
    const backend = new ScaffoldExecutionBackend();
    const actionResults = [
      backend.startRun(runContext),
      backend.resumeRun(runContext, { kind: "manual" })
    ];
    const reconcileResult = backend.reconcileRun(runContext);

    for (const result of actionResults) {
      expect(result).not.toHaveProperty("backend_run_id");
      expect(result).not.toHaveProperty("thread_id");
      expect(result).not.toHaveProperty("process_id");
      expect(result).not.toHaveProperty("workspace_path");
    }
    expect(reconcileResult).not.toHaveProperty("backend_run_id");
    expect(reconcileResult).not.toHaveProperty("thread_id");
    expect(reconcileResult).not.toHaveProperty("process_id");
    expect(reconcileResult).not.toHaveProperty("workspace_path");
  });

  it("allows fake backends to return started resumed and stale results", () => {
    const fakeBackend: ExecutionBackend = {
      describeBackend() {
        return {
          status: "available",
          teammateExecutionImplemented: true,
          backend: "fake",
          backend_status: "running",
          capabilities: {
            canStart: true,
            canResume: true,
            canReconcile: true,
            supportsWorkspaces: true
          }
        };
      },
      startRun(context) {
        expect(context.run_id).toBe(runContext.run_id);
        return {
          status: "started",
          delivery_status: "backend_start_attempted",
          backend: "fake",
          backend_status: "running",
          backend_run_id: "backend-run-1",
          thread_id: "thread-1",
          process_id: "process-1",
          workspace_path: "/tmp/codex-team-worktree",
          started_at: "2026-06-05T00:00:00.000Z"
        };
      },
      resumeRun(context, trigger) {
        expect(context.member_id).toBe(runContext.member_id);
        expect(trigger.kind).toBe("message");
        return {
          status: "resumed",
          delivery_status: "backend_resume_attempted",
          backend: "fake",
          backend_status: "running",
          backend_run_id: "backend-run-1",
          thread_id: "thread-1",
          process_id: "process-1"
        };
      },
      reconcileRun(context) {
        expect(context.team_id).toBe(runContext.team_id);
        return {
          status: "stale",
          backend: "fake",
          backend_status: "stale",
          backend_run_id: "backend-run-1",
          thread_id: "thread-1",
          process_id: "process-1",
          last_error: "backend no longer reports the run as active"
        };
      }
    };

    expect(fakeBackend.describeBackend().capabilities.canStart).toBe(true);
    expect(fakeBackend.startRun(runContext)).toMatchObject({
      status: "started",
      delivery_status: "backend_start_attempted",
      backend_run_id: "backend-run-1",
      workspace_path: "/tmp/codex-team-worktree"
    });
    expect(
      fakeBackend.resumeRun(runContext, {
        kind: "message",
        message_id: "message-test-id"
      })
    ).toMatchObject({
      status: "resumed",
      delivery_status: "backend_resume_attempted",
      thread_id: "thread-1"
    });
    expect(fakeBackend.reconcileRun(runContext)).toMatchObject({
      status: "stale",
      backend_status: "stale",
      process_id: "process-1"
    });
  });
});
