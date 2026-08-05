import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "agentcat";

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

export default {
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mcp-hook")) {
      return hookHandler.fetch(request);
    }
    return handler.fetch(request);
  },
};
