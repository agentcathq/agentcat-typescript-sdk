import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { track } from "../index.js";
import { EventCapture, setupTestHooks, sid } from "./test-utils.js";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory.js";

setupTestHooks();

// Low-level server with a plain structured tool and a composed-schema tool.
async function setupLowLevelStructured(trackOptions: any = {}) {
  const server = new Server(
    { name: "structured test server", version: "1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "stats",
        description: "returns stats",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
      {
        name: "poly",
        description: "composed output schema",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          // type: "object" satisfies the SDK client's ListTools validation;
          // the oneOf keyword alone marks the schema composed for injection.
          type: "object",
          oneOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
              required: ["a"],
              additionalProperties: false,
            },
          ],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "poly") {
      return {
        content: [{ type: "text", text: "poly" }],
        structuredContent: { a: "x" },
      };
    }
    return {
      content: [{ type: "text", text: "42 things" }],
      structuredContent: { count: 42 },
    };
  });
  track(server, "proj_test", { enableAgentTracking: true, ...trackOptions });

  const client = new Client({ name: "test client", version: "1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    server,
    client,
    cleanup: async () => {
      await clientTransport.close?.();
      await serverTransport.close?.();
    },
  };
}

describe("structured mint-back: high-level (V2) path", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    resetTodos();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  // THE BUG (PROD): a structuredContent-only consumer (Claude Code) never
  // sees the content footer, so it can never learn its handles. This test
  // reads ONLY structuredContent. Bonus: the SDK client ajv-validates the
  // result against the listed outputSchema, so passing also proves the
  // injected declaration satisfies a strict validating client end to end.
  it("structuredContent-only consumer discovers minted handles", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    const result: any = await client.callTool({
      name: "get_stats",
      arguments: { context: "checking stats" },
    });
    const sc = result.structuredContent;
    const mint = sc.mcp_session;
    expect(mint.session_id).toMatch(/^ses_/);
    expect(mint).not.toHaveProperty("agent_id");
    expect(mint.status).toBe("issued");
    expect(sc.count).toBe(0); // customer payload intact
    // The mirror leads so it survives client-side truncation of long results.
    expect(Object.keys(sc)[0]).toBe("mcp_session");
    await cleanup();
  });

  it("tools/list declares mcp_session on get_stats; schema-less tools untouched", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    const { tools } = await client.listTools();
    const stats = tools.find((t) => t.name === "get_stats")!;
    const prop = (stats.outputSchema as any).properties.mcp_session;
    expect(prop.type).toBe("object");
    expect(Object.keys(prop.properties)).toEqual([
      "session_id",
      "agent_id",
      "status",
    ]);
    const addTodo = tools.find((t) => t.name === "add_todo")!;
    expect(addTodo.outputSchema).toBeUndefined();
    await cleanup();
  });

  it("steady state: supplied handles are re-echoed on every response; text block stays mint-only", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    const result: any = await client.callTool({
      name: "get_stats",
      arguments: {
        context: "checking stats",
        session_id: sid("fixed"),
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    const mint = result.structuredContent.mcp_session;
    expect(mint.session_id).toBe(sid("fixed"));
    expect(mint.agent_id).toBe("opus-4.80-1m|claude-code|k3n9x");
    expect(mint.status).toBe("active");
    // the text block is a mint-time announcement only — none in steady state
    const block = (result.content as any[]).find(
      (c: any) => c.type === "text" && c.text.startsWith("[session_id"),
    );
    expect(block).toBeUndefined();
    await cleanup();
  });

  it("wire-only: published event.response never contains mcp_session", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    await client.callTool({
      name: "get_stats",
      arguments: { context: "checking stats" },
    });
    const event = capture.findEventByType("mcp:tools/call")!;
    const published = JSON.stringify(event.response);
    expect(published).not.toContain("mcp_session");
    expect(published).not.toContain("[session_id");
    expect((event.response as any).structuredContent).toEqual({ count: 0 });
    await cleanup();
  });

  it("content-only tools are unaffected: block leads content, no structuredContent conjured", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "buy milk", context: "testing" },
    });
    expect(result.structuredContent).toBeUndefined();
    // Prepended as the FIRST content element so it survives truncation.
    const first = (result.content as any[])[0];
    expect(first.type).toBe("text");
    expect(first.text).toMatch(/^\[session_id issued/);
    await cleanup();
  });
});

describe("structured mint-back: low-level (V1) path", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("mints into structuredContent on the V1 path too", async () => {
    const { client, cleanup } = await setupLowLevelStructured();
    await client.listTools();
    const result: any = await client.callTool({ name: "stats", arguments: {} });
    const mint = result.structuredContent.mcp_session;
    expect(mint.session_id).toMatch(/^ses_/);
    expect(mint).not.toHaveProperty("agent_id");
    expect(mint.status).toBe("issued");
    expect(result.structuredContent.count).toBe(42);
    expect(Object.keys(result.structuredContent)[0]).toBe("mcp_session");
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(JSON.stringify(event.response)).not.toContain("mcp_session");
    await cleanup();
  });

  it("composed outputSchema: schema untouched, no mirror, text block still delivers", async () => {
    const { client, cleanup } = await setupLowLevelStructured();
    const { tools } = await client.listTools();
    const poly = tools.find((t) => t.name === "poly")!;
    expect(JSON.stringify(poly.outputSchema)).not.toContain("mcp_session");
    const result: any = await client.callTool({ name: "poly", arguments: {} });
    expect(result.structuredContent.mcp_session).toBeUndefined();
    expect(result.structuredContent.a).toBe("x");
    const first = (result.content as any[])[0];
    expect(first.type).toBe("text");
    expect(first.text).toMatch(/^\[session_id issued/);
    await cleanup();
  });

  it("hook mode: mirrored payload carries agent_id but never session_id or status", async () => {
    const { client, cleanup } = await setupLowLevelStructured({
      resolveSessionId: () => "corr-1",
    });
    await client.listTools();
    const result: any = await client.callTool({
      name: "stats",
      arguments: { agent_id: "opus-4.80-1m|claude-code|k3n9x" },
    });
    const mint = result.structuredContent.mcp_session;
    expect(mint).not.toHaveProperty("session_id");
    expect(mint).not.toHaveProperty("status");
    expect(mint.agent_id).toBe("opus-4.80-1m|claude-code|k3n9x");
    await cleanup();
  });

  it("no tools/list ever (no registry): mirror applies — a list-less client cannot be validating", async () => {
    const { server, cleanup } = await setupLowLevelStructured();
    // Drive the wrapped handler directly without ever listing tools.
    const handler = (server as any)._requestHandlers.get("tools/call");
    const result: any = await handler(
      { method: "tools/call", params: { name: "stats", arguments: {} } },
      {},
    );
    expect(result.structuredContent.mcp_session.session_id).toMatch(/^ses_/);
    await cleanup();
  });
});
