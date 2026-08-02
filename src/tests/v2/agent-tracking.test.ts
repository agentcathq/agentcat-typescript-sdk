import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient, mintBackOf, handleFrom } from "./harness.js";
import { EventCapture } from "../test-utils.js";
import { AgentCatOptions } from "../../types.js";
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
} from "../../modules/constants.js";

async function setupHighLevel(trackOptions: AgentCatOptions = {}) {
  const mcp = new McpServer(
    { name: "v2-agent-tracking", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.registerTool(
    "echo",
    {
      description: "Echo",
      inputSchema: z.object({ msg: z.string() }),
      outputSchema: z.object({ echoed: z.string() }),
    },
    async (args: { msg: string }) => ({
      content: [{ type: "text" as const, text: `echo: ${args.msg}` }],
      structuredContent: { echoed: args.msg },
    }),
  );
  agentcat.track(mcp, "proj_test", trackOptions);
  const client = await connectClient(mcp);
  await client.listTools();
  return { mcp, client };
}

describe("v2 agent tracking: enableAgentTracking true", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("advertises agent_id as required on every tool including get_more_tools", async () => {
    const { client } = await setupHighLevel({ enableAgentTracking: true });
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect((echo.inputSchema as any).properties).toHaveProperty("agent_id");
    expect((echo.inputSchema as any).properties).toHaveProperty("session_id");
    // agent_id is self-chosen and required; session_id stays optional (omission
    // is the minting signal).
    expect((echo.inputSchema as any).required).toContain("agent_id");
    expect((echo.inputSchema as any).required ?? []).not.toContain(
      "session_id",
    );
    const gmt = tools.find((t) => t.name === "get_more_tools")!;
    expect((gmt.inputSchema as any).properties).toHaveProperty("agent_id");
    expect((gmt.inputSchema as any).required).toContain("agent_id");
    await client.close();
  });

  it("tolerates omission: task-only mint-back, event without agent identity", async () => {
    const { client } = await setupHighLevel({ enableAgentTracking: true });
    const result: any = await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "agent omission" },
    });
    const block = mintBackOf(result)!;
    expect(block).toContain("[MCP INSTRUCTIONS]: session_id issued");
    expect(block).not.toContain("agent_id");

    const mirror = result.structuredContent._mcp_instructions;
    expect(mirror.session_id).toBe(handleFrom(block, "session_id"));
    expect(mirror).not.toHaveProperty("agent_id");

    const [event] = capture.getEvents();
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_SOURCE);
    await client.close();
  });

  it("echoes a self-chosen agent_id verbatim with source tag supplied", async () => {
    const { client } = await setupHighLevel({ enableAgentTracking: true });
    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        msg: "hi",
        context: "agent echo",
        session_id: "ses_fixed",
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    expect(mintBackOf(result)).toBeUndefined();
    const mirror = result.structuredContent._mcp_instructions;
    expect(mirror.session_id).toBe("ses_fixed");
    expect(mirror.agent_id).toBe("opus-4.80-1m|claude-code|k3n9x");
    expect(mirror.instructions).toContain("confirmed");

    const [event] = capture.getEvents();
    expect(event.sessionId).toBe("ses_fixed");
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_AGENT_ID]: "opus-4.80-1m|claude-code|k3n9x",
      [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
    });
    await client.close();
  });

  it("subagent flow: inherited task + own generated agent_id, no mint-back", async () => {
    const { client } = await setupHighLevel({ enableAgentTracking: true });
    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        msg: "hi",
        context: "subagent flow",
        session_id: "ses_parent",
        agent_id: "haiku-4.5|claude-code|q7w2e",
      },
    });
    expect(mintBackOf(result)).toBeUndefined();
    const [event] = capture.getEvents();
    expect(event.sessionId).toBe("ses_parent");
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_AGENT_ID]: "haiku-4.5|claude-code|q7w2e",
      [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
    });
    await client.close();
  });
});

describe("v2 agent tracking: OFF by default", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("injects no agent_id param, tags nothing, and mints task-only", async () => {
    const { client } = await setupHighLevel();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect((t.inputSchema as any).properties).not.toHaveProperty("agent_id");
    }
    const result: any = await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "defaults" },
    });
    const block = mintBackOf(result)!;
    expect(block).toContain("[MCP INSTRUCTIONS]: session_id issued");
    expect(block).not.toContain("agent_id");
    const [event] = capture.getEvents();
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_SOURCE);
    await client.close();
  });
});
