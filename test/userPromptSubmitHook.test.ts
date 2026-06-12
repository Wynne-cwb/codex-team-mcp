import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentHandler } from "../src/tools/agentHandler.js";
import { createSendMessageHandler } from "../src/tools/messageHandler.js";
import { createTeamCreateHandler } from "../src/tools/teamHandlers.js";
import { withLeaderInboxSurface } from "../src/tools/registry.js";
import { DurableStateAdapter } from "../src/state/durableState.js";
import { TABLE_NAMES } from "../src/state/schema.js";

// Item 1 (§2d): the UserPromptSubmit inbox-nudge hook ARTIFACT. It is a read-only,
// out-of-process script — exercised here as a child process against a real seeded DB.

const HOOK_SCRIPT = fileURLToPath(
  new URL("../hooks/userPromptSubmit-inbox-nudge.mjs", import.meta.url)
);

let stateRoot: string;
let workspaceRoot: string;

type ToolHandler = (
  args: unknown,
  extra: unknown
) => Promise<{ content: Array<{ type: string; text?: string }> }>;

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(tmpdir(), "codex-team-hook-"));
  workspaceRoot = path.join(stateRoot, "workspace");
  // Ensure the workspace dir exists so it is a valid child-process cwd even before any
  // handler has created the state tree under it.
  mkdirSync(workspaceRoot, { recursive: true });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

async function callHandler(
  handler: ToolHandler,
  args: Record<string, unknown>,
  extra: unknown
): Promise<Record<string, unknown>> {
  const result = await handler(args, extra);
  const first = result.content[0];
  return JSON.parse(first && "text" in first ? (first.text ?? "{}") : "{}") as Record<
    string,
    unknown
  >;
}

const leadExtra = { sessionId: "lead-session" };
function teammateExtra(builderMemberId: string): Record<string, unknown> {
  return {
    sessionId: "builder-session",
    codexTeamMemberId: builderMemberId,
    codexTeamMemberRole: "teammate"
  };
}

async function seedTeamAndTeammate(): Promise<{ teamId: string; builderMemberId: string }> {
  await callHandler(
    createTeamCreateHandler({ stateRoot, workspaceRoot }),
    { team_name: "Alpha Team", description: "hook e2e" },
    leadExtra
  );
  const agentPayload = await callHandler(
    createAgentHandler({ stateRoot, workspaceRoot }),
    { name: "Builder", team_name: "alpha-team", prompt: "seed teammate" },
    leadExtra
  );
  const builderMemberId = (agentPayload.debug as { internal_member_id: string })
    .internal_member_id;
  const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
  let teamId: string;
  try {
    teamId = (
      adapter
        .getDatabase()
        .prepare(`SELECT team_id AS teamId FROM ${TABLE_NAMES.teams} LIMIT 1`)
        .get() as { teamId: string }
    ).teamId;
  } finally {
    adapter.close();
  }
  return { teamId, builderMemberId };
}

async function teammateToLead(builderMemberId: string, message: string): Promise<void> {
  await callHandler(
    createSendMessageHandler({ stateRoot, workspaceRoot }),
    { to: "team-lead@alpha-team", message, summary: "to lead" },
    teammateExtra(builderMemberId)
  );
}

// Run the hook as a child process with the workspace bound by env; capture stdout.
// Use the SAME node binary running the tests (process.execPath) — `node` may not be
// on PATH inside the test sandbox. The handlers in this suite seed the DB at an
// explicit `stateRoot`, so we pass the matching CODEX_TEAM_STATE_ROOT (the hook honors
// it per §2d.2, mirroring resolveStateRoot) so the hook reads the SAME DB.
function runHook(env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [HOOK_SCRIPT], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CODEX_TEAM_WORKSPACE_ROOT: workspaceRoot,
      CODEX_TEAM_STATE_ROOT: stateRoot,
      ...env
    },
    encoding: "utf8"
  });
}

describe("Item 1 §2d — UserPromptSubmit inbox-nudge hook", () => {
  it("emits NOTHING when there is no DB / no team (never throws into the prompt path)", () => {
    // No team seeded — the workspace has no DB file.
    const out = runHook();
    expect(out).toBe("");
  });

  it("emits NOTHING when the leader inbox is empty", async () => {
    await seedTeamAndTeammate();
    const out = runHook();
    expect(out).toBe("");
  });

  it("emits additionalContext with the unread count when the leader has mail", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "HELLO_LEAD_1");
    await teammateToLead(builderMemberId, "HELLO_LEAD_2");

    const out = runHook();
    const parsed = JSON.parse(out) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("2 new teammate");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("CheckInbox");
    // The nudge carries NO message body (notify + pull).
    expect(out).not.toContain("HELLO_LEAD_1");
    expect(out).not.toContain("HELLO_LEAD_2");
  });

  it("is a NO-OP for a teammate session (CODEX_TEAM_MEMBER_ROLE=teammate)", async () => {
    const { builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "STILL_FOR_LEAD");

    const out = runHook({ CODEX_TEAM_MEMBER_ROLE: "teammate" });
    expect(out).toBe("");
  });

  it("is READ-ONLY: running the hook never marks the leader's mail read", async () => {
    const { teamId, builderMemberId } = await seedTeamAndTeammate();
    await teammateToLead(builderMemberId, "DO_NOT_CONSUME");

    runHook();
    runHook();

    // The leader's row is STILL unread (read_at NULL) after running the hook.
    const adapter = new DurableStateAdapter({ stateRoot, workspaceRoot });
    try {
      const rows = adapter
        .getDatabase()
        .prepare(
          `SELECT read_at FROM ${TABLE_NAMES.messages}
           WHERE recipient_member_id = ?`
        )
        .all(`leader:${teamId}`) as Array<{ read_at: string | null }>;
      expect(rows.length).toBe(1);
      expect(rows[0].read_at).toBeNull();
    } finally {
      adapter.close();
    }

    // And the TL auto-surface can still claim it (proof the hook did not consume it).
    const wrapped = withLeaderInboxSurface(
      async () => ({ content: [{ type: "text", text: "{}" }] }),
      { stateRoot, workspaceRoot }
    );
    const surfaced = await callHandler(wrapped, {}, leadExtra);
    expect((surfaced.inbox as { unread_count: number }).unread_count).toBe(1);
  });
});
