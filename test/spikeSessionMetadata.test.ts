import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/codex-session-metadata-spike.md", import.meta.url)
);

const REQUIRED_HEADINGS = [
  "# Codex Session Metadata Spike",
  "## codex CLI exec / exec resume",
  "## MCP (mcp-server)",
  "## app-server / remote-control",
  "## SDK",
  "## tmux",
  "## iTerm2",
  "## Lowered gate verdicts",
  "## OS sandbox (optional bonus)",
  "## Convergence outcome",
  "## Unsupported Claims"
];

const SIX_SURFACES = [
  "codex_cli_exec",
  "mcp",
  "app_server",
  "sdk",
  "tmux",
  "iterm2"
];

const UNSUPPORTED_ANCHORS = ["--agent-id", "--team-name", "do not invent session metadata"];

function readFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf8");
}

describe("codex-session-metadata-spike.md fixture shape", () => {
  it("contains every required heading", () => {
    const fixture = readFixture();
    for (const heading of REQUIRED_HEADINGS) {
      expect(fixture, `missing heading: ${heading}`).toContain(heading);
    }
  });

  it("records all six surfaces in the Lowered gate verdicts table", () => {
    const fixture = readFixture();
    const tableSection = fixture.slice(fixture.indexOf("## Lowered gate verdicts"));
    expect(tableSection).toContain("| surface | worktree_runnable | persistent_id | qualifies |");
    for (const surface of SIX_SURFACES) {
      expect(tableSection, `gate table missing surface: ${surface}`).toContain(surface);
    }
  });

  it("records a convergence outcome with converged_backend or escalate_to_team_lead", () => {
    const fixture = readFixture();
    expect(fixture).toContain("## Convergence outcome");
    expect(fixture).toMatch(/converged_backend|escalate_to_team_lead/);
    // At least one surface must qualify, OR the fixture must record an explicit escalation.
    expect(fixture).toMatch(/qualifies: yes|escalate_to_team_lead/);
  });

  it("keeps OS sandbox recorded as a non-gating bonus", () => {
    const fixture = readFixture();
    const sandboxSection = fixture.slice(fixture.indexOf("## OS sandbox (optional bonus)"));
    expect(sandboxSection).toMatch(/NOT a gate|never a gate|not a gate/i);
  });

  it("contains the unsupported-claims honesty anchors", () => {
    const fixture = readFixture();
    for (const anchor of UNSUPPORTED_ANCHORS) {
      expect(fixture, `missing unsupported-claims anchor: ${anchor}`).toContain(anchor);
    }
  });

  it("states the captured codex --version", () => {
    const fixture = readFixture();
    expect(fixture).toContain("codex-cli 0.138.0");
  });
});
