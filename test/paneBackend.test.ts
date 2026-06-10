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
      "it2 session list": { stdout: "other-session\n" }
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
          args: ["session", "list"]
        })
      ])
    );
  });

  it("marks iTerm2 pane metadata stale when live output only contains an overlapping pane ID", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "it2 0.2.3\n" },
      "it2 session list": {
        stdout: "window iterm-pane-10 w0t0p0:session-10\n"
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
          args: ["session", "list"]
        })
      ])
    );
  });

  it("keeps iTerm2 pane metadata active when live output contains an exact pane token", () => {
    const commandRunner = createFakeCommandRunner({
      it2: { stdout: "it2 0.2.3\n" },
      "it2 session list": {
        stdout: "window iterm-pane-1 w0t0p0:session-10\n"
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
          args: ["session", "list"]
        })
      ])
    );
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
