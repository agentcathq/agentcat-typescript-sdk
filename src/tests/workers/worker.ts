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

// Third route whose tool publishes a custom event with the server form and no
// sessionId: the event must join the session of the tool call it runs in.
const customEventHandler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "agentcat-workers-custom-event-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Completes a task and records it as a custom event",
      inputSchema: z.object({ task: z.string() }),
    },
    async ({ task }: { task: string }) => {
      await agentcat.publishCustomEvent(server, "proj_workers_test", {
        resourceName: "task_completed",
      });
      return {
        content: [{ type: "text" as const, text: `completed ${task}` }],
      };
    },
  );

  return agentcat.track(server, "proj_workers_test", {
    apiBaseUrl: "https://ingest.agentcat.test",
    disableDiagnostics: true,
  });
});

export default {
  fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/mcp-hook")) {
      return hookHandler.fetch(request);
    }
    if (url.pathname.startsWith("/mcp-custom-event")) {
      return customEventHandler.fetch(request);
    }
    return handler.fetch(request);
  },
};
