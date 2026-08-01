// src/tests/v2/era-2026.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { EventCapture } from "../test-utils.js";

let factoryRuns = 0;

function buildHandler() {
  factoryRuns = 0;
  return createMcpHandler(() => {
    factoryRuns++;
    const mcp = new McpServer(
      { name: "era-2026", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "echo",
      { description: "Echo", inputSchema: z.object({ msg: z.string() }) },
      async (args: { msg: string }) => ({
        content: [{ type: "text" as const, text: args.msg }],
      }),
    );
    // track-in-factory: the documented 2026-era pattern — every per-request
    // instance is tracked; module-level singletons keep this cheap.
    return agentcat.track(mcp, "proj_test");
  });
}

async function connect2026(handler: {
  fetch(req: Request): Promise<Response>;
}) {
  const transport = new StreamableHTTPClientTransport(
    new URL("http://test.local/mcp"),
    { fetch: (url: any, init: any) => handler.fetch(new Request(url, init)) },
  );
  const client = new Client(
    { name: "agentcat-2026-client", version: "3.2.1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  return client;
}

// If the versionNegotiation option shape rejects at compile time, check the
// installed client's typings (node_modules/@modelcontextprotocol/client) and
// docs/migration/support-2026-07-28.md — the option is client-side, mode
// 'auto' probes for the modern era. Do NOT silently drop the option: these
// tests exist to run the 2026-07-28 wire path.

describe("2026-07-28 era via createMcpHandler", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("tracks per-request instances and captures envelope identity", async () => {
    const handler = buildHandler();
    const client = await connect2026(handler);

    await client.callTool({ name: "echo", arguments: { msg: "one" } });
    await client.callTool({ name: "echo", arguments: { msg: "two" } });

    // Per-request topology: more than one factory instance served the calls.
    expect(factoryRuns).toBeGreaterThanOrEqual(2);

    const toolEvents = capture
      .getEvents()
      .filter((e) => e.resourceName === "echo");
    expect(toolEvents).toHaveLength(2);

    // Envelope-derived identity: clientInfo travels per request on 2026.
    expect(toolEvents[0].clientName).toBe("agentcat-2026-client");
    expect(toolEvents[0].clientVersion).toBe("3.2.1");
    // Envelope-derived protocol version tag.
    expect(toolEvents[0].tags?.agentcat_protocol_version).toBe("2026-07-28");
    await client.close();
  });

  it("rebuild-on-demand serves calls on instances that never listed", async () => {
    const handler = buildHandler();
    const client = await connect2026(handler);
    // callTool straight away: the serving instance for this request has
    // never seen tools/list.
    const result = (await client.callTool({
      name: "echo",
      arguments: { msg: "solo" },
    })) as any;
    expect(result.content[0].text).toContain("solo");
    const [event] = capture
      .getEvents()
      .filter((e) => e.resourceName === "echo");
    expect(event.sessionId).toMatch(/^ses_/);
    await client.close();
  });
});
