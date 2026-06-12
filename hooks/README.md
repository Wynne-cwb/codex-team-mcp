# codex-team `UserPromptSubmit` inbox nudge (optional hook)

This directory ships a small, **read-only** Codex CLI hook as a **repo artifact**. It is
**not installed automatically** — nothing here is ever written into `~/.codex`. Wire it up
yourself only if you want it.

## What it does

The interactive **Team Lead (TL)** has no pane, so teammate → TL messages are *pulled*, not
pushed. This hook closes the worst gap in that pull path: it reminds the TL of unread mail
on the **same turn** the TL submits a prompt.

[`userPromptSubmit-inbox-nudge.mjs`](./userPromptSubmit-inbox-nudge.mjs) runs on Codex's
`UserPromptSubmit` event — which fires when you submit a prompt, **before** the model
processes it. The script opens the codex-team SQLite DB **read-only**, counts the leader's
unread messages, and (only if `N > 0`) emits `hookSpecificOutput.additionalContext`:

```
📬 You have N new teammate message(s) — call CheckInbox before responding.
```

Codex injects that single line into the model's context for that turn, so the TL surfaces
and handles the mail while responding.

- **Latency** = your next user message (the best achievable without an idle wake).
- **Cost** = ~0 marginal tokens (one short line; no speculative polling turns).
- **Architecture change** = none (no app-server, no human-in-loop, no launch change).

> [!NOTE]
> Codex currently renders `additionalContext` as a **visible** developer message in the
> transcript ([issue #16933](https://github.com/openai/codex/issues/16933)). That is fine
> here — it doubles as a free ambient signal. The injected line is kept short on purpose.

## The pull discipline (canonical anti-poll guidance)

This hook is the **primary home** of the TL anti-speculative-poll guidance
(`CANONICAL-PULL-MODEL.md` §2c / §4 ownership map):

> Do not speculatively call `CheckInbox`. You are nudged when mail arrives (`inbox_pending`
> on every codex-team tool result; a 📬 line each time you submit a prompt). Call
> `CheckInbox` only when `inbox_pending > 0`, when you see the 📬 nudge, or at a natural
> checkpoint — never on a loop.

## Hard contract (why it is safe)

The script obeys every bullet of `CANONICAL-PULL-MODEL.md` §2(d):

1. **Read-only.** Opens the DB read-only and runs exactly ONE `COUNT` query. It does **not**
   claim, mark-read, stamp `delivered_at`/`read_at`, write events, or mutate any row.
   (Marking-read stays owned by `CheckInbox` and the TL auto-surface; a hook that marked
   read would silently consume the TL's mail and break the auto-surface.)
2. **Resolves the team by cwd.** `workspaceRoot` = `CODEX_TEAM_WORKSPACE_ROOT` if set, else
   the hook's cwd; DB at `<workspaceRoot>/.codex-team/state/codex-team.sqlite` unless
   `CODEX_TEAM_STATE_ROOT` overrides (mirrors the server's `resolveStateRoot`). It picks the
   active, non-archived team for that workspace, then `leader:<teamId>`.
3. **Counts only the leader's unread.** `COUNT(*) … WHERE recipient_member_id =
   'leader:<teamId>' AND read_at IS NULL`, served by the v8 index
   `idx_messages_recipient_pending`. No body is read (D-02 safe).
4. **Emits only when `N > 0`.** Empty inbox → prints nothing (a cheap no-op; never blocks
   the prompt).
5. **No-op for teammate sessions.** If `CODEX_TEAM_MEMBER_ROLE=teammate` is set (the env the
   TL injects into pane-hosted teammates), the hook emits nothing — the nudge is for the
   **leader** only; teammates already get the in-pane 📬 nudge + pull.
6. **Never throws into the prompt path.** Any error (no DB, locked, no team) → silently
   emits nothing and exits clean; your prompt proceeds unchanged.

## Requirements

- A Codex CLI with stable hooks (default-enabled since `0.124.0`).
- Node.js ≥ 22 (the script is an ESM `.mjs`).
- The `better-sqlite3` module resolvable from the script. The simplest setup is to point the
  hook command at the copy that ships inside this installed package, e.g.
  `<codex-team-mcp install>/hooks/userPromptSubmit-inbox-nudge.mjs`, so it resolves the
  package's own `node_modules/better-sqlite3`. If `better-sqlite3` cannot be resolved the
  hook fails closed (emits nothing) — never an error.

## Install (manual, you do this)

1. Note the absolute path to the script. If you installed the npm package, it is at
   `…/node_modules/codex-team-mcp/hooks/userPromptSubmit-inbox-nudge.mjs`. From a checkout it
   is this file's sibling.

2. Add a `UserPromptSubmit` command hook to **your** `~/.codex/hooks.json` (create it if
   absent). A minimal snippet — replace `/ABS/PATH/TO` with the real absolute path:

   ```jsonc
   {
     "hooks": {
       "UserPromptSubmit": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "node /ABS/PATH/TO/hooks/userPromptSubmit-inbox-nudge.mjs"
             }
           ]
         }
       ]
     }
   }
   ```

   > [!IMPORTANT]
   > If you already have a `hooks.json`, **merge** this `UserPromptSubmit` entry into your
   > existing config — do not overwrite the file. Other hooks (e.g. gsd's) must be preserved.

3. The hook resolves the team by **cwd**, so run the TL's Codex from the workspace root that
   owns `.codex-team/state/`. If your TL runs elsewhere, export
   `CODEX_TEAM_WORKSPACE_ROOT=/abs/workspace/root` (and `CODEX_TEAM_STATE_ROOT` if you
   relocate the state dir) in that session so the hook reads the right DB.

4. Submit a prompt to the TL. When teammates have sent unread mail, you'll see the 📬 line;
   otherwise nothing changes.

### Optional: also nudge at tool boundaries

For long stretches where the TL works without user prompts, a **matcher-scoped /
rate-limited** `PostToolUse` hook (e.g. on `^Bash$` or edits) can inject the same nudge at
tool boundaries. Do **not** attach it to all tools (noisy + token cost). Note that
`PreToolUse` does **not** support `additionalContext`
([issue #19385](https://github.com/openai/codex/issues/19385)) — injection must use
`UserPromptSubmit`, `PostToolUse`, or `SessionStart`.

## Sources

- Codex hooks: https://developers.openai.com/codex/hooks
- `additionalContext` renders visibly: https://github.com/openai/codex/issues/16933
- `PreToolUse` has no `additionalContext` parity: https://github.com/openai/codex/issues/19385
