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

export default {
  fetch(request: Request): Promise<Response> {
    return handler.fetch(request);
  },
};
