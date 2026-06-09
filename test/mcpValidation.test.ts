import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCodexTeamServer } from "../src/server.js";

let client: Client;
let server: ReturnType<typeof createCodexTeamServer>;

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({
    name: "codex-team-test",
    version: "0.1.0"
  });
  server = createCodexTeamServer();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
});

async function listToolSchema(name: string) {
  const tools = await client.listTools();
  const tool = tools.tools.find((entry) => entry.name === name);
  expect(tool).toBeDefined();

  return tool?.inputSchema ?? {};
}

describe("MCP boundary validation", () => {
  it("advertises Claude-style task payload schemas after implementation routing", async () => {
    const taskCreateSchema = await listToolSchema("TaskCreate");
    const taskUpdateSchema = await listToolSchema("TaskUpdate");
    const taskGetSchema = await listToolSchema("TaskGet");

    expect(taskCreateSchema.properties).toMatchObject({
      subject: expect.any(Object),
      description: expect.any(Object),
      active_form: expect.any(Object),
      owner: expect.any(Object),
      metadata: expect.any(Object)
    });
    expect(taskUpdateSchema.properties).toMatchObject({
      taskId: expect.any(Object),
      task_id: expect.any(Object),
      addBlocks: expect.any(Object),
      addBlockedBy: expect.any(Object),
      active_form: expect.any(Object),
      metadata: expect.any(Object),
      notes: expect.any(Object)
    });
    expect(taskGetSchema.properties).toMatchObject({
      taskId: expect.any(Object),
      task_id: expect.any(Object)
    });
  });

  it("advertises structured SendMessage.message protocol payloads", async () => {
    const sendMessageSchema = await listToolSchema("SendMessage");
    const messageSchema = (sendMessageSchema.properties as Record<string, unknown>)
      .message;
    const serializedMessageSchema = JSON.stringify(messageSchema);

    expect(sendMessageSchema.properties).toMatchObject({
      to: expect.any(Object),
      summary: expect.any(Object),
      message: expect.any(Object),
      from: expect.any(Object)
    });
    expect(serializedMessageSchema).toContain("shutdown_request");
    expect(serializedMessageSchema).toContain("shutdown_response");
    expect(serializedMessageSchema).toContain("plan_approval_response");
  });

  it("advertises compatible TeamCreate and Agent parameters", async () => {
    const tools = await client.listTools();
    const toolByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    const teamCreateRequired = toolByName.get("TeamCreate")?.inputSchema.required;
    const agentRequired = toolByName.get("Agent")?.inputSchema.required;

    expect(Array.isArray(teamCreateRequired) ? teamCreateRequired : []).toContain(
      "team_name"
    );
    expect(Array.isArray(agentRequired) ? agentRequired : []).not.toContain("name");
    expect(toolByName.get("TeamCreate")?.inputSchema.properties).toMatchObject({
      description: expect.any(Object),
      agent_type: expect.any(Object),
      model: expect.any(Object)
    });
    expect(toolByName.get("Agent")?.inputSchema.properties).toMatchObject({
      name: expect.any(Object),
      team_name: expect.any(Object),
      mode: expect.any(Object),
      prompt: expect.any(Object),
      description: expect.any(Object),
      model: expect.any(Object),
      agent_type: expect.any(Object),
      subagent_type: expect.any(Object),
      run_in_background: expect.any(Object),
      isolation: expect.any(Object),
      cwd: expect.any(Object)
    });
  });
});
