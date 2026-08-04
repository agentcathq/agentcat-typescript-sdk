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

async function setupLowLevel(trackOptions: any = {}) {
  const server = new Server(
    { name: "low-level test server", version: "1.0" },
    { capabilities: { tools: {} } },
  );
  const receivedArgs: any[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    receivedArgs.push(request.params.arguments);
    if (request.params.arguments?.text === "explode") {
      return { isError: true, content: [{ type: "text", text: "boom" }] };
    }
    return {
      content: [
        { type: "text", text: `echo: ${request.params.arguments?.text}` },
      ],
    };
  });

  // This suite exercises full two-handle behavior; agent tracking is opt-in
  // (default off), so the helper opts in. Tests may still override it.
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
    receivedArgs,
    cleanup: async () => {
      await clientTransport.close?.();
      await serverTransport.close?.();
    },
  };
}

async function setupOwnSessionId() {
  const server = new Server(
    { name: "own session id server", version: "1.0" },
    { capabilities: { tools: {} } },
  );
  const receivedArgs: any[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "declares its own session_id",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            session_id: { type: "string", description: "customer's own" },
          },
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    receivedArgs.push(request.params.arguments);
    return { content: [{ type: "text", text: "ok" }] };
  });
  track(server, "proj_test", { enableAgentTracking: true });
  const client = new Client({ name: "test client", version: "1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    receivedArgs,
    cleanup: async () => {
      await clientTransport.close?.();
      await serverTransport.close?.();
    },
  };
}

/**
 * A tool whose input schema is composed (oneOf), the shape produced by
 * z.union / z.discriminatedUnion. Handle injection skips it — there is no
 * single properties bag to extend — but the customer never declared
 * session_id either, so the argument name is still AgentCat's.
 */
async function setupComposedSchema() {
  const server = new Server(
    { name: "composed schema server", version: "1.0" },
    { capabilities: { tools: {} } },
  );
  const receivedArgs: any[] = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "union_tool",
        description: "takes one of two shapes",
        inputSchema: {
          type: "object",
          oneOf: [
            {
              properties: { kind: { const: "a" }, a: { type: "string" } },
              required: ["kind", "a"],
            },
            {
              properties: { kind: { const: "b" }, b: { type: "number" } },
              required: ["kind", "b"],
            },
          ],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    receivedArgs.push(request.params.arguments);
    return { content: [{ type: "text", text: "ok" }] };
  });
  track(server, "proj_test");
  const client = new Client({ name: "test client", version: "1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    receivedArgs,
    cleanup: async () => {
      await clientTransport.close?.();
      await serverTransport.close?.();
    },
  };
}

const mintBackOf = (result: any): string | undefined =>
  (result.content as any[]).find(
    (c) => c.type === "text" && c.text.startsWith("[MCP INSTRUCTIONS]"),
  )?.text;

const handleFrom = (text: string, name: string): string =>
  new RegExp(`${name}=(\\S+)`).exec(text)![1];

describe("low-level server: explicit handles", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("injects optional handles into listed tool schemas", async () => {
    const { client, cleanup } = await setupLowLevel();
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(Object.keys(echo.inputSchema.properties!)).toEqual([
      "text",
      "session_id",
      "agent_id",
      "context",
    ]);
    expect(echo.inputSchema.required).toEqual(["text", "agent_id", "context"]);
    const gmt = tools.find((t) => t.name === "get_more_tools")!;
    expect(gmt.inputSchema.properties).toHaveProperty("session_id");
    expect(gmt.inputSchema.properties).toHaveProperty("agent_id");
    expect(gmt.annotations).toEqual({
      title: "Get More Tools",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    await cleanup();
  });

  it("publishes no tools/list or initialize events", async () => {
    const { client, cleanup } = await setupLowLevel();
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: { text: "hi", context: "testing" },
    });
    const types = capture.getEvents().map((e) => e.eventType);
    expect(types).not.toContain("mcp:tools/list");
    expect(types).not.toContain("mcp:initialize");
    expect(types).toContain("mcp:tools/call");
    await cleanup();
  });

  it("first call mints session_id, appends the mint-back, and tags the task source", async () => {
    const { client, cleanup } = await setupLowLevel();
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
      agentcat_session_id_source: "minted",
    });
    expect(event.tags).not.toHaveProperty("agentcat_agent_id");
    expect(event.tags).not.toHaveProperty("agentcat_agent_id_source");
    await cleanup();
  });

  it("echoed handles are reused verbatim with no mint-back", async () => {
    const { client, cleanup } = await setupLowLevel();
    await client.listTools();
    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "testing",
        session_id: sid("fixed"),
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    expect(mintBackOf(result)).toBeUndefined();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe(sid("fixed"));
    expect(event.tags).toMatchObject({
      agentcat_session_id_source: "supplied",
      agentcat_agent_id: "opus-4.80-1m|claude-code|k3n9x",
      agentcat_agent_id_source: "supplied",
    });
    await cleanup();
  });

  it("subagent flow: inherited task + omitted agent yields no mint-back, task tagged supplied", async () => {
    const { client, cleanup } = await setupLowLevel();
    await client.listTools();
    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "testing",
        session_id: sid("parent"),
      },
    });
    expect(mintBackOf(result)).toBeUndefined();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.tags).toMatchObject({
      agentcat_session_id_source: "supplied",
    });
    expect(event.tags).not.toHaveProperty("agentcat_agent_id");
    expect(event.tags).not.toHaveProperty("agentcat_agent_id_source");
    await cleanup();
  });

  it("appends the mint-back on isError results too", async () => {
    const { client, cleanup } = await setupLowLevel();
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
    await cleanup();
  });

  it("strips injected params before the customer handler; event keeps them", async () => {
    const { client, receivedArgs, cleanup } = await setupLowLevel();
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "why",
        session_id: sid("x"),
        agent_id: "agt_x",
      },
    });
    expect(receivedArgs[0]).toEqual({ text: "hi" });
    const event = capture.findEventByType("mcp:tools/call")!;
    expect((event.parameters as any).request.params.arguments.session_id).toBe(
      sid("x"),
    );
    await cleanup();
  });

  it("a customer's own session_id is never adopted and still reaches the handler", async () => {
    const { client, receivedArgs, cleanup } = await setupOwnSessionId();
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: { text: "hi", session_id: "CUSTOMER-VALUE-123" },
    });

    // Their parameter is untouched.
    expect(receivedArgs[0].session_id).toBe("CUSTOMER-VALUE-123");
    // Ours is not polluted by it.
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe("");
    expect(event.tags.agentcat_session_id_source).toBe("foreign");
    await cleanup();
  });

  it("composed-schema tool: injection is skipped, yet the call still mints a session and announces it", async () => {
    const { client, cleanup } = await setupComposedSchema();
    const { tools } = await client.listTools();
    const union = tools.find((t) => t.name === "union_tool")!;
    // Injection really was skipped -- this is the oneOf path, not a normal tool.
    // (An injection regression would surface under `properties`, a spec key
    // every SDK version echoes.)
    expect(union.inputSchema.properties ?? {}).not.toHaveProperty("session_id");
    // Some SDK v1 versions (1.22.x: ".passthrough() removed to support the
    // Ajv validator") strip non-spec keys like oneOf from the client's view
    // of inputSchema. The server-side schema AgentCat's injector saw still
    // carried it, so only assert the composed shape when the SDK echoes it.
    const listedOneOf = (union.inputSchema as any).oneOf;
    if (listedOneOf !== undefined) expect(listedOneOf).toHaveLength(2);

    const result: any = await client.callTool({
      name: "union_tool",
      arguments: { kind: "a", a: "x" },
    });
    // Skipping injection must not make the tool sessionless: nobody else
    // declared session_id, so the name is still ours to mint into.
    const block = mintBackOf(result)!;
    expect(block).toContain("[MCP INSTRUCTIONS]: session_id issued.");
    const sessionId = handleFrom(block, "session_id");

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe(sessionId);
    expect(event.tags.agentcat_session_id_source).toBe("minted");
    await cleanup();
  });

  it("composed-schema tool: an echoed session_id AgentCat issued is honored, not called foreign", async () => {
    const { client, cleanup } = await setupComposedSchema();
    await client.listTools();
    const result: any = await client.callTool({
      name: "union_tool",
      arguments: { kind: "b", b: 2, session_id: sid("union") },
    });
    expect(mintBackOf(result)).toBeUndefined();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe(sid("union"));
    expect(event.tags.agentcat_session_id_source).toBe("supplied");
    await cleanup();
  });

  it("hook mode: no session_id param, hook-derived session id, no task mint-back", async () => {
    const { client, cleanup } = await setupLowLevel({
      resolveSessionId: () => "customer-correlation-7",
    });
    await client.listTools();
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.properties).not.toHaveProperty("session_id");
    expect(echo.inputSchema.properties).toHaveProperty("agent_id");
    expect(echo.inputSchema.required).toContain("agent_id");

    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "testing",
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    // Hook mode never emits a text mint-back block, agent supplied or not.
    expect(mintBackOf(result)).toBeUndefined();

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.tags).toMatchObject({
      agentcat_session_id_source: "hook",
      agentcat_agent_id: "opus-4.80-1m|claude-code|k3n9x",
      agentcat_agent_id_source: "supplied",
    });
    expect(event.sessionId).toMatch(/^ses_/);
    await cleanup();
  });

  it("enableTracing:false — no handle params injected, no mint-back, no events", async () => {
    const { client, cleanup } = await setupLowLevel({ enableTracing: false });
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.properties).not.toHaveProperty("session_id");
    expect(echo.inputSchema.properties).not.toHaveProperty("agent_id");
    const result: any = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
    });
    expect(mintBackOf(result)).toBeUndefined();
    expect(capture.findEventByType("mcp:tools/call")).toBeUndefined();
    await cleanup();
  });

  it("enableAgentTracking:false — no agent param, tag, or mint-back line", async () => {
    const { client, cleanup } = await setupLowLevel({
      enableAgentTracking: false,
    });
    await client.listTools();
    const { tools } = await client.listTools();
    expect(
      tools.find((t) => t.name === "echo")!.inputSchema.properties,
    ).not.toHaveProperty("agent_id");
    const result: any = await client.callTool({
      name: "echo",
      arguments: { text: "hi", context: "testing" },
    });
    const block = mintBackOf(result)!;
    expect(block).toContain("session_id=");
    expect(block).not.toContain("agent_id=");
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.tags).not.toHaveProperty("agentcat_agent_id");
    await cleanup();
  });

  it("enableReportMissing:false — handles still inject, no get_more_tools", async () => {
    const { client, cleanup } = await setupLowLevel({
      enableReportMissing: false,
    });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "get_more_tools")).toBeUndefined();
    const echo = tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.properties).toHaveProperty("session_id");
    expect(echo.inputSchema.properties).toHaveProperty("agent_id");
    expect(echo.inputSchema.required).toContain("agent_id");
    await cleanup();
  });

  it("stamps _meta clientInfo and protocol version when present", async () => {
    const { server, cleanup } = await setupLowLevel();
    // Drive the wrapped handler directly to control _meta (the SDK client
    // does not expose per-request _meta injection).
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
      {},
    );
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.clientName).toBe("modern-client");
    expect(event.tags).toMatchObject({
      agentcat_protocol_version: "2026-07-28",
    });
    await cleanup();
  });

  it("declares _mcp_instructions in a listed plain-object outputSchema", async () => {
    const server = new Server(
      { name: "low-level structured server", version: "1.0" },
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
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "42" }],
      structuredContent: { count: 42 },
    }));
    track(server, "proj_test", { enableAgentTracking: true });

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const { tools } = await client.listTools();
    const stats = tools.find((t) => t.name === "stats")!;
    const prop = (stats.outputSchema!.properties as any)._mcp_instructions;
    expect(prop.type).toBe("object");
    expect(Object.keys(prop.properties)).toEqual([
      "session_id",
      "agent_id",
      "instructions",
    ]);

    await clientTransport.close?.();
    await serverTransport.close?.();
  });
});

describe("high-level server: explicit handles", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    resetTodos();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("mints on first call, appends exactly one mint-back block", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test");
    await client.listTools();
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "buy milk", context: "testing handles" },
    });
    const blocks = (result.content as any[]).filter(
      (c) => c.type === "text" && c.text.startsWith("[MCP INSTRUCTIONS]"),
    );
    expect(blocks).toHaveLength(1); // outermost wrapper only — never doubled
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe(handleFrom(blocks[0].text, "session_id"));
    await cleanup();
  });

  it("callback receives stripped args; supplied handles reused silently", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: {
        text: "buy milk",
        context: "testing",
        session_id: sid("hl"),
        agent_id: "agt_hl",
      },
    });
    // Tool executed normally (its own text present), no instruction block.
    expect((result.content as any[])[0].text).toContain("buy milk");
    expect(mintBackOf(result)).toBeUndefined();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe(sid("hl"));
    expect(event.tags).toMatchObject({
      agentcat_session_id_source: "supplied",
    });
    await cleanup();
  });

  it("agent tracking is OFF by default: no param, no tag, task-only mint-back", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test");
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.inputSchema.properties).not.toHaveProperty("agent_id");
    }
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "buy milk", context: "testing defaults" },
    });
    const block = mintBackOf(result)!;
    expect(block).toContain("[MCP INSTRUCTIONS]: session_id issued");
    expect(block).not.toContain("agent_id");
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.tags).not.toHaveProperty("agentcat_agent_id");
    expect(event.tags).not.toHaveProperty("agentcat_agent_id_source");
    await cleanup();
  });

  it("get_more_tools carries handles and the mint-back", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    const result: any = await client.callTool({
      name: "get_more_tools",
      arguments: { context: "need a search tool" },
    });
    expect(mintBackOf(result)).toContain(
      "[MCP INSTRUCTIONS]: session_id issued.",
    );
    expect(mintBackOf(result)).not.toContain("agent_id");
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toMatch(/^ses_/);
    expect(event.userIntent).toBe("need a search tool");
    await cleanup();
  });

  it("enableTracing:false — get_more_tools still answers, no mint-back, no event", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableTracing: false });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "get_more_tools")).toBeDefined();
    const result: any = await client.callTool({
      name: "get_more_tools",
      arguments: { context: "need a search tool" },
    });
    expect((result.content as any[])[0].text).toContain(
      "we have shown you the full tool list",
    );
    expect(mintBackOf(result)).toBeUndefined();
    expect(capture.findEventByType("mcp:tools/call")).toBeUndefined();
    await cleanup();
  });

  it("identify runs per call and stamps the event; no identify event published", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", {
      identify: async () => ({ userId: "actor-7", userName: "Sam" }),
    });
    await client.listTools();
    await client.callTool({
      name: "add_todo",
      arguments: { text: "x", context: "testing" },
    });
    const events = capture.getEvents();
    expect(events.map((e) => e.eventType)).not.toContain("agentcat:identify");
    const call = capture.findEventByType("mcp:tools/call")!;
    expect(call.identifyActorGivenId).toBe("actor-7");
    expect(call.identifyActorName).toBe("Sam");
    await cleanup();
  });
});

describe("published events exclude SDK-authored mint-back text", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    resetTodos();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("low-level: minting call — block on the wire, absent from event.response", async () => {
    const { client, cleanup } = await setupLowLevel();
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
    await cleanup();
  });

  it("low-level: minting error call — event.response and event.error stay clean", async () => {
    const { client, cleanup } = await setupLowLevel();
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
    await cleanup();
  });

  it("low-level: echoed handles — event.response is exactly the handler result", async () => {
    const { client, cleanup } = await setupLowLevel();
    await client.listTools();
    await client.callTool({
      name: "echo",
      arguments: {
        text: "hi",
        context: "testing",
        session_id: sid("fixed"),
        agent_id: "agt_fixed",
      },
    });
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.response).toEqual({
      content: [{ type: "text", text: "echo: hi" }],
    });
    await cleanup();
  });

  it("high-level: minting call — block on the wire, absent from event.response", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "buy milk", context: "testing handles" },
    });
    expect(mintBackOf(result)).toContain(
      "[MCP INSTRUCTIONS]: session_id issued.",
    );
    expect(mintBackOf(result)).not.toContain("agent_id");

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(JSON.stringify(event.response)).not.toContain("[MCP INSTRUCTIONS]");
    expect(JSON.stringify(event.response)).toContain("buy milk");
    await cleanup();
  });

  it("high-level: get_more_tools minting call — event.response keeps only the answer", async () => {
    const { server, client, cleanup } = await setupTestServerAndClient();
    track(server, "proj_test", { enableAgentTracking: true });
    await client.listTools();
    const result: any = await client.callTool({
      name: "get_more_tools",
      arguments: { context: "need a search tool" },
    });
    expect(mintBackOf(result)).toContain(
      "[MCP INSTRUCTIONS]: session_id issued.",
    );
    expect(mintBackOf(result)).not.toContain("agent_id");

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(JSON.stringify(event.response)).not.toContain("[MCP INSTRUCTIONS]");
    expect(JSON.stringify(event.response)).toContain(
      "we have shown you the full tool list",
    );
    await cleanup();
  });
});
