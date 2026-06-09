import { describe, expect, it } from "vitest";

import { COMPATIBILITY_TOOLS, TARGET_CLAUDE_TOOLS } from "../src/tools/registry.js";

const expectedTargetTools = [
  "TeamCreate",
  "TeamDelete",
  "Agent",
  "SendMessage",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet"
];

const expectedToolStatuses = {
  TeamCreate: "implemented",
  TeamDelete: "implemented",
  Agent: "implemented",
  SendMessage: "implemented",
  TaskCreate: "implemented",
  TaskUpdate: "implemented",
  TaskList: "implemented",
  TaskGet: "implemented",
  TeamDiagnostics: "implemented"
};

describe("compatibility tool registry", () => {
  it("keeps the target Claude tool list exact", () => {
    expect([...TARGET_CLAUDE_TOOLS]).toEqual(expectedTargetTools);
  });

  it("registers all target tools plus TeamDiagnostics", () => {
    const names = COMPATIBILITY_TOOLS.map((tool) => tool.codexToolName);

    expect(names).toEqual([...expectedTargetTools, "TeamDiagnostics"]);
  });

  it("maps every target tool with a Claude compatibility description", () => {
    const targetTools = COMPATIBILITY_TOOLS.filter((tool) =>
      expectedTargetTools.includes(tool.claudeToolName)
    );

    expect(targetTools).toHaveLength(expectedTargetTools.length);
    for (const tool of targetTools) {
      expect(tool.description).toContain("Codex Team compatibility equivalent of Claude");
    }
  });

  it("reports implemented lifecycle Agent messaging and task tools honestly", () => {
    const statusByTool = Object.fromEntries(
      COMPATIBILITY_TOOLS.map((tool) => [tool.codexToolName, tool.status])
    );

    expect(statusByTool).toMatchObject(expectedToolStatuses);
  });

  it("describes Agent as Phase 5 lifecycle-aware backend-dependent execution", () => {
    const agent = COMPATIBILITY_TOOLS.find((tool) => tool.codexToolName === "Agent");

    expect(agent?.status).toBe("implemented");
    expect(agent?.description).toContain("Phase 5");
    expect(agent?.description).toContain("backend-dependent start and resume");
    expect(agent?.description).toContain("lifecycle");
  });

  it("describes SendMessage and task tools as durable Phase 5 coordination tools", () => {
    const sendMessage = COMPATIBILITY_TOOLS.find(
      (tool) => tool.codexToolName === "SendMessage"
    );
    const taskGet = COMPATIBILITY_TOOLS.find(
      (tool) => tool.codexToolName === "TaskGet"
    );

    expect(sendMessage?.status).toBe("implemented");
    expect(sendMessage?.description).toContain("persisted");
    expect(sendMessage?.description).toContain("Phase 5");
    expect(sendMessage?.description).toContain("next turn boundary");
    expect(taskGet?.status).toBe("implemented");
    expect(taskGet?.description).toContain("team-scoped");
    expect(taskGet?.description).toContain("Phase 5");
  });

  it("reports TeamDiagnostics as the implemented Phase 5 diagnostics handler", () => {
    const diagnostics = COMPATIBILITY_TOOLS.find(
      (tool) => tool.codexToolName === "TeamDiagnostics"
    );

    expect(diagnostics).toMatchObject({
      status: "implemented",
      nextPhase: "Phase 5"
    });
    expect(diagnostics?.description).toContain("Phase 5 lifecycle");
    expect(diagnostics?.description).toContain("workspace review");
    expect(diagnostics?.description).toContain("backend-dependent");
  });
});
