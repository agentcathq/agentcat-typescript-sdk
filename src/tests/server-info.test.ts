import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { track } from "../index.js";
import { AgentCatOptions } from "../types.js";
import { setBackgroundTaskRegistrar } from "../modules/backgroundTasks.js";
import { serverInfoRecorder } from "./test-utils/server-info-recorder.js";
import { EventCapture } from "./test-utils.js";

const PROJECT_ID = "proj_" + "a".repeat(27);
const LONG_DESCRIPTION = "Beta does a lot. ".repeat(118).slice(0, 2000);

const tasks: Promise<void>[] = [];

/** Waits for every background task that the SDK registered. */
async function settle(): Promise<void> {
  while (tasks.length > 0) {
    await Promise.allSettled(tasks.splice(0));
  }
}

function sent() {
  return serverInfoRecorder.bodies;
}

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

interface FixtureOptions {
  name?: string;
  projectId?: string | null;
  options?: AgentCatOptions;
  resourcesAndPrompts?: boolean;
}

function createFixtureServer(fixture: FixtureOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: fixture.name ?? "demo-server",
      version: "1.2.3",
      title: "Demo Title",
    },
    { instructions: "Use the demo tools." },
  );
  server.registerTool(
    "alpha",
    { description: "Alpha tool", inputSchema: { q: z.string().optional() } },
    async () => text("alpha ok"),
  );
  server.registerTool(
    "beta",
    {
      title: "Beta Title",
      description: LONG_DESCRIPTION,
      inputSchema: { n: z.number().describe("A number") },
      outputSchema: { doubled: z.number() },
      annotations: { readOnlyHint: true },
    },
    async ({ n }) => ({
      ...text(`${n * 2}`),
      structuredContent: { doubled: n * 2 },
    }),
  );
  server.registerTool("gamma", { description: "Gamma tool" }, async () =>
    text("gamma ok"),
  );
  if (fixture.resourcesAndPrompts !== false) {
    server.registerResource(
      "readme",
      "file:///readme.md",
      { description: "The readme" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "readme" }] }),
    );
    server.registerResource(
      "config",
      "file:///config.json",
      { title: "Config", mimeType: "application/json" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "{}" }] }),
    );
    server.registerResource(
      "item",
      new ResourceTemplate("items://{id}", { list: undefined }),
      { description: "One item" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "item" }] }),
    );
    server.registerPrompt(
      "greet",
      { description: "Greet someone", argsSchema: { who: z.string() } },
      ({ who }) => ({
        messages: [
          { role: "user", content: { type: "text", text: `Hi ${who}` } },
        ],
      }),
    );
    server.registerPrompt("summary", { description: "Summarize" }, () => ({
      messages: [{ role: "user", content: { type: "text", text: "Sum" } }],
    }));
  }
  track(
    server,
    fixture.projectId === undefined ? PROJECT_ID : fixture.projectId,
    fixture.options ?? {},
  );
  return server;
}

async function connect(server: { connect(t: unknown): Promise<void> }) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "server-info-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

const callAlpha = (client: Client) =>
  client.callTool({ name: "alpha", arguments: {} });

let events: EventCapture;
const openClients: Client[] = [];

async function connectFixture(fixture: FixtureOptions = {}) {
  const server = createFixtureServer(fixture);
  const client = await connect(server);
  openClients.push(client);
  return { server, client };
}

beforeEach(async () => {
  tasks.length = 0;
  setBackgroundTaskRegistrar((task) => {
    tasks.push(task);
  });
  events = new EventCapture();
  await events.start();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await settle();
  setBackgroundTaskRegistrar(undefined);
  await events.stop();
  for (const client of openClients.splice(0)) await client.close();
});

describe("server info test setup", () => {
  it("V16: the global setup records heartbeats and sends nothing to the AgentCat API", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await connectFixture();

    await client.listTools();
    await settle();

    expect(sent()).toHaveLength(1);
    const serverInfoCalls = fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("/v1/public/server-info/"),
    );
    expect(serverInfoCalls).toHaveLength(0);
  });
});

/** A memory 60 seconds old, so a plain tool call may start a heartbeat. */
async function useWarmMemory(): Promise<void> {
  const { resetServerInfoStateForTests } =
    await import("../modules/serverInfo.js");
  resetServerInfoStateForTests(Date.now() - 60_000);
}

/** A low-level server whose list handlers the test writes itself. */
function createLowLevelServer(
  handlers: {
    tools?: (cursor?: string) => any;
    resources?: (cursor?: string) => any;
    prompts?: (cursor?: string) => any;
  },
  options: AgentCatOptions = {},
): Server {
  const capabilities: Record<string, object> = {};
  if (handlers.tools) capabilities.tools = {};
  if (handlers.resources) capabilities.resources = {};
  if (handlers.prompts) capabilities.prompts = {};
  const server = new Server(
    { name: "demo-server", version: "1.2.3" },
    { capabilities },
  );
  if (handlers.tools) {
    const tools = handlers.tools;
    server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      tools(request.params?.cursor),
    );
    server.setRequestHandler(CallToolRequestSchema, async () =>
      text("alpha ok"),
    );
  }
  if (handlers.resources) {
    const resources = handlers.resources;
    server.setRequestHandler(ListResourcesRequestSchema, async (request) =>
      resources(request.params?.cursor),
    );
  }
  if (handlers.prompts) {
    const prompts = handlers.prompts;
    server.setRequestHandler(ListPromptsRequestSchema, async (request) =>
      prompts(request.params?.cursor),
    );
  }
  track(server, PROJECT_ID, options);
  return server;
}

const tool = (name: string) => ({
  name,
  description: `${name} tool`,
  inputSchema: { type: "object" as const, properties: {} },
});

async function connectLowLevel(server: Server) {
  const client = await connect(server);
  openClients.push(client);
  return client;
}

describe("server info body", () => {
  it("V1: one tool call sends the whole server info once", async () => {
    await useWarmMemory();
    const { client } = await connectFixture();

    await callAlpha(client);
    await settle();

    expect(sent()).toHaveLength(1);
    const body = sent()[0];
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.serverName).toBe("demo-server");
    expect(body.serverVersion).toBe("1.2.3");
    expect(body.serverTitle).toBe("Demo Title");
    expect(body.instructions).toBe("Use the demo tools.");
    const features = body.features as Record<string, any[]>;
    expect(Object.keys(features).sort()).toEqual([
      "prompts",
      "resourceTemplates",
      "resources",
      "tools",
    ]);

    const listed = await client.listTools();
    await settle();
    expect(sent()).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(features.tools))).toEqual(
      JSON.parse(JSON.stringify(listed.tools)),
    );
    expect(features.tools.map((t) => t.name)).toEqual([
      "alpha",
      "beta",
      "gamma",
      "get_more_tools",
    ]);
    const beta = features.tools.find((t) => t.name === "beta");
    expect(beta.description).toBe(LONG_DESCRIPTION);
    expect(beta.description).toHaveLength(2000);
    expect(beta.title).toBe("Beta Title");
    expect(beta.outputSchema).toBeDefined();
    expect(beta.annotations).toEqual({ readOnlyHint: true });
    expect(beta.inputSchema.properties.context).toBeDefined();

    expect(features.resources).toHaveLength(2);
    expect(features.resources.map((r) => r.uri)).toEqual([
      "file:///readme.md",
      "file:///config.json",
    ]);
    expect(features.resourceTemplates).toHaveLength(1);
    expect(features.resourceTemplates[0].uriTemplate).toBe("items://{id}");
    expect(features.prompts).toHaveLength(2);
    expect(features.prompts[0].arguments).toEqual([
      { name: "who", required: true },
    ]);
  });

  it("reads the instructions from the private _instructions field of the v1 server", async () => {
    await useWarmMemory();
    const { server, client } = await connectFixture();
    expect((server.server as any)._instructions).toBe("Use the demo tools.");

    await callAlpha(client);
    await settle();

    expect(sent()[0].instructions).toBe("Use the demo tools.");
  });

  it("V2: joins a tool list of 5 tools on 3 pages, with get_more_tools once", async () => {
    await useWarmMemory();
    const pages: Record<string, any> = {
      first: { tools: [tool("t1"), tool("t2")], nextCursor: "page2" },
      page2: { tools: [tool("t3"), tool("t4")], nextCursor: "page3" },
      page3: { tools: [tool("t5")] },
    };
    const client = await connectLowLevel(
      createLowLevelServer({ tools: (cursor) => pages[cursor ?? "first"] }),
    );

    await client.callTool({ name: "t1", arguments: {} });
    await settle();

    expect(sent()).toHaveLength(1);
    const tools = (sent()[0].features as any).tools as any[];
    expect(tools.map((t) => t.name)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "get_more_tools",
    ]);
  });

  it("V3: a server with tools only sends the key tools and no other key", async () => {
    await useWarmMemory();
    const { client } = await connectFixture({ resourcesAndPrompts: false });

    await callAlpha(client);
    await settle();

    expect(sent()).toHaveLength(1);
    expect(Object.keys(sent()[0].features as object)).toEqual(["tools"]);
    expect(sent()[0].serverTitle).toBe("Demo Title");
  });

  it("gives an empty string for a missing title and missing instructions", async () => {
    await useWarmMemory();
    const client = await connectLowLevel(
      createLowLevelServer({ tools: () => ({ tools: [tool("t1")] }) }),
    );

    await client.callTool({ name: "t1", arguments: {} });
    await settle();

    expect(sent()[0].serverTitle).toBe("");
    expect(sent()[0].instructions).toBe("");
  });

  it("gives an empty array for an empty list", async () => {
    await useWarmMemory();
    const client = await connectLowLevel(
      createLowLevelServer({
        tools: () => ({ tools: [tool("t1")] }),
        resources: () => ({ resources: [] }),
      }),
    );

    await client.callTool({ name: "t1", arguments: {} });
    await settle();

    expect((sent()[0].features as any).resources).toEqual([]);
  });

  it("V4: a failing prompt list leaves out prompts and keeps the full tool list", async () => {
    await useWarmMemory();
    const client = await connectLowLevel(
      createLowLevelServer({
        tools: () => ({ tools: [tool("t1"), tool("t2")] }),
        resources: () => ({ resources: [{ uri: "file:///a", name: "a" }] }),
        prompts: () => {
          throw new Error("prompts are down");
        },
      }),
    );

    await client.callTool({ name: "t1", arguments: {} });
    await settle();

    expect(sent()).toHaveLength(1);
    const features = sent()[0].features as Record<string, any[]>;
    expect(Object.keys(features).sort()).toEqual(["resources", "tools"]);
    expect(features.tools.map((t) => t.name)).toEqual([
      "t1",
      "t2",
      "get_more_tools",
    ]);
  });

  it("V5: a failing tool list sends nothing", async () => {
    await useWarmMemory();
    const client = await connectLowLevel(
      createLowLevelServer({
        tools: () => {
          throw new Error("tools are down");
        },
        prompts: () => ({ prompts: [] }),
      }),
    );

    const result: any = await client.callTool({ name: "t1", arguments: {} });
    await settle();

    expect(result.content).toContainEqual({ type: "text", text: "alpha ok" });
    expect(sent()).toHaveLength(0);
  });

  it("V6: a list that repeats its cursor fails within 100 pages and in under 5 seconds", async () => {
    await useWarmMemory();
    let resourceCalls = 0;
    const client = await connectLowLevel(
      createLowLevelServer({
        tools: () => ({ tools: [tool("t1")] }),
        resources: () => {
          resourceCalls++;
          return {
            resources: [{ uri: "file:///a", name: "a" }],
            nextCursor: "same",
          };
        },
      }),
    );
    const started = Date.now();

    await client.callTool({ name: "t1", arguments: {} });
    await settle();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(resourceCalls).toBeLessThanOrEqual(100);
    expect(sent()).toHaveLength(1);
    expect(Object.keys(sent()[0].features as object)).toEqual(["tools"]);
  });

  it("fails a list that has more than 100 pages", async () => {
    await useWarmMemory();
    let resourceCalls = 0;
    const client = await connectLowLevel(
      createLowLevelServer({
        tools: () => ({ tools: [tool("t1")] }),
        resources: (cursor) => {
          resourceCalls++;
          const page = Number(cursor ?? "0");
          return {
            resources: [{ uri: `file:///${page}`, name: `r${page}` }],
            nextCursor: String(page + 1),
          };
        },
      }),
    );

    await client.callTool({ name: "t1", arguments: {} });
    await settle();

    expect(resourceCalls).toBe(100);
    expect(Object.keys(sent()[0].features as object)).toEqual(["tools"]);
  });

  it("V15: server_name and server_version equal those of the event of the call", async () => {
    await useWarmMemory();
    const { client } = await connectFixture();

    await callAlpha(client);
    await settle();
    await events.flush();

    const event = events.findEventsByResourceName("alpha")[0];
    expect(event).toBeDefined();
    expect(sent()[0].serverName).toBe(event.serverName);
    expect(sent()[0].serverVersion).toBe(event.serverVersion);
  });
});
