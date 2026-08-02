import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient, mintBackOf, handleFrom } from "./harness.js";
import { EventCapture, sid } from "../test-utils.js";
import { AgentCatOptions } from "../../types.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
} from "../../modules/constants.js";

async function setupHighLevel(trackOptions: AgentCatOptions = {}) {
  const mcp = new McpServer(
    { name: "v2-gmt", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.registerTool(
    "echo",
    { description: "Echo", inputSchema: z.object({ msg: z.string() }) },
    async (args: { msg: string }) => ({
      content: [{ type: "text" as const, text: `echo: ${args.msg}` }],
    }),
  );
  agentcat.track(mcp, "proj_test", trackOptions);
  const client = await connectClient(mcp);
  await client.listTools();
  return { mcp, client };
}

describe("v2 get_more_tools on a tracked high-level server", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("advertises the tool with required bespoke context, handles, and honest annotations", async () => {
    const { client } = await setupHighLevel({ enableAgentTracking: true });
    const { tools } = await client.listTools();
    const gmt = tools.find((t) => t.name === "get_more_tools")!;
    expect(gmt).toBeDefined();
    expect(gmt.description).toContain("Check for additional tools");
    expect((gmt.inputSchema as any).required).toContain("context");
    expect((gmt.inputSchema as any).properties).toHaveProperty("session_id");
    expect((gmt.inputSchema as any).properties).toHaveProperty("agent_id");
    expect((gmt.inputSchema as any).required).toContain("agent_id");
    expect(gmt.annotations).toEqual({
      title: "Get More Tools",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    await client.close();
  });

  it("answers with the canned text and publishes an event carrying userIntent", async () => {
    const { client } = await setupHighLevel();
    const missingDescription = "Need a database query tool for SQL operations";
    const result: any = await client.callTool({
      name: "get_more_tools",
      arguments: { context: missingDescription },
    });
    expect(result.content[0].text).toContain("Unfortunately");
    expect(result.content[0].text).toContain(
      "we have shown you the full tool list",
    );

    const [event] = capture.getEvents();
    expect(event.eventType).toBe(PublishEventRequestEventTypeEnum.mcpToolsCall);
    expect(event.resourceName).toBe("get_more_tools");
    expect(event.userIntent).toBe(missingDescription);
    // The bespoke context is a real parameter — preserved on the event.
    expect((event.parameters as any).request.params.arguments.context).toBe(
      missingDescription,
    );
    expect(event.sessionId).toMatch(/^ses_/);
    await client.close();
  });

  it("applies the mint-back to its result; the published event keeps only the answer", async () => {
    const { client } = await setupHighLevel({ enableAgentTracking: true });
    const result: any = await client.callTool({
      name: "get_more_tools",
      arguments: {
        context: "need a search tool",
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    const block = mintBackOf(result)!;
    expect(block).toContain("[MCP INSTRUCTIONS]: session_id issued");
    expect(block).not.toContain("agent_id");
    expect(handleFrom(block, "session_id")).toMatch(/^ses_/);

    const [event] = capture.getEvents();
    expect(event.sessionId).toBe(handleFrom(block, "session_id"));
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_AGENT_ID]: "opus-4.80-1m|claude-code|k3n9x",
      [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
    });
    // Mint-back is wire-only — never recorded on the event.
    expect(JSON.stringify(event.response)).not.toContain("[MCP INSTRUCTIONS]");
    expect(JSON.stringify(event.response)).toContain(
      "we have shown you the full tool list",
    );
    await client.close();
  });

  it("keeps task continuity when a supplied session_id spans customer tools and get_more_tools", async () => {
    const { client } = await setupHighLevel();
    const sessionId = sid("gmt_continuity");
    await client.callTool({
      name: "echo",
      arguments: {
        msg: "one",
        context: "before reporting",
        session_id: sessionId,
      },
    });
    const gmtResult: any = await client.callTool({
      name: "get_more_tools",
      arguments: {
        context: "need a bulk import tool",
        session_id: sessionId,
      },
    });
    expect(mintBackOf(gmtResult)).toBeUndefined(); // nothing minted
    await client.callTool({
      name: "echo",
      arguments: {
        msg: "two",
        context: "after reporting",
        session_id: sessionId,
      },
    });

    const events = capture.getEvents();
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.sessionId))).toEqual(
      new Set([sessionId]),
    );
    expect(events.map((e) => e.resourceName)).toEqual([
      "echo",
      "get_more_tools",
      "echo",
    ]);
    await client.close();
  });

  it("stamps identity resolved for a get_more_tools call onto its event", async () => {
    const { client } = await setupHighLevel({
      identify: async () => ({
        userId: "report-user",
        userData: { role: "Developer" },
      }),
    });
    await client.callTool({
      name: "get_more_tools",
      arguments: { context: "Need GraphQL query builder" },
    });

    const events = capture.getEvents();
    expect(
      events.some(
        (e) =>
          e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
      ),
    ).toBe(false);
    const [event] = events;
    expect(event.resourceName).toBe("get_more_tools");
    expect(event.identifyActorGivenId).toBe("report-user");
    expect(event.identifyActorData).toEqual({ role: "Developer" });
    await client.close();
  });
});
