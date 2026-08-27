import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { EventCapture, sid } from "../test-utils.js";

// Module-scope capture of what the late-registered handler actually received —
// result payload smuggling won't survive the wire schema.
let lastSeenArgs: Record<string, unknown> | undefined;

describe("v2 late registration: registerTool AFTER track()", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    lastSeenArgs = undefined;
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("advertises a tool registered after track() with injected params", async () => {
    const mcp = new McpServer(
      { name: "v2-late", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    // Track FIRST — zero tools registered, so even the SDK's lazy
    // setToolRequestHandlers has not run yet. The registry proxy and the
    // registration re-arm patch carry the whole setup.
    agentcat.track(mcp, "proj_test");
    mcp.registerTool(
      "late_tool",
      {
        description: "Registered after tracking was enabled",
        inputSchema: z.object({ message: z.string() }),
      },
      async (args: { message: string }) => ({
        content: [
          { type: "text" as const, text: `Processed: ${args.message}` },
        ],
      }),
    );
    const client = await connectClient(mcp);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("late_tool");
    expect(names).toContain("get_more_tools");
    const late = tools.find((t) => t.name === "late_tool")!;
    expect((late.inputSchema as any).properties.session_id).toBeDefined();
    expect((late.inputSchema as any).properties.context).toBeDefined();
    await client.close();
  });

  it("strips injected args that a loose schema passes through (inner tap on the late executor)", async () => {
    const mcp = new McpServer(
      { name: "v2-late", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    agentcat.track(mcp, "proj_test");
    mcp.registerTool(
      "late_loose",
      {
        description: "Loose schema",
        inputSchema: z.looseObject({ message: z.string() }),
      },
      async (args: Record<string, unknown>) => {
        lastSeenArgs = args;
        return {
          content: [{ type: "text" as const, text: String(args.message) }],
        };
      },
    );
    const client = await connectClient(mcp);
    await client.listTools();

    await client.callTool({
      name: "late_loose",
      arguments: {
        message: "hi",
        context: "late strip test",
        session_id: sid("late"),
      },
    });

    expect(lastSeenArgs).toBeDefined();
    expect(lastSeenArgs!.session_id).toBeUndefined();
    expect(lastSeenArgs!.context).toBeUndefined();
    expect(lastSeenArgs!.message).toBe("hi");

    const [event] = capture.getEvents();
    expect(event.sessionId).toBe(sid("late"));
    expect(event.userIntent).toBe("late strip test");
    // The event keeps the raw request, injected params included.
    expect((event.parameters as any).request.params.arguments.session_id).toBe(
      sid("late"),
    );
    await client.close();
  });

  it("captures full error stacks from a late-registered tool via the executor tap", async () => {
    const mcp = new McpServer(
      { name: "v2-late", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    agentcat.track(mcp, "proj_test");
    const boom = new Error("late kaboom with stack");
    mcp.registerTool(
      "late_explode",
      { description: "Throws", inputSchema: z.object({}) },
      async () => {
        throw boom;
      },
    );
    const client = await connectClient(mcp);
    await client.listTools();

    const result: any = await client.callTool({
      name: "late_explode",
      arguments: { session_id: sid("late_err") },
    });
    expect(result.isError).toBe(true); // v2 McpServer converts throws

    const [event] = capture.getEvents();
    expect(event.sessionId).toBe(sid("late_err"));
    expect(event.isError).toBe(true);
    expect(event.error?.message).toContain("late kaboom with stack");
    expect(event.error?.stack).toBeTruthy(); // full stack via __agentcat_error
    await client.close();
  });

  it("stamps resolved identity onto events from late-registered tools", async () => {
    const mcp = new McpServer(
      { name: "v2-late", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    let identifyCalled = false;
    agentcat.track(mcp, "proj_test", {
      identify: async (request, extra) => {
        identifyCalled = true;
        expect(request).toBeDefined();
        expect(extra).toBeDefined();
        return { userId: "post-track-user", userData: { name: "Post Track" } };
      },
    });
    mcp.registerTool(
      "post_track_tool",
      {
        description: "A tool added after tracking was enabled",
        inputSchema: z.object({ message: z.string() }),
      },
      async (args: { message: string }) => ({
        content: [
          { type: "text" as const, text: `Processed: ${args.message}` },
        ],
      }),
    );
    const client = await connectClient(mcp);
    await client.listTools();

    const result: any = await client.callTool({
      name: "post_track_tool",
      arguments: {
        message: "post-track identification",
        context: "verifying identify on dynamically added tools",
      },
    });
    expect(result.content[1].text).toContain("post-track identification");
    expect(identifyCalled).toBe(true);

    const [event] = capture.getEvents();
    expect(event.resourceName).toBe("post_track_tool");
    expect(event.userIntent).toBe(
      "verifying identify on dynamically added tools",
    );
    expect(event.identifyActorGivenId).toBe("post-track-user");
    expect(event.identifyActorData).toEqual({ name: "Post Track" });
    await client.close();
  });
});
