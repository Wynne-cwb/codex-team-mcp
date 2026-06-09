---
name: agent-team-compatibility
description: Use Claude Agent Team vocabulary through the Codex Team compatibility MCP tools.
---

# Agent Team Compatibility

Use this skill when a workflow, instruction, or user request refers to Claude Agent Team vocabulary in Codex: Team Lead, TeamMate, `TeamCreate`, `Agent`, `SendMessage`, or team-scoped task tools.

## Required Tool Use

Team Leads call `TeamCreate` before creating addressable TeamMates. A named `Agent` call with team context creates scheduled addressable TeamMates when Agent Team compatibility tools are available.

Team Leads and TeamMates use `SendMessage` for teammate communication. Ordinary assistant text is not a teammate message.

Task tools are team-scoped. Owner assignment can notify assignees through persisted queued messages on the `SendMessage` path.

Phase 5 message delivery is persisted before backend work. A running TeamMate is queued for the next turn boundary; a scheduled, idle, or stopped TeamMate may use backend-dependent start and resume when the configured backend supports it and durable run metadata is available. The default backend reports unsupported execution, so do not treat unsupported backend results as successful TeamMate execution.

File-modifying TeamMate work must use isolation or a reviewable diff before it can affect the Team Lead workspace. Treat workspace review and `needs_review` results as review gates, not as merged work.

Optional pane mode may be enabled by the project as a backend-dependent pane-style approximation. It can expose TeamMate activity through terminal panes, terminal scrollback, and `TeamDiagnostics` pane attach/status when tmux or iTerm2-style support is available. It is not exact Claude tmux/iTerm2 pane parity.

Pane visibility does not create a direct message path. Team Leads and TeamMates still use `SendMessage` for user text, not direct pane shell input. Treat `pending_review` and `needs_review` workspace review states as review gates. Do not promise full transcript persistence, browser dashboard UI, or user-facing force kill or terminate controls in Phase 7.

Use these compatibility tools for team workflows:

- `TeamCreate`
- `TeamDelete`
- `Agent`
- `SendMessage`
- `TaskCreate`
- `TaskUpdate`
- `TaskList`
- `TaskGet`
- `TeamDiagnostics`

## Unavailable Layer Behavior

If the tools are unavailable, say: `Agent Team compatibility layer unavailable`.

Do not silently substitute generic subagents for missing Agent Team compatibility tools.

Report the unavailable layer clearly and use this repair path:

1. Check the MCP startup config.
2. Inspect the loaded tool inventory.
3. Call `TeamDiagnostics` if it is visible.
4. Read `docs/startup.md`.
5. Read `docs/compatibility.md` and `docs/validation.md` for Phase 7 support labels and validation evidence.

## Current Boundary

The compatibility layer now supports durable teams, persisted active bindings, addressable TeamMates, persisted messages, team-scoped tasks, lifecycle status, backend-dependent start and resume, optional pane attach/status, reconciliation summaries, and workspace review safety.

This is not exact Claude runtime parity and not exact Claude tmux/iTerm2 pane parity. Codex external emulation queues TeamMate messages for the next turn boundary and cannot guarantee true Claude in-process runtime behavior, mid-turn message injection, full transcript persistence, exact pane parity, or approval-bridge parity. Broadcast delivery and cross-session bridge delivery remain later-phase work.

See `docs/compatibility.md` for the behavior-level compatibility matrix and `docs/validation.md` for the synthetic workflow validation artifact.
