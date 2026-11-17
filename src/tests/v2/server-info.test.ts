import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod4";
import { track } from "../../index.js";
import { setBackgroundTaskRegistrar } from "../../modules/backgroundTasks.js";
import { resetServerInfoStateForTests } from "../../modules/serverInfo.js";
import { serverInfoRecorder } from "../test-utils/server-info-recorder.js";
import { EventCapture } from "../test-utils.js";
import { connectClient } from "./harness.js";

const PROJECT_ID = "proj_" + "b".repeat(27);
const LONG_DESCRIPTION = "Beta does a lot. ".repeat(118).slice(0, 2000);

const tasks: Promise<void>[] = [];
const openClients: Client[] = [];
let events: EventCapture;

async function settle(): Promise<void> {
  while (tasks.length > 0) {
    await Promise.allSettled(tasks.splice(0));
  }
}

const sent = () => serverInfoRecorder.bodies;

const useWarmMemory = () => resetServerInfoStateForTests(Date.now() - 60_000);

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
});

function createFixtureServer(resourcesAndPrompts = true): McpServer {
  const server = new McpServer(
    { name: "demo-server", version: "1.2.3", title: "Demo Title" },
    { capabilities: { tools: {} }, instructions: "Use the demo tools." },
  );
  server.registerTool(
    "alpha",
    { description: "Alpha tool", inputSchema: z.object({}) },
    async () => text("alpha ok"),
  );
  server.registerTool(
    "beta",
    {
      title: "Beta Title",
      description: LONG_DESCRIPTION,
      inputSchema: z.object({ n: z.number().describe("A number") }),
      outputSchema: z.object({ doubled: z.number() }),
      annotations: { readOnlyHint: true },
    },
    async ({ n }: { n: number }) => ({
      ...text(`${n * 2}`),
      structuredContent: { doubled: n * 2 },
    }),
  );
  server.registerTool("gamma", { description: "Gamma tool" }, async () =>
    text("gamma ok"),
  );
  if (resourcesAndPrompts) {
    server.registerResource(
      "readme",
      "file:///readme.md",
      { description: "The readme" },
      async (uri: URL) => ({ contents: [{ uri: uri.href, text: "readme" }] }),
    );
    server.registerResource(
      "config",
      "file:///config.json",
      { title: "Config", mimeType: "application/json" },
      async (uri: URL) => ({ contents: [{ uri: uri.href, text: "{}" }] }),
    );
    server.registerResource(
      "item",
      new ResourceTemplate("items://{id}", { list: undefined }),
      { description: "One item" },
      async (uri: URL) => ({ contents: [{ uri: uri.href, text: "item" }] }),
    );
    server.registerPrompt(
      "greet",
      {
        description: "Greet someone",
        argsSchema: z.object({ who: z.string() }),
      },
      ({ who }: { who: string }) => ({
        messages: [
          { role: "user", content: { type: "text", text: `Hi ${who}` } },
        ],
      }),
    );
    server.registerPrompt("summary", { description: "Summarize" }, () => ({
      messages: [{ role: "user", content: { type: "text", text: "Sum" } }],
    }));
  }
  track(server, PROJECT_ID);
  return server;
}

async function connectFixture(resourcesAndPrompts = true) {
  const server = createFixtureServer(resourcesAndPrompts);
  const client = await connectClient(server);
  openClients.push(client);
  return { server, client };
}

const callAlpha = (client: Client) =>
  client.callTool({ name: "alpha", arguments: {} });

beforeEach(async () => {
  tasks.length = 0;
  setBackgroundTaskRegistrar((task) => {
    tasks.push(task);
  });
  events = new EventCapture();
  await events.start();
});

afterEach(async () => {
  await settle();
  setBackgroundTaskRegistrar(undefined);
  await events.stop();
  for (const client of openClients.splice(0)) await client.close();
});

describe("v2 server info heartbeat", () => {
  it("V1: one tool call sends the whole server info once", async () => {
    useWarmMemory();
    const { client } = await connectFixture();

    await callAlpha(client);
    await settle();

    expect(sent()).toHaveLength(1);
    const body = sent()[0];
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.serverName).toBe("demo-server");
    expect(body.serverVersion).toBe("1.2.3");
    expect(body.serverTitle).toBe("Demo Title");
    const features = body.features as Record<string, any[]>;

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
    expect(beta.outputSchema).toBeDefined();
    expect(beta.annotations).toEqual({ readOnlyHint: true });
    expect(features.resources).toHaveLength(2);
    expect(features.resourceTemplates).toHaveLength(1);
    expect(features.resourceTemplates[0].uriTemplate).toBe("items://{id}");
    expect(features.prompts).toHaveLength(2);
    expect(features.prompts[0].arguments).toEqual([
      expect.objectContaining({ name: "who", required: true }),
    ]);
  });

  it("reads the instructions from the private _instructions field of the v2 server", async () => {
    useWarmMemory();
    const { server, client } = await connectFixture();
    expect((server.server as any)._instructions).toBe("Use the demo tools.");

    await callAlpha(client);
    await settle();

    expect(sent()[0].instructions).toBe("Use the demo tools.");
  });

  it("V3: a server with tools only sends the key tools and no other key", async () => {
    useWarmMemory();
    const { client } = await connectFixture(false);

    await callAlpha(client);
    await settle();

    expect(Object.keys(sent()[0].features as object)).toEqual(["tools"]);
  });

  it("V15: server_name and server_version equal those of the event of the call", async () => {
    useWarmMemory();
    const { client } = await connectFixture();

    await callAlpha(client);
    await settle();
    await events.flush();

    const event = events.findEventsByResourceName("alpha")[0];
    expect(sent()[0].serverName).toBe(event.serverName);
    expect(sent()[0].serverVersion).toBe(event.serverVersion);
  });

  it("V17: a new memory sends for a tool list request and a feedback note, not for a tool call", async () => {
    const { client } = await connectFixture();

    await callAlpha(client);
    await settle();
    expect(sent()).toHaveLength(0);

    await client.listTools();
    await settle();
    expect(sent()).toHaveLength(1);

    resetServerInfoStateForTests();
    await client.callTool({
      name: "get_more_tools",
      arguments: { context: "I need a delete tool" },
    });
    await settle();
    expect(sent()).toHaveLength(2);
  });

  it("V4: a failing prompt list leaves out prompts and keeps the full tool list", async () => {
    useWarmMemory();
    const { server, client } = await connectFixture();
    (server.server as any)._requestHandlers.set("prompts/list", async () => {
      throw new Error("prompts are down");
    });

    await callAlpha(client);
    await settle();

    const features = sent()[0].features as Record<string, any[]>;
    expect(features).not.toHaveProperty("prompts");
    expect(features.tools).toHaveLength(4);
  });
});
