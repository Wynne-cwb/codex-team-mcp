# Troubleshooting (codex-team)

Repair paths for the codex-team layer. Most "it's broken" reports are actually
**normal** turn-boundary / pull behavior (see `delivery-model.md`) — check the status
first before assuming a fault.

## TOC

- [1. Layer unavailable (tools missing)](#1-layer-unavailable-tools-missing)
- [2. A teammate never replied](#2-a-teammate-never-replied)
- [3. A message is stuck `queued`](#3-a-message-is-stuck-queued)
- [4. `changed_files` empty or stale](#4-changed_files-empty-or-stale)
- [5. Backend reports unsupported ≠ success](#5-backend-reports-unsupported--success)
- [6. Cross-team recipient rejected](#6-cross-team-recipient-rejected)
- [7. Turn-boundary / queued is NOT a bug](#7-turn-boundary--queued-is-not-a-bug)
- [8. How to read TeamDiagnostics](#8-how-to-read-teamdiagnostics)

---

## 1. Layer unavailable (tools missing)

If the codex-team tools are not visible at all, say plainly:
`Agent Team compatibility layer unavailable`.

**Do not silently substitute generic subagents** for the missing team tools — that
fakes a team and loses persistence, addressing, and the merge gate. Report the
unavailable layer clearly and follow this repair path:

1. Check the MCP startup config (is the `codex-team` server registered and launching?).
2. Inspect the loaded tool inventory (are `TeamCreate` / `SendMessage` etc. present?).
3. Call `TeamDiagnostics` if it is visible.
4. Read `docs/startup.md`.
5. Read `docs/compatibility.md` and `docs/validation.md` for support labels and
   validation evidence.

## 2. A teammate never replied

Almost always **turn-boundary timing**, not a fault. A teammate replies via
`SendMessage` at one of ITS turn boundaries, and its message reaches the TL on the
TL's next pull (a tool call or a prompt that surfaces `inbox_pending`). Before
assuming failure:

- Check `inbox_pending` on your last tool result and call `CheckInbox` if N>0.
- Run `TeamDiagnostics` and look at the teammate's lifecycle status and recent runs.
  Is it still `running` (hasn't reached a boundary), `idle`/`stopped` (done — pull
  its message), or did its run error?
- Remember: ordinary text in a teammate's pane is NOT a message. Only `SendMessage`
  reaches you. A teammate that "talked" only in its pane sent you nothing.

## 3. A message is stuck `queued`

`queued_for_next_turn` (recipient running) and `queued_while_idle` (recipient
idle/stopped) are **normal** — the message is persisted and waiting for a turn
boundary. It is not lost. If it stays queued unexpectedly long, check whether the
recipient's run is alive in `TeamDiagnostics`; a dead/never-started backend (see §5)
means there is no turn boundary coming.

## 4. `changed_files` empty or stale

`changed_files` is captured at **teardown** of a teammate run. An in-flight run may
not have it yet, and a long-idle run reflects the last teardown snapshot. If you need
the current diff before merge, use `TeamMerge` action `review` (or read the worktree
directly) rather than trusting a stale `changed_files`.

## 5. Backend reports unsupported ≠ success

If a run reports `backend_unavailable` / unsupported execution (the default backend
with no real runner configured), the teammate work **did not execute**. Do NOT treat
an unsupported backend result as successful TeamMate execution. Configure a real
execution backend (see `docs/startup.md`) before relying on teammates to do file work.

## 6. Cross-team recipient rejected

`SendMessage` delivers within ONE team. If you address a member outside your active
team, the send is rejected (`cross_team_recipient`). Fix the recipient: use a member
of your own team (find the correct id on the `TeamDiagnostics` roster). Broadcast
(`to: "*"`) and cross-session bridge delivery are unsupported.

## 7. Turn-boundary / queued is NOT a bug

Recap of the most common false alarms — all expected:

- `queued_for_next_turn` / `queued_while_idle` — normal queueing (§3).
- `pending_review` / `needs_review` — the merge gate, not a failure; review & merge.
- `delivered` without an immediate reply — the pane was nudged, not that the body was
  read; the recipient reads it on its next turn.
- No mid-turn delivery — guaranteed mid-turn message injection is unsupported by
  design; messages land at turn boundaries.

## 8. How to read TeamDiagnostics

`TeamDiagnostics` is your situational-awareness tool. By default it shows only your
active team. Use it to:

- See the **roster** — member ids and display names (use these as `SendMessage`
  recipients and to reach peers directly).
- See each member's **lifecycle status** (running / idle / stopped) and recent runs —
  to tell "still working" from "done, go pull its message" (§2).
- See recent **messages** and **review state** — what is queued, delivered, or
  awaiting merge.

Filters worth knowing: `teammate_id` narrows to one member; `include_history` /
`include_archived` widen the view; `messages_since` and the `max_*` caps bound the
output. `include_debug` adds sanitized backend diagnostics when you need the detail.
