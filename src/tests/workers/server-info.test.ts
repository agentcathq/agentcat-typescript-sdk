import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SELF } from "cloudflare:test";
import { waitUntil } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackgroundTaskRegistrar } from "../../modules/backgroundTasks.js";
import { resetServerInfoStateForTests } from "../../modules/serverInfo.js";

const INGEST = "https://ingest.agentcat.test";
const SERVER_INFO_URL = `${INGEST}/v1/public/server-info/`;

interface Post {
  url: string;
  body: any;
}

let posts: Post[];
let tasks: Promise<void>[];
let serverInfoAnswer: () => Promise<Response>;
const clients: Client[] = [];

/** Waits for every task that the SDK handed to waitUntil. */
async function settle(): Promise<void> {
  while (tasks.length > 0) {
    await Promise.allSettled(tasks.splice(0));
  }
}

const heartbeats = () => posts.filter((post) => post.url === SERVER_INFO_URL);

async function connect(scenario = ""): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL("https://worker.test/mcp-info"),
    {
      fetch: (input, init) => SELF.fetch(new Request(input, init)),
      requestInit: { headers: { "x-heartbeat-scenario": scenario } },
    },
  );
  const client = new Client(
    { name: "workers-info-client", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function echo(client: Client, text = "hello"): Promise<void> {
  const result: any = await client.callTool({
    name: "echo",
    arguments: { text },
  });
  expect(result.isError).toBeUndefined();
  expect(result.content).toContainEqual({ type: "text", text });
}

beforeEach(() => {
  // Each test records into its own array: a heartbeat left waiting by an
  // earlier test can never land in a later test's record.
  const record: Post[] = [];
  posts = record;
  tasks = [];
  serverInfoAnswer = async () =>
    new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
  // The registrar of the workerd entry point, with a record of each task.
  setBackgroundTaskRegistrar((task) => {
    tasks.push(task);
    waitUntil(task);
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(INGEST)) {
        throw new Error(`Unexpected outbound request to ${url}`);
      }
      const body =
        typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.text()
            : "";
      record.push({ url, body: body ? JSON.parse(body) : undefined });
      if (url === SERVER_INFO_URL) return serverInfoAnswer();
      return new Response(JSON.stringify({ status: "accepted" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  resetServerInfoStateForTests();
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.unstubAllGlobals();
});

describe("Cloudflare Workers server info heartbeat", () => {
  it("V1: a tool call in a warm memory sends the whole server info through waitUntil", async () => {
    resetServerInfoStateForTests(Date.now() - 60_000);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delivered = false;
    serverInfoAnswer = async () => {
      await gate;
      delivered = true;
      return new Response(null, { status: 202 });
    };
    const client = await connect();

    await echo(client);
    await vi.waitFor(() => expect(heartbeats()).toHaveLength(1));
    expect(delivered).toBe(false);
    release!();
    await settle();
    expect(delivered).toBe(true);

    const body = heartbeats()[0].body;
    expect(body.project_id).toBe("proj_workers_test");
    expect(body.server_name).toBe("agentcat-workers-info");
    expect(body.server_version).toBe("1.2.3");
    expect(body.server_title).toBe("Workers Info");
    expect(body.instructions).toBe("Use the echo tool.");
    expect(Object.keys(body.features).sort()).toEqual([
      "prompts",
      "resourceTemplates",
      "resources",
      "tools",
    ]);
    const listed = await client.listTools();
    await settle();
    expect(heartbeats()).toHaveLength(1);
    expect(body.features.tools).toEqual(
      JSON.parse(JSON.stringify(listed.tools)),
    );
    expect(body.features.resources).toHaveLength(1);
    expect(body.features.prompts).toHaveLength(1);
  });

  it("V10: the tool call gets its normal result whatever the heartbeat meets", async () => {
    resetServerInfoStateForTests(Date.now() - 60_000);
    await echo(await connect("prompts-fail"));
    await settle();
    expect(heartbeats()).toHaveLength(1);
    expect(heartbeats()[0].body.features).not.toHaveProperty("prompts");

    resetServerInfoStateForTests(Date.now() - 60_000);
    await echo(await connect("redaction-fail"));
    await settle();
    expect(heartbeats()).toHaveLength(1);

    resetServerInfoStateForTests(Date.now() - 60_000);
    serverInfoAnswer = async () => new Response(null, { status: 500 });
    await echo(await connect());
    await settle();
    expect(heartbeats()).toHaveLength(2);

    resetServerInfoStateForTests(Date.now() - 60_000);
    serverInfoAnswer = () => new Promise(() => {});
    await echo(await connect());
    await vi.waitFor(() => expect(heartbeats()).toHaveLength(3));

    resetServerInfoStateForTests(Date.now() - 60_000);
    await echo(await connect("resources-hang"));
  });

  it("V17: a new memory sends for a tool list request and a feedback note, not for a tool call", async () => {
    const client = await connect();

    await echo(client);
    await settle();
    expect(heartbeats()).toHaveLength(0);

    await client.listTools();
    await settle();
    expect(heartbeats()).toHaveLength(1);

    resetServerInfoStateForTests();
    await client.callTool({
      name: "get_more_tools",
      arguments: { context: "I need a delete tool" },
    });
    await settle();
    expect(heartbeats()).toHaveLength(2);
  });

  it("V18: with an empty memory at each request, only the tool list requests send", async () => {
    const client = await connect();

    for (let round = 0; round < 3; round++) {
      resetServerInfoStateForTests();
      await echo(client, `round ${round}`);
      resetServerInfoStateForTests();
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("echo");
    }
    await settle();

    expect(heartbeats()).toHaveLength(3);
  });
});
