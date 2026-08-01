import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import { connectClient } from "./harness.js";

describe("v2 harness smoke", () => {
  it("round-trips a tool call through a real v2 server", async () => {
    const mcp = new McpServer(
      { name: "smoke", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "greet",
      { description: "Greet", inputSchema: z.object({ name: z.string() }) },
      async (args: { name: string }) => ({
        content: [{ type: "text" as const, text: `Hello ${args.name}` }],
      }),
    );

    const client = await connectClient(mcp);
    const result = (await client.callTool({
      name: "greet",
      arguments: { name: "world" },
    })) as { content: Array<{ type: string; text?: string }> };

    expect(result.content[0]?.text).toBe("Hello world");
    await client.close();
  });
});
