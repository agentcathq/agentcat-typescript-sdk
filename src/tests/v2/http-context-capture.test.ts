import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/server";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { EventCapture } from "../test-utils.js";

// The event pipeline (redact → sanitize → truncate) mutates queued events in
// place asynchronously after add(); give it a beat before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

/**
 * The in-memory transport carries no HTTP, so the ServerContext-shaped extra
 * is synthetic — but the server, track() wrap seam, and pipeline are real.
 * Drive the wrapped tools/call handler directly (technique from
 * lowlevel-handles.test.ts) with the http context a v2 HTTP transport would
 * supply.
 */
async function setupLowLevel() {
  const server = new Server(
    { name: "v2-http-context", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
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
  server.setRequestHandler("tools/call", async (request: any) => ({
    content: [
      { type: "text", text: `echo: ${request.params.arguments?.text}` },
    ],
  }));
  agentcat.track(server, "proj_test", {});
  const client = await connectClient(server);
  await client.listTools();
  const handler = (server as any)._requestHandlers.get("tools/call");
  return { server, client, handler };
}

const callEcho = {
  method: "tools/call",
  params: { name: "echo", arguments: { text: "hi", context: "testing" } },
};

describe("v2: HTTP request context lands in published event parameters", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("captures headers, method, and url from the web Request", async () => {
    const { client, handler } = await setupLowLevel();
    await handler(callEcho, {
      sessionId: "transport-1",
      mcpReq: { id: 7, requestState: () => undefined, envelope: {} },
      http: {
        req: new Request("http://127.0.0.1:4105/mcp", {
          method: "POST",
          headers: { "x-agentcat-health-run": "run:ts_v2" },
        }),
      },
    });
    await settle();

    const event = capture.findEventByType("mcp:tools/call")!;
    const extra = (event.parameters as any).extra;
    expect(extra.http.req.method).toBe("POST");
    expect(extra.http.req.url).toBe("http://127.0.0.1:4105/mcp");
    expect(extra.http.req.headers["x-agentcat-health-run"]).toBe("run:ts_v2");
    // Path-agnostic twin of the health harness's header_ok check: the exact
    // value must appear somewhere under parameters after the full pipeline.
    expect(JSON.stringify(event.parameters)).toContain("run:ts_v2");
    await client.close();
  });

  it("leaves stdio-shaped extra (no http) unchanged", async () => {
    const { client, handler } = await setupLowLevel();
    await handler(callEcho, {
      mcpReq: { id: 8, requestState: () => undefined, envelope: {} },
    });
    await settle();

    const event = capture.findEventByType("mcp:tools/call")!;
    const extra = (event.parameters as any).extra;
    expect(extra.mcpReq).toBeDefined();
    expect(extra.http).toBeUndefined();
    await client.close();
  });

  it("does not throw on a malformed req and still publishes the event", async () => {
    const { client, handler } = await setupLowLevel();
    const result = await handler(callEcho, {
      mcpReq: { id: 9, requestState: () => undefined, envelope: {} },
      http: { req: { headers: 42 } },
    });
    await settle();

    expect(result.content?.length ?? 0).toBeGreaterThanOrEqual(1);
    const event = capture.findEventByType("mcp:tools/call")!;
    expect((event.parameters as any).extra.http.req.headers).toBe(42);
    await client.close();
  });
});
