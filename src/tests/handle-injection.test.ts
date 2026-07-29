import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { addHandleParametersToTools } from "../modules/handle-parameters.js";
import { addContextParameterToTools } from "../modules/context-parameters.js";
import {
  TASK_ID_PARAMETER_DESCRIPTION,
  AGENT_ID_PARAMETER_DESCRIPTION,
} from "../modules/constants.js";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory.js";
import { track } from "../index.js";
import { EventCapture } from "./test-utils.js";
import { getServerTrackingData } from "../modules/internal.js";

const tool = (name: string, inputSchema: any) => ({ name, inputSchema }) as any;

describe("handle parameter injection", () => {
  it("injects both handles as optional properties", () => {
    const [out] = addHandleParametersToTools(
      [
        tool("add_todo", {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        }),
      ],
      true,
    ) as any[];
    expect(out.inputSchema.properties.task_id.type).toBe("string");
    expect(out.inputSchema.properties.agent_id.type).toBe("string");
    expect(out.inputSchema.required).toEqual(["text"]);
    // Pin the injected copy to the constants: a re-typed inline literal at the
    // injection site must not be able to diverge from constants.ts silently.
    expect(out.inputSchema.properties.task_id.description).toBe(
      TASK_ID_PARAMETER_DESCRIPTION,
    );
    expect(out.inputSchema.properties.agent_id.description).toBe(
      AGENT_ID_PARAMETER_DESCRIPTION,
    );
  });

  it("omits agent_id when agent tracking is disabled", () => {
    const [out] = addHandleParametersToTools(
      [tool("add_todo", { type: "object", properties: {} })],
      false,
    ) as any[];
    expect(out.inputSchema.properties.task_id).toBeDefined();
    expect(out.inputSchema.properties.agent_id).toBeUndefined();
  });

  it("orders properties customerParams, task_id, agent_id, context", () => {
    let tools: any[] = [
      tool("add_todo", {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
    ];
    tools = addHandleParametersToTools(tools, true) as any[];
    tools = addContextParameterToTools(tools) as any[];
    expect(Object.keys(tools[0].inputSchema.properties)).toEqual([
      "text",
      "task_id",
      "agent_id",
      "context",
    ]);
  });

  it("injects into get_more_tools (deliberately not exempted)", () => {
    // get_more_tools is deliberately NOT skipped for handles.
    const [out] = addHandleParametersToTools(
      [
        tool("get_more_tools", {
          type: "object",
          properties: { context: { type: "string" } },
          required: ["context"],
        }),
      ],
      true,
    ) as any[];
    expect(out.inputSchema.properties.task_id).toBeDefined();
    expect(out.inputSchema.properties.agent_id).toBeDefined();
  });

  it("skips a tool that already declares task_id", () => {
    const original = tool("x", {
      type: "object",
      properties: { task_id: { type: "number" } },
    });
    const [out] = addHandleParametersToTools([original], true) as any[];
    expect(out.inputSchema.properties.task_id.type).toBe("number");
    expect(out.inputSchema.properties.agent_id).toBeUndefined();
  });

  it.each(["oneOf", "allOf", "anyOf"])(
    "skips complex schemas (%s)",
    (keyword) => {
      const [out] = addHandleParametersToTools(
        [tool("x", { [keyword]: [{ type: "object" }] })],
        true,
      ) as any[];
      expect(out.inputSchema.properties).toBeUndefined();
    },
  );

  it("removes additionalProperties: false so the schema stays valid", () => {
    const [out] = addHandleParametersToTools(
      [
        tool("x", {
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
      ],
      true,
    ) as any[];
    expect(out.inputSchema.additionalProperties).toBeUndefined();
    expect(out.inputSchema.properties.task_id).toBeDefined();
  });

  it("does not mutate the original tool", () => {
    const original = tool("x", { type: "object", properties: {} });
    addHandleParametersToTools([original], true);
    expect(original.inputSchema.properties.task_id).toBeUndefined();
  });
});

describe("tools/list wiring", () => {
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

  it("serves handles on every listed tool, in the right order", async () => {
    track(server, "proj_test");
    const { tools } = await client.listTools();
    const addTodo = tools.find((t: any) => t.name === "add_todo");
    expect(Object.keys(addTodo.inputSchema.properties)).toEqual([
      "text",
      "task_id",
      "agent_id",
      "context",
    ]);
  });

  it("serves handles on get_more_tools too", async () => {
    track(server, "proj_test");
    const { tools } = await client.listTools();
    const more = tools.find((t: any) => t.name === "get_more_tools");
    expect(more.inputSchema.properties.task_id).toBeDefined();
    expect(more.inputSchema.properties.agent_id).toBeDefined();
  });

  it("publishes no mcp:tools/list event", async () => {
    track(server, "proj_test");
    await client.listTools();
    await new Promise((r) => setTimeout(r, 50));
    expect(capture.findEventByType("mcp:tools/list")).toBeUndefined();
  });
});

describe("tools/list handle collisions", () => {
  it("skips injection and records a tool that declares its own task_id", async () => {
    const server = new McpServer({ name: "collision server", version: "1.0" });
    server.tool(
      "legacy_tool",
      "A tool that already owns task_id",
      { task_id: z.string().describe("The customer's own task id") },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport),
    ]);

    try {
      track(server, "proj_test");
      const { tools } = await client.listTools();
      const legacy: any = tools.find((t: any) => t.name === "legacy_tool");

      // The customer's own parameter must survive untouched, and no agent_id
      // may be grafted on next to it.
      expect(legacy.inputSchema.properties.task_id.description).toBe(
        "The customer's own task id",
      );
      expect(legacy.inputSchema.properties.agent_id).toBeUndefined();

      const data = getServerTrackingData(server.server);
      expect(data?.handleCollisionTools.has("legacy_tool")).toBe(true);
      // Non-colliding built-ins must not land in the set.
      expect(data?.handleCollisionTools.has("get_more_tools")).toBe(false);
    } finally {
      await clientTransport.close?.();
      await serverTransport.close?.();
    }
  });
});
