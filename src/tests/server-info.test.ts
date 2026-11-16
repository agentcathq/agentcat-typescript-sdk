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

describe("server info redaction", () => {
  function createSecretServer(redact: (text: string) => Promise<string>) {
    const server = new McpServer(
      { name: "secret-server", version: "1.0.0", title: "the secret title" },
      { instructions: "the secret plan" },
    );
    server.registerTool(
      "secret_tool",
      {
        description: "secret tool",
        inputSchema: { q: z.string().describe("a secret") },
      },
      async () => text("ok"),
    );
    server.registerResource(
      "secret-file",
      "file:///secret.txt",
      { description: "the secret file" },
      async (uri) => ({ contents: [{ uri: uri.href, text: "x" }] }),
    );
    track(server, PROJECT_ID, { redactSensitiveInformation: redact });
    return server;
  }

  it("V11: the redaction function runs on the text and leaves names and URIs alone", async () => {
    await useWarmMemory();
    const client = await connect(
      createSecretServer(async (value) => value.replaceAll("secret", "[x]")),
    );
    openClients.push(client);

    await client.callTool({ name: "secret_tool", arguments: { q: "a" } });
    await settle();

    expect(sent()).toHaveLength(1);
    const body = sent()[0];
    const features = body.features as Record<string, any[]>;
    expect(body.instructions).toBe("the [x] plan");
    expect(body.serverTitle).toBe("the [x] title");
    const secretTool = features.tools.find((t) => t.name === "secret_tool");
    expect(secretTool.description).toBe("[x] tool");
    expect(secretTool.inputSchema.properties.q.description).toBe("a [x]");
    expect(features.resources[0].uri).toBe("file:///secret.txt");
    expect(features.resources[0].name).toBe("secret-file");
    expect(features.resources[0].description).toBe("the [x] file");
    expect(body.serverName).toBe("secret-server");
  });

  it("V12: a failing redaction function stops the heartbeat", async () => {
    await useWarmMemory();
    const client = await connect(
      createSecretServer(async () => {
        throw new Error("redaction is down");
      }),
    );
    openClients.push(client);

    const result: any = await client.callTool({
      name: "secret_tool",
      arguments: { q: "a" },
    });
    await settle();

    expect(result.content).toContainEqual({ type: "text", text: "ok" });
    expect(sent()).toHaveLength(0);
  });

  it("a redaction function that gives no string stops the heartbeat", async () => {
    await useWarmMemory();
    const client = await connect(
      createSecretServer(async () => undefined as unknown as string),
    );
    openClients.push(client);

    await client.callTool({ name: "secret_tool", arguments: { q: "a" } });
    await settle();

    expect(sent()).toHaveLength(0);
  });
});

async function emptyMemory(): Promise<void> {
  const { resetServerInfoStateForTests } =
    await import("../modules/serverInfo.js");
  resetServerInfoStateForTests();
}

const T0 = new Date("2026-11-16T10:00:00Z").getTime();

/** Fakes the clock only; timers stay real. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
}

function moveClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe("server info guard and start", () => {
  it("V7: one heartbeat for three requests, none at 3,599 s, a second at 3,600 s", async () => {
    fakeClock();
    await useWarmMemory();
    const { client } = await connectFixture();

    await callAlpha(client);
    await callAlpha(client);
    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(1);

    moveClock(3_599_000);
    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(1);

    moveClock(1_000);
    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(2);
  });

  it("V8: two server objects with the same project and name send once; another name sends again", async () => {
    await useWarmMemory();
    const first = await connectFixture();
    const second = await connectFixture();
    const other = await connectFixture({ name: "other-server" });

    await callAlpha(first.client);
    await callAlpha(second.client);
    await settle();
    expect(sent()).toHaveLength(1);

    await callAlpha(other.client);
    await settle();
    expect(sent()).toHaveLength(2);
    expect(sent().map((b) => b.serverName)).toEqual([
      "demo-server",
      "other-server",
    ]);
  });

  it("V9: no heartbeat with an empty project ID", async () => {
    await useWarmMemory();
    const { client } = await connectFixture({ projectId: null });

    await client.listTools();
    await callAlpha(client);
    await settle();

    expect(sent()).toHaveLength(0);
  });

  it("V9: no heartbeat with tracing off", async () => {
    await useWarmMemory();
    const { client } = await connectFixture({
      options: { enableTracing: false },
    });

    await client.listTools();
    await callAlpha(client);
    await client.callTool({ name: "get_more_tools", arguments: {} });
    await settle();

    expect(sent()).toHaveLength(0);
  });

  it("V17: a new memory sends for a tool list request and a feedback note, not for a tool call", async () => {
    const { client } = await connectFixture();

    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(0);

    await client.listTools();
    await settle();
    expect(sent()).toHaveLength(1);

    await emptyMemory();
    await client.callTool({
      name: "get_more_tools",
      arguments: { context: "I need a delete tool" },
    });
    await settle();
    expect(sent()).toHaveLength(2);
  });

  it("V18: with no memory between requests, only the tool list requests send", async () => {
    const { client } = await connectFixture();

    for (let round = 0; round < 3; round++) {
      await emptyMemory();
      const result: any = await callAlpha(client);
      expect(result.content).toContainEqual({ type: "text", text: "alpha ok" });
      await emptyMemory();
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain("alpha");
    }
    await settle();

    expect(sent()).toHaveLength(3);
  });

  it("V19: in a new memory a tool call sends at 60 s, not at 0 s or 59 s", async () => {
    fakeClock();
    const { client } = await connectFixture();

    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(0);

    moveClock(59_000);
    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(0);

    moveClock(1_000);
    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(1);
  });

  it("empties the guard when it holds 1,000 keys", async () => {
    await useWarmMemory();
    const listFor = (server: Server) =>
      (server as any)._requestHandlers.get("tools/list")(
        { method: "tools/list", params: {} },
        {},
      );
    const servers: Server[] = [];
    for (let index = 0; index < 1_000; index++) {
      const server = new Server(
        { name: `server-${index}`, version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [tool("t1")],
      }));
      track(server, PROJECT_ID);
      servers.push(server);
    }
    for (const server of servers) await listFor(server);
    await settle();
    expect(sent()).toHaveLength(1_000);

    await listFor(servers[0]);
    await settle();
    expect(sent()).toHaveLength(1_000);

    const extra = new Server(
      { name: "server-1000", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    extra.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [tool("t1")],
    }));
    track(extra, PROJECT_ID);
    await listFor(extra);
    await listFor(servers[0]);
    await settle();
    expect(sent()).toHaveLength(1_002);
  });

  it("enters no list handler before the result of the request is on its way", async () => {
    const order: string[] = [];
    const busyMs = 500;
    let slow = false;
    const client = await connectLowLevel(
      createLowLevelServer({
        tools: () => {
          order.push("tools/list entered");
          const until = Date.now() + (slow ? busyMs : 0);
          while (Date.now() < until) {
            // a slow synchronous part
          }
          return { tools: [tool("t1")] };
        },
        prompts: () => {
          order.push("prompts/list entered");
          return { prompts: [] };
        },
      }),
    );
    await client.listTools();
    await settle();
    await useWarmMemory();
    order.length = 0;
    slow = true;

    const started = Date.now();
    await client.callTool({ name: "t1", arguments: {} });
    const elapsed = Date.now() - started;
    order.push("tool call result");
    await settle();

    expect(order).toEqual([
      "tool call result",
      "tools/list entered",
      "prompts/list entered",
    ]);
    expect(elapsed).toBeLessThan(busyMs);
    expect(sent()).toHaveLength(2);
  });
});

describe("V10: a failing heartbeat never reaches the request", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  let outputSpies: Array<{ mock: { calls: unknown[] } }> = [];

  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
    outputSpies = [
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
      vi.spyOn(console, "log"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "warn"),
    ];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    for (const spy of outputSpies) expect(spy.mock.calls).toEqual([]);
    vi.restoreAllMocks();
  });

  /** Fakes the timers too, so a test can pass the heartbeat's time limits. */
  function fakeTimers(): void {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  }

  async function expectNormalResult(client: Client): Promise<void> {
    const result: any = await callAlpha(client);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContainEqual({ type: "text", text: "alpha ok" });
  }

  it("the API never answers", async () => {
    await useWarmMemory();
    const { client } = await connectFixture();
    let aborted = false;
    serverInfoRecorder.respond = (_body, signal) =>
      new Promise(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      });
    fakeTimers();

    await expectNormalResult(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(aborted).toBe(true);
  });

  it("a list handler fails", async () => {
    await useWarmMemory();
    const { server, client } = await connectFixture();
    (server.server as any)._requestHandlers.set("prompts/list", async () => {
      throw new Error("prompts are down");
    });

    await expectNormalResult(client);
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].features).not.toHaveProperty("prompts");
  });

  it("a list handler never returns", async () => {
    await useWarmMemory();
    const { server, client } = await connectFixture();
    let entered = false;
    (server.server as any)._requestHandlers.set("resources/list", () => {
      entered = true;
      return new Promise(() => {});
    });
    fakeTimers();

    await expectNormalResult(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(entered).toBe(true);
    expect(sent()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].features).not.toHaveProperty("resources");
  });

  it("the redaction function fails", async () => {
    await useWarmMemory();
    const { client } = await connectFixture({
      options: {
        redactSensitiveInformation: async () => {
          throw new Error("redaction is down");
        },
      },
    });

    await expectNormalResult(client);
    await settle();
    expect(sent()).toHaveLength(0);
  });

  it("the API answers 500 and no second POST follows", async () => {
    await useWarmMemory();
    const { client } = await connectFixture();
    serverInfoRecorder.respond = async () => {
      const { ResponseError } = await import("agentcat-api");
      throw new ResponseError(new Response(null, { status: 500 }), "500");
    };

    await expectNormalResult(client);
    await settle();
    expect(sent()).toHaveLength(1);
  });

  it("a list handler throws synchronously", async () => {
    await useWarmMemory();
    const { server, client } = await connectFixture();
    (server.server as any)._requestHandlers.set("resources/list", () => {
      throw new Error("sync failure");
    });

    await expectNormalResult(client);
    await settle();
    expect(sent()).toHaveLength(1);
    expect(sent()[0].features).not.toHaveProperty("resources");
  });

  it("the whole build stops after 30 seconds and sends nothing", async () => {
    await useWarmMemory();
    const { client } = await connectFixture({
      options: {
        redactSensitiveInformation: (value) =>
          value === "Use the demo tools."
            ? new Promise(() => {})
            : Promise.resolve(value),
      },
    });
    fakeTimers();

    await expectNormalResult(client);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(sent()).toHaveLength(0);
  });
});

describe("server info send", () => {
  const BASE_URL = "https://ingest.agentcat.test";

  async function useApiClientSender(): Promise<void> {
    const { setServerInfoSender } = await import("../modules/serverInfo.js");
    setServerInfoSender();
  }

  function stubFetch(statuses: number[]) {
    const posts: Array<{ url: string; body: any; headers: Headers }> = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith(BASE_URL)) {
          throw new Error(`unexpected request to ${url}`);
        }
        posts.push({
          url,
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });
        const status = statuses[posts.length - 1] ?? 202;
        return new Response(JSON.stringify({ status: "accepted" }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    return posts;
  }

  it("V14: the POST goes to the custom base URL, with the body of the contract", async () => {
    await useWarmMemory();
    await useApiClientSender();
    const posts = stubFetch([202]);
    const { client } = await connectFixture({
      options: { apiBaseUrl: BASE_URL },
    });

    await callAlpha(client);
    await settle();

    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${BASE_URL}/v1/public/server-info/`);
    expect(posts[0].headers.get("content-type")).toBe("application/json");
    expect(posts[0].headers.has("authorization")).toBe(false);
    expect(Object.keys(posts[0].body).sort()).toEqual([
      "features",
      "instructions",
      "project_id",
      "server_name",
      "server_title",
      "server_version",
    ]);
    expect(posts[0].body.project_id).toBe(PROJECT_ID);
    expect(posts[0].body.server_name).toBe("demo-server");
  });

  it("V13: after a 413 it sends once more without input and output schemas", async () => {
    await useWarmMemory();
    await useApiClientSender();
    const posts = stubFetch([413, 202]);
    const { client } = await connectFixture({
      options: { apiBaseUrl: BASE_URL },
    });

    await callAlpha(client);
    await settle();

    expect(posts).toHaveLength(2);
    const [full, small] = posts.map((p) => p.body.features.tools as any[]);
    expect(full.some((t) => t.inputSchema)).toBe(true);
    expect(full.some((t) => t.outputSchema)).toBe(true);
    for (const t of small) {
      expect(t).not.toHaveProperty("inputSchema");
      expect(t).not.toHaveProperty("outputSchema");
    }
    const labels = (tools: any[]) =>
      tools.map((t) => [t.name, t.title, t.description]);
    expect(labels(small)).toEqual(labels(full));
    expect(posts[1].body.instructions).toBe(posts[0].body.instructions);
    expect(posts[1].body.features.resources).toEqual(
      posts[0].body.features.resources,
    );
  });

  it("V13: after two 413 answers it stops", async () => {
    await useWarmMemory();
    await useApiClientSender();
    const posts = stubFetch([413, 413, 202]);
    const { client } = await connectFixture({
      options: { apiBaseUrl: BASE_URL },
    });

    await callAlpha(client);
    await settle();

    expect(posts).toHaveLength(2);
  });
});

describe("server info time limits stop the work behind them", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const fakeTimers = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const after = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  it("calls no further page once the 5 second list limit has passed", async () => {
    await useWarmMemory();
    let pageCalls = 0;
    const client = await connectLowLevel(
      createLowLevelServer({
        tools: () => ({ tools: [tool("t1")] }),
        resources: async (cursor) => {
          pageCalls++;
          await after(3_000);
          const page = Number(cursor ?? "0");
          return {
            resources: [{ uri: `file:///${page}`, name: `r${page}` }],
            nextCursor: String(page + 1),
          };
        },
      }),
    );
    fakeTimers();

    await client.callTool({ name: "t1", arguments: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    const callsAtLimit = pageCalls;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();

    expect(callsAtLimit).toBe(2);
    expect(pageCalls).toBe(callsAtLimit);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].features).not.toHaveProperty("resources");
  });

  it("starts no further redaction call once the 30 second build limit has passed", async () => {
    let redactionCalls = 0;
    const { client } = await connectFixture({
      options: {
        redactSensitiveInformation: async (value) => {
          redactionCalls++;
          await after(2_000);
          return value;
        },
      },
    });
    fakeTimers();

    const listing = client.listTools();
    await vi.advanceTimersByTimeAsync(0);
    await listing;
    await vi.advanceTimersByTimeAsync(30_000);
    const callsAtLimit = redactionCalls;
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();

    expect(callsAtLimit).toBeGreaterThan(0);
    expect(redactionCalls).toBe(callsAtLimit);
    expect(sent()).toHaveLength(0);
  });
});

describe("server info logs", () => {
  const lines: string[] = [];

  beforeEach(async () => {
    lines.length = 0;
    const { setDiagnosticsSink } = await import("../modules/logging.js");
    setDiagnosticsSink((entry) => {
      lines.push(entry);
    });
  });

  afterEach(async () => {
    const { setDiagnosticsSink } = await import("../modules/logging.js");
    setDiagnosticsSink(null);
  });

  const heartbeatLines = () => lines.filter((l) => l.includes("Server info"));

  it("never logs the message of an error from customer code", async () => {
    await useWarmMemory();
    const { server, client } = await connectFixture({
      options: {
        redactSensitiveInformation: async (value) => {
          if (value === "Use the demo tools.") {
            throw new Error("cannot redact the secret plan");
          }
          return value;
        },
      },
    });
    (server.server as any)._requestHandlers.set("prompts/list", async () => {
      throw new TypeError("the secret prompt store is down");
    });

    await callAlpha(client);
    await settle();

    expect(sent()).toHaveLength(0);
    expect(heartbeatLines().length).toBeGreaterThanOrEqual(2);
    expect(heartbeatLines().some((l) => l.includes("TypeError"))).toBe(true);
    for (const line of heartbeatLines()) expect(line).not.toContain("secret");
  });
});
