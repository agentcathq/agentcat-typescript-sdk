// Lane abstraction for the real-HTTP e2e matrix: five topologies, each
// binding a real `node:http` server on an ephemeral 127.0.0.1 port and driving
// it with the matching real MCP client over the network — no in-process
// shortcuts, no fetch overrides.
//
// Teardown order (idempotent, per plan): client.close → transport(s)/handler
// close → httpServer.closeAllConnections() → awaited httpServer.close().
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";

// v1 (2025-era) SDK — server transport + client over real HTTP.
import { StreamableHTTPServerTransport as V1StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// v2 SDK — createMcpHandler factory topology + long-lived session transport.
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  Client as V2Client,
  StreamableHTTPClientTransport as V2StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import * as agentcat from "../../index.js";
import type { AgentCatOptions } from "../../types.js";
import type { EventCapture } from "../test-utils.js";
import { buildV1Toolkit, buildV2Toolkit, type ToolSink } from "./toolkit.js";

// Shared mint-back helpers — one source of truth with the v2 suite.
export { mintBackOf, handleFrom } from "../v2/harness.js";

export const E2E_PROJECT_ID = "proj_test";

export type LaneId =
  | "v1-stateful"
  | "v1-stateless"
  | "v2-handler-legacy"
  | "v2-handler-auto"
  | "v2-longlived";

export interface ClientInfo {
  name: string;
  version: string;
}

/**
 * Minimal structural client surface scenario scripts are written against.
 * Both the v1 and v2 SDK Clients satisfy it.
 */
export interface ScenarioClient {
  listTools(params?: unknown): Promise<{ tools: any[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<any>;
  close(): Promise<void>;
}

export interface LaneInstance {
  /** Full MCP endpoint URL, e.g. http://127.0.0.1:49152/mcp */
  baseUrl: string;
  /** Connect a fresh real client over HTTP. Clients are auto-closed by close(). */
  connectClient(info?: ClientInfo): Promise<ScenarioClient>;
  /** Idempotent full teardown: clients → transports/handler → sockets → server. */
  close(): Promise<void>;
}

export interface Lane {
  id: LaneId;
  major: 1 | 2;
  topology: "stateful" | "per-request";
  /** True when client identity travels in the 2026-07-28 per-request envelope. */
  envelope: boolean;
  start(options: AgentCatOptions, sink: ToolSink): Promise<LaneInstance>;
}

const DEFAULT_CLIENT_INFO: ClientInfo = {
  name: "agentcat-e2e-client",
  version: "1.0.0",
};

async function listenOnEphemeralPort(
  handler: http.RequestListener,
): Promise<{ httpServer: http.Server; baseUrl: string }> {
  const httpServer = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  return { httpServer, baseUrl: `http://127.0.0.1:${port}/mcp` };
}

/** Builds the idempotent teardown shared by every lane. */
function makeInstance(
  baseUrl: string,
  httpServer: http.Server,
  connect: (info: ClientInfo) => Promise<ScenarioClient>,
  closeServerSide: () => Promise<void>,
): LaneInstance {
  const clients: ScenarioClient[] = [];
  let closed = false;
  return {
    baseUrl,
    async connectClient(info?: ClientInfo) {
      const client = await connect(info ?? DEFAULT_CLIENT_INFO);
      clients.push(client);
      return client;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) {
        try {
          await client.close();
        } catch {
          // double-close (script already closed it) is fine
        }
      }
      try {
        await closeServerSide();
      } catch {
        // transports may already be closed by DELETE / res.close
      }
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function connectV1Client(
  baseUrl: string,
  info: ClientInfo,
): Promise<ScenarioClient> {
  const client = new V1Client(info);
  const transport = new V1StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  return client;
}

async function connectV2Client(
  baseUrl: string,
  info: ClientInfo,
  mode: "legacy" | "auto",
): Promise<ScenarioClient> {
  const client = new V2Client(info, { versionNegotiation: { mode } });
  const transport = new V2StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// v1-stateful: ONE tracked v1 server; a session map keyed by mcp-session-id
// hands each session its own StreamableHTTPServerTransport. track() runs once
// at startup.
// ---------------------------------------------------------------------------
const v1Stateful: Lane = {
  id: "v1-stateful",
  major: 1,
  topology: "stateful",
  envelope: false,
  async start(options, sink) {
    const server = buildV1Toolkit(sink);
    agentcat.track(server, E2E_PROJECT_ID, options);
    const transports = new Map<string, V1StreamableHTTPServerTransport>();

    const { httpServer, baseUrl } = await listenOnEphemeralPort((req, res) => {
      void (async () => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          transport = new V1StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
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

    return makeInstance(
      baseUrl,
      httpServer,
      (info) => connectV1Client(baseUrl, info),
      async () => {
        for (const transport of [...transports.values()]) {
          await transport.close();
        }
        transports.clear();
      },
    );
  },
};

// ---------------------------------------------------------------------------
// v1-stateless: POST-only serverless idiom — a FRESH v1 server + track()
// inside the request handler (mirrors the v2 factory pattern), stateless
// transport, both torn down when the response closes. GET/DELETE answer 405;
// both SDK clients explicitly tolerate 405 on their optional GET stream and
// session-terminate DELETE.
// ---------------------------------------------------------------------------
const v1Stateless: Lane = {
  id: "v1-stateless",
  major: 1,
  topology: "per-request",
  envelope: false,
  async start(options, sink) {
    const { httpServer, baseUrl } = await listenOnEphemeralPort((req, res) => {
      void (async () => {
        if (req.method !== "POST") {
          res.writeHead(405, {
            "Content-Type": "application/json",
            Allow: "POST",
          });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Method not allowed." },
              id: null,
            }),
          );
          return;
        }
        const server = buildV1Toolkit(sink);
        agentcat.track(server, E2E_PROJECT_ID, options);
        const transport = new V1StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    return makeInstance(
      baseUrl,
      httpServer,
      (info) => connectV1Client(baseUrl, info),
      async () => {
        // per-request transports die with their responses; nothing persistent
      },
    );
  },
};

// ---------------------------------------------------------------------------
// v2-handler-legacy / v2-handler-auto: one createMcpHandler whose factory
// tracks a fresh v2 McpServer per request, bridged to node:http via
// toNodeHandler(handler) → (req, res, parsedBody?) => Promise<void>.
// The two sub-lanes differ ONLY in the connecting client's versionNegotiation
// mode: "legacy" (2025 wire) vs "auto" (real 2026-07-28 envelope era).
// ---------------------------------------------------------------------------
function v2HandlerLane(id: LaneId, mode: "legacy" | "auto"): Lane {
  return {
    id,
    major: 2,
    topology: "per-request",
    envelope: mode === "auto",
    async start(options, sink) {
      const handler = createMcpHandler(() =>
        agentcat.track(buildV2Toolkit(sink), E2E_PROJECT_ID, options),
      );
      const nodeHandler = toNodeHandler(handler);
      const { httpServer, baseUrl } = await listenOnEphemeralPort(
        (req, res) => {
          void nodeHandler(req, res);
        },
      );

      return makeInstance(
        baseUrl,
        httpServer,
        (info) => connectV2Client(baseUrl, info, mode),
        () => handler.close(),
      );
    },
  };
}

const v2HandlerLegacy = v2HandlerLane("v2-handler-legacy", "legacy");
const v2HandlerAuto = v2HandlerLane("v2-handler-auto", "auto");

// ---------------------------------------------------------------------------
// v2-longlived: persistent tracked v2 McpServer on a session-ful streamable
// HTTP transport. NodeStreamableHTTPServerTransport is the installed package's
// node:http wrapper around WebStandardStreamableHTTPServerTransport (same
// options type; same hono-based bridge toNodeHandler uses). track() runs once
// at startup.
// ---------------------------------------------------------------------------
const v2Longlived: Lane = {
  id: "v2-longlived",
  major: 2,
  topology: "stateful",
  envelope: false,
  async start(options, sink) {
    const server = buildV2Toolkit(sink);
    agentcat.track(server, E2E_PROJECT_ID, options);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      keepAliveMs: 0,
    });
    await server.connect(transport);

    const { httpServer, baseUrl } = await listenOnEphemeralPort((req, res) => {
      void transport.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    return makeInstance(
      baseUrl,
      httpServer,
      (info) => connectV2Client(baseUrl, info, "legacy"),
      () => transport.close(),
    );
  },
};

export const LANES: readonly Lane[] = [
  v1Stateful,
  v1Stateless,
  v2HandlerLegacy,
  v2HandlerAuto,
  v2Longlived,
];

export function laneById(id: LaneId): Lane {
  const lane = LANES.find((l) => l.id === id);
  if (!lane) throw new Error(`unknown lane: ${id}`);
  return lane;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Waits until the capture holds at least `count` events and returns them.
 * Always use this over trusting in-process ordering — events cross a real
 * socket boundary in this suite.
 */
export async function waitForEvents(
  capture: EventCapture,
  count: number,
  timeout = 2000,
) {
  return await vi.waitFor(
    () => {
      const events = capture.getEvents();
      if (events.length < count) {
        throw new Error(
          `expected >= ${count} captured events, saw ${events.length}`,
        );
      }
      return events;
    },
    { timeout, interval: 20 },
  );
}

/** Fixed settle for pipeline-mutation assertions (redaction etc.). */
export function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
