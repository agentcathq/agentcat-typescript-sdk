import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient, mintBackOf } from "./harness.js";
import { EventCapture } from "../test-utils.js";
import { AgentCatOptions } from "../../types.js";
import { DEFAULT_CONTEXT_PARAMETER_DESCRIPTION } from "../../modules/constants.js";

async function setupHighLevel(trackOptions: AgentCatOptions = {}) {
  const mcp = new McpServer(
    { name: "v2-options", version: "1.0.0" },
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
  return { mcp, client };
}

describe("v2 options: enableTracing false", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("injects no handle params into the listing", async () => {
    const { client } = await setupHighLevel({ enableTracing: false });
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect((echo.inputSchema as any).properties).not.toHaveProperty(
      "conversation_id",
    );
    expect((echo.inputSchema as any).properties).not.toHaveProperty("agent_id");
    await client.close();
  });

  it("passes tool calls through unwrapped-behavior: no event, no mint-back", async () => {
    const { client } = await setupHighLevel({ enableTracing: false });
    await client.listTools();
    const result: any = await client.callTool({
      name: "echo",
      arguments: { msg: "hi" },
    });
    expect(result.content[0].text).toBe("echo: hi");
    expect(mintBackOf(result)).toBeUndefined();
    expect(capture.getEvents()).toHaveLength(0);
    await client.close();
  });

  it("still answers get_more_tools directly, publishing nothing", async () => {
    const { client } = await setupHighLevel({ enableTracing: false });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "get_more_tools")).toBeDefined();
    const result: any = await client.callTool({
      name: "get_more_tools",
      arguments: { context: "need a search tool" },
    });
    expect(result.content[0].text).toContain(
      "we have shown you the full tool list",
    );
    expect(mintBackOf(result)).toBeUndefined();
    expect(capture.getEvents()).toHaveLength(0);
    await client.close();
  });
});

describe("v2 options: enableReportMissing false", () => {
  it("omits get_more_tools; handle injection is unaffected", async () => {
    const { client } = await setupHighLevel({ enableReportMissing: false });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "get_more_tools")).toBeUndefined();
    const echo = tools.find((t) => t.name === "echo")!;
    expect((echo.inputSchema as any).properties).toHaveProperty(
      "conversation_id",
    );
    expect((echo.inputSchema as any).properties).toHaveProperty("context");
    await client.close();
  });
});

describe("v2 options: enableToolCallContext false", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("injects no context param; events carry no userIntent", async () => {
    const { client } = await setupHighLevel({ enableToolCallContext: false });
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect((echo.inputSchema as any).properties).not.toHaveProperty("context");
    // Handles are independent of the context feature.
    expect((echo.inputSchema as any).properties).toHaveProperty(
      "conversation_id",
    );

    await client.callTool({
      name: "echo",
      arguments: { msg: "hi", conversation_id: "ses_ctxoff" },
    });
    const [event] = capture.getEvents();
    expect(event.sessionId).toBe("ses_ctxoff");
    expect(event.userIntent).toBeUndefined();
    await client.close();
  });
});

describe("v2 options: customContextDescription", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("lands the custom text in the advertised context param description", async () => {
    const customDescription = "Explain your reasoning for this action";
    const { client } = await setupHighLevel({
      enableToolCallContext: true,
      customContextDescription: customDescription,
    });
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    const context = (echo.inputSchema as any).properties.context;
    expect(context).toBeDefined();
    expect(context.description).toBe(customDescription);
    expect(context.description).not.toBe(DEFAULT_CONTEXT_PARAMETER_DESCRIPTION);
    // get_more_tools keeps its bespoke context parameter untouched.
    const gmt = tools.find((t) => t.name === "get_more_tools")!;
    expect((gmt.inputSchema as any).properties.context.description).not.toBe(
      customDescription,
    );
    await client.close();
  });

  it("captures userIntent from calls made with the custom description configured", async () => {
    const { client } = await setupHighLevel({
      enableToolCallContext: true,
      customContextDescription: "Tell me what you're trying to accomplish",
    });
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "I need to add a task to my list" },
    });
    const [event] = capture.getEvents();
    expect(event.resourceName).toBe("echo");
    expect(event.userIntent).toBe("I need to add a task to my list");
    await client.close();
  });

  it("uses the default description when customContextDescription is not provided", async () => {
    const { client } = await setupHighLevel({ enableToolCallContext: true });
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect((echo.inputSchema as any).properties.context.description).toBe(
      DEFAULT_CONTEXT_PARAMETER_DESCRIPTION,
    );
    await client.close();
  });
});

describe("v2 options: track() edge paths", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("second track() on the same server is a no-op: no double wrap, one event per call", async () => {
    const { mcp, client } = await setupHighLevel();
    agentcat.track(mcp, "proj_test"); // must not re-install
    const { tools } = await client.listTools();
    expect(tools.filter((t) => t.name === "get_more_tools")).toHaveLength(1);

    const result: any = await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "double-track" },
    });
    const blocks = (result.content as any[]).filter(
      (c) => c.type === "text" && c.text.startsWith("[MCP INSTRUCTIONS]"),
    );
    expect(blocks).toHaveLength(1); // mint-back never doubles
    expect(capture.getEvents()).toHaveLength(1);
    await client.close();
  });

  it("returns an incompatible object untouched instead of throwing", async () => {
    const notAServer = { some: "object" };
    const returned = agentcat.track(notAServer, "proj_test");
    expect(returned).toBe(notAServer);
  });
});
