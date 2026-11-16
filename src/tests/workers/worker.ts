import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
// The source entry point for Workers, not the built package: the tests and
// setup.ts share its module state (the heartbeat memory, the heartbeat
// sender and the background registrar), so no test can reach the real
// heartbeat sender by accident.
import * as agentcat from "../../index.workerd.js";

const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "agentcat-workers-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "echo",
    {
      description: "Echo the supplied text",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }: { text: string }) => ({
      content: [{ type: "text" as const, text }],
    }),
  );

  return agentcat.track(server, "proj_workers_test", {
    apiBaseUrl: "https://ingest.agentcat.test",
    disableDiagnostics: true,
  });
});

// Second route with deferred customer hooks that settle ~100ms after firing —
// slower than the tool handler. Proves the background hook awaits ride the
// same waitUntil registration as event delivery.
const hookHandler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "agentcat-workers-hook-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "echo",
    {
      description: "Echo the supplied text",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }: { text: string }) => ({
      content: [{ type: "text" as const, text }],
    }),
  );

  return agentcat.track(server, "proj_workers_test", {
    apiBaseUrl: "https://ingest.agentcat.test",
    disableDiagnostics: true,
    resolveSessionId: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "workers-hook-corr";
    },
    identify: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { userId: "workers-hook-user" };
    },
  });
});

// Server info route. The x-heartbeat-scenario header picks a failure for the
// heartbeat to meet.
const serverInfoHandler = createMcpHandler(({ requestInfo }) => {
  const scenario = requestInfo?.headers.get("x-heartbeat-scenario") ?? "";
  const server = new McpServer(
    {
      name: "agentcat-workers-info",
      version: "1.2.3",
      title: "Workers Info",
    },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: "Use the echo tool.",
    },
  );
  server.registerTool(
    "echo",
    {
      description: "Echo the supplied text",
      inputSchema: z.object({ text: z.string() }),
    },
    async ({ text }: { text: string }) => ({
      content: [{ type: "text" as const, text }],
    }),
  );
  server.registerResource(
    "readme",
    "file:///readme.md",
    { description: "The readme" },
    async (uri: URL) => ({ contents: [{ uri: uri.href, text: "readme" }] }),
  );
  server.registerPrompt("summary", { description: "Summarize" }, () => ({
    messages: [{ role: "user", content: { type: "text", text: "Sum" } }],
  }));
  const handlers = (server.server as any)._requestHandlers as Map<
    string,
    unknown
  >;
  if (scenario === "prompts-fail") {
    handlers.set("prompts/list", async () => {
      throw new Error("prompts are down");
    });
  }
  if (scenario === "resources-hang") {
    handlers.set("resources/list", () => new Promise(() => {}));
  }

  return agentcat.track(server, "proj_workers_test", {
    apiBaseUrl: "https://ingest.agentcat.test",
    disableDiagnostics: true,
    ...(scenario === "redaction-fail" && {
      redactSensitiveInformation: async () => {
        throw new Error("redaction is down");
      },
    }),
  });
});

export default {
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mcp-hook")) {
      return hookHandler.fetch(request);
    }
    if (url.pathname.startsWith("/mcp-info")) {
      return serverInfoHandler.fetch(request);
    }
    return handler.fetch(request);
  },
};
