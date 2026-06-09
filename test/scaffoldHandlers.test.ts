import { describe, expect, it } from "vitest";

import { COMPATIBILITY_TOOLS } from "../src/tools/registry.js";
import {
  buildScaffoldToolPayload,
  createScaffoldToolHandler
} from "../src/tools/scaffoldHandlers.js";
import type { ToolMapping } from "../src/types.js";

const implementedLifecycleTools = [
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TeamDiagnostics"
];

describe("scaffold handlers", () => {
  it("does not include Phase 5 lifecycle/status tools as registry-backed scaffold representatives", () => {
    const registryBackedScaffoldRepresentatives = COMPATIBILITY_TOOLS.filter(
      (tool) => tool.status !== "implemented"
    ).map((tool) => tool.codexToolName);

    expect(registryBackedScaffoldRepresentatives).toEqual([]);
    for (const toolName of implementedLifecycleTools) {
      expect(registryBackedScaffoldRepresentatives).not.toContain(toolName);
    }
    expect(registryBackedScaffoldRepresentatives).not.toContain("TeamCreate");
    expect(registryBackedScaffoldRepresentatives).not.toContain("TeamDelete");
  });

  it("builds honest scaffold-only JSON only for a local unimplemented mapping object", async () => {
    const mapping: ToolMapping = {
      claudeToolName: "FutureTool",
      codexToolName: "FutureTool",
      description: "Local scaffold payload test mapping",
      status: "scaffold_only",
      nextPhase: "Phase 6"
    };

    const payload = buildScaffoldToolPayload(mapping);

    expect(payload).toMatchObject({
      codex_tool_name: "FutureTool",
      implemented_now: false,
      no_generic_subagent_fallback: true,
      status: "scaffold_only"
    });
    expect(payload.diagnostics_hint).toContain("TeamDiagnostics");
    expect(payload).not.toHaveProperty("team_file_path");
    expect(payload).not.toHaveProperty("message_id");
    expect(payload).not.toHaveProperty("task_id");
  });

  it("returns honest scaffold-only JSON from createScaffoldToolHandler for local mappings", async () => {
    const mapping: ToolMapping = {
      claudeToolName: "FutureTool",
      codexToolName: "FutureTool",
      description: "Local handler payload test mapping",
      status: "scaffold_only",
      nextPhase: "Phase 6"
    };
    const result = await createScaffoldToolHandler(mapping)();
    const payload = JSON.parse(result.content[0]?.text ?? "{}");

    expect(payload).toMatchObject({
      codex_tool_name: "FutureTool",
      implemented_now: false,
      no_generic_subagent_fallback: true,
      status: "scaffold_only"
    });
  });
});
