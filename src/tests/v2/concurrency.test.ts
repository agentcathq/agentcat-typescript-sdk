import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { EventCapture } from "../test-utils.js";
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_TASK_SOURCE,
} from "../../modules/constants.js";

describe("v2 concurrent tool calls do not clobber each other's attribution", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("each event keeps its own task_id, agent_id, and actor under interleaving", async () => {
    const mcp = new McpServer(
      { name: "v2-concurrent", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "slow_echo",
      {
        description: "echoes slowly",
        inputSchema: z.object({ text: z.string(), delay_ms: z.number() }),
      },
      async (args: { text: string; delay_ms: number }) => {
        await new Promise((r) => setTimeout(r, args.delay_ms));
        return { content: [{ type: "text" as const, text: args.text }] };
      },
    );
    agentcat.track(mcp, "proj_test", {
      enableAgentTracking: true,
      // Identity derives from the request, so cross-contamination is visible.
      identify: async (request) => ({
        userId: `actor-${(request as any).params?.arguments?.text}`,
      }),
    });
    const client = await connectClient(mcp);
    await client.listTools();

    const calls = [
      { text: "A", delay_ms: 120, task_id: "ses_task_A", agent_id: "agt_A" },
      { text: "B", delay_ms: 40, task_id: "ses_task_B", agent_id: "agt_B" },
      { text: "C", delay_ms: 80, task_id: "ses_task_C", agent_id: "agt_C" },
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
      expect(event).toBeDefined();
      expect(event.sessionId).toBe(c.task_id);
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_TASK_SOURCE]: "supplied",
        [AGENTCAT_TAG_AGENT_ID]: c.agent_id,
      });
      expect(event.identifyActorGivenId).toBe(`actor-${c.text}`);
    }
    await client.close();
  });
});
