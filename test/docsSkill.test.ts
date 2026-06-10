import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TARGET_CLAUDE_TOOLS } from "../src/tools/registry.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedCompatibilityStatuses = [
  "Supported",
  "Approximated",
  "Backend-dependent",
  "Unsupported"
] as const;

type CompatibilityStatus = (typeof allowedCompatibilityStatuses)[number];

const expectedCompatibilityStatuses = new Map<string, CompatibilityStatus>([
  ["Durable team creation with leader identity", "Supported"],
  ["Active-team inference across restart-style state reopening", "Supported"],
  ["Named TeamMate identity through `Agent`", "Supported"],
  ["Ordinary `Agent` without `name` remains ordinary subagent path", "Supported"],
  ["Explicit message persistence before backend delivery", "Supported"],
  ["Task create/update/list/get over SQLite task state", "Supported"],
  ["Restart persistence for active bindings, messages, and tasks", "Supported"],
  ["`TeamDiagnostics` status summaries", "Supported"],
  ["Per-TeamMate real backend status (OBS-01)", "Supported"],
  ["Enriched, sanitized backend diagnostics (OBS-02)", "Supported"],
  ["Workspace review safety and `needs_review`", "Supported"],
  ["Read-only / review-only execution (no file writes)", "Supported"],
  ["File-modifying execution via an isolated git worktree (D-01/D-03)", "Backend-dependent"],
  [
    "OS sandbox overlay on top of the worktree (optional, non-gating)",
    "Backend-dependent"
  ],
  [
    "TL-driven auditable worktree merge / escalate (`TeamMerge`, D-04)",
    "Backend-dependent"
  ],
  [
    "Fail-closed block of file-modifying work without an isolated worktree (ISOL-01)",
    "Supported"
  ],
  ["Running-recipient turn-boundary queueing", "Approximated"],
  ["Default backend execution with no configured runner", "Backend-dependent"],
  ["Backend start/resume with durable metadata", "Backend-dependent"],
  ["Pane-style terminal UI", "Backend-dependent"],
  ["Auto pane create/attach over a real run (PANE-01 / D-01)", "Backend-dependent"],
  ["Pane fallback without breaking durable state (PANE-02)", "Supported"],
  ["Idle/stopped panes stay open (D-04 / I-05)", "Backend-dependent"],
  ['Broadcast delivery through `to: "*"`', "Unsupported"],
  ["Cross-session bridge delivery", "Unsupported"],
  ["Exact Claude tmux/iTerm2 pane parity", "Unsupported"],
  ["Approval-bridge parity", "Unsupported"],
  ["True Claude in-process runtime behavior", "Unsupported"],
  ["AsyncLocalStorage-equivalent context", "Unsupported"],
  ["Hidden Claude CLI args", "Unsupported"],
  ["Guaranteed mid-turn message injection", "Unsupported"]
]);

const docsBoundaryStrings = [
  "true Claude in-process runtime behavior",
  "AsyncLocalStorage-equivalent context",
  "hidden Claude CLI args",
  "pane-style approximation",
  "terminal scrollback",
  "not exact Claude tmux/iTerm2 pane parity",
  "approval-bridge parity",
  "guaranteed mid-turn message injection"
];

const unsupportedBoundaryRows = [
  "True Claude in-process runtime behavior",
  "AsyncLocalStorage-equivalent context",
  "Hidden Claude CLI args",
  "Exact Claude tmux/iTerm2 pane parity",
  "Approval-bridge parity",
  "Guaranteed mid-turn message injection"
];

const syntheticWorkflowRequiredTools = [
  "TeamCreate",
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TeamDiagnostics"
];

async function readPackageFile(path: string): Promise<string> {
  return readFile(resolve(packageRoot, path), "utf8");
}

function parseCompatibilityTable(markdown: string): Map<string, Record<string, string>> {
  const lines = markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line));
  const [headerLine, ...rowLines] = lines;
  const headers = headerLine
    ?.split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());

  expect(headers).toEqual([
    "Behavior",
    "Status",
    "What Codex Team Provides",
    "Boundary",
    "Evidence"
  ]);

  return new Map(
    rowLines.map((line) => {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      const row = Object.fromEntries(
        (headers ?? []).map((header, index) => [header, cells[index] ?? ""])
      );

      return [row.Behavior, row];
    })
  );
}

describe("docs and compatibility skill", () => {
  it("keeps required Agent Team skill guidance", async () => {
    const skill = await readPackageFile("skills/agent-team-compatibility/SKILL.md");

    expect(skill).toContain("TeamCreate");
    expect(skill).toContain("SendMessage");
    expect(skill).toContain("Agent Team compatibility layer unavailable");
    expect(skill).toContain("Do not silently substitute generic subagents");
    expect(skill).toContain("queued for the next turn boundary");
    expect(skill).toContain("backend-dependent start and resume");
    expect(skill).toContain("workspace review");
    expect(skill).toContain("needs_review");
    expect(skill).toContain("pending_review");
    expect(skill).toContain("pane-style approximation");
    expect(skill).toContain("terminal scrollback");
    expect(skill).toContain("not exact Claude tmux/iTerm2 pane parity");
    expect(skill).toContain("not exact Claude runtime parity");
    expect(skill).toContain("default backend reports unsupported execution");
    expect(skill).toContain("docs/compatibility.md");
    expect(skill).toContain("docs/validation.md");
  });

  it("documents startup diagnostics and all mapped tools", async () => {
    const startup = await readPackageFile("docs/startup.md");
    const mapping = await readPackageFile("docs/tool-mapping.md");

    expect(startup).toContain("TeamDiagnostics");
    expect(startup).toContain("dist/index.js");
    expect(startup).toContain("CODEX_TEAM_PANE_MODE=1");
    expect(startup).toContain("CODEX_TEAM_PANE_BACKEND=auto|tmux|iterm2");
    expect(startup).toContain("CODEX_TEAM_PANE_SESSION_PREFIX=<prefix>");
    expect(startup).toContain("CODEX_TEAM_CODEX_COMMAND=<path-or-command>");
    expect(startup).toContain("CODEX_TEAM_PANE_BACKEND");
    expect(startup).toContain("CODEX_TEAM_PANE_SESSION_PREFIX");
    expect(startup).toContain("CODEX_TEAM_CODEX_COMMAND");
    expect(startup).toContain("tmux -L <socket> attach-session -t <session>");
    expect(startup).toContain("pane-style approximation");
    expect(startup).toContain("terminal scrollback");
    expect(startup).toContain("not exact Claude tmux/iTerm2 pane parity");

    for (const tool of TARGET_CLAUDE_TOOLS) {
      expect(mapping).toContain(tool);
    }
    expect(mapping).toContain("TeamDiagnostics");
    expect(mapping).toContain("implemented");
    expect(mapping).toContain("backend-dependent start and resume");
    expect(mapping).toContain("queued for the next turn boundary");
    expect(mapping).toContain("workspace review");
    expect(mapping).toContain("needs_review");
    expect(mapping).toContain("pending_review");
    expect(mapping).toContain("pane attach/status");
    expect(mapping).toContain("SendMessage");
    expect(mapping).toContain("terminal scrollback");
    expect(mapping).toContain("not exact Claude tmux/iTerm2 pane parity");
    expect(mapping).toContain("not exact Claude runtime parity");
    expect(mapping).toContain("broadcast_unsupported_in_v1");
    expect(mapping).toContain("task_edges");
    expect(mapping).toContain("task_events");
    expect(mapping).toContain("compatibility.md");
    expect(mapping).toContain("validation.md");
    expect(startup).toContain("Durable teams, active bindings, TeamMate lifecycle/run rows, persisted messages, and team-scoped tasks are implemented");
    expect(startup).toContain("default backend reports unsupported execution");
    expect(startup).toContain("backend-dependent start and resume");
    expect(startup).toContain("queued for the next turn boundary");
    expect(startup).toContain("workspace review");
    expect(startup).toContain("needs_review");
    expect(startup).toContain("pane attach/status");
    expect(startup).toContain("SendMessage");
    expect(startup).toContain("not exact Claude runtime parity");
    expect(startup).toContain("compatibility.md");
    expect(startup).toContain("validation.md");
  });

  it("pins the Phase 7 compatibility matrix contract", async () => {
    const compatibility = await readPackageFile("docs/compatibility.md");
    const rows = parseCompatibilityTable(compatibility);
    const allowed = new Set<string>(allowedCompatibilityStatuses);

    for (const status of allowedCompatibilityStatuses) {
      expect(compatibility).toContain(status);
    }
    for (const boundary of docsBoundaryStrings) {
      expect(compatibility).toContain(boundary);
    }

    expect(rows.size).toBe(expectedCompatibilityStatuses.size);

    for (const [behavior, expectedStatus] of expectedCompatibilityStatuses) {
      const row = rows.get(behavior);

      expect(row, `Missing compatibility row: ${behavior}`).toBeDefined();
      expect(row?.Status).toBe(expectedStatus);
    }

    for (const [behavior, row] of rows) {
      expect(allowed.has(row.Status), `${behavior} has invalid Status`).toBe(true);
      expect(
        /\[[^\]]+\]\([^)]+\)/.test(row.Evidence),
        `${behavior} missing markdown evidence link in Evidence`
      ).toBe(true);
    }

    for (const behavior of unsupportedBoundaryRows) {
      const row = rows.get(behavior);

      expect(row?.Status).toBe("Unsupported");
      expect(row?.Status).not.toBe("Supported");
    }
  });

  it("documents Phase 7 validation commands and fixture evidence", async () => {
    const validation = await readPackageFile("docs/validation.md");
    const fixture = await readPackageFile(
      "test/fixtures/synthetic-claude-team-workflow.md"
    );
    const skill = await readPackageFile(
      "skills/agent-team-compatibility/SKILL.md"
    );

    expect(validation).toContain(
      "npm test -- --run test/compatibilityWorkflow.test.ts test/docsSkill.test.ts"
    );
    expect(validation).toContain("npm test -- --run test/docsSkill.test.ts");
    expect(validation).toContain(
      "npm run build && npm test -- --run && npm run smoke:list-tools"
    );
    expect(validation).toContain("test/fixtures/synthetic-claude-team-workflow.md");
    expect(validation).toContain("test/compatibilityWorkflow.test.ts");
    expect(validation).toContain("test/docsSkill.test.ts");
    expect(validation).toContain("compatibility.md");
    expect(validation).toContain("scripts/smoke-list-tools.mjs");
    expect(validation).toContain("Known Limitations");
    expect(validation).toContain(
      "npm test -- --run test/paneBackend.test.ts test/paneExecutionBackend.test.ts test/paneDiagnostics.test.ts test/paneMcp.test.ts"
    );
    expect(validation).toContain("npm run build");
    expect(validation).toContain("npm test -- --run");
    expect(validation).toContain("npm run smoke:list-tools");
    expect(validation).toContain("tmux -L <socket> attach-session -t <session>");
    expect(validation).toContain("CODEX_TEAM_PANE_BACKEND=iterm2");
    expect(validation).toContain("pending_review");
    expect(validation).toContain("needs_review");
    expect(validation).toContain("pane attach/status");
    expect(validation).toContain("terminal scrollback");
    expect(validation).toContain("not exact Claude tmux/iTerm2 pane parity");

    for (const tool of syntheticWorkflowRequiredTools) {
      expect(fixture).toContain(tool);
    }
    expect(fixture).toContain("Agent Team compatibility layer unavailable");
    expect(fixture).toContain("Do not silently substitute generic subagents");
    expect(skill).toContain(
      "docs/compatibility.md` and `docs/validation.md` for Phase 7 support labels"
    );
    expect(skill).not.toContain("Phase 6 support labels");
  });

  it("documents the Phase 12 worktree merge model, TeamMerge tool, and four execution categories", async () => {
    const compatibility = await readPackageFile("docs/compatibility.md");
    const mapping = await readPackageFile("docs/tool-mapping.md");
    const startup = await readPackageFile("docs/startup.md");
    const validation = await readPackageFile("docs/validation.md");

    // Compatibility matrix distinguishes the four execution categories.
    expect(compatibility).toContain("Read-only / review-only execution (no file writes)");
    expect(compatibility).toContain(
      "File-modifying execution via an isolated git worktree (D-01/D-03)"
    );
    expect(compatibility).toContain(
      "OS sandbox overlay on top of the worktree (optional, non-gating)"
    );
    expect(compatibility).toContain(
      "Fail-closed block of file-modifying work without an isolated worktree (ISOL-01)"
    );
    expect(compatibility).toContain("TeamMerge");

    // TeamMerge is an honestly-labeled codex-team extension + the merge model is documented.
    expect(mapping).toContain("TeamMerge");
    expect(mapping).toContain("codex-team extension");
    expect(mapping).toContain("TL autonomous merge + human fallback");
    expect(mapping).toContain("never a silent background auto-merge");
    expect(mapping).toContain("overrides Phase 5 D-15");

    // Startup + validation document the TL merge flow and the maintainer real UAT.
    expect(startup).toContain("TeamMerge");
    expect(startup).toContain("TL autonomous merge + human fallback");
    expect(startup).toContain("Maintainer real UAT");
    expect(validation).toContain("test/executionAcceptanceWalkthrough.test.ts");
    expect(validation).toContain("test/isolationEnforcement.test.ts");
    expect(validation).toContain("Maintainer real UAT");
  });
});
