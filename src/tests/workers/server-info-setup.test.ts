import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serverInfoRecorder } from "../test-utils/server-info-recorder.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Workers test setup", () => {
  it("V16: every Workers route records heartbeats and sends none to the network", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return new Response(JSON.stringify({ status: "accepted" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    for (const route of ["/mcp", "/mcp-hook", "/mcp-info"]) {
      const client = new Client(
        { name: "workers-setup-client", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`https://worker.test${route}`),
          { fetch: (input, init) => SELF.fetch(new Request(input, init)) },
        ),
      );
      try {
        await client.listTools();
      } finally {
        await client.close();
      }
    }

    await vi.waitFor(() =>
      expect(serverInfoRecorder.bodies.map((b) => b.serverName).sort()).toEqual(
        [
          "agentcat-workers-hook-test",
          "agentcat-workers-info",
          "agentcat-workers-test",
        ],
      ),
    );
    expect(urls.filter((url) => url.includes("/server-info/"))).toEqual([]);
  });
});
