import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { track } from "../index.js";
import { EventCapture, setupTestHooks } from "./test-utils.js";

setupTestHooks();

describe("concurrent tool calls do not clobber each other's attribution", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("each event keeps its own session_id, agent_id, and actor under interleaving", async () => {
    const server = new McpServer({ name: "concurrent server", version: "1.0" });
    server.tool(
      "slow_echo",
      "echoes slowly",
      { text: z.string(), delay_ms: z.number() },
      async (args) => {
        await new Promise((r) => setTimeout(r, args.delay_ms));
        return { content: [{ type: "text", text: args.text }] };
      },
    );
    track(server, "proj_test", {
      enableAgentTracking: true,
      // Identity derives from the request, so cross-contamination is visible.
      identify: async (request) => ({
        userId: `actor-${request.params?.arguments?.text}`,
      }),
    });
    const client = new Client({ name: "test client", version: "1.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.server.connect(st)]);
    await client.listTools();

    const calls = [
      {
        text: "A",
        delay_ms: 120,
        session_id: "ses_session_A",
        agent_id: "agt_A",
      },
      {
        text: "B",
        delay_ms: 40,
        session_id: "ses_session_B",
        agent_id: "agt_B",
      },
      {
        text: "C",
        delay_ms: 80,
        session_id: "ses_session_C",
        agent_id: "agt_C",
      },
    ];
    await Promise.all(
      calls.map((c) =>
        client.callTool({
          name: "slow_echo",
          arguments: { ...c, context: "concurrency regression test" },
        }),
      ),
    );

    const events = capture
      .getEvents()
      .filter((e) => e.eventType === "mcp:tools/call");
    expect(events).toHaveLength(3);
    for (const c of calls) {
      const event = events.find(
        (e) => (e.parameters as any).request.params.arguments.text === c.text,
      )!;
      expect(event.sessionId).toBe(c.session_id);
      expect(event.tags).toMatchObject({ agentcat_agent_id: c.agent_id });
      expect(event.identifyActorGivenId).toBe(`actor-${c.text}`);
    }
    await ct.close?.();
    await st.close?.();
  });
});
