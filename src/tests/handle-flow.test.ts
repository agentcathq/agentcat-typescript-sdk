import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as z4 from "zod/v4";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory.js";
import { track, publishCustomEvent } from "../index.js";
import { EventCapture } from "./test-utils.js";

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("handle flow", () => {
  let server: any;
  let client: any;
  let cleanup: () => Promise<void>;
  let capture: EventCapture;

  beforeEach(async () => {
    resetTodos();
    const setup = await setupTestServerAndClient();
    server = setup.server;
    client = setup.client;
    cleanup = setup.cleanup;
    capture = new EventCapture();
    await capture.start();
  });

  afterEach(async () => {
    await capture.stop();
    await cleanup();
  });

  it("mints on the first call and appends the mint-back block", async () => {
    track(server, "proj_test");
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c" },
    });
    await settle();

    const last = result.content[result.content.length - 1];
    expect(last.text.startsWith("[MCP INSTRUCTIONS]: Handles issued.")).toBe(
      true,
    );

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId!.startsWith("ses_")).toBe(true);
    expect(event.tags!.agentcat_agent_id.startsWith("agt_")).toBe(true);
    expect(event.tags!.agentcat_task_id_source).toBe("minted");
    expect(event.tags!.agentcat_agent_id_source).toBe("minted");
  });

  it("reuses supplied handles and appends nothing", async () => {
    track(server, "proj_test");
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: {
        text: "a",
        context: "c",
        task_id: "ses_x",
        agent_id: "agt_y",
      },
    });
    await settle();

    expect(
      result.content.some((c: any) =>
        String(c.text).includes("[MCP INSTRUCTIONS]"),
      ),
    ).toBe(false);

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe("ses_x");
    expect(event.tags!.agentcat_agent_id).toBe("agt_y");
    expect(event.tags!.agentcat_task_id_source).toBe("supplied");
  });

  it("mints only an agent ID for a subagent, preserving the task ID", async () => {
    track(server, "proj_test");
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c", task_id: "ses_parent" },
    });
    await settle();

    const last = result.content[result.content.length - 1];
    expect(last.text.startsWith("[MCP INSTRUCTIONS]: Handle issued.")).toBe(
      true,
    );
    expect(last.text).toContain("Your task_id=ses_parent was accepted.");

    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.sessionId).toBe("ses_parent");
    expect(event.tags!.agentcat_agent_id_source).toBe("minted");
  });

  it("never passes handles to the customer's handler", async () => {
    track(server, "proj_test");
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: {
        text: "a",
        context: "c",
        task_id: "ses_x",
        agent_id: "agt_y",
      },
    });
    // The todo tool echoes its text; a leaked handle would surface as a schema error.
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('Added todo: "a"');
  });

  it("retains the raw handles on event.parameters", async () => {
    track(server, "proj_test");
    await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c", task_id: "ses_x" },
    });
    await settle();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect((event.parameters as any).request.params.arguments.task_id).toBe(
      "ses_x",
    );
  });

  it("keeps customer tags and does not let them collide", async () => {
    track(server, "proj_test", {
      eventTags: () => ({ agent_id: "customer-value" }),
    });
    await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c" },
    });
    await settle();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.tags!.agent_id).toBe("customer-value");
    expect(event.tags!.agentcat_agent_id.startsWith("agt_")).toBe(true);
  });

  it("omits agent handles when agent tracking is disabled", async () => {
    track(server, "proj_test", { enableAgentTracking: false });
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c" },
    });
    await settle();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.tags!.agentcat_agent_id).toBeUndefined();
    const last = result.content[result.content.length - 1];
    expect(last.text).not.toContain("agent_id=");
  });

  it("does not append the mint-back block to an errored result", async () => {
    track(server, "proj_test");
    const result: any = await client.callTool({
      name: "complete_todo",
      arguments: { id: "nope", context: "c" },
    });
    expect(result.isError).toBe(true);
    expect(
      result.content.some((c: any) =>
        String(c.text).includes("[MCP INSTRUCTIONS]"),
      ),
    ).toBe(false);
  });

  it("derives the task ID from the resolveTaskId hook when configured", async () => {
    track(server, "proj_test", { resolveTaskId: () => "workflow-42" });
    const result: any = await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c" },
    });
    await settle();
    const event = capture.findEventByType("mcp:tools/call")!;
    expect(event.tags!.agentcat_task_id_source).toBe("hook");
    expect(event.sessionId!.startsWith("ses_")).toBe(true);
    // The hook won the task ID, so only the agent ID was minted.
    const last = result.content[result.content.length - 1];
    expect(last.text.startsWith("[MCP INSTRUCTIONS]: Handle issued.")).toBe(
      true,
    );
    expect(last.text).toContain(
      `Your task_id=${event.sessionId} was accepted.`,
    );
  });

  it("correlates a custom event published with the same identifier the resolveTaskId hook returns", async () => {
    track(server, "proj_test", { resolveTaskId: () => "workflow-42" });
    await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c" },
    });
    // The customer's own workflow id, not a handle we minted: derived, exactly
    // as the hook's return value is, so both land on one task.
    await publishCustomEvent("workflow-42", "proj_test", {
      resourceName: "checkout-completed",
    });
    await settle();

    const toolCall = capture.findEventByType("mcp:tools/call")!;
    const custom = capture.findEventByType("agentcat:custom")!;
    expect(custom).toBeDefined();
    expect(toolCall.sessionId!.startsWith("ses_")).toBe(true);
    expect(custom.sessionId).toBe(toolCall.sessionId);
  });

  it("correlates a custom event published with a Task ID the agent handed back", async () => {
    track(server, "proj_test");
    await client.callTool({
      name: "add_todo",
      arguments: { text: "a", context: "c", task_id: "ses_handed_back" },
    });
    // Already one of ours: used verbatim, never re-derived.
    await publishCustomEvent("ses_handed_back", "proj_test", {
      resourceName: "checkout-completed",
    });
    await settle();

    const toolCall = capture.findEventByType("mcp:tools/call")!;
    expect(toolCall.sessionId).toBe("ses_handed_back");
    expect(capture.findEventByType("agentcat:custom")!.sessionId).toBe(
      "ses_handed_back",
    );
  });

  it("publishes a custom event against a tracked server with no session ID", async () => {
    track(server, "proj_test");
    await publishCustomEvent(server, "proj_test", { resourceName: "x" });
    await settle();

    const custom = capture.findEventByType("agentcat:custom")!;
    expect(custom).toBeDefined();
    expect(custom.sessionId).toBeUndefined();
  });

  it("attributes a custom event to an explicitly supplied actor", async () => {
    track(server, "proj_test");
    await publishCustomEvent("ses_actor_flow", "proj_test", {
      resourceName: "x",
      actor: { userId: "user-1", userName: "Ada", userData: { plan: "pro" } },
    });
    await settle();

    const custom = capture.findEventByType("agentcat:custom")!;
    expect(custom.identifyActorGivenId).toBe("user-1");
    expect(custom.identifyActorName).toBe("Ada");
    expect(custom.identifyActorData).toEqual({ plan: "pro" });
  });
});

describe("handle flow — a tool that owns task_id", () => {
  // The single guarantee this describe block exists for: AgentCat never reads,
  // strips, or mint-backs a parameter it did not inject.
  const setupCollisionServer = async () => {
    const server = new McpServer({ name: "collision server", version: "1.0" });
    server.registerTool(
      "legacy_tool",
      {
        description: "A tool that already owns task_id",
        inputSchema: { task_id: z.string().describe("The customer's own id") },
      },
      async (args: any) => ({
        content: [{ type: "text" as const, text: `got:${args.task_id}` }],
      }),
    );
    server.tool("plain_tool", "No collision here", {}, async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    }));

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport),
    ]);
    return {
      server,
      client,
      cleanup: async () => {
        await clientTransport.close?.();
        await serverTransport.close?.();
      },
    };
  };

  it("passes its own task_id through and appends no mint-back", async () => {
    const capture = new EventCapture();
    await capture.start();
    const { server, client, cleanup } = await setupCollisionServer();
    try {
      track(server, "proj_test");
      const result: any = await client.callTool({
        name: "legacy_tool",
        arguments: { task_id: "customer-owned-123" },
      });
      await settle();

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe("got:customer-owned-123");
      expect(
        result.content.some((c: any) =>
          String(c.text).includes("[MCP INSTRUCTIONS]"),
        ),
      ).toBe(false);

      const event = capture
        .getEvents()
        .find((e) => e.resourceName === "legacy_tool")!;
      expect(event).toBeDefined();
      // The customer's value was NOT adopted as the Task ID.
      expect(event.sessionId).not.toBe("customer-owned-123");
      expect(event.sessionId!.startsWith("ses_")).toBe(true);
      expect(event.tags!.agentcat_handle_collision).toBe("task_id");
    } finally {
      await capture.stop();
      await cleanup();
    }
  });

  it("still mints and appends the mint-back for a non-colliding tool on the same server", async () => {
    const capture = new EventCapture();
    await capture.start();
    const { server, client, cleanup } = await setupCollisionServer();
    try {
      track(server, "proj_test");
      const result: any = await client.callTool({
        name: "plain_tool",
        arguments: {},
      });
      await settle();

      const last = result.content[result.content.length - 1];
      expect(last.text.startsWith("[MCP INSTRUCTIONS]: Handles issued.")).toBe(
        true,
      );
      const event = capture
        .getEvents()
        .find((e) => e.resourceName === "plain_tool")!;
      expect(event.tags!.agentcat_handle_collision).toBeUndefined();
    } finally {
      await capture.stop();
      await cleanup();
    }
  });

  it("suppresses mint-back on a colliding tool even when a resolveTaskId hook is set", async () => {
    // Regression guard: suppression must key off collision, not off
    // taskIdSource — a hooked colliding call reads "hook", not "minted".
    const capture = new EventCapture();
    await capture.start();
    const { server, client, cleanup } = await setupCollisionServer();
    try {
      track(server, "proj_test", { resolveTaskId: () => "workflow-42" });
      const result: any = await client.callTool({
        name: "legacy_tool",
        arguments: { task_id: "customer-owned-123" },
      });
      await settle();

      expect(result.content[0].text).toBe("got:customer-owned-123");
      expect(
        result.content.some((c: any) =>
          String(c.text).includes("[MCP INSTRUCTIONS]"),
        ),
      ).toBe(false);
      const event = capture
        .getEvents()
        .find((e) => e.resourceName === "legacy_tool")!;
      expect(event.tags!.agentcat_task_id_source).toBe("hook");
      expect(event.tags!.agentcat_handle_collision).toBe("task_id");
    } finally {
      await capture.stop();
      await cleanup();
    }
  });
});

describe("handle flow — a zod-v4 tool that owns task_id", () => {
  // The MCP SDK accepts zod ^3.25 || ^4.0 and normalises any v4 shape through
  // objectFromShape -> z4mini.object(shape). A ZodMiniObject has NO `_def` —
  // its shape lives at `_zod.def.shape` — so a schema reader that only knows
  // `.properties` and `._def.shape` sees no parameters at all and misses the
  // collision. Both cases below were hard-broken before that was fixed.
  const setupV4CollisionServer = async () => {
    const server = new McpServer({ name: "v4 collision", version: "1.0" });
    server.registerTool(
      "legacy_v4_tool",
      {
        description: "A zod-v4 tool that already owns task_id",
        inputSchema: { task_id: z4.string() },
      },
      async (args: any) => ({
        content: [{ type: "text" as const, text: `got:${args.task_id}` }],
      }),
    );

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport),
    ]);
    return {
      server,
      client,
      cleanup: async () => {
        await clientTransport.close?.();
        await serverTransport.close?.();
      },
    };
  };

  it("passes its own task_id through with no preceding tools/list", async () => {
    // Nothing has populated handleCollisionTools, so the registry lookup is
    // the ONLY defence. Missing it strips task_id, the SDK's zod parse then
    // rejects the call, and the customer's tool is hard-broken with
    // "Input validation error ... expected string, received undefined".
    const { server, client, cleanup } = await setupV4CollisionServer();
    try {
      track(server, "proj_test");
      const result: any = await client.callTool({
        name: "legacy_v4_tool",
        arguments: { task_id: "customer-owned-v4" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe("got:customer-owned-v4");
      expect(
        result.content.some((c: any) =>
          String(c.text).includes("[MCP INSTRUCTIONS]"),
        ),
      ).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it("passes its own task_id through after a tools/list", async () => {
    // handleCollisionTools now rescues the outer wrapper, but the
    // callback-level strip is a separate check — if it disagrees, the handler
    // silently receives {} and the argument is lost without any error.
    const capture = new EventCapture();
    await capture.start();
    const { server, client, cleanup } = await setupV4CollisionServer();
    try {
      track(server, "proj_test");
      await client.listTools();
      const result: any = await client.callTool({
        name: "legacy_v4_tool",
        arguments: { task_id: "customer-owned-v4" },
      });
      await settle();

      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe("got:customer-owned-v4");
      expect(
        result.content.some((c: any) =>
          String(c.text).includes("[MCP INSTRUCTIONS]"),
        ),
      ).toBe(false);

      const event = capture
        .getEvents()
        .find((e) => e.resourceName === "legacy_v4_tool")!;
      expect(event.tags!.agentcat_handle_collision).toBe("task_id");
      expect(event.sessionId).not.toBe("customer-owned-v4");
    } finally {
      await capture.stop();
      await cleanup();
    }
  });
});

describe("low-level server handle wiring", () => {
  // Step 7b regression: the low-level tools/list wrap used to live under
  // enableReportMissing, so turning that option off silently disabled handle
  // injection and collision recording too.
  const setupLowLevelServer = async () => {
    const server = new Server(
      { name: "low level server", version: "1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "echo",
          description: "Echoes",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request: any) => ({
      content: [
        {
          type: "text" as const,
          text: `echo:${JSON.stringify(request.params.arguments)}`,
        },
      ],
    }));

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    return {
      server,
      client,
      connect: async () =>
        Promise.all([
          client.connect(clientTransport),
          server.connect(serverTransport),
        ]),
      cleanup: async () => {
        await clientTransport.close?.();
        await serverTransport.close?.();
      },
    };
  };

  it("serves handles with enableReportMissing false, and omits get_more_tools", async () => {
    const { server, client, connect, cleanup } = await setupLowLevelServer();
    try {
      track(server, "proj_test", { enableReportMissing: false });
      await connect();
      const { tools } = await client.listTools();
      expect(tools.map((t: any) => t.name)).toEqual(["echo"]);
      const echo: any = tools[0];
      expect(echo.inputSchema.properties.task_id).toBeDefined();
      expect(echo.inputSchema.properties.agent_id).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("mints, strips and mint-backs on the low-level tools/call path", async () => {
    const capture = new EventCapture();
    await capture.start();
    const { server, client, connect, cleanup } = await setupLowLevelServer();
    try {
      track(server, "proj_test", { enableReportMissing: false });
      await connect();
      const result: any = await client.callTool({
        name: "echo",
        arguments: { text: "a" },
      });
      await settle();

      // The handler saw no handles...
      expect(result.content[0].text).toBe('echo:{"text":"a"}');
      // ...and the mint-back was appended.
      const last = result.content[result.content.length - 1];
      expect(last.text.startsWith("[MCP INSTRUCTIONS]: Handles issued.")).toBe(
        true,
      );

      const event = capture.findEventByType("mcp:tools/call")!;
      expect(event.sessionId!.startsWith("ses_")).toBe(true);
      expect(event.tags!.agentcat_task_id_source).toBe("minted");
      expect(event.tags!.agentcat_agent_id.startsWith("agt_")).toBe(true);
    } finally {
      await capture.stop();
      await cleanup();
    }
  });

  it("reuses a supplied task_id on the low-level path", async () => {
    const capture = new EventCapture();
    await capture.start();
    const { server, client, connect, cleanup } = await setupLowLevelServer();
    try {
      track(server, "proj_test", { enableReportMissing: false });
      await connect();
      const result: any = await client.callTool({
        name: "echo",
        arguments: { text: "a", task_id: "ses_x", agent_id: "agt_y" },
      });
      await settle();

      expect(result.content[0].text).toBe('echo:{"text":"a"}');
      expect(
        result.content.some((c: any) =>
          String(c.text).includes("[MCP INSTRUCTIONS]"),
        ),
      ).toBe(false);
      const event = capture.findEventByType("mcp:tools/call")!;
      expect(event.sessionId).toBe("ses_x");
      expect(event.tags!.agentcat_agent_id).toBe("agt_y");
    } finally {
      await capture.stop();
      await cleanup();
    }
  });
});

describe("handle flow — enableTracing: false", () => {
  // Handles are advertised only when tracing is on, so with tracing off there
  // is nothing of ours on the wire. The low-level path gets this for free —
  // setupToolCallTracing is never installed — but the high-level wrappers are
  // installed unconditionally and once appended a mint-back block, telling an
  // agent to echo handles that no schema declared, on a server whose owner had
  // switched tracking off.
  const setupHighLevelEchoServer = async () => {
    const server = new McpServer({ name: "echo server", version: "1.0" });
    server.registerTool(
      "echo",
      {
        description: "Echoes its arguments",
        inputSchema: { text: z.string() },
      },
      async (args: any) => ({
        content: [
          { type: "text" as const, text: `echo:${JSON.stringify(args)}` },
        ],
      }),
    );

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    return {
      server,
      client,
      connect: async () =>
        Promise.all([
          client.connect(clientTransport),
          server.server.connect(serverTransport),
        ]),
      cleanup: async () => {
        await clientTransport.close?.();
        await serverTransport.close?.();
      },
    };
  };

  const setupLowLevelEchoServer = async () => {
    const server = new Server(
      { name: "low level echo server", version: "1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "echo",
          description: "Echoes",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request: any) => ({
      content: [
        {
          type: "text" as const,
          text: `echo:${JSON.stringify(request.params.arguments)}`,
        },
      ],
    }));

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    return {
      server,
      client,
      connect: async () =>
        Promise.all([
          client.connect(clientTransport),
          server.connect(serverTransport),
        ]),
      cleanup: async () => {
        await clientTransport.close?.();
        await serverTransport.close?.();
      },
    };
  };

  it("injects no handles into the high-level tools/list schema", async () => {
    const { server, client, connect, cleanup } =
      await setupHighLevelEchoServer();
    try {
      track(server, "proj_test", { enableTracing: false });
      await connect();
      const { tools } = await client.listTools();
      const echo: any = tools.find((t: any) => t.name === "echo");
      expect(echo.inputSchema.properties.task_id).toBeUndefined();
      expect(echo.inputSchema.properties.agent_id).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("appends no mint-back and leaves arguments untouched on the high-level path", async () => {
    const { server, client, connect, cleanup } =
      await setupHighLevelEchoServer();
    try {
      track(server, "proj_test", { enableTracing: false });
      await connect();
      const result: any = await client.callTool({
        name: "echo",
        arguments: { text: "a" },
      });

      expect(result.content[0].text).toBe('echo:{"text":"a"}');
      expect(
        result.content.some((c: any) =>
          String(c.text).includes("[MCP INSTRUCTIONS]"),
        ),
      ).toBe(false);
      // Nothing but the customer's own content.
      expect(result.content).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it("does not resolve handles at all on the high-level path", async () => {
    const { server, client, connect, cleanup } =
      await setupHighLevelEchoServer();
    const calls: string[] = [];
    try {
      track(server, "proj_test", {
        enableTracing: false,
        resolveTaskId: (request: any) => {
          calls.push(request?.params?.name);
          return "workflow-1";
        },
      });
      await connect();
      await client.callTool({ name: "echo", arguments: { text: "a" } });
      expect(calls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("appends no mint-back and leaves arguments untouched on the low-level path", async () => {
    const { server, client, connect, cleanup } =
      await setupLowLevelEchoServer();
    try {
      track(server, "proj_test", {
        enableTracing: false,
        enableReportMissing: false,
      });
      await connect();
      const result: any = await client.callTool({
        name: "echo",
        arguments: { text: "a", task_id: "ses_x" },
      });

      // Not injected, so not stripped: the handler sees exactly what was sent.
      expect(result.content[0].text).toBe(
        'echo:{"text":"a","task_id":"ses_x"}',
      );
      expect(result.content).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});
