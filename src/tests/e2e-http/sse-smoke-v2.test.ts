// SSE smoke for the v2 major: baseline-defaults semantics on the long-lived
// topology with STREAMING (SSE) POST responses over a real socket.
//
// The frozen lanes.ts v2-longlived lane pins `enableJsonResponse: true` for
// matrix determinism, so this file builds the same ~30 lines of long-lived
// wiring locally with `enableJsonResponse: false` — POST responses then come
// back as `text/event-stream` bodies carrying the JSON-RPC response (noted as
// deliberate duplication in the phase2b report). Assertions are EventCapture +
// sink only, mirroring the v2-matrix baseline scenario.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import * as agentcat from "../../index.js";
import { EventCapture } from "../test-utils.js";
import {
  waitForEvents,
  mintBackOf,
  handleFrom,
  E2E_PROJECT_ID,
} from "./lanes.js";
import { buildV2Toolkit, type ToolSink } from "./toolkit.js";

describe("e2e-http v2 SSE smoke: long-lived lane, streaming POST responses", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("baseline-defaults over a real text/event-stream response", async () => {
    const sink: ToolSink = [];

    // Local long-lived wiring (copied from lanes.ts v2-longlived, JSON mode
    // flipped off): persistent tracked v2 McpServer on the installed
    // package's node:http wrapper of WebStandardStreamableHTTPServerTransport.
    const server = buildV2Toolkit(sink);
    agentcat.track(server, E2E_PROJECT_ID, {});
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false, // ← the point of this file: SSE responses
      keepAliveMs: 0,
    });
    await server.connect(transport);

    // Record every POST response's content type off the real sockets — the
    // proof that the wire actually streamed SSE rather than single JSON
    // bodies. The hono-based node bridge passes its headers straight to
    // res.writeHead (bypassing the res.setHeader map), so intercept writeHead
    // itself.
    const postResponseContentTypes: string[] = [];
    const httpServer = http.createServer((req, res) => {
      if (req.method === "POST") {
        const originalWriteHead = res.writeHead.bind(res);
        res.writeHead = ((...args: any[]) => {
          const headers = args.find((a) => a && typeof a === "object");
          const contentType = Object.entries(headers ?? {}).find(
            ([k]) => k.toLowerCase() === "content-type",
          )?.[1];
          postResponseContentTypes.push(String(contentType ?? ""));
          return (originalWriteHead as any)(...args);
        }) as any;
      }
      void transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/mcp`;

    const client = new Client(
      { name: "agentcat-e2e-client", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );
    const clientTransport = new StreamableHTTPClientTransport(new URL(baseUrl));
    try {
      await client.connect(clientTransport);

      // Listing: agentcat injected context + session_id and added get_more_tools.
      const { tools } = await client.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("get_more_tools");
      const echo = tools.find((t: any) => t.name === "echo")!;
      expect((echo.inputSchema as any).properties.context).toBeDefined();
      expect((echo.inputSchema as any).properties.session_id).toBeDefined();

      // Call with context but no session_id → SDK mints and announces the handle
      // inside the SSE-framed result.
      const result: any = await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "sse smoke intent" },
      });
      const mintBack = mintBackOf(result);
      expect(mintBack).toBeDefined();
      expect(handleFrom(mintBack!, "session_id")).toMatch(/^ses_/);

      // Event: minted ses_ session + captured intent.
      await waitForEvents(capture, 1);
      const echoEvents = capture.findEventsByResourceName("echo");
      expect(echoEvents).toHaveLength(1);
      expect(echoEvents[0].sessionId).toMatch(/^ses_/);
      expect(echoEvents[0].userIntent).toBe("sse smoke intent");

      // Strip-proof: the customer handler saw msg but no injected params.
      const seen = sink.filter((entry) => entry.tool === "echo");
      expect(seen).toHaveLength(1);
      expect(seen[0].args.msg).toBe("hi");
      expect(seen[0].args.session_id).toBeUndefined();
      expect(seen[0].args.context).toBeUndefined();

      // Streaming proof: the POST round-trips above (initialize, tools/list,
      // tools/call) came back as SSE bodies, not single JSON documents.
      expect(
        postResponseContentTypes.filter((ct) =>
          ct.includes("text/event-stream"),
        ).length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        postResponseContentTypes.some((ct) => ct.includes("application/json")),
      ).toBe(false);
    } finally {
      try {
        await client.close();
      } catch {
        // double close is fine
      }
      try {
        await transport.close();
      } catch {
        // already closed by the client's DELETE is fine
      }
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
