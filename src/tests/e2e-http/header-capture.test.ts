// Header capture over real sockets: the in-repo twin of the health harness's
// `header_ok` assertion (verify_events.py). A client sends a sentinel header
// on every HTTP request; the published event's parameters must carry its
// exact value — path-agnostic, like the harness's _deep_contains — plus the
// shape-specific paths per SDK major (v2 `extra.http.req.headers`, v1
// `extra.requestInfo.headers`).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Client as V1Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as V1StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  Client as V2Client,
  StreamableHTTPClientTransport as V2StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { EventCapture } from "../test-utils.js";
import { laneById, waitForEvents, settle } from "./lanes.js";
import type { ToolSink } from "./toolkit.js";

const SENTINEL_HEADER = "x-agentcat-health-run";
const SENTINEL = "hcrun:header-capture";

/** Exact-value deep search, mirroring verify_events.py's _deep_contains. */
function deepContains(value: unknown, needle: string): boolean {
  if (value === needle) return true;
  if (Array.isArray(value)) return value.some((v) => deepContains(v, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => deepContains(v, needle));
  }
  return false;
}

describe("e2e-http: HTTP headers land in published event parameters", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("v2 (longlived lane): sentinel header at extra.http.req.headers", async () => {
    const sink: ToolSink = [];
    const instance = await laneById("v2-longlived").start({}, sink);
    const client = new V2Client(
      { name: "agentcat-e2e-client", version: "1.0.0" },
      { versionNegotiation: { mode: "legacy" } },
    );
    const transport = new V2StreamableHTTPClientTransport(
      new URL(instance.baseUrl),
      { requestInit: { headers: { [SENTINEL_HEADER]: SENTINEL } } },
    );
    try {
      await client.connect(transport);
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "header capture" },
      });

      await waitForEvents(capture, 1);
      await settle();
      const [event] = capture.findEventsByResourceName("echo");
      const extra = (event.parameters as any).extra;
      expect(extra.http.req.headers[SENTINEL_HEADER]).toBe(SENTINEL);
      expect(extra.http.req.method).toBe("POST");
      expect(typeof extra.http.req.url).toBe("string");
      // The harness-shaped check: exact value, any path.
      expect(deepContains(event.parameters, SENTINEL)).toBe(true);
    } finally {
      try {
        await client.close();
      } catch {
        // double close is fine
      }
      await instance.close();
    }
  });

  it("v1 (stateful lane): sentinel header at extra.requestInfo.headers, url a string", async () => {
    const sink: ToolSink = [];
    const instance = await laneById("v1-stateful").start({}, sink);
    const client = new V1Client({
      name: "agentcat-e2e-client",
      version: "1.0.0",
    });
    const transport = new V1StreamableHTTPClientTransport(
      new URL(instance.baseUrl),
      { requestInit: { headers: { [SENTINEL_HEADER]: SENTINEL } } },
    );
    try {
      await client.connect(transport);
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "header capture" },
      });

      await waitForEvents(capture, 1);
      await settle();
      const [event] = capture.findEventsByResourceName("echo");
      const extra = (event.parameters as any).extra;
      expect(extra.requestInfo.headers[SENTINEL_HEADER]).toBe(SENTINEL);
      // The URL fix: a URL instance used to publish as {}.
      expect(typeof extra.requestInfo.url).toBe("string");
      expect(extra.requestInfo.url).toContain("/mcp");
      expect(deepContains(event.parameters, SENTINEL)).toBe(true);
    } finally {
      try {
        await client.close();
      } catch {
        // double close is fine
      }
      await instance.close();
    }
  });
});
