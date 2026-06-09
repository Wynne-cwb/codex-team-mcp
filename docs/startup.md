# Codex MCP Startup

## MCP Server Configuration

Use the published package through `npx`:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": ["-y", "codex-team-mcp@latest"]
    }
  }
}
```

For local development, build the package first:

```bash
npm install
npm run build
```

Then configure Codex with an absolute path to the built stdio entrypoint:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "node",
      "args": [
        "/absolute/path/to/codex-team-mcp/dist/index.js"
      ]
    }
  }
}
```

After build, the package bin points at the same local entrypoint:

```text
dist/index.js
```

## Optional Pane Mode

Pane mode is an optional, backend-dependent pane-style approximation. It does not change `TeamCreate`, `Agent`, `SendMessage`, task, lifecycle, or workspace safety semantics, and it is not exact Claude tmux/iTerm2 pane parity.

Enable pane mode through MCP server environment variables:

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": [
        "-y",
        "codex-team-mcp@latest"
      ],
      "env": {
        "CODEX_TEAM_PANE_MODE": "1",
        "CODEX_TEAM_PANE_BACKEND": "auto",
        "CODEX_TEAM_PANE_SESSION_PREFIX": "codex-team",
        "CODEX_TEAM_CODEX_COMMAND": "codex"
      }
    }
  }
}
```

Supported pane configuration values:

```text
CODEX_TEAM_PANE_MODE=1
CODEX_TEAM_PANE_BACKEND=auto|tmux|iterm2
CODEX_TEAM_PANE_SESSION_PREFIX=<prefix>
CODEX_TEAM_CODEX_COMMAND=<path-or-command>
```

| Variable | Values | Purpose |
|---|---|---|
| `CODEX_TEAM_PANE_MODE` | `1` | Enables pane mode. Use `CODEX_TEAM_PANE_MODE=1` when you want pane attach/status metadata. |
| `CODEX_TEAM_PANE_BACKEND` | `auto`, `tmux`, `iterm2` | Selects the terminal backend. `auto` tries tmux first, then iTerm2 when available. |
| `CODEX_TEAM_PANE_SESSION_PREFIX` | `<prefix>` | Prefix for generated external tmux sessions. Treat this as a trusted config value, not user text. |
| `CODEX_TEAM_CODEX_COMMAND` | `<path-or-command>` | Command used to start or resume Codex in pane-backed runs. |

When tmux is available, pane mode prefers tmux first. If the leader is outside tmux, Codex Team can create an external tmux session and report an attach command through `TeamDiagnostics`. The attach command shape is:

```bash
tmux -L <socket> attach-session -t <session>
```

The placeholders are reported metadata; do not build attach commands from untrusted teammate names or message text. The pane transcript experience in Phase 7 is terminal scrollback. Codex Team does not persist full pane transcripts, raw prompts, raw message bodies, or task text in diagnostics or planning summaries.

If tmux/iTerm2 or durable Codex start/resume metadata is unavailable, core Agent Team tools continue to work through the standard event-driven lifecycle. `TeamDiagnostics` reports the pane degradation reason. Lifecycle actions return `backend_unavailable` or degraded pane metadata instead of pretending a pane-backed TeamMate started.

Wave 0 bootstrap notes limit the Phase 7 claim: pane-backed start/resume is supported only when durable Codex session/run metadata is available, such as a discovered `thread_id` from `codex exec --json` and a valid resume path. Otherwise pane mode is attach/status only. See [validation.md](validation.md) for the validation evidence and known limits.

## Troubleshooting

1. For local development, run `npm install && npm run build` from the package directory.
2. Confirm `dist/index.js` exists.
3. Reload or restart Codex MCP servers after changing config.
4. Inspect the live tool inventory and confirm the eight compatibility tools plus `TeamDiagnostics` are visible.
5. Call `TeamDiagnostics` to inspect package version, registered mappings, durable state summaries, lifecycle/run status, pane attach/status, workspace review state, reconciliation summaries, and caller metadata fallback behavior.

## Runtime State

Durable teams, active bindings, TeamMate lifecycle/run rows, persisted messages, and team-scoped tasks are implemented through SQLite runtime state. `SendMessage` stores explicit inbox rows before returning delivery outcomes, and task tools read and write team-scoped task rows, `task_edges`, and `task_events`.

Phase 5 supports backend-dependent start and resume through an execution backend contract. The default backend reports unsupported execution; it does not fabricate TeamMate runs, backend IDs, thread IDs, process IDs, or workspace paths. Running TeamMate messages are queued for the next turn boundary, not injected mid-turn.

Workspace safety is explicit: file-modifying TeamMate work requires an isolated workspace or reviewable diff artifact before backend start. Reconciliation and `TeamDiagnostics` surface workspace review state, including `needs_review`, without deleting workspaces, merging diffs, or dropping queued messages.

Optional pane mode adds backend-dependent terminal panes and attach/status metadata. It is a pane-style approximation backed by terminal scrollback and `TeamDiagnostics`, not exact Claude tmux/iTerm2 pane parity. Any user text to a TeamMate must still use `SendMessage`; direct pane shell input is not the Agent Team message path.

This is not exact Claude runtime parity. Codex external emulation cannot promise true Claude in-process runtime behavior, guaranteed mid-turn message injection, exact pane parity, or approval-bridge parity. Broadcast delivery, cross-session bridge delivery, full transcript persistence, browser dashboard UI, and user-facing force kill or terminate controls remain outside Phase 7 support.

## Compatibility And Validation

Read the Phase 7 [Compatibility matrix](compatibility.md) for behavior-level support labels and [Validation artifact](validation.md) for the synthetic workflow, pane commands, coverage, manual checks, and known limits.
