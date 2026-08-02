import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient, mintBackOf, handleFrom } from "./harness.js";
import { EventCapture, sid } from "../test-utils.js";
import { AgentCatOptions } from "../../types.js";
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_SESSION_SOURCE,
} from "../../modules/constants.js";

async function setupHighLevel(trackOptions: AgentCatOptions = {}) {
  const mcp = new McpServer(
    { name: "v2-session-modes", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.registerTool(
    "echo",
    { description: "Echo", inputSchema: z.object({ msg: z.string() }) },
    async (args: { msg: string }) => ({
      content: [{ type: "text" as const, text: `echo: ${args.msg}` }],
    }),
  );
  agentcat.track(mcp, "proj_test", trackOptions);
  const client = await connectClient(mcp);
  await client.listTools();
  return { mcp, client };
}

describe("v2 session modes: resolveSessionId hook", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("advertises no session_id param; agent_id stays available", async () => {
    const { client } = await setupHighLevel({
      resolveSessionId: () => "customer-correlation-7",
      enableAgentTracking: true,
    });
    const { tools } = await client.listTools();
    const echo = tools.find((t) => t.name === "echo")!;
    expect((echo.inputSchema as any).properties).not.toHaveProperty(
      "session_id",
    );
    expect((echo.inputSchema as any).properties).toHaveProperty("agent_id");
    expect((echo.inputSchema as any).required).toContain("agent_id");
    // get_more_tools follows the same policy — it publishes events too.
    const gmt = tools.find((t) => t.name === "get_more_tools")!;
    expect((gmt.inputSchema as any).properties).not.toHaveProperty(
      "session_id",
    );
    expect((gmt.inputSchema as any).properties).toHaveProperty("agent_id");
    await client.close();
  });

  it("derives a deterministic ses_ id: same hook value + project → same id across calls and instances", async () => {
    const { client } = await setupHighLevel({
      resolveSessionId: () => "customer-correlation-7",
    });
    await client.callTool({
      name: "echo",
      arguments: { msg: "one", context: "hook determinism" },
    });
    await client.callTool({
      name: "echo",
      arguments: { msg: "two", context: "hook determinism" },
    });
    const [first, second] = capture.getEvents();
    expect(first.sessionId).toMatch(/^ses_/);
    expect(first.sessionId).toBe(second.sessionId);
    expect(first.tags).toMatchObject({
      [AGENTCAT_TAG_SESSION_SOURCE]: "hook",
    });
    await client.close();

    // A completely fresh server instance with the same hook value and project
    // resolves the SAME session id — the derivation is stateless and stable.
    const { client: client2 } = await setupHighLevel({
      resolveSessionId: () => "customer-correlation-7",
    });
    await client2.callTool({
      name: "echo",
      arguments: { msg: "three", context: "hook determinism" },
    });
    const third = capture.getEvents()[2];
    expect(third.sessionId).toBe(first.sessionId);
    await client2.close();

    // A different hook value maps to a different task.
    const { client: client3 } = await setupHighLevel({
      resolveSessionId: () => "customer-correlation-8",
    });
    await client3.callTool({
      name: "echo",
      arguments: { msg: "four", context: "hook determinism" },
    });
    const fourth = capture.getEvents()[3];
    expect(fourth.sessionId).toMatch(/^ses_/);
    expect(fourth.sessionId).not.toBe(first.sessionId);
    await client3.close();
  });

  it("emits no mint-back in hook mode; a supplied agent_id is tagged as supplied", async () => {
    const { client } = await setupHighLevel({
      resolveSessionId: () => "customer-correlation-7",
      enableAgentTracking: true,
    });
    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        msg: "hi",
        context: "hook mint-back",
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });
    expect(mintBackOf(result)).toBeUndefined();
    const [event] = capture.getEvents();
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_AGENT_ID]: "opus-4.80-1m|claude-code|k3n9x",
      [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
    });
    await client.close();
  });

  it("hook mode + tracking on + omitted agent_id: no mint-back at all, no agent tags", async () => {
    const { client } = await setupHighLevel({
      resolveSessionId: () => "customer-correlation-7",
      enableAgentTracking: true,
    });
    const result: any = await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "hook, no agent supplied" },
    });
    expect(mintBackOf(result)).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    const [event] = capture.getEvents();
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
    expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_SOURCE);
    await client.close();
  });

  it("mints silently on hook null: fresh ses_ per call, minted source, no mint-back", async () => {
    const { client } = await setupHighLevel({
      resolveSessionId: () => null,
    });
    const first: any = await client.callTool({
      name: "echo",
      arguments: { msg: "one", context: "hook null" },
    });
    const second: any = await client.callTool({
      name: "echo",
      arguments: { msg: "two", context: "hook null" },
    });
    // The agent can never learn a silently minted id, so nothing is prompted.
    expect(mintBackOf(first)).toBeUndefined();
    expect(mintBackOf(second)).toBeUndefined();

    const events = capture.getEvents();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.sessionId).toMatch(/^ses_/);
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
      });
    }
    // One single-event task per null return — never a shared session.
    expect(events[0].sessionId).not.toBe(events[1].sessionId);
    await client.close();
  });
});

describe("v2 session modes: supplied vs minted (no hook)", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("tags a supplied session_id as supplied and reuses it verbatim, no mint-back", async () => {
    const { client } = await setupHighLevel();
    const result: any = await client.callTool({
      name: "echo",
      arguments: {
        msg: "hi",
        context: "supplied task",
        session_id: sid("fixed"),
      },
    });
    expect(mintBackOf(result)).toBeUndefined();
    const [event] = capture.getEvents();
    expect(event.sessionId).toBe(sid("fixed"));
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_SESSION_SOURCE]: "supplied",
    });
    await client.close();
  });

  it("mints on omission, announces the id, and tags the source as minted", async () => {
    const { client } = await setupHighLevel();
    const result: any = await client.callTool({
      name: "echo",
      arguments: { msg: "hi", context: "minted task" },
    });
    const block = mintBackOf(result)!;
    const sessionId = handleFrom(block, "session_id");
    expect(sessionId).toMatch(/^ses_/);
    const [event] = capture.getEvents();
    expect(event.sessionId).toBe(sessionId);
    expect(event.tags).toMatchObject({
      [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
    });
    await client.close();
  });
});
