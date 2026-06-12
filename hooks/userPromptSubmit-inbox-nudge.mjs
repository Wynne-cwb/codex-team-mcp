#!/usr/bin/env node
// codex-team — UserPromptSubmit inbox nudge (REPO ARTIFACT; NOT installed).
//
// Optimization Item 1(d) / CANONICAL-PULL-MODEL.md §2(d). A tiny, READ-ONLY Codex CLI
// `UserPromptSubmit` hook. It fires when the user submits a prompt, BEFORE the model
// processes it, and emits `hookSpecificOutput.additionalContext` (stdout JSON) so the
// interactive Team Lead is reminded of unread teammate mail on that SAME turn — no
// architecture change, ~0 marginal token, latency = the next user message.
//
// Install instructions + a sample hooks.json snippet live in ./README.md. This file is
// NEVER auto-written into ~/.codex; the human Team Lead wires it up if they want it.
//
// HARD CONTRACT (CANONICAL-PULL-MODEL.md §2(d)):
//   1. READ-ONLY — opens the SQLite DB read-only, runs exactly ONE COUNT query, mutates
//      nothing (no claim, no delivered_at/read_at, no events). Claiming/marking-read
//      stays owned by CheckInbox + the TL auto-surface; a hook that marked read would
//      silently consume the TL's mail and break the auto-surface.
//   2. Resolve team by cwd — workspaceRoot = CODEX_TEAM_WORKSPACE_ROOT (if set) else the
//      hook's cwd; DB at <workspaceRoot>/.codex-team/state/codex-team.sqlite unless
//      CODEX_TEAM_STATE_ROOT overrides (mirrors resolveStateRoot). Resolve the active,
//      non-archived team for that workspace, then the leader member leader:<teamId>.
//   3. Leader unread count — COUNT(*) of messages with recipient_member_id =
//      'leader:<teamId>' AND read_at IS NULL. Nothing else.
//   4. Emit additionalContext ONLY when N > 0.
//   5. NEVER claim / mark-read.
//   6. Fast (<100ms) — one indexed COUNT on a read-only connection; open→count→close.
//   7. Empty inbox → emit nothing (cheap no-op; never blocks the prompt).
//   8. No-op for teammate sessions — if CODEX_TEAM_MEMBER_ROLE=teammate, emit nothing
//      (the nudge is LEADER-only; teammates already get the in-pane 📬 nudge + pull).
//   9. Never throw into the prompt path — any error (no DB, locked, no team) silently
//      emits nothing; the user's prompt proceeds unchanged.
//
// Sources: https://developers.openai.com/codex/hooks · issue #16933 (additionalContext
// renders visibly) · issue #19385 (PreToolUse has no additionalContext parity → inject
// via UserPromptSubmit / PostToolUse / SessionStart).

import path from "node:path";
import { createRequire } from "node:module";

// `require` is not defined in an ESM module; bind one to this file so the optional
// `better-sqlite3` resolve below uses the codex-team install's copy.
const require = createRequire(import.meta.url);

// --- §2(d).8: no-op for teammate sessions ---------------------------------------
if (process.env.CODEX_TEAM_MEMBER_ROLE === "teammate") {
  process.exit(0);
}

// Everything below is wrapped so ANY failure silently emits nothing (§2(d).9).
try {
  const workspaceRoot = path.resolve(
    nonBlank(process.env.CODEX_TEAM_WORKSPACE_ROOT) ?? process.cwd()
  );
  // Mirror resolveStateRoot: CODEX_TEAM_STATE_ROOT overrides the default ".codex-team/state".
  const stateRootInput = nonBlank(process.env.CODEX_TEAM_STATE_ROOT) ?? ".codex-team/state";
  const stateRoot = path.resolve(workspaceRoot, stateRootInput);
  const databasePath = path.join(stateRoot, "codex-team.sqlite");

  const count = countLeaderUnread(databasePath, workspaceRoot);
  // §2(d).4 + §2(d).7: emit ONLY when there is mail; empty → print nothing.
  if (count > 0) {
    const noun = count === 1 ? "message" : "messages";
    const additionalContext = `📬 You have ${count} new teammate ${noun} — call CheckInbox before responding.`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext
        }
      })
    );
  }
} catch {
  // §2(d).9: never throw into the prompt path. Emit nothing, exit clean.
}
process.exit(0);

// Open the DB read-only and run exactly ONE indexed COUNT for the leader's unread mail.
// Returns 0 on any problem so the caller stays a silent no-op.
function countLeaderUnread(databasePath, workspaceRoot) {
  let Database;
  try {
    // Resolved relative to this hook; the codex-team install ships better-sqlite3.
    // The CJS module exports the constructor directly (module.exports = Database); a
    // `.default` only appears under some interop shims — accept either shape.
    const mod = require("better-sqlite3");
    Database = typeof mod === "function" ? mod : mod?.default;
  } catch {
    return 0;
  }
  if (typeof Database !== "function") {
    return 0;
  }

  let db;
  try {
    // §2(d).1 + §2(d).6: READ-ONLY connection, fail fast if the file is absent.
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch {
    return 0;
  }

  try {
    // §2(d).2: the active, non-archived team for this workspace. If ambiguous → take
    // the most recently created one; if none → emit nothing (count 0).
    const team = db
      .prepare(
        `SELECT team_id AS teamId
         FROM teams
         WHERE workspace_root = ? AND status = 'active'
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(workspaceRoot);
    if (!team || typeof team.teamId !== "string") {
      return 0;
    }

    const leaderMemberId = `leader:${team.teamId}`;
    // §2(d).3: the EXACT §2(a) query — COUNT of read_at IS NULL for the leader. Served
    // by the v8 covering index idx_messages_recipient_pending. No body read (D-02 safe).
    const row = db
      .prepare(
        `SELECT COUNT(*) AS unread
         FROM messages
         WHERE team_id = ? AND recipient_member_id = ? AND read_at IS NULL`
      )
      .get(team.teamId, leaderMemberId);
    return row && typeof row.unread === "number" ? row.unread : 0;
  } catch {
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      // ignore close errors
    }
  }
}

function nonBlank(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
