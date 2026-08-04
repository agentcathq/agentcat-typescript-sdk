import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare Workers event delivery", () => {
  it("keeps AgentCat ingestion alive after a v2 handler returns", async () => {
    let releaseIngestion: (() => void) | undefined;
    let ingestionCompleted = false;
    const ingestionGate = new Promise<void>((resolve) => {
      releaseIngestion = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof Request ? new URL(input.url) : new URL(String(input));
      if (url.origin !== "https://ingest.agentcat.test") {
        throw new Error(`Unexpected outbound request to ${url.toString()}`);
      }

      await ingestionGate;
      ingestionCompleted = true;
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const transport = new StreamableHTTPClientTransport(
      new URL("https://worker.test/mcp"),
      {
        fetch: (input, init) => SELF.fetch(new Request(input, init)),
      },
    );
    const client = new Client(
      { name: "workers-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    try {
      await client.connect(transport);
      const resultPromise = client.callTool({
        name: "echo",
        arguments: { text: "hello from Workers" },
      });

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      // The handler response is independent of the still-pending analytics
      // request. The workerd entrypoint has registered that request with
      // waitUntil so it can safely continue after this response.
      const result = await resultPromise;
      expect((result.content as Array<{ text?: string }>)[0].text).toBe(
        "hello from Workers",
      );
      expect(ingestionCompleted).toBe(false);

      releaseIngestion!();
      await vi.waitFor(() => expect(ingestionCompleted).toBe(true));
    } finally {
      releaseIngestion?.();
      await client.close();
    }
  });

  it("captures HTTP headers from a genuine workerd Request into event parameters", async () => {
    // workerd's Request is a different realm/implementation than undici's —
    // exactly the case the extra projection duck-types for. Record every
    // outbound ingest body and prove the sentinel header the client sent
    // survived into the published event payload.
    const ingestBodies: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request
            ? new URL(input.url)
            : new URL(String(input));
        if (url.origin !== "https://ingest.agentcat.test") {
          throw new Error(`Unexpected outbound request to ${url.toString()}`);
        }
        const body =
          typeof init?.body === "string"
            ? init.body
            : input instanceof Request
              ? await input.text()
              : "";
        ingestBodies.push(body);
        return new Response(null, { status: 202 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const transport = new StreamableHTTPClientTransport(
      new URL("https://worker.test/mcp"),
      {
        fetch: (input, init) => SELF.fetch(new Request(input, init)),
        requestInit: {
          headers: { "x-agentcat-health-run": "workers-sentinel" },
        },
      },
    );
    const client = new Client(
      { name: "workers-test-client", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );

    try {
      await client.connect(transport);
      await client.callTool({
        name: "echo",
        arguments: { text: "headers please" },
      });

      await vi.waitFor(() =>
        expect(
          ingestBodies.some((body) => body.includes("workers-sentinel")),
        ).toBe(true),
      );
    } finally {
      await client.close();
    }
  });
});
