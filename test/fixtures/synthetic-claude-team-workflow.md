# Synthetic Claude Team Workflow

## Thin Compatibility Instruction

Claude Agent Team vocabulary maps to the Codex Team compatibility tools:
`TeamCreate`, `Agent`, `SendMessage`, `TaskCreate`, `TaskUpdate`, `TaskList`,
`TaskGet`, and `TeamDiagnostics`.

If the tool inventory does not include the Agent Team compatibility tools, say
exactly `Agent Team compatibility layer unavailable`.

Do not silently substitute generic subagents for missing Agent Team compatibility
tools.

## Workflow

The Team Lead creates `Alpha Team`.

The Team Lead creates named TeamMates `Builder` and `Reviewer`.

The Team Lead sends an explicit message to `Builder`: review the workflow fixture
and report current validation status.

The Team Lead creates a task assigned to `Builder` with the subject
`Validate compatibility workflow`.

The Team Lead updates the task to `in_progress`.

The Team Lead lists in-progress tasks owned by `Builder`.

The Team Lead gets `task-1` for full task details and history.

The Team Lead calls `TeamDiagnostics` to inspect tool status, durable state,
message/task summaries, lifecycle/run summaries, and backend limitations.

## Expected Compatibility Tool Path

1. `TeamCreate` creates `Alpha Team` and establishes the active Team Lead
   context.
2. `Agent` creates addressable TeamMates `Builder` and `Reviewer` in the active
   team.
3. `SendMessage` persists an explicit message to `Builder`.
4. `TaskCreate` creates `Validate compatibility workflow` and assigns it to
   `Builder`.
5. `TaskUpdate` moves `task-1` to `in_progress`.
6. `TaskList` returns the in-progress task owned by `Builder`.
7. `TaskGet` returns the task detail and event history for `task-1`.
8. `TeamDiagnostics` reports the compatibility tool surface and durable state
   summaries.

## Unavailable Tool Behavior

When Agent Team compatibility tools are missing, the only acceptable response is
`Agent Team compatibility layer unavailable`.

Do not silently substitute generic subagents for missing Agent Team compatibility
tools.

## Known Limits

TeamMate execution uses backend-dependent start and resume.

Messages to running TeamMates are queued for the next turn boundary.

This is not exact Claude runtime parity.

The layer does not provide true Claude in-process runtime behavior.

The layer does not support guaranteed mid-turn message injection.
