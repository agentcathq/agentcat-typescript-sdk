// SSE smoke for the v1 major: the baseline-defaults scenario against a
// v1-stateful topology whose transport streams POST responses over SSE
// (enableJsonResponse: false) on a real socket — the matrix runs JSON mode
// everywhere for determinism, so this file proves the streamed path once.
//
// NOTE (report-material): lanes.ts is frozen and its v1-stateful lane pins
// enableJsonResponse: true with no toggle, so the ~30 lines of stateful
// wiring below are duplicated from lanes.ts with only that flag flipped.
// If lanes.ts ever grows an SSE option, fold this back in.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as agentcat from "../../index.js";
import { EventCapture } from "../test-utils.js";
import {
  waitForEvents,
  mintBackOf,
  handleFrom,
  E2E_PROJECT_ID,
} from "./lanes.js";
import { scenarioConfig } from "./scenario-types.js";
import { buildV1Toolkit, type ToolSink } from "./toolkit.js";
import {
  AGENTCAT_TAG_TASK_SOURCE,
  MINT_BACK_HEADER_TASK,
} from "../../modules/constants.js";

interface SseInstance {
  client: Client;
  close(): Promise<void>;
}

/** v1-stateful wiring (mirrors lanes.ts) with SSE POST responses. */
async function startStatefulSse(sink: ToolSink): Promise<SseInstance> {
  const { options } = scenarioConfig("baseline-defaults");
  const server = buildV1Toolkit(sink);
  agentcat.track(server, E2E_PROJECT_ID, options);
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: false, // SSE mode — the point of this file
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        const created = transport;
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        await server.connect(created);
      }
      await transport.handleRequest(req, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;

  const client = new Client({ name: "agentcat-e2e-client", version: "1.0.0" });
  const clientTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
  );
  await client.connect(clientTransport);

  let closed = false;
  return {
    client,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.close();
      } catch {
        // double-close tolerated
      }
      for (const transport of [...transports.values()]) {
        try {
          await transport.close();
        } catch {
          // already closed via DELETE
        }
      }
      transports.clear();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe("e2e-http v1 SSE smoke (stateful, enableJsonResponse: false)", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("baseline-defaults over streamed POST responses", async () => {
    const sink: ToolSink = [];
    const instance = await startStatefulSse(sink);
    try {
      const { client } = instance;

      // Listing arrives over an SSE-framed response body.
      const { tools } = await client.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("get_more_tools");
      const echo: any = tools.find((t: any) => t.name === "echo")!;
      expect(echo.inputSchema.properties.context).toBeDefined();
      expect(echo.inputSchema.properties.task_id).toBeDefined();

      // Call with context but no task_id → mint-back rides the SSE stream.
      const result: any = await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "sse smoke intent" },
      });
      const mintBack = mintBackOf(result);
      expect(mintBack).toBeDefined();
      expect(mintBack).toContain(MINT_BACK_HEADER_TASK);
      const taskId = handleFrom(mintBack!, "task_id");
      expect(taskId).toMatch(/^ses_/);

      const events = await waitForEvents(capture, 1);
      expect(events).toHaveLength(1);
      const [event] = capture.findEventsByResourceName("echo");
      expect(event.sessionId).toBe(taskId);
      expect(event.userIntent).toBe("sse smoke intent");
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_TASK_SOURCE]: "minted",
      });

      // Strip-proof unchanged in SSE mode.
      const seen = sink.filter((entry) => entry.tool === "echo");
      expect(seen).toHaveLength(1);
      expect(seen[0].args.msg).toBe("hi");
      expect(seen[0].args.task_id).toBeUndefined();
      expect(seen[0].args.context).toBeUndefined();
    } finally {
      await instance.close();
    }
  });
});
