import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/server";
import * as agentcat from "../../index.js";
import { connectClient, mintBackOf, handleFrom } from "./harness.js";
import { EventCapture, sid } from "../test-utils.js";
import { AgentCatOptions } from "../../types.js";
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
  AGENTCAT_TAG_SESSION_SOURCE,
} from "../../modules/constants.js";

/**
 * Twin of the v1 handles-integration low-level suite, on a real v2 low-level
 * Server (string-method registration). Agent tracking is opt-in, so the
 * helper opts in; tests may override.
 */
async function setupLowLevel(trackOptions: AgentCatOptions = {}) {
  const server = new Server(
    { name: "v2-low-handles", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const receivedArgs: any[] = [];
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "echo",
        description: "echoes",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async (request: any) => {
    receivedArgs.push(request.params.arguments);
    if (request.params.arguments?.text === "explode") {
      return { isError: true, content: [{ type: "text", text: "boom" }] };
    }
    if (request.params.arguments?.text === "throw") {
      throw new Error("low-level handler exploded");
    }
    return {
      content: [
        { type: "text", text: `echo: ${request.params.arguments?.text}` },
      ],
    };
  });
  agentcat.track(server, "proj_test", {
    enableAgentTracking: true,
    ...trackOptions,
  });
  const client = await connectClient(server);
  return { server, client, receivedArgs };
}

describe("v2 low-level server: explicit handles", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("injects optional handles into listed tool schemas in canonical order", async () => {
    const { client } = await setupLowLevel();
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(Object.keys((echo.inputSchema as any).properties)).toEqual([
      "text",
      "session_id",
      "agent_id",
      "context",
    ]);
    expect((echo.inputSchema as any).required).toEqual([
      "text",
      "agent_id",
      "context",
    ]);
    const gmt = tools.find((t) => t.name === "get_more_tools")!;
    expect((gmt.inputSchema as any).properties).toHaveProperty("session_id");
    expect((gmt.inputSchema as any).properties).toHaveProperty("agent_id");
    await client.close();
  });

  it("publishes no tools/list or initialize events", async () => {
    const { client } = await setupLowLevel();
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: { text: "hi", context: "testing" },
    });
    const types = capture.getEvents().map((e) => e.eventType);
    expect(types).not.toContain("mcp:tools/list");
    expect(types).not.toContain("mcp:initialize");
    expect(types).toContain("mcp:tools/call");
    await client.close();
  });

  it("first call mints session_id, appends the mint-back, and tags the task source", async () => {
    const { client } = await setupLowLevel();
    await client.listTools();
    const result: any = await client.callTool({
      name: "echo",
      arguments: { text: "hi", context: "testing intent" },
    });
    const block = mintBackOf(result)!;
    expect(block).toContain("[MCP INSTRUCTIONS]: session_id issued.");
    expect(block).not.toContain("agent_id");
    const sessionId = handleFrom(block, "session_id");
    expect(sessionId).toMatch(/^ses_/);

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe(sessionId);
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
    });
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_SOURCE);
    await client.close();
  });

  it("strips injected params before the customer handler; event keeps them", async () => {
    const { client, receivedArgs } = await setupLowLevel();
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "why",
        session_id: sid("x"),
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    expect(receivedArgs[0]).toEqual({ text: "hi" });
    const event = capture.findEventByType("mcp:tools/call")!;
    expect((event.parameters as any).request.params.arguments.session_id).toBe(
      sid("x"),
    );
    await client.close();
  });

  it("appends the mint-back on isError results; event.response and event.error stay clean", async () => {
    const { client } = await setupLowLevel();
    await client.listTools();
    const result: any = await client.callTool({
      name: "echo",
      arguments: { text: "explode", context: "testing" },
    });
    expect(result.isError).toBe(true);
    expect(mintBackOf(result)).toContain(
      "[MCP INSTRUCTIONS]: session_id issued.",
    );
    expect(mintBackOf(result)).not.toContain("agent_id");

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.isError).toBe(true);
    expect(JSON.stringify(event.response)).not.toContain("[MCP INSTRUCTIONS]");
    expect(event.error?.message).toContain("boom");
    expect(event.error?.message).not.toContain("[MCP INSTRUCTIONS]");
    await client.close();
  });

  it("publishes the event and rethrows when the low-level handler throws", async () => {
    const { client } = await setupLowLevel();
    await client.listTools();
    await expect(
      client.callTool({
        name: "echo",
        arguments: {
          text: "throw",
          context: "testing",
          session_id: sid("boom"),
        },
      }),
    ).rejects.toThrow();

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe(sid("boom"));
    expect(event.isError).toBe(true);
    expect(event.error?.message).toContain("low-level handler exploded");
    expect(event.error?.stack).toBeTruthy();
    await client.close();
  });

  it("minting call: block on the wire, absent from event.response", async () => {
    const { client } = await setupLowLevel();
    await client.listTools();
    const result: any = await client.callTool({
      name: "echo",
      arguments: { text: "hi", context: "testing intent" },
    });
    expect(mintBackOf(result)).toContain(
      "[MCP INSTRUCTIONS]: session_id issued.",
    );
    expect(mintBackOf(result)).not.toContain("agent_id");

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(JSON.stringify(event.response)).not.toContain("[MCP INSTRUCTIONS]");
    expect((event.response as any).content).toEqual([
      { type: "text", text: "echo: hi" },
    ]);
    await client.close();
  });

  it("echoed handles: event.response is exactly the handler result", async () => {
    const { client } = await setupLowLevel();
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "testing",
        session_id: sid("fixed"),
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.response).toEqual({
      content: [{ type: "text", text: "echo: hi" }],
    });
    await client.close();
  });

  it("an invalid session_id publishes sessionless and tells the agent to re-send", async () => {
    const { client } = await setupLowLevel();
    await client.listTools();
    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "testing intent",
        session_id: "not-a-real-id",
      },
    });

    expect(mintBackOf(result)).toContain("session_id not recognized");

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe("");
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_SESSION_SOURCE]: "invalid",
    });
    await client.close();
  });

  it("stamps _meta clientInfo and protocol version when present", async () => {
    const { server, client } = await setupLowLevel();
    await client.listTools();
    // Drive the wrapped handler directly to control _meta (the SDK client
    // does not expose per-request _meta injection). The v2 SDK's handler
    // wrapper reads ctx.mcpReq.requestState(), so supply the minimal ctx.
    const handler = (server as any)._requestHandlers.get("tools/call");
    await handler(
      {
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { text: "hi", context: "testing" },
          _meta: {
            "io.modelcontextprotocol/clientInfo": {
              name: "modern-client",
              version: "2.0",
            },
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
        },
      },
      { mcpReq: { id: 7, requestState: () => undefined, envelope: {} } },
    );
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.clientName).toBe("modern-client");
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_PROTOCOL_VERSION]: "2026-07-28",
    });
    await client.close();
  });

  it("prefers the v2 envelope for clientInfo and protocol version", async () => {
    const { server, client } = await setupLowLevel();
    await client.listTools();
    // v2 lifts the reserved io.modelcontextprotocol/* keys out of _meta into
    // the request envelope before dispatch — the envelope is authoritative.
    const handler = (server as any)._requestHandlers.get("tools/call");
    await handler(
      {
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi", context: "t" } },
      },
      {
        mcpReq: {
          id: 42,
          requestState: () => undefined,
          envelope: {
            "io.modelcontextprotocol/clientInfo": {
              name: "envelope-client",
              version: "3.0",
            },
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          },
        },
      },
    );
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.clientName).toBe("envelope-client");
    expect(event.clientVersion).toBe("3.0");
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_PROTOCOL_VERSION]: "2026-07-28",
    });
    await client.close();
  });
});
