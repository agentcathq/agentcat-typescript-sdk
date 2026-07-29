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
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory.js";
import { track } from "../index.js";
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
    expect(event.sessionId.startsWith("ses_")).toBe(true);
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
    expect(event.sessionId.startsWith("ses_")).toBe(true);
    // The hook won the task ID, so only the agent ID was minted.
    const last = result.content[result.content.length - 1];
    expect(last.text.startsWith("[MCP INSTRUCTIONS]: Handle issued.")).toBe(
      true,
    );
    expect(last.text).toContain(
      `Your task_id=${event.sessionId} was accepted.`,
    );
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
      expect(event.sessionId.startsWith("ses_")).toBe(true);
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
      expect(event.sessionId.startsWith("ses_")).toBe(true);
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
