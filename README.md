# codex-team-mcp

[![npm package](https://img.shields.io/npm/v/codex-team-mcp.svg)](https://www.npmjs.com/package/codex-team-mcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-43853d.svg)](package.json)

Unofficial Claude Agent Team compatibility for Codex, packaged as a stdio MCP server.

`codex-team-mcp` exposes Claude-style team tools such as `TeamCreate`, `Agent`, `SendMessage`, and team-scoped task tools to Codex. It gives Team-oriented skills a durable, auditable coordination layer without requiring changes to Codex CLI internals.

> [!IMPORTANT]
> This is an external compatibility layer, not exact Claude runtime parity. It supports durable team state, addressable TeamMates, persisted messages, team tasks, lifecycle diagnostics, and optional pane-style metadata. It does not provide true Claude in-process execution, guaranteed mid-turn message injection, approval-bridge parity, or exact Claude tmux/iTerm2 panes.

## What It Provides

| Capability | Status |
| --- | --- |
| Durable team creation and active-team binding | Supported |
| Addressable TeamMate identities through named `Agent` calls | Supported |
| Explicit persisted `SendMessage` inbox messages | Supported |
| Team-scoped `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` | Supported |
| Restart-safe SQLite runtime state | Supported |
| Lifecycle, message, task, pane, and workspace diagnostics | Supported |
| Backend start/resume of live TeamMate work | Backend-dependent |
| Optional tmux/iTerm2-style pane metadata | Backend-dependent |

## Quickstart

Add the MCP server to your Codex configuration:

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

Reload or restart Codex MCP servers, then confirm the tool inventory includes:

```text
TeamCreate
TeamDelete
Agent
SendMessage
TaskCreate
TaskUpdate
TaskList
TaskGet
TeamDiagnostics
```

If anything looks off, call `TeamDiagnostics` first. It reports package version, registered tools, state root, active bindings, lifecycle status, pane metadata, queued messages, task summaries, and workspace review state.

## Example Workflow

Create a team:

```js
TeamCreate({
  "team_name": "Alpha Team",
  "description": "Compatibility validation"
})
```

Create addressable TeamMates:

```js
Agent({
  "name": "Builder",
  "mode": "read",
  "prompt": "Review the current implementation and report status."
})
```

Send explicit teammate messages:

```js
SendMessage({
  "to": "Builder",
  "summary": "Status check",
  "message": "Please review the compatibility workflow and report any issues."
})
```

Create and update team tasks:

```js
TaskCreate({
  "subject": "Validate compatibility workflow",
  "owner": "Builder",
  "metadata": { "priority": "high" }
})
```

```js
TaskUpdate({
  "taskId": "task-1",
  "status": "in_progress",
  "notes": "Started validation"
})
```

> [!NOTE]
> Ordinary chat text is not a teammate inbox message. Use `SendMessage` whenever user text should be delivered to a TeamMate.

## Tool Surface

| Tool | Purpose |
| --- | --- |
| `TeamCreate` | Creates a durable team, leader identity, and scoped active binding. |
| `TeamDelete` | Archives a team and invalidates active bindings without hard-deleting state. |
| `Agent` | Creates addressable TeamMates such as `builder@alpha-team`. |
| `SendMessage` | Persists explicit messages before attempting backend delivery. |
| `TaskCreate` | Creates team-scoped tasks in SQLite. |
| `TaskUpdate` | Updates task status, owner, notes, metadata, and blockers. |
| `TaskList` | Lists concise task projections by status or owner. |
| `TaskGet` | Reads full task detail and task history. |
| `TeamDiagnostics` | Reports tool, state, lifecycle, message, task, pane, and workspace summaries. |

## Optional Pane Mode

Pane mode adds backend-dependent tmux/iTerm2-style attach and status metadata. It is useful when you want terminal visibility into TeamMate activity, but it does not change the message path or workspace safety rules.

```json
{
  "mcpServers": {
    "codex-team": {
      "command": "npx",
      "args": ["-y", "codex-team-mcp@latest"],
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

Supported values:

| Variable | Values |
| --- | --- |
| `CODEX_TEAM_PANE_MODE` | `1`, `true`, `enabled` |
| `CODEX_TEAM_PANE_BACKEND` | `auto`, `tmux`, `iterm2` |
| `CODEX_TEAM_PANE_SESSION_PREFIX` | trusted prefix for generated pane sessions |
| `CODEX_TEAM_CODEX_COMMAND` | command used by pane-backed Codex runs |

## Runtime State And Safety

Runtime state is stored in SQLite outside the conversation transcript. By default, the server resolves state under the workspace root at:

```text
.codex-team/state/codex-team.sqlite
```

You can override this with:

```text
CODEX_TEAM_STATE_ROOT=/path/to/state
CODEX_TEAM_WORKSPACE_ROOT=/path/to/workspace
```

File-modifying TeamMate work is guarded by workspace review safety. Treat `pending_review` and `needs_review` as review gates, not accepted changes in the Team Lead workspace.

## Local Development

```bash
npm install
npm run build
npm test -- --run
npm run smoke:list-tools
npm publish --dry-run
```

The smoke test starts the built stdio MCP server and verifies all nine compatibility tools are visible.

## Documentation

- [Startup and troubleshooting](docs/startup.md)
- [Claude-to-Codex tool mapping](docs/tool-mapping.md)
- [Compatibility matrix](docs/compatibility.md)
- [Validation evidence](docs/validation.md)
- [Agent Team compatibility skill](skills/agent-team-compatibility/SKILL.md)
