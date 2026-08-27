import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { EventCapture, sid } from "../test-utils.js";
import { AgentCatOptions } from "../../types.js";
import { AGENTCAT_CUSTOM_EVENT_TYPE } from "../../modules/constants.js";

// The event pipeline (redact → sanitize → truncate) mutates queued events in
// place asynchronously after add(); give it a beat before asserting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("v2 pipeline: redactSensitiveInformation on captured events", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("applies the string-redaction hook to a v2-captured event", async () => {
    const mcp = new McpServer(
      { name: "v2-pipeline", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "leaky",
      { description: "Leaks", inputSchema: z.object({ query: z.string() }) },
      async (args: { query: string }) => ({
        content: [
          {
            type: "text" as const,
            text: `result for ${args.query}: secret-sauce`,
          },
        ],
      }),
    );
    agentcat.track(mcp, "proj_test", {
      redactSensitiveInformation: async (text) =>
        text.replace(/secret-sauce/g, "[REDACTED]"),
    });
    const client = await connectClient(mcp);
    await client.listTools();

    await client.callTool({
      name: "leaky",
      arguments: {
        query: "find the secret-sauce",
        context: "pipeline redaction test",
        session_id: sid("redact"),
      },
    });
    await settle();

    const [event] = capture.getEvents();
    const responseText = (event.response as any).content[0].text;
    expect(responseText).toContain("[REDACTED]");
    expect(responseText).not.toContain("secret-sauce");
    // Parameters pass through the same hook.
    const argsOnEvent = (event.parameters as any).request.params.arguments;
    expect(argsOnEvent.query).toBe("find the [REDACTED]");
    // Protected fields survive redaction untouched.
    expect(event.sessionId).toBe(sid("redact"));
    expect(event.resourceName).toBe("leaky");
    await client.close();
  });

  it("sanitizes image content blocks in v2 tool responses", async () => {
    const mcp = new McpServer(
      { name: "v2-pipeline", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "get_attachment",
      { description: "Attachment", inputSchema: z.object({ id: z.string() }) },
      async () => ({
        content: [
          { type: "text" as const, text: "Here is the attachment:" },
          {
            type: "image" as const,
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ",
            mimeType: "image/png",
          },
        ],
      }),
    );
    agentcat.track(mcp, "proj_test");
    const client = await connectClient(mcp);
    await client.listTools();

    await client.callTool({
      name: "get_attachment",
      arguments: { id: "att_1", context: "sanitization test" },
    });
    await settle();

    const [event] = capture.getEvents();
    const content = (event.response as any).content;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "text",
      text: "Here is the attachment:",
    });
    expect(content[1]).toEqual({
      type: "text",
      text: "[image content redacted - not supported by AgentCat]",
    });
    await client.close();
  });
});

describe("v2 pipeline: publishCustomEvent", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  async function trackedServer(trackOptions: AgentCatOptions = {}) {
    const mcp = new McpServer(
      { name: "v2-custom-events", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "noop",
      { description: "Noop", inputSchema: z.object({}) },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    agentcat.track(mcp, "proj_test", trackOptions);
    return mcp;
  }

  it("queues a custom event on a v2-tracked server with sessionId attribution", async () => {
    const mcp = await trackedServer();

    await agentcat.publishCustomEvent(mcp, "proj_test", {
      sessionId: "ses_custom000000000000000000000",
      resourceName: "custom-action",
      parameters: { action: "test" },
      message: "Testing custom event",
    });

    const events = capture.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(AGENTCAT_CUSTOM_EVENT_TYPE);
    expect(events[0].sessionId).toBe("ses_custom000000000000000000000");
    expect(events[0].projectId).toBe("proj_test");
    expect(events[0].resourceName).toBe("custom-action");
    expect(events[0].parameters).toEqual({ action: "test" });
    expect(events[0].userIntent).toBe("Testing custom event"); // message maps to userIntent
  });

  it("validates tags and normalizes empty properties on direct custom events", async () => {
    const mcp = await trackedServer();

    await agentcat.publishCustomEvent(mcp, "proj_test", {
      sessionId: "ses_custom000000000000000000000",
      resourceName: "custom-action",
      tags: { valid: "value", "bad!key": "value" },
      properties: {},
    });

    const [event] = capture.getEvents();
    expect(event.tags).toEqual({ valid: "value" });
    expect(event.properties).toBeUndefined();
  });

  it("publishes without a session when a tracked server gets no sessionId", async () => {
    const mcp = await trackedServer();

    await agentcat.publishCustomEvent(mcp, "proj_test", {
      resourceName: "sessionless-action",
    });

    const [event] = capture.getEvents();
    expect(event.resourceName).toBe("sessionless-action");
    expect(event.sessionId).toBe(""); // wire: stateless — server assigns
  });

  it("uses a session ID string verbatim as the session, carrying full event data", async () => {
    await agentcat.publishCustomEvent("user-session-12345", "proj_test", {
      resourceName: "full-test",
      parameters: { key: "value" },
      response: { result: "success" },
      message: "Complete test",
      duration: 1500,
      properties: { device: "mobile", feature_flags: ["beta"] },
      tags: { env: "production" },
    });

    const [event] = capture.getEvents();
    expect(event.eventType).toBe(AGENTCAT_CUSTOM_EVENT_TYPE);
    expect(event.sessionId).toBe("user-session-12345"); // verbatim, never derived
    expect(event.resourceName).toBe("full-test");
    expect(event.parameters).toEqual({ key: "value" });
    expect(event.response).toEqual({ result: "success" });
    expect(event.userIntent).toBe("Complete test"); // message maps to userIntent
    expect(event.duration).toBe(1500);
    expect(event.tags).toEqual({ env: "production" });
    expect(event.properties).toEqual({
      device: "mobile",
      feature_flags: ["beta"],
    });
  });

  it("lets eventData.sessionId take precedence over the session ID string", async () => {
    await agentcat.publishCustomEvent("ignored-string", "proj_test", {
      sessionId: "ses_wins00000000000000000000000",
    });

    const [event] = capture.getEvents();
    expect(event.sessionId).toBe("ses_wins00000000000000000000000");
  });

  it("throws for an untracked v2 server", async () => {
    const untracked = new McpServer(
      { name: "v2-untracked", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    await expect(
      agentcat.publishCustomEvent(untracked, "proj_test", {
        resourceName: "custom-action",
      }),
    ).rejects.toThrow("Server is not tracked");
    expect(capture.getEvents()).toHaveLength(0);
  });

  it("validates its required parameters", async () => {
    await expect(agentcat.publishCustomEvent("session-id", "")).rejects.toThrow(
      "projectId is required",
    );
    await expect(
      agentcat.publishCustomEvent(123 as any, "proj_test"),
    ).rejects.toThrow(
      "First parameter must be either an MCP server object or a session ID string",
    );
    await expect(
      agentcat.publishCustomEvent(null as any, "proj_test"),
    ).rejects.toThrow(
      "First parameter must be either an MCP server object or a session ID string",
    );
    expect(capture.getEvents()).toHaveLength(0);
  });
});
