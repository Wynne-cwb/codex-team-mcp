# codex-team-mcp

`codex-team-mcp` is an unofficial Claude Agent Team compatibility MCP server for Codex. It exposes Claude-style Agent Team tool names so Team-oriented skills can discover the intended surface while the runtime implementation remains external to Codex CLI internals.

## Current Status

The package now supports durable teams, active bindings, addressable TeamMates, persisted messages, team-scoped tasks, and lifecycle/run diagnostics through an external Codex MCP compatibility layer.

TeamMate execution is backend-dependent execution: the default backend reports unsupported execution rather than faking live TeamMate runs. File-modifying work is guarded by workspace review safety, so isolated workspaces or reviewable diffs must be reviewed before they affect the Team Lead workspace.

Phase 7 adds optional pane mode as a pane-style approximation: when enabled and locally supported, TeamMate activity can be shown through tmux/iTerm2-style terminal panes and inspected through `TeamDiagnostics` pane attach/status. The pane transcript experience is terminal scrollback, and user text to TeamMates still goes through `SendMessage`.

Workspace review visibility remains part of the contract. Treat `pending_review` and `needs_review` as review states, not accepted changes in the Team Lead workspace. Phase 7 does not add user-facing force kill or terminate controls.

This is not exact Claude runtime parity and not exact Claude tmux/iTerm2 pane parity. Codex external emulation does not provide true Claude in-process runtime behavior, guaranteed mid-turn message injection, full transcript persistence, or approval-bridge parity.

## Quickstart

Configure Codex to launch the package with `npx`:

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

For local development:

```bash
npm install
npm run build
npm run smoke:list-tools
```

## Guides

- [Startup and troubleshooting](docs/startup.md)
- [Claude-to-Codex tool mapping](docs/tool-mapping.md)
- [Compatibility matrix](docs/compatibility.md)
- [Validation evidence](docs/validation.md)
- [Agent Team compatibility skill](skills/agent-team-compatibility/SKILL.md)
