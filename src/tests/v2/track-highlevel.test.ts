import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { EventCapture } from "../test-utils.js";

// Module-scope capture of what a tool handler actually received — result
// payload smuggling won't survive the wire schema, so assert through this.
let lastSeenArgs: Record<string, unknown> | undefined;

describe("track() on v2 McpServer", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("injects params + get_more_tools into tools/list and mirrors outputSchema", async () => {
    const mcp = new McpServer(
      { name: "v2-high", version: "1.0.0" },
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
        content: [{ type: "text" as const, text: args.msg }],
        structuredContent: { echoed: args.msg },
      }),
    );
    agentcat.track(mcp, "proj_test");
    const client = await connectClient(mcp);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).toContain("get_more_tools");
    const echo = tools.find((t) => t.name === "echo")!;
    expect((echo.inputSchema as any).properties.conversation_id).toBeDefined();
    expect((echo.inputSchema as any).properties.context).toBeDefined();
    expect(
      (echo.outputSchema as any).properties._mcp_instructions,
    ).toBeDefined();
    await client.close();
  });

  it("captures events, strips injected args (loose schema), appends mint-back, mirrors structuredContent", async () => {
    const mcp = new McpServer(
      { name: "v2-high", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "echo",
      {
        description: "Echo",
        inputSchema: z.looseObject({ msg: z.string() }),
        outputSchema: z.object({ echoed: z.string() }),
      },
      async (args: Record<string, unknown>) => {
        lastSeenArgs = args;
        return {
          content: [{ type: "text" as const, text: String(args.msg) }],
          structuredContent: { echoed: String(args.msg) },
        };
      },
    );
    agentcat.track(mcp, "proj_test");
    const client = await connectClient(mcp);
    await client.listTools(); // populate registries + trigger inner-tap sweep

    const result = (await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "test intent" }, // no conversation_id → mint
    })) as any;

    // Inner tap stripped what the loose schema passed through:
    expect(lastSeenArgs).toBeDefined();
    expect(lastSeenArgs!.conversation_id).toBeUndefined();
    expect(lastSeenArgs!.context).toBeUndefined();
    expect(lastSeenArgs!.msg).toBe("hi");

    // Mint-back: trailing text block announces the minted conversation_id, and the
    // structured mirror rides structuredContent (validates against the
    // injected outputSchema — the client checked it).
    const lastBlock = result.content[result.content.length - 1];
    expect(lastBlock.text).toContain("[MCP INSTRUCTIONS]");
    expect(result.structuredContent._mcp_instructions.conversation_id).toMatch(
      /^ses_/,
    );

    // Event: minted session, userIntent from context, raw args preserved.
    const events = capture.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].resourceName).toBe("echo");
    expect(events[0].sessionId).toMatch(/^ses_/);
    expect(events[0].userIntent).toBe("test intent");
    await client.close();
  });

  it("echoes a supplied conversation_id and captures error stacks via the executor tap", async () => {
    const mcp = new McpServer(
      { name: "v2-high", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const boom = new Error("kaboom with stack");
    mcp.registerTool(
      "explode",
      { description: "Throws", inputSchema: z.object({}) },
      async () => {
        throw boom;
      },
    );
    agentcat.track(mcp, "proj_test");
    const client = await connectClient(mcp);
    await client.listTools();

    const result = (await client.callTool({
      name: "explode",
      arguments: { conversation_id: "ses_fixed123" },
    })) as any;
    expect(result.isError).toBe(true); // v2 McpServer converts throws

    const [event] = capture.getEvents();
    expect(event.sessionId).toBe("ses_fixed123");
    expect(event.isError).toBe(true);
    expect(event.error?.message).toContain("kaboom with stack");
    expect(event.error?.stack).toBeTruthy(); // full stack via __agentcat_error
    await client.close();
  });

  it("re-wraps the regenerated executor after update() on the next list", async () => {
    const mcp = new McpServer(
      { name: "v2-high", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    let seen: Record<string, unknown> | undefined;
    const registered = mcp.registerTool(
      "echo",
      { description: "Echo", inputSchema: z.looseObject({ msg: z.string() }) },
      async (args: Record<string, unknown>) => {
        return { content: [{ type: "text" as const, text: "v1 handler" }] };
      },
    );
    agentcat.track(mcp, "proj_test");
    const client = await connectClient(mcp);
    await client.listTools();

    registered.update({
      callback: async (args: Record<string, unknown>) => {
        seen = args;
        return { content: [{ type: "text" as const, text: "v2 handler" }] };
      },
    } as any);
    await client.listTools(); // sweep re-wraps the regenerated executor

    await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "why", conversation_id: "ses_x" },
    });
    expect(seen!.msg).toBe("hi");
    expect(seen!.conversation_id).toBeUndefined(); // tap active on the NEW executor
    await client.close();
  });
});
