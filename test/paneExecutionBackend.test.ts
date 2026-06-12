import { describe, expect, it } from "vitest";

import type {
  ExecutionRunContext,
  ExecutionTrigger
} from "../src/adapters/execution.js";
import {
  PaneExecutionBackend,
  TEAMMATE_PREAMBLE,
  type PaneExecutionBackendOptions
} from "../src/adapters/paneExecutionBackend.js";
import {
  createCapabilityRankedBackendChain,
  selectExecutionBackend
} from "../src/adapters/capabilityRankedBackendChain.js";
import { CodexCliExecutionBackend } from "../src/adapters/codexCliExecutionBackend.js";
import type {
  PaneBackendCommandResult,
  PaneBackendMetadata,
  PaneReconcileResult
} from "../src/adapters/paneBackend.js";

const runContext: ExecutionRunContext = {
  run_id: "run:alpha:builder",
  team_id: "team-alpha",
  member_id: "teammate:team-alpha:builder",
  teammate_id: "builder@alpha-team",
  team_name: "alpha-team",
  workspace_root: "/workspace",
  prompt_present: true,
  work_classification: "read_only",
  isolation_kind: "none",
  workspace_path: null,
  metadata: {
    backend_thread_id: "thread-pane-1"
  }
};

const availablePane: PaneBackendMetadata = {
  mode: "pane",
  backend_type: "tmux",
  availability_status: "available",
  pane_id: "%12",
  session_name: "codex-team-alpha-team",
  window_name: "teammates",
  socket_name: "codex-team-alpha-team-run-alpha-builder",
  is_native: false
};

function createFakePaneBackend(input?: {
  available?: boolean;
  reconcileStatus?: PaneReconcileResult["status"];
  paneId?: string;
}) {
  const createCommands: Array<readonly string[]> = [];
  const createCalls: ExecutionRunContext[] = [];
  const reconcileCalls: ExecutionRunContext[] = [];
  const sendCalls: Array<{
    pane: PaneBackendMetadata;
    command: readonly string[];
  }> = [];
  const pane: PaneBackendMetadata = {
    ...availablePane,
    availability_status: input?.available === false ? "unavailable" : "available",
    degradation_reason:
      input?.available === false ? "tmux command not found" : undefined,
    pane_id: input?.paneId ?? availablePane.pane_id
  };
  const reconcileStatus = input?.reconcileStatus ?? "active";

  return {
    createCommands,
    createCalls,
    reconcileCalls,
    sendCalls,
    describeAvailability(): PaneBackendMetadata {
      return pane;
    },
    createPane(context: ExecutionRunContext, command?: readonly string[]) {
      createCalls.push(context);
      if (command) {
        createCommands.push(command);
      }
      if (input?.available === false) {
        return { ok: false, pane };
      }
      return { ok: true, pane, process_id: pane.pane_id };
    },
    resumePane() {
      return { ok: true, pane };
    },
    reconcilePane(context: ExecutionRunContext): PaneReconcileResult {
      reconcileCalls.push(context);
      return {
        status: reconcileStatus,
        pane: {
          ...pane,
          availability_status:
            reconcileStatus === "active" ? "available" : "degraded",
          degradation_reason:
            reconcileStatus === "active"
              ? undefined
              : "pane metadata no longer maps to a live pane"
        },
        deleted: false
      };
    },
    closePane() {
      return { ok: true, pane_id: pane.pane_id };
    },
    sendToPane(
      target: PaneBackendMetadata,
      command: readonly string[]
    ): PaneBackendCommandResult {
      sendCalls.push({ pane: target, command });
      return { ok: true, stdout: "", stderr: "", exit_code: 0 };
    }
  };
}

const durableOptions = (
  extra: Partial<PaneExecutionBackendOptions>
): PaneExecutionBackendOptions => ({
  executionClaim: "durable_start_resume_supported",
  sleep: () => {},
  now: () => 1000,
  sessionPollTimeoutMs: 0,
  ...extra
});

describe("PaneExecutionBackend (scaffold default)", () => {
  it("defaults to attach/status only and does not advertise durable start or resume", () => {
    const backend = new PaneExecutionBackend({
      paneBackend: createFakePaneBackend(),
      commandBuilder: {
        buildStartCommand: () => ["codex", "exec", "--json", "bootstrap"],
        buildResumeCommand: () => ["codex", "exec", "resume", "--json"]
      }
    });

    const description = backend.describeBackend();
    const startResult = backend.startRun(runContext);
    const resumeResult = backend.resumeRun(runContext, {
      kind: "message",
      message_id: "message:alpha:1"
    });
    const serializedResults = JSON.stringify({ startResult, resumeResult });

    expect(description).toMatchObject({
      status: "unavailable",
      teammateExecutionImplemented: false,
      backend: "tmux",
      backend_status: "not_started",
      capabilities: {
        canStart: false,
        canResume: false,
        canReconcile: true,
        supportsWorkspaces: true
      },
      limitation: "codex_session_metadata_unavailable"
    });
    expect(startResult).toMatchObject({ status: "unsupported" });
    expect(resumeResult).toMatchObject({ status: "not_resumable" });
    expect(serializedResults).not.toContain("backend_start_attempted");
    expect(serializedResults).not.toContain("backend_resume_attempted");
  });
});

describe("PaneExecutionBackend (pane-hosted full TUI)", () => {
  it("describes itself as available with durable start+resume when a pane backend is available", () => {
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend: createFakePaneBackend() })
    );

    expect(backend.describeBackend()).toMatchObject({
      status: "available",
      teammateExecutionImplemented: true,
      backend: "tmux",
      backend_status: "running",
      capabilities: {
        canStart: true,
        canResume: true,
        canReconcile: true,
        supportsWorkspaces: true,
        supportsOsSandbox: true
      }
    });
  });

  it("starts a teammate by launching the FULL codex TUI (not exec) and captures the rollout session id", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({
        paneBackend,
        // Real default command builder is exercised (no commandBuilder injected).
        locateRollout: () => ({
          session_id: "sess-rollout-1",
          rollout_path: "/codex/sessions/rollout-x.jsonl"
        })
      })
    );

    const result = backend.startRun({
      ...runContext,
      work_classification: "code_implementation",
      isolation_kind: "git_worktree",
      workspace_path: "/work/tree/run-a",
      metadata: { prompt: "implement the feature" }
    });

    // Full interactive codex TUI: `codex -C <cwd> -a never -s workspace-write
    // <-c env overrides> <prompt>`. Phase 13: the 3 per-launch `-c` env overrides
    // appear AFTER `-s <mode>` and BEFORE the positional prompt.
    expect(paneBackend.createCommands).toHaveLength(1);
    const command = paneBackend.createCommands[0];
    expect(command).toHaveLength(14);
    expect(command.slice(0, 7)).toEqual([
      "codex",
      "-C",
      "/work/tree/run-a",
      "-a",
      "never",
      "-s",
      "workspace-write"
    ]);
    expect(command.slice(7, 13)).toEqual([
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_WORKSPACE_ROOT="/workspace"',
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_MEMBER_ID="teammate:team-alpha:builder"',
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_MEMBER_ROLE="teammate"'
    ]);
    // The positional prompt is the behavior-contract preamble + the real task.
    expect(command[13]).toBe(`${TEAMMATE_PREAMBLE}\n\nimplement the feature`);
    expect(command).not.toContain("exec");

    expect(result).toMatchObject({
      status: "started",
      delivery_status: "backend_start_attempted",
      backend: "tmux",
      backend_status: "running",
      thread_id: "sess-rollout-1",
      backend_run_id: "sess-rollout-1",
      process_id: "%12",
      metadata: {
        pane: { mode: "pane", availability_status: "available", pane_id: "%12" },
        rollout_path: "/codex/sessions/rollout-x.jsonl"
      }
    });
  });

  it("starts WITHOUT a fabricated thread_id when no rollout session id is captured", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend, locateRollout: () => null })
    );

    const result = backend.startRun({
      ...runContext,
      workspace_path: "/work/tree/run-a",
      metadata: { prompt: "do work" }
    });

    expect(result.status).toBe("started");
    expect(result.backend_status).toBe("running");
    expect(result.thread_id).toBeUndefined();
    expect(result.backend_run_id).toBeUndefined();
    // process_id still set to the pane id -> the run has durable resume metadata.
    expect(result.process_id).toBe("%12");
  });

  it("degrades to unsupported when no pane backend is available", () => {
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend: createFakePaneBackend({ available: false }) })
    );

    expect(backend.describeBackend()).toMatchObject({
      status: "unavailable",
      capabilities: { canStart: false, canResume: false }
    });
    expect(backend.startRun(runContext)).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable"
    });
  });

  it("keeps file-modifying work behind workspace isolation", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend })
    );

    expect(
      backend.startRun({
        ...runContext,
        work_classification: "code_implementation",
        isolation_kind: "none",
        workspace_path: null
      })
    ).toMatchObject({
      status: "unsupported",
      delivery_status: "backend_unavailable",
      last_error: expect.stringContaining("workspace isolation")
    });
    expect(paneBackend.createCommands).toHaveLength(0);
  });

  it("never exposes raw prompt / secrets in action metadata", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({
        paneBackend,
        locateRollout: () => ({
          session_id: "sess-1",
          rollout_path: "/codex/sessions/rollout-x.jsonl"
        })
      })
    );

    const result = backend.startRun({
      ...runContext,
      work_classification: "code_implementation",
      isolation_kind: "git_worktree",
      workspace_path: "/work/tree/run-a",
      metadata: {
        prompt: "SECRET_PANE_PROMPT",
        message: "SECRET_PANE_MESSAGE",
        task: "SECRET_PANE_TASK",
        description: "SECRET_PANE_DESCRIPTION",
        transcript: "SECRET_PANE_TRANSCRIPT"
      }
    });
    const serialized = JSON.stringify(result.metadata);

    for (const secret of [
      "SECRET_PANE_PROMPT",
      "SECRET_PANE_MESSAGE",
      "SECRET_PANE_TASK",
      "SECRET_PANE_DESCRIPTION",
      "SECRET_PANE_TRANSCRIPT"
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const key of ["prompt", "message", "task", "description", "transcript"]) {
      expect(result.metadata).not.toHaveProperty(key);
    }
  });

  it("prefixes the start prompt with the autonomous-teammate behavior contract", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend, locateRollout: () => null })
    );

    backend.startRun({
      ...runContext,
      work_classification: "code_implementation",
      isolation_kind: "git_worktree",
      workspace_path: "/work/tree/run-a",
      metadata: { prompt: "implement the feature" }
    });

    const command = paneBackend.createCommands[0];
    const positionalPrompt = command[command.length - 1];
    // The positional prompt opens with the preamble (escalation closed loop)...
    expect(positionalPrompt.startsWith(TEAMMATE_PREAMBLE)).toBe(true);
    // ...and still carries the original assigned task verbatim.
    expect(positionalPrompt).toContain("implement the feature");
    expect(positionalPrompt).toBe(`${TEAMMATE_PREAMBLE}\n\nimplement the feature`);
  });

  // Phase 14 (SC3 norm / D-Q4): the preamble gains the peer-messaging "send once,
  // end your turn" norm. Asserted against the CONSTANT (no hard-coded copy) so the
  // exact-array buildStartCommand tests above stay green via interpolation.
  it("carries the peer-messaging send-once norm in TEAMMATE_PREAMBLE", () => {
    expect(TEAMMATE_PREAMBLE).toMatch(/teammates?/i);
    expect(TEAMMATE_PREAMBLE).toContain("TeamDiagnostics");
    expect(TEAMMATE_PREAMBLE).toMatch(/end your turn/i);
    expect(TEAMMATE_PREAMBLE).toMatch(/do not keep replying|don't keep replying|do not ping-pong/i);
  });

  it("opens a blank TUI with no preamble when no prompt is present", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend, locateRollout: () => null })
    );

    backend.startRun({
      ...runContext,
      work_classification: "read_only",
      isolation_kind: "none",
      workspace_path: "/work/tree/run-a",
      // No `prompt` -> codex opens a blank interactive TUI, never a bare preamble.
      metadata: {}
    });

    const command = paneBackend.createCommands[0];
    // Phase 13: the env -c overrides are injected even with no positional prompt
    // (env binding is independent of the prompt); the command still ends WITHOUT
    // a positional prompt.
    expect(command).toEqual([
      "codex",
      "-C",
      "/work/tree/run-a",
      "-a",
      "never",
      "-s",
      "read-only",
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_WORKSPACE_ROOT="/workspace"',
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_MEMBER_ID="teammate:team-alpha:builder"',
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_MEMBER_ROLE="teammate"'
    ]);
    expect(command.join("\n")).not.toContain(TEAMMATE_PREAMBLE);
  });

  // Phase 13 (SC1 / BIDIR-01 / D-Q3): per-launch `-c` env injection.
  it("injects shared workspace root, member id, and teammate role via per-launch -c overrides", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend, locateRollout: () => null })
    );

    backend.startRun({
      ...runContext,
      member_id: "teammate:team-alpha:builder",
      workspace_root: "/workspace",
      workspace_path: "/work/tree/run-a",
      work_classification: "code_implementation",
      isolation_kind: "git_worktree",
      metadata: { prompt: "implement the feature" }
    });

    expect(paneBackend.createCommands[0]).toEqual([
      "codex",
      "-C",
      "/work/tree/run-a",
      "-a",
      "never",
      "-s",
      "workspace-write",
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_WORKSPACE_ROOT="/workspace"',
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_MEMBER_ID="teammate:team-alpha:builder"',
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_MEMBER_ROLE="teammate"',
      `${TEAMMATE_PREAMBLE}\n\nimplement the feature`
    ]);
    // Per-launch `-c` only — never a bare global CODEX_TEAM_*= env mutation.
    const joined = paneBackend.createCommands[0].join(" ");
    expect(joined).not.toMatch(/(^| )CODEX_TEAM_WORKSPACE_ROOT=/);
    expect(joined).not.toMatch(/(^| )CODEX_TEAM_MEMBER_ID=/);
    expect(joined).not.toMatch(/(^| )CODEX_TEAM_MEMBER_ROLE=/);
  });

  it("TOML-escapes quotes and backslashes in injected -c env values", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend, locateRollout: () => null })
    );

    backend.startRun({
      ...runContext,
      member_id: "teammate:team-alpha:builder",
      workspace_root: '/a"b\\c',
      workspace_path: "/work/tree/run-a",
      work_classification: "read_only",
      metadata: {}
    });

    const command = paneBackend.createCommands[0];
    expect(command).toContain(
      'mcp_servers.codex-team.env.CODEX_TEAM_WORKSPACE_ROOT="/a\\"b\\\\c"'
    );
  });

  it("omits member id/role -c tokens when the run context has no member_id", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(
      durableOptions({ paneBackend, locateRollout: () => null })
    );

    backend.startRun({
      ...runContext,
      member_id: null,
      workspace_root: "/workspace",
      workspace_path: "/work/tree/run-a",
      work_classification: "read_only",
      metadata: {}
    });

    expect(paneBackend.createCommands[0]).toEqual([
      "codex",
      "-C",
      "/work/tree/run-a",
      "-a",
      "never",
      "-s",
      "read-only",
      "-c",
      'mcp_servers.codex-team.env.CODEX_TEAM_WORKSPACE_ROOT="/workspace"'
    ]);
    const joined = paneBackend.createCommands[0].join(" ");
    expect(joined).not.toContain("CODEX_TEAM_MEMBER_ID");
    expect(joined).not.toContain("CODEX_TEAM_MEMBER_ROLE");
  });
});

describe("PaneExecutionBackend reconcile (rollout turn-state x pane liveness)", () => {
  const reconcileContext: ExecutionRunContext = {
    ...runContext,
    workspace_path: "/work/tree/run-a",
    metadata: {
      backend_thread_id: "sess-1",
      backend_process_id: "%12",
      backend_metadata: {
        pane: availablePane,
        rollout_path: "/codex/sessions/rollout-x.jsonl"
      }
    }
  };

  function backendFor(input: {
    reconcileStatus: PaneReconcileResult["status"];
    turn_state: "completed" | "failed" | "in_progress" | "unknown";
    deliverable?: string;
  }) {
    const paneBackend = createFakePaneBackend({
      reconcileStatus: input.reconcileStatus
    });
    const backend = new PaneExecutionBackend(
      durableOptions({
        paneBackend,
        locateRollout: () => ({
          session_id: "sess-1",
          rollout_path: "/codex/sessions/rollout-x.jsonl"
        }),
        readRolloutStatus: () => ({
          turn_state: input.turn_state,
          deliverable: input.deliverable
        })
      })
    );
    return { backend, paneBackend };
  }

  it("maps a completed turn to idle and surfaces the deliverable", () => {
    const { backend } = backendFor({
      reconcileStatus: "active",
      turn_state: "completed",
      deliverable: "the final result"
    });

    expect(backend.reconcileRun(reconcileContext)).toMatchObject({
      status: "idle",
      backend_status: "idle",
      thread_id: "sess-1",
      metadata: { deliverable: "the final result", session_deleted: false }
    });
  });

  it("maps a failed/aborted turn to failed", () => {
    const { backend } = backendFor({
      reconcileStatus: "active",
      turn_state: "failed"
    });

    expect(backend.reconcileRun(reconcileContext)).toMatchObject({
      status: "failed",
      backend_status: "failed",
      last_error: "codex_pane_turn_failed"
    });
  });

  it("maps an in-progress turn with a live pane to active", () => {
    const { backend } = backendFor({
      reconcileStatus: "active",
      turn_state: "in_progress"
    });

    expect(backend.reconcileRun(reconcileContext)).toMatchObject({
      status: "active",
      backend_status: "running"
    });
  });

  it("maps an in-progress turn whose pane has died to failed", () => {
    const { backend } = backendFor({
      reconcileStatus: "stale",
      turn_state: "in_progress"
    });

    expect(backend.reconcileRun(reconcileContext)).toMatchObject({
      status: "failed",
      backend_status: "failed",
      last_error: "codex_pane_exited_without_completion"
    });
  });
});

describe("PaneExecutionBackend resume (text injection into the live pane)", () => {
  const resumeContext: ExecutionRunContext = {
    ...runContext,
    workspace_path: "/work/tree/run-a",
    metadata: {
      backend_thread_id: "sess-1",
      summary: "please continue your work",
      backend_metadata: { pane: availablePane }
    }
  };

  it("delivers the summary text into the existing pane via sendToPane", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(durableOptions({ paneBackend }));
    const secretBody = "SECRET_SENDMESSAGE_BODY";

    const result = backend.resumeRun(resumeContext, {
      kind: "message",
      message_id: "message:alpha:1",
      metadata: { body: secretBody }
    });

    expect(result).toMatchObject({
      status: "resumed",
      delivery_status: "backend_resume_attempted",
      backend: "tmux",
      backend_status: "running",
      thread_id: "sess-1",
      process_id: "%12"
    });
    // The non-sensitive summary was typed into the pane...
    expect(paneBackend.sendCalls).toHaveLength(1);
    expect(paneBackend.sendCalls[0].pane.pane_id).toBe("%12");
    expect(paneBackend.sendCalls[0].command).toEqual([
      "please continue your work"
    ]);
    // ...and the raw SendMessage body was NEVER delivered.
    const flat = JSON.stringify(paneBackend.sendCalls);
    expect(flat).not.toContain(secretBody);
  });

  it("delivers the FULL body (resume_delivery_text) into the pane, not just the summary", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(durableOptions({ paneBackend }));
    const fullBody =
      "Please continue: here is the full multi-sentence answer from the human user.";

    const result = backend.resumeRun(
      {
        ...runContext,
        workspace_path: "/work/tree/run-a",
        metadata: {
          backend_thread_id: "sess-1",
          // Both present -> the full body wins over the 5-word summary.
          summary: "follow-up",
          resume_delivery_text: fullBody,
          backend_metadata: { pane: availablePane }
        }
      },
      { kind: "message", message_id: "message:alpha:1" }
    );

    expect(result.status).toBe("resumed");
    expect(paneBackend.sendCalls).toHaveLength(1);
    // The FULL body was typed into the pane verbatim...
    expect(paneBackend.sendCalls[0].command).toEqual([fullBody]);
    // ...and the truncated summary was NOT what got delivered.
    expect(paneBackend.sendCalls[0].command).not.toEqual(["follow-up"]);
  });

  it("falls back to the summary when no resume_delivery_text is present", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(durableOptions({ paneBackend }));

    const result = backend.resumeRun(
      {
        ...runContext,
        workspace_path: "/work/tree/run-a",
        // Only a summary (e.g. a system lifecycle notice) -> summary is delivered.
        metadata: {
          backend_thread_id: "sess-1",
          summary: "please continue your work",
          backend_metadata: { pane: availablePane }
        }
      },
      { kind: "message", message_id: "message:alpha:1" }
    );

    expect(result.status).toBe("resumed");
    expect(paneBackend.sendCalls).toHaveLength(1);
    expect(paneBackend.sendCalls[0].command).toEqual(["please continue your work"]);
  });

  it("gracefully reports not_resumable when the run has no live pane", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(durableOptions({ paneBackend }));

    const result = backend.resumeRun(
      {
        ...runContext,
        metadata: { backend_thread_id: "sess-1", summary: "continue" }
      },
      { kind: "message", message_id: "message:alpha:1" }
    );

    expect(result.status).toBe("not_resumable");
    expect(paneBackend.sendCalls).toHaveLength(0);
  });

  it("gracefully reports not_resumable when no lawful resume text is available", () => {
    const paneBackend = createFakePaneBackend();
    const backend = new PaneExecutionBackend(durableOptions({ paneBackend }));

    const result = backend.resumeRun(
      {
        ...runContext,
        workspace_path: "/work/tree/run-a",
        // pane present, but NO summary -> nothing lawful to type.
        metadata: { backend_metadata: { pane: availablePane } }
      },
      { kind: "message", message_id: "message:alpha:1" }
    );

    expect(result.status).toBe("not_resumable");
    expect(paneBackend.sendCalls).toHaveLength(0);
  });
});

describe("execution backend selection wiring (pane-hosted rank-1, detached fallback)", () => {
  const availableCodexRunner = {
    run: () => ({ stdout: "", stderr: "", exitCode: 0 })
  };

  it("selects the pane-hosted backend when a pane backend is available", () => {
    const chain = createCapabilityRankedBackendChain([
      new PaneExecutionBackend({
        paneBackend: createFakePaneBackend(),
        executionClaim: "durable_start_resume_supported"
      }),
      new CodexCliExecutionBackend({ runner: availableCodexRunner })
    ]);

    expect(chain.describeBackend().backend).toBe("tmux");
    expect(selectExecutionBackend(chain)).toMatchObject({
      status: "selected",
      backend: "tmux"
    });
  });

  it("falls back to the detached codex backend when no pane backend is available", () => {
    const chain = createCapabilityRankedBackendChain([
      new PaneExecutionBackend({
        paneBackend: createFakePaneBackend({ available: false }),
        executionClaim: "durable_start_resume_supported"
      }),
      new CodexCliExecutionBackend({ runner: availableCodexRunner })
    ]);

    expect(chain.describeBackend().backend).toBe("codex_cli_exec");
    expect(selectExecutionBackend(chain)).toMatchObject({
      status: "selected",
      backend: "codex_cli_exec"
    });
  });
});
