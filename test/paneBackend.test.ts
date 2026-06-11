import { describe, expect, it } from "vitest";

import {
  buildExternalTmuxAttachCommand,
  buildTmuxSocketName,
  createITerm2PaneBackend,
  createPaneBackendRegistry,
  createTmuxPaneBackend,
  sanitizePaneIdentifier,
  type PaneBackendCommandRunner,
  type PaneBackendMetadata
} from "../src/adapters/paneBackend.js";
import {
  createTerminalCommandRunner,
  type TerminalCommandExecutor
} from "../src/adapters/terminalCommand.js";

interface CommandCall {
  command: string;
  args: string[];
  cwd?: string;
}

interface CommandResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

function createFakeCommandRunner(
  responses: Record<string, CommandResult>
): PaneBackendCommandRunner & { calls: CommandCall[] } {
  const calls: CommandCall[] = [];
  const runner: PaneBackendCommandRunner & { calls: CommandCall[] } = {
    calls,
    run(command: string, args: string[], options?: { cwd?: string }) {
      calls.push({ command, args, cwd: options?.cwd });
      const key = [command, ...args].join(" ");
      const result = responses[key] ?? responses[command];
      if (!result || result.exitCode === 1) {
        return {
          ok: false,
          stdout: result?.stdout ?? "",
          stderr: result?.stderr ?? "command not found",
          exit_code: result?.exitCode ?? 127
        };
      }

      return {
        ok: true,
        stdout: result.stdout,
        stderr: result.stderr ?? "",
        exit_code: result.exitCode ?? 0
      };
    }
  };

  return runner;
}

const paneContext = {
  run_id: "run:alpha:builder",
  team_name: "alpha-team",
  teammate_id: "builder@alpha-team",
  workspace_root: "/workspace",
  start_command: ["codex", "exec", "--json", "bootstrap teammate"]
};

describe("pane terminal command runner", () => {
  it("runs terminal commands with argument arrays and no shell interpolation", async () => {
    const calls: Array<{
      command: string;
      args: string[];
      options?: { cwd?: string; shell?: boolean };
    }> = [];
    const executor: TerminalCommandExecutor = async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "ok", stderr: "", exit_code: 0 };
    };
    const runner = createTerminalCommandRunner({ executor });
    const unsafeSessionName = "codex-team-alpha; rm -rf /";

    await runner.run("tmux", ["new-session", "-d", "-s", unsafeSessionName], {
      cwd: "/workspace"
    });

    expect(calls).toEqual([
      {
        command: "tmux",
        args: ["new-session", "-d", "-s", unsafeSessionName],
        options: expect.objectContaining({
          cwd: "/workspace",
          shell: false
        })
      }
    ]);
    expect(calls[0]?.command).not.toContain(" ");
    expect(calls[0]?.command).not.toContain(";");
    expect(calls[0]?.args).toContain(unsafeSessionName);
  });
});

describe("pane backend detection and metadata", () => {
  it("auto-selects native tmux when inside tmux (TMUX set), without probing it2", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      it2: { stdout: "it2 0.2.3\n" }
    });

    const registry = createPaneBackendRegistry({
      preferredBackend: "auto",
      env: { TMUX: "/tmp/tmux-501/default,123,0" },
      commandRunner
    });

    expect(registry.describeAvailability()).toMatchObject({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available"
    });
    // Inside tmux is decided purely from env.TMUX — it2 is never probed.
    expect(commandRunner.calls.map((call) => call.command)).not.toContain("it2");
  });

  it("auto-selects iTerm2 when in an iTerm2 window and `it2 session list` succeeds", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: iterm-pane-7\n"
      }
    });

    const registry = createPaneBackendRegistry({
      preferredBackend: "auto",
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    expect(registry.describeAvailability()).toMatchObject({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available"
    });

    const result = registry.createPane(paneContext);

    expect(result.ok).toBe(true);
    expect(result.pane).toMatchObject({
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-7"
    } satisfies Partial<PaneBackendMetadata>);
    // Splits with `it2 session split -v` targeting the leader session — never the
    // non-existent `it2 split-pane` subcommand.
    const splitCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "split"
    );
    expect(splitCall?.args).toEqual(["session", "split", "-v", "-s", "session"]);
    expect(
      commandRunner.calls.some(
        (call) => call.command === "it2" && call.args.includes("split-pane")
      )
    ).toBe(false);
  });

  it("auto-falls back to external detached tmux when neither inside tmux nor in iTerm2", () => {
    const socketName = buildTmuxSocketName("alpha-team", "run-alpha-builder");
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      it2: { stdout: "it2 0.2.3\n" },
      [`tmux -L ${socketName} new-session -d -s codex-team-alpha-team -n teammates -P -F #{pane_id}`]:
        { stdout: "%5\n" }
    });

    const registry = createPaneBackendRegistry({
      preferredBackend: "auto",
      env: {},
      commandRunner,
      stableId: "run-alpha-builder"
    });

    expect(registry.describeAvailability()).toMatchObject({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available"
    });

    const result = registry.createPane(paneContext);

    expect(result.pane).toMatchObject({
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%5",
      is_native: false
    } satisfies Partial<PaneBackendMetadata>);
    expect(result.pane.attach_command).toContain("attach-session");
    // Outside an iTerm2 window, it2 is never probed.
    expect(commandRunner.calls.map((call) => call.command)).not.toContain("it2");
  });

  it("does not pick iTerm2 when in iTerm2 but `it2 session list` fails — falls back to installed tmux and never calls it2 split", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "it2 session list": { exitCode: 1, stderr: "iTerm2 API not reachable" }
    });

    const registry = createPaneBackendRegistry({
      preferredBackend: "auto",
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    expect(registry.describeAvailability()).toMatchObject({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available"
    });
    // it2 was probed via `session list` only; a failed API never triggers a split.
    expect(
      commandRunner.calls.some(
        (call) =>
          call.command === "it2" &&
          (call.args.includes("split-pane") ||
            (call.args[0] === "session" && call.args[1] === "split"))
      )
    ).toBe(false);
  });

  it("iTerm2 describeAvailability probes `it2 session list`, never `it2 --version`", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    expect(backend.describeAvailability()).toMatchObject({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available"
    });
    expect(commandRunner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "it2", args: ["session", "list"] })
      ])
    );
    expect(
      commandRunner.calls.some(
        (call) => call.command === "it2" && call.args.includes("--version")
      )
    ).toBe(false);
  });

  it("creates an external tmux session with a concrete attach command when outside tmux", () => {
    const socketName = buildTmuxSocketName("alpha-team", "run-alpha-builder");
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      [`tmux -L ${socketName} new-session -d -s codex-team-alpha-team -n teammates -P -F #{pane_id}`]:
        { stdout: "%12\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {},
      commandRunner,
      stableId: "run-alpha-builder"
    });

    const result = backend.createPane(paneContext);

    expect(result.pane).toMatchObject({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%12",
      session_name: "codex-team-alpha-team",
      window_name: "teammates",
      socket_name: socketName,
      is_native: false
    } satisfies Partial<PaneBackendMetadata>);
    expect(result.pane.attach_command).toMatch(
      /tmux -L 'codex-team-.*' attach-session -t 'codex-team-.*'/
    );
    expect(result.pane.attach_command).toContain("tmux -L 'codex-team-");
    expect(result.pane.attach_command).toContain(
      "attach-session -t 'codex-team-"
    );
    expect(commandRunner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "tmux",
          args: expect.arrayContaining([
            "-L",
            socketName,
            "new-session",
            "-d",
            "-s",
            "codex-team-alpha-team"
          ])
        })
      ])
    );
  });

  it("claim downgrade keeps tmux attach metadata status-only without executing Codex", () => {
    const socketName = buildTmuxSocketName("alpha-team", "run-alpha-builder");
    // 0.3.2: the command is now appended to `new-session` as a single shell-quoted
    // `[shell-command]` arg (tmux runs it in the pane). Codex still never runs as a
    // direct subprocess of the MCP server — only `tmux` is invoked.
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      [`tmux -L ${socketName} new-session -d -s codex-team-alpha-team -n teammates -P -F #{pane_id} 'codex' 'exec' '--json' 'SENTINEL_TMUX'`]:
        { stdout: "%12\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {},
      commandRunner,
      stableId: "run-alpha-builder"
    });

    const result = backend.createPane(paneContext, [
      "codex",
      "exec",
      "--json",
      "SENTINEL_TMUX"
    ]);

    expect(result.thread_id).toBeUndefined();
    expect(result.pane).toMatchObject({
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%12"
    } satisfies Partial<PaneBackendMetadata>);
    expect(commandRunner.calls.some((call) => call.command === "codex")).toBe(
      false
    );
  });

  it("records native tmux pane metadata when TMUX and TMUX_PANE are present", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux display-message -p #{session_name}": { stdout: "leader-session\n" },
      "tmux display-message -p #{window_name}": { stdout: "leader-window\n" },
      "tmux split-window -d -P -F #{pane_id}": { stdout: "%42\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_PANE: "%1"
      },
      commandRunner
    });

    expect(backend.createPane(paneContext).pane).toMatchObject({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%42",
      session_name: "leader-session",
      window_name: "leader-window",
      socket_name: "default",
      attach_command: "tmux attach-session -t 'leader-session'",
      is_native: true
    } satisfies Partial<PaneBackendMetadata>);
  });

  it("includes native tmux socket name in attach command for non-default sockets", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux display-message -p #{session_name}": { stdout: "leader-session\n" },
      "tmux display-message -p #{window_name}": { stdout: "leader-window\n" },
      "tmux split-window -d -P -F #{pane_id}": { stdout: "%42\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {
        TMUX: "/tmp/tmux-501/custom,123,0",
        TMUX_PANE: "%1"
      },
      commandRunner
    });

    const result = backend.createPane(paneContext);

    expect(result.pane).toMatchObject({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%42",
      session_name: "leader-session",
      window_name: "leader-window",
      socket_name: "custom",
      attach_command: "tmux -L 'custom' attach-session -t 'leader-session'",
      is_native: true
    } satisfies Partial<PaneBackendMetadata>);
    expect(
      commandRunner.calls.some((call) => call.args.includes("attach-session"))
    ).toBe(false);
  });

  it("shell-quotes native tmux attach commands and redacts SECRET identifiers case-insensitively", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux display-message -p #{session_name}": {
        stdout: "work; rm -rf \"$HOME\"\n"
      },
      "tmux display-message -p #{window_name}": { stdout: "leader-window\n" },
      "tmux split-window -d -P -F #{pane_id}": { stdout: "%42\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_PANE: "%1"
      },
      commandRunner
    });

    const result = backend.createPane(paneContext);

    expect(result.pane.attach_command).toBe(
      "tmux attach-session -t 'work; rm -rf \"$HOME\"'"
    );
    expect(sanitizePaneIdentifier("SECRET_API_TOKEN", "fallback")).toBe(
      "redacted-secret"
    );
    expect(sanitizePaneIdentifier("secret_api_token", "fallback")).toBe(
      "redacted-secret"
    );
  });

  it("marks tmux pane metadata stale when list-panes does not include the pane", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux -L default list-panes -a -F #{pane_id}": { stdout: "%99\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {},
      commandRunner
    });

    const result = backend.reconcilePane?.({
      ...paneContext,
      metadata: {
        backend_metadata: {
          pane: {
            mode: "pane",
            backend_type: "tmux",
            availability_status: "available",
            pane_id: "%42",
            socket_name: "default",
            session_name: "leader-session"
          }
        }
      }
    });

    expect(result).toMatchObject({
      status: "stale",
      deleted: false,
      pane: {
        backend_type: "tmux",
        availability_status: "degraded",
        degradation_reason: expect.stringContaining("tmux pane not found")
      }
    });
    expect(commandRunner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "tmux",
          args: ["-L", "default", "list-panes", "-a", "-F", "#{pane_id}"]
        })
      ])
    );
  });

  it("reports iTerm2 as unavailable when TERM_PROGRAM or ITERM_SESSION_ID is missing", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "it2 0.2.3\n" }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "Apple_Terminal"
      },
      commandRunner
    });

    expect(backend.describeAvailability()).toMatchObject({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "unavailable",
      degradation_reason: expect.stringContaining("ITERM_SESSION_ID")
    } satisfies Partial<PaneBackendMetadata>);
  });

  it("claim downgrade keeps iTerm2 attach metadata status-only without executing Codex", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: iterm-pane-1\n"
      }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    const result = backend.createPane(paneContext, [
      "codex",
      "exec",
      "--json",
      "SENTINEL_ITERM2"
    ]);

    expect(result.thread_id).toBeUndefined();
    expect(result.pane).toMatchObject({
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-1"
    } satisfies Partial<PaneBackendMetadata>);
    expect(commandRunner.calls.some((call) => call.command === "codex")).toBe(
      false
    );
  });

  it("marks iTerm2 pane metadata stale when session list does not include the pane", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "it2 0.2.3\n" },
      // Liveness is resolved via the MACHINE-READABLE `--json` form. The bare
      // `it2 session list` renders a width-truncated table (ids shown as e.g.
      // `DD1441FC-0CE1-44…`), so reconcile must NOT depend on it.
      "it2 session list --json": { stdout: '[{"id":"other-session"}]\n' }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    const result = backend.reconcilePane?.({
      ...paneContext,
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: "iterm-pane-1",
          session_name: "w0t0p0:session"
        }
      }
    });

    expect(result).toMatchObject({
      status: "stale",
      deleted: false,
      pane: {
        backend_type: "iterm2",
        availability_status: "degraded",
        degradation_reason: expect.stringContaining("iterm2 pane not found")
      }
    });
    expect(commandRunner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "it2",
          args: ["session", "list", "--json"]
        })
      ])
    );
  });

  it("marks iTerm2 pane metadata stale when live output only contains an overlapping pane ID", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "it2 0.2.3\n" },
      // Overlapping-but-not-exact ids (pane-10 / session-10) must NOT be treated
      // as a match for pane-1 / session-1.
      "it2 session list --json": {
        stdout: '[{"id":"iterm-pane-10"},{"id":"w0t0p0:session-10"}]\n'
      }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    const result = backend.reconcilePane?.({
      ...paneContext,
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: "iterm-pane-1",
          session_name: "w0t0p0:session-1"
        }
      }
    });

    expect(result).toMatchObject({
      status: "stale",
      deleted: false,
      pane: {
        backend_type: "iterm2",
        availability_status: "degraded",
        degradation_reason: expect.stringContaining("iterm2 pane not found")
      }
    });
    expect(commandRunner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "it2",
          args: ["session", "list", "--json"]
        })
      ])
    );
  });

  it("keeps iTerm2 pane metadata active when live output contains an exact pane token", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "it2 0.2.3\n" },
      "it2 session list --json": {
        stdout: '[{"id":"iterm-pane-1"},{"id":"w0t0p0:session-10"}]\n'
      }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    const result = backend.reconcilePane?.({
      ...paneContext,
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: "iterm-pane-1",
          session_name: "w0t0p0:session-1"
        }
      }
    });

    expect(result).toMatchObject({
      status: "active",
      deleted: false,
      pane: {
        backend_type: "iterm2",
        availability_status: "available"
      }
    });
    expect(commandRunner.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: "it2",
          args: ["session", "list", "--json"]
        })
      ])
    );
  });

  // Regression (locks the failed→failed bug): the bare `it2 session list` table
  // truncates a full session UUID to e.g. `DD1441FC-0CE1-44…`, so matching a
  // full id against it ALWAYS failed and reconcile flagged LIVE panes as dead —
  // wrongly failing completed teammates. Reconcile MUST use the `--json` form
  // (full `id`) for liveness.
  it("keeps the pane active when `--json` lists the full session UUID (regression)", () => {
    const fullPaneId = "FAA62892-4C34-44A3-803A-ECCFF081A27A";
    const commandRunner = createFakeCommandRunner({
      // The `--json` form returns the FULL, un-truncated id.
      "it2 session list --json": {
        stdout: `[{"id":"${fullPaneId}","name":"codex","tty":"/dev/ttys001","window_id":"w0","tab_id":"t0"}]\n`
      }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    const result = backend.reconcilePane?.({
      ...paneContext,
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: fullPaneId,
          session_name: "w0t0p0:session"
        }
      }
    });

    expect(result).toMatchObject({
      status: "active",
      deleted: false,
      pane: {
        backend_type: "iterm2",
        availability_status: "available"
      }
    });
    // Proves liveness no longer rides on the truncating bare table.
    const listCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "list"
    );
    expect(listCall?.args).toEqual(["session", "list", "--json"]);
    expect(
      commandRunner.calls.some(
        (call) =>
          call.command === "it2" &&
          call.args.join(" ") === "session list"
      )
    ).toBe(false);
  });

  it("marks the pane stale when `--json` lists only a different full UUID (regression)", () => {
    const fullPaneId = "FAA62892-4C34-44A3-803A-ECCFF081A27A";
    const otherId = "DD1441FC-0CE1-44A0-9B11-000000000000";
    const commandRunner = createFakeCommandRunner({
      "it2 session list --json": {
        stdout: `[{"id":"${otherId}"}]\n`
      }
    });
    const backend = createITerm2PaneBackend({
      env: {
        TERM_PROGRAM: "iTerm.app",
        ITERM_SESSION_ID: "w0t0p0:session"
      },
      commandRunner
    });

    const result = backend.reconcilePane?.({
      ...paneContext,
      metadata: {
        pane: {
          mode: "pane",
          backend_type: "iterm2",
          availability_status: "available",
          pane_id: fullPaneId,
          session_name: "w0t0p0:session"
        }
      }
    });

    expect(result).toMatchObject({
      status: "stale",
      deleted: false,
      pane: {
        backend_type: "iterm2",
        availability_status: "degraded",
        degradation_reason: expect.stringContaining("iterm2 pane not found")
      }
    });
    const listCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "list"
    );
    expect(listCall?.args).toEqual(["session", "list", "--json"]);
  });

  it("reports pane unavailable with degradation reason when no backend command is found", () => {
    const commandRunner = createFakeCommandRunner({});
    const registry = createPaneBackendRegistry({
      preferredBackend: "tmux",
      env: {},
      commandRunner
    });

    expect(registry.describeAvailability()).toMatchObject({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "unavailable",
      degradation_reason: expect.stringContaining("tmux")
    } satisfies Partial<PaneBackendMetadata>);
  });

  it("sanitizes attach command display without storing prompt message task or body text", () => {
    const socketName = buildTmuxSocketName("alpha-team", "redaction");
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      [`tmux -L ${socketName} new-session -d -s codex-team-alpha-team -n teammates -P -F #{pane_id}`]:
        { stdout: "%9\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {},
      commandRunner,
      stableId: "redaction"
    });
    const sensitiveText = "SECRET_PANE_PROMPT message task body";

    const result = backend.createPane({
      ...paneContext,
      start_command: ["codex", "exec", "--json", sensitiveText]
    });
    const serialized = JSON.stringify(result.pane);

    expect(result.pane.attach_command).not.toContain(sensitiveText);
    expect(serialized).not.toContain("SECRET_PANE_PROMPT");
    for (const redactedKey of ["prompt", "message", "task", "body"]) {
      expect(result.pane).not.toHaveProperty(redactedKey);
    }
  });
});

describe("tmux socket name bounding", () => {
  // macOS caps the Unix-domain-socket path (`sun_path`) at 104 bytes. tmux puts
  // the socket at `/private/tmp/tmux-<uid>/<socketName>`, so a representative tmp
  // dir lets us assert the full path stays comfortably under the limit.
  const REPRESENTATIVE_TMP_DIR = "/private/tmp/tmux-501";
  const SUN_PATH_LIMIT = 104;
  const SOCKET_NAME_CAP = 50;

  const longTeam =
    "notification-directory-research-20260610-extra-long-team-name";
  const longRun =
    "run:notification-directory-research-team:builder-member-id:11111111-2222-3333-4444-555555555555";

  it("bounds the socket name and full socket path for very long identifiers", () => {
    const socketName = buildTmuxSocketName(longTeam, longRun);

    expect(socketName.startsWith("codex-team-")).toBe(true);
    expect(socketName.length).toBeLessThanOrEqual(SOCKET_NAME_CAP);

    const fullPath = `${REPRESENTATIVE_TMP_DIR}/${socketName}`;
    expect(Buffer.byteLength(fullPath, "utf8")).toBeLessThan(SUN_PATH_LIMIT);
  });

  it("produces a deterministic socket name for identical inputs", () => {
    const first = buildTmuxSocketName("alpha-team", "run-alpha-builder");
    const second = buildTmuxSocketName("alpha-team", "run-alpha-builder");

    expect(first).toBe(second);
    // Distinct (team, run) inputs resolve to distinct sockets.
    expect(buildTmuxSocketName("alpha-team", "run-alpha-builder")).not.toBe(
      buildTmuxSocketName("beta-team", "run-alpha-builder")
    );
    expect(buildTmuxSocketName("alpha-team", "run-alpha-builder")).not.toBe(
      buildTmuxSocketName("alpha-team", "run-beta-builder")
    );
  });

  it("keeps a generated pane's stored socket name and attach command bounded and identical", () => {
    const expectedTeam = sanitizePaneIdentifier(longTeam, "team");
    const expectedRun = sanitizePaneIdentifier(longRun, "run");
    const expectedSocket = buildTmuxSocketName(expectedTeam, expectedRun);
    const sessionName = `codex-team-${expectedTeam}`;

    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      [`tmux -L ${expectedSocket} new-session -d -s ${sessionName} -n teammates -P -F #{pane_id}`]:
        { stdout: "%7\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {},
      commandRunner
    });

    const result = backend.createPane({
      run_id: longRun,
      team_name: longTeam,
      teammate_id: "builder@notification-directory-research",
      workspace_root: "/workspace",
      start_command: ["codex", "exec", "--json", "bootstrap teammate"]
    });

    expect(result.ok).toBe(true);
    expect(result.pane.pane_id).toBe("%7");
    // The stored socket name is the bounded, deterministic name.
    expect(result.pane.socket_name).toBe(expectedSocket);
    expect((result.pane.socket_name ?? "").length).toBeLessThanOrEqual(
      SOCKET_NAME_CAP
    );
    expect(
      Buffer.byteLength(
        `${REPRESENTATIVE_TMP_DIR}/${result.pane.socket_name}`,
        "utf8"
      )
    ).toBeLessThan(SUN_PATH_LIMIT);
    // The attach command rebuilt from the stored socket references the SAME name.
    expect(result.pane.attach_command).toBe(
      buildExternalTmuxAttachCommand({ socketName: expectedSocket, sessionName })
    );
    expect(result.pane.attach_command).toContain(`-L '${expectedSocket}'`);
  });
});

describe("pane command execution and iTerm2 layout (0.3.2)", () => {
  const ITERM2_ENV = {
    TERM_PROGRAM: "iTerm.app",
    ITERM_SESSION_ID: "w0t0p0:session"
  };

  it("first teammate (no prior panes) splits the leader vertically `-v -s <leader>`", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: pane-1\n"
      }
    });
    const backend = createITerm2PaneBackend({
      env: ITERM2_ENV,
      commandRunner
    });

    // No previousTeammatePaneIds -> this is the first teammate.
    const first = backend.createPane(paneContext);

    expect(first.pane.pane_id).toBe("pane-1");
    const splitCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "split"
    );
    expect(splitCall?.args).toEqual(["session", "split", "-v", "-s", "session"]);
  });

  it("subsequent teammate stacks off the most recent prior pane without -v", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -s pane-1": { stdout: "Created new pane: pane-2\n" }
    });
    const backend = createITerm2PaneBackend({
      env: ITERM2_ENV,
      commandRunner
    });

    // The DB-derived anchor list (most-recent first) carries the prior pane.
    const second = backend.createPane({
      ...paneContext,
      previousTeammatePaneIds: ["pane-1"]
    });

    expect(second.pane.pane_id).toBe("pane-2");
    const splitCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "split"
    );
    // Stacks off the prior teammate session and is NOT vertical — the fix for the
    // v1 bug where every teammate re-split the leader and piled up horizontally.
    expect(splitCall?.args).toEqual(["session", "split", "-s", "pane-1"]);
    expect(splitCall?.args).not.toContain("-v");
  });

  it("anchors on the FIRST (most recent) candidate when several prior panes exist", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -s pane-2": { stdout: "Created new pane: pane-3\n" }
    });
    const backend = createITerm2PaneBackend({
      env: ITERM2_ENV,
      commandRunner
    });

    // Most-recent first: pane-2 is the latest, so it is the anchor.
    const third = backend.createPane({
      ...paneContext,
      previousTeammatePaneIds: ["pane-2", "pane-1"]
    });

    expect(third.pane.pane_id).toBe("pane-3");
    const splitCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "split"
    );
    expect(splitCall?.args).toEqual(["session", "split", "-s", "pane-2"]);
  });

  it("runs the visibility command inside the new iTerm2 pane via `it2 session run`", () => {
    const logPath = "/workspace/.codex-team/runs/run.jsonl";
    const cmdStr = `'tail' '-f' '${logPath}'`;
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: pane-1\n"
      },
      [`it2 session run -s pane-1 ${cmdStr}`]: { stdout: "" }
    });
    const backend = createITerm2PaneBackend({
      env: ITERM2_ENV,
      commandRunner
    });

    const result = backend.createPane(paneContext, ["tail", "-f", logPath]);

    expect(result.ok).toBe(true);
    expect(result.pane).toMatchObject({
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "pane-1"
    } satisfies Partial<PaneBackendMetadata>);
    const runCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "run"
    );
    // The command is one shell-quoted string arg targeting the new pane.
    expect(runCall?.args).toEqual(["session", "run", "-s", "pane-1", cmdStr]);
  });

  it("keeps the iTerm2 pane available (with a degradation reason) when `session run` fails", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: pane-1\n"
      }
      // No response for `session run` -> the run fails.
    });
    const backend = createITerm2PaneBackend({
      env: ITERM2_ENV,
      commandRunner
    });

    const result = backend.createPane(paneContext, [
      "tail",
      "-f",
      "/workspace/.codex-team/runs/run.jsonl"
    ]);

    // Split succeeded, so the pane is still available — only the content failed.
    expect(result.ok).toBe(true);
    expect(result.pane).toMatchObject({
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "pane-1"
    } satisfies Partial<PaneBackendMetadata>);
    expect(typeof result.pane.degradation_reason).toBe("string");
  });

  it("prunes a dead anchor and retries with the next candidate (at-fault recovery)", () => {
    const commandRunner = createFakeCommandRunner({
      // Availability still probes the bare `it2 session list` (exit code only).
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      // The recovery probe uses the MACHINE-READABLE `--json` form (the bare
      // table truncates ids); it omits pane-2 so the probe confirms pane-2 is
      // dead but pane-1 is still alive.
      "it2 session list --json": {
        stdout: '[{"id":"session"},{"id":"pane-1"}]\n'
      },
      // Splitting off the dead (most-recent) anchor fails.
      "it2 session split -s pane-2": { exitCode: 1, stderr: "no such session" },
      // The retry off the next candidate succeeds.
      "it2 session split -s pane-1": { stdout: "Created new pane: pane-3\n" }
    });
    const backend = createITerm2PaneBackend({
      env: ITERM2_ENV,
      commandRunner
    });

    // pane-2 is the latest (dead); pane-1 is the next candidate (alive).
    const result = backend.createPane({
      ...paneContext,
      previousTeammatePaneIds: ["pane-2", "pane-1"]
    });

    // Split off pane-2 fails -> confirm dead -> advance -> retry off pane-1 -> pane-3.
    expect(result.ok).toBe(true);
    expect(result.pane.pane_id).toBe("pane-3");

    // The recovery sequence: a failed `-s pane-2` split, then a `session list`
    // confirmation, then a retry `-s pane-1`.
    const it2Steps = commandRunner.calls
      .filter((call) => call.command === "it2")
      .map((call) => call.args.join(" "));
    const failedIdx = it2Steps.lastIndexOf("session split -s pane-2");
    const listIdx = it2Steps.indexOf("session list --json", failedIdx);
    const retryIdx = it2Steps.indexOf("session split -s pane-1", failedIdx);
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThan(failedIdx);
    expect(retryIdx).toBeGreaterThan(listIdx);
  });

  it("falls back to the leader split when every candidate anchor is dead", () => {
    const commandRunner = createFakeCommandRunner({
      // Availability still probes the bare `it2 session list` (exit code only).
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      // The `--json` recovery probe omits both pane-2 and pane-1 -> both dead.
      "it2 session list --json": { stdout: '[{"id":"session"}]\n' },
      "it2 session split -s pane-2": { exitCode: 1, stderr: "no such session" },
      "it2 session split -s pane-1": { exitCode: 1, stderr: "no such session" },
      // Exhausted candidates -> fall back once to the leader vertical split.
      "it2 session split -v -s session": {
        stdout: "Created new pane: pane-9\n"
      }
    });
    const backend = createITerm2PaneBackend({
      env: ITERM2_ENV,
      commandRunner
    });

    const result = backend.createPane({
      ...paneContext,
      previousTeammatePaneIds: ["pane-2", "pane-1"]
    });

    // Both anchors dead -> the fallback leader split produces the pane.
    expect(result.ok).toBe(true);
    expect(result.pane.pane_id).toBe("pane-9");

    const splitArgs = commandRunner.calls
      .filter(
        (call) =>
          call.command === "it2" &&
          call.args[0] === "session" &&
          call.args[1] === "split"
      )
      .map((call) => call.args.join(" "));
    // Tried each candidate in order, then fell back to the leader split exactly once.
    expect(splitArgs).toEqual([
      "session split -s pane-2",
      "session split -s pane-1",
      "session split -v -s session"
    ]);
  });

  it("runs the visibility command in a native tmux pane via `split-window [shell-command]`", () => {
    const logPath = "/workspace/.codex-team/runs/run.jsonl";
    const cmdStr = `'tail' '-f' '${logPath}'`;
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux display-message -p #{session_name}": { stdout: "leader-session\n" },
      "tmux display-message -p #{window_name}": { stdout: "leader-window\n" },
      [`tmux split-window -d -P -F #{pane_id} ${cmdStr}`]: { stdout: "%42\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_PANE: "%1"
      },
      commandRunner
    });

    const result = backend.createPane(paneContext, ["tail", "-f", logPath]);

    expect(result.ok).toBe(true);
    expect(result.pane.pane_id).toBe("%42");
    const splitCall = commandRunner.calls.find(
      (call) => call.command === "tmux" && call.args[0] === "split-window"
    );
    expect(splitCall?.args).toEqual([
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      cmdStr
    ]);
  });

  it("runs the visibility command in an external tmux session via `new-session [shell-command]`", () => {
    const socketName = buildTmuxSocketName("alpha-team", "run-alpha-builder");
    const logPath = "/workspace/.codex-team/runs/run.jsonl";
    const cmdStr = `'tail' '-f' '${logPath}'`;
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      [`tmux -L ${socketName} new-session -d -s codex-team-alpha-team -n teammates -P -F #{pane_id} ${cmdStr}`]:
        { stdout: "%12\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {},
      commandRunner,
      stableId: "run-alpha-builder"
    });

    const result = backend.createPane(paneContext, ["tail", "-f", logPath]);

    expect(result.ok).toBe(true);
    expect(result.pane.pane_id).toBe("%12");
    const newSessionCall = commandRunner.calls.find(
      (call) => call.command === "tmux" && call.args.includes("new-session")
    );
    // The command is the LAST argv element (a single shell-command string).
    expect(newSessionCall?.args.at(-1)).toBe(cmdStr);
  });

  it("shell-quotes a workspace log path that contains spaces as one argv element", () => {
    const socketName = buildTmuxSocketName("alpha-team", "run-alpha-builder");
    const spacedPath =
      "/Users/me/Automizely Marketing/.codex-team/runs/run.jsonl";
    const cmdStr = `'tail' '-f' '${spacedPath}'`;
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      [`tmux -L ${socketName} new-session -d -s codex-team-alpha-team -n teammates -P -F #{pane_id} ${cmdStr}`]:
        { stdout: "%21\n" }
    });
    const backend = createTmuxPaneBackend({
      env: {},
      commandRunner,
      stableId: "run-alpha-builder"
    });

    const result = backend.createPane(paneContext, ["tail", "-f", spacedPath]);

    expect(result.ok).toBe(true);
    const newSessionCall = commandRunner.calls.find(
      (call) => call.command === "tmux" && call.args.includes("new-session")
    );
    const lastArg = newSessionCall?.args.at(-1);
    // The spaced path stays inside ONE quoted token (no word-splitting).
    expect(lastArg).toBe(cmdStr);
    expect(lastArg).toContain(`'${spacedPath}'`);
  });
});

describe("pane teardown (closePane)", () => {
  const ITERM2_ENV = {
    TERM_PROGRAM: "iTerm.app",
    ITERM_SESSION_ID: "w0t0p0:session"
  };

  it("iTerm2 closePane closes the session via `it2 session close -f -s <id>`", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: pane-1\n"
      },
      "it2 session close -f -s pane-1": { stdout: "" }
    });
    const backend = createITerm2PaneBackend({ env: ITERM2_ENV, commandRunner });

    const created = backend.createPane(paneContext);
    const result = backend.closePane?.(created.pane);

    expect(result).toMatchObject({ ok: true, pane_id: "pane-1" });
    const closeCall = commandRunner.calls.find(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "close"
    );
    expect(closeCall?.args).toEqual(["session", "close", "-f", "-s", "pane-1"]);
  });

  it("iTerm2 closePane prunes the tracked session so the next split re-targets the leader", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: pane-1\n"
      },
      "it2 session close -f -s pane-1": { stdout: "" }
    });
    const backend = createITerm2PaneBackend({ env: ITERM2_ENV, commandRunner });

    const first = backend.createPane(paneContext);
    expect(first.pane.pane_id).toBe("pane-1");

    const closeResult = backend.closePane?.(first.pane);
    expect(closeResult?.ok).toBe(true);

    // After close+prune the tracked teammate list is empty, so the next split
    // starts fresh from the leader (`-v -s session`) and never tries to stack off
    // the now-closed pane-1.
    const second = backend.createPane(paneContext);
    expect(second.pane.pane_id).toBe("pane-1");

    const stackedOffClosed = commandRunner.calls.filter(
      (call) =>
        call.command === "it2" &&
        call.args.join(" ") === "session split -s pane-1"
    );
    expect(stackedOffClosed).toHaveLength(0);

    const splitCalls = commandRunner.calls.filter(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "split"
    );
    expect(splitCalls[0]?.args).toEqual([
      "session",
      "split",
      "-v",
      "-s",
      "session"
    ]);
    expect(splitCalls[1]?.args).toEqual([
      "session",
      "split",
      "-v",
      "-s",
      "session"
    ]);
  });

  it("iTerm2 closePane prunes even when the close command fails (pane already gone)", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "it2 session split -v -s session": {
        stdout: "Created new pane: pane-1\n"
      }
      // No response for `session close` -> the close fails.
    });
    const backend = createITerm2PaneBackend({ env: ITERM2_ENV, commandRunner });

    const first = backend.createPane(paneContext);
    const result = backend.closePane?.(first.pane);

    // Failure is reported with a sanitized reason, but the id is still pruned.
    expect(result?.ok).toBe(false);
    expect(typeof result?.reason).toBe("string");

    const second = backend.createPane(paneContext);
    const stackedOffClosed = commandRunner.calls.filter(
      (call) =>
        call.command === "it2" &&
        call.args.join(" ") === "session split -s pane-1"
    );
    expect(stackedOffClosed).toHaveLength(0);
    expect(second.pane.pane_id).toBe("pane-1");
  });

  it("iTerm2 closePane reports pane_id_missing when the pane has no id", () => {
    const commandRunner = createFakeCommandRunner({
      "it2 session list": { stdout: "iTerm2 Sessions\n" }
    });
    const backend = createITerm2PaneBackend({ env: ITERM2_ENV, commandRunner });

    const result = backend.closePane?.({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available"
    });

    expect(result).toEqual({ ok: false, reason: "pane_id_missing" });
    expect(
      commandRunner.calls.some(
        (call) => call.command === "it2" && call.args[1] === "close"
      )
    ).toBe(false);
  });

  it("tmux closePane kills a native pane via `kill-pane -t <id>`", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux kill-pane -t %42": { stdout: "" }
    });
    const backend = createTmuxPaneBackend({ env: {}, commandRunner });

    const result = backend.closePane?.({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%42",
      session_name: "leader-session",
      is_native: true
    });

    expect(result).toMatchObject({ ok: true, pane_id: "%42" });
    const killCall = commandRunner.calls.find(
      (call) => call.command === "tmux" && call.args[0] === "kill-pane"
    );
    expect(killCall?.args).toEqual(["kill-pane", "-t", "%42"]);
  });

  it("tmux closePane kills an external-session pane via `-L <socket> kill-pane -t <id>`", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux -L codex-team-sock kill-pane -t %12": { stdout: "" }
    });
    const backend = createTmuxPaneBackend({ env: {}, commandRunner });

    const result = backend.closePane?.({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%12",
      session_name: "codex-team-alpha",
      socket_name: "codex-team-sock",
      is_native: false
    });

    expect(result).toMatchObject({ ok: true, pane_id: "%12" });
    const killCall = commandRunner.calls.find(
      (call) => call.command === "tmux" && call.args.includes("kill-pane")
    );
    expect(killCall?.args).toEqual([
      "-L",
      "codex-team-sock",
      "kill-pane",
      "-t",
      "%12"
    ]);
  });

  it("tmux closePane falls back to `-L <socket> kill-session -t <session>` when an external pane has no id", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "tmux -L codex-team-sock kill-session -t codex-team-alpha": { stdout: "" }
    });
    const backend = createTmuxPaneBackend({ env: {}, commandRunner });

    const result = backend.closePane?.({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      session_name: "codex-team-alpha",
      socket_name: "codex-team-sock",
      is_native: false
    });

    expect(result?.ok).toBe(true);
    const killCall = commandRunner.calls.find(
      (call) => call.command === "tmux" && call.args.includes("kill-session")
    );
    expect(killCall?.args).toEqual([
      "-L",
      "codex-team-sock",
      "kill-session",
      "-t",
      "codex-team-alpha"
    ]);
  });

  it("tmux closePane reports pane_id_missing for a native pane without an id", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" }
    });
    const backend = createTmuxPaneBackend({ env: {}, commandRunner });

    const result = backend.closePane?.({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available"
    });

    expect(result).toEqual({ ok: false, reason: "pane_id_missing" });
  });

  it("registry.closePane routes by the pane's backend_type, not the current terminal", () => {
    // The current terminal is plain (neither tmux nor iTerm2 env), yet we tear
    // down panes of BOTH types — each must reach its own backend's close command.
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "tmux 3.6a\n" },
      "it2 session list": { stdout: "iTerm2 Sessions\n" },
      "tmux kill-pane -t %42": { stdout: "" },
      "it2 session close -f -s iterm-pane-1": { stdout: "" }
    });
    const registry = createPaneBackendRegistry({
      preferredBackend: "auto",
      env: {},
      commandRunner
    });

    const tmuxResult = registry.closePane({
      mode: "pane",
      backend_type: "tmux",
      availability_status: "available",
      pane_id: "%42"
    });
    const itermResult = registry.closePane({
      mode: "pane",
      backend_type: "iterm2",
      availability_status: "available",
      pane_id: "iterm-pane-1"
    });

    expect(tmuxResult).toMatchObject({ ok: true, pane_id: "%42" });
    expect(itermResult).toMatchObject({ ok: true, pane_id: "iterm-pane-1" });
    // tmux pane -> tmux kill-pane
    expect(
      commandRunner.calls.some(
        (call) => call.command === "tmux" && call.args[0] === "kill-pane"
      )
    ).toBe(true);
    // iterm2 pane -> it2 session close
    expect(
      commandRunner.calls.some(
        (call) =>
          call.command === "it2" &&
          call.args[0] === "session" &&
          call.args[1] === "close"
      )
    ).toBe(true);
  });
});

describe("sendToPane (resume nudge into a live pane)", () => {
  it("iTerm2 sendToPane submits via bracketed-paste body + lone carriage return (candidate C)", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "" }
    });
    const backend = createITerm2PaneBackend({
      env: { TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv,
      commandRunner,
      // No-op sleep so the test does not block on the real 400ms settle.
      sleep: () => {}
    });

    const result = backend.sendToPane?.(
      {
        mode: "pane",
        backend_type: "iterm2",
        availability_status: "available",
        pane_id: "w0t0p0:UUID"
      },
      ["please continue your work"]
    );

    expect(result?.ok).toBe(true);
    const sendCalls = commandRunner.calls.filter(
      (call) =>
        call.command === "it2" &&
        call.args[0] === "session" &&
        call.args[1] === "send"
    );
    // Candidate C is a TWO-STEP submit: (1) the body wrapped in an explicit
    // bracketed paste (ESC[200~ … ESC[201~) so codex treats it as a paste-insert
    // and clears its paste-burst suppress window, then (2) a SEPARATE lone
    // carriage return that submits cleanly. A single `send "text\r"` is swallowed
    // by codex's paste-burst heuristic and never submits.
    expect(sendCalls).toHaveLength(2);
    // 1. bracketed-paste-wrapped body (raw text, NO shell single-quoting). The
    //    markers are REAL bracketed-paste control bytes: ESC (0x1B) + `[200~` /
    //    `[201~`, matching the PASS script's `printf '\033[200~%s\033[201~'`.
    expect(sendCalls[0]?.args).toEqual([
      "session",
      "send",
      "-s",
      "w0t0p0:UUID",
      "\x1b[200~please continue your work\x1b[201~"
    ]);
    // 2. the lone carriage return that submits.
    expect(sendCalls[1]?.args).toEqual([
      "session",
      "send",
      "-s",
      "w0t0p0:UUID",
      "\r"
    ]);
    // The delivered body must NOT be shell-quoted — single quotes would be typed
    // literally into the composer.
    expect(sendCalls[0]?.args[4]).not.toContain("'");
    // It is NOT the old single-shot `"<text>\r"` send.
    expect(
      commandRunner.calls.some(
        (call) =>
          call.command === "it2" &&
          call.args[4] === "please continue your work\r"
      )
    ).toBe(false);
    // sendToPane must NOT use `it2 session run` (its LF never submits).
    expect(
      commandRunner.calls.some(
        (call) =>
          call.command === "it2" &&
          call.args[0] === "session" &&
          call.args[1] === "run"
      )
    ).toBe(false);
  });

  it("tmux sendToPane runs `send-keys -t <id> <text> Enter` (raw, not shell-quoted)", () => {
    const commandRunner = createFakeCommandRunner({
      tmux: { stdout: "" }
    });
    const backend = createTmuxPaneBackend({ commandRunner });

    const result = backend.sendToPane?.(
      {
        mode: "pane",
        backend_type: "tmux",
        availability_status: "available",
        pane_id: "%12",
        socket_name: "codex-team-abc"
      },
      ["continue please"]
    );

    expect(result?.ok).toBe(true);
    const sendCall = commandRunner.calls.find(
      (call) => call.command === "tmux" && call.args.includes("send-keys")
    );
    expect(sendCall?.args).toEqual([
      "-L",
      "codex-team-abc",
      "send-keys",
      "-t",
      "%12",
      "continue please",
      "Enter"
    ]);
  });

  it("registry routes sendToPane by the pane's backend_type", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "" },
      tmux: { stdout: "" }
    });
    const registry = createPaneBackendRegistry({
      env: { TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv,
      commandRunner
    });

    const itermResult = registry.sendToPane?.(
      {
        mode: "pane",
        backend_type: "iterm2",
        availability_status: "available",
        pane_id: "w0t0p0:UUID"
      },
      ["hi"]
    );
    const tmuxResult = registry.sendToPane?.(
      {
        mode: "pane",
        backend_type: "tmux",
        availability_status: "available",
        pane_id: "%12"
      },
      ["hi"]
    );

    expect(itermResult?.ok).toBe(true);
    expect(tmuxResult?.ok).toBe(true);
    expect(
      commandRunner.calls.some(
        (call) =>
          call.command === "it2" &&
          call.args[0] === "session" &&
          call.args[1] === "send"
      )
    ).toBe(true);
    expect(
      commandRunner.calls.some(
        (call) => call.command === "tmux" && call.args.includes("send-keys")
      )
    ).toBe(true);
  });
});
