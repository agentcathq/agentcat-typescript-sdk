import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory";
import { track, publishCustomEvent } from "../index";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types";
import { EventCapture } from "./test-utils";
import { HighLevelMCPServerLike } from "../types";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";

/**
 * Every auto-captured tool call now also carries AgentCat's own namespaced
 * handle tags. This file is about the CUSTOMER's tags, so it asserts on the
 * customer's slice exactly — and `expectHandleTags` separately pins that the
 * namespaced ones really are there, so the filter can never hide their loss.
 */
const customerTags = (event: { tags?: Record<string, string> | null }) => {
  const tags = { ...(event.tags ?? {}) };
  for (const key of Object.keys(tags)) {
    if (key.startsWith("agentcat_")) delete tags[key];
  }
  return tags;
};

const expectHandleTags = (event: { tags?: Record<string, string> | null }) => {
  expect(event.tags!.agentcat_task_id_source).toBeDefined();
  expect(event.tags!.agentcat_agent_id).toMatch(/^agt_/);
};

describe("Event Tags & Properties", () => {
  let server: HighLevelMCPServerLike;
  let client: any;
  let cleanup: () => Promise<void>;
  let eventCapture: EventCapture;

  beforeEach(async () => {
    resetTodos();
    const setup = await setupTestServerAndClient();
    server = setup.server;
    client = setup.client;
    cleanup = setup.cleanup;
    eventCapture = new EventCapture();
    await eventCapture.start();
  });

  afterEach(async () => {
    await eventCapture.stop();
    await cleanup();
  });

  describe("eventTags callback", () => {
    it("should attach tags to tool call events", async () => {
      track(server, "test-project", {
        eventTags: async () => ({
          env: "test",
          trace_id: "abc-123",
        }),
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(customerTags(toolCallEvent!)).toEqual({
        env: "test",
        trace_id: "abc-123",
      });
      expectHandleTags(toolCallEvent!);
    });

    it("should not block tool calls when callback throws", async () => {
      track(server, "test-project", {
        eventTags: async () => {
          throw new Error("Tags callback failed");
        },
      });

      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain("Added todo");

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      // When the callback throws, resolveEventTags returns null and no
      // customer tag is written — only AgentCat's own handle tags remain.
      expect(customerTags(toolCallEvent!)).toEqual({});
      expectHandleTags(toolCallEvent!);
    });

    it("should handle null return from callback", async () => {
      track(server, "test-project", {
        eventTags: async () => null,
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(customerTags(toolCallEvent!)).toEqual({});
      expectHandleTags(toolCallEvent!);
    });

    it("should validate tags from callback", async () => {
      track(server, "test-project", {
        eventTags: async () => ({
          valid: "value",
          "invalid!": "value",
        }),
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(customerTags(toolCallEvent!)).toEqual({ valid: "value" });
      expectHandleTags(toolCallEvent!);
    });
  });

  describe("eventProperties callback", () => {
    it("should attach properties to tool call events", async () => {
      track(server, "test-project", {
        eventProperties: async () => ({
          device: "desktop",
          feature_flags: ["dark_mode"],
          nested: { key: "value" },
        }),
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent!.properties).toEqual({
        device: "desktop",
        feature_flags: ["dark_mode"],
        nested: { key: "value" },
      });
    });

    it("should not block tool calls when callback throws", async () => {
      track(server, "test-project", {
        eventProperties: async () => {
          throw new Error("Properties callback failed");
        },
      });

      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain("Added todo");
    });

    it("should handle null return from callback", async () => {
      track(server, "test-project", {
        eventProperties: async () => null,
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent!.properties).toBeUndefined();
    });
  });

  describe("both callbacks configured", () => {
    it("should attach both tags and properties to the same event", async () => {
      track(server, "test-project", {
        eventTags: async () => ({ env: "test" }),
        eventProperties: async () => ({ device: "mobile" }),
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(customerTags(toolCallEvent!)).toEqual({ env: "test" });
      expectHandleTags(toolCallEvent!);
      expect(toolCallEvent!.properties).toEqual({ device: "mobile" });
    });
  });

  describe("publishCustomEvent", () => {
    it("should include tags and properties passed directly", async () => {
      track(server, "test-project", {});

      await publishCustomEvent(server, "test-project", {
        resourceName: "custom-action",
        tags: { env: "production", trace_id: "xyz" },
        properties: { device: "mobile", feature_flags: ["beta"] },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const customEvent = events.find(
        (e) => e.resourceName === "custom-action",
      );
      expect(customEvent).toBeDefined();
      expect(customEvent!.tags).toEqual({ env: "production", trace_id: "xyz" });
      expect(customEvent!.properties).toEqual({
        device: "mobile",
        feature_flags: ["beta"],
      });
    });

    it("should validate tags passed directly", async () => {
      track(server, "test-project", {});

      await publishCustomEvent(server, "test-project", {
        resourceName: "custom-action",
        tags: { valid: "value", "bad!key": "value" },
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const customEvent = events.find(
        (e) => e.resourceName === "custom-action",
      );
      expect(customEvent!.tags).toEqual({ valid: "value" });
    });

    it("should normalize empty properties to omission", async () => {
      track(server, "test-project", {});

      await publishCustomEvent(server, "test-project", {
        resourceName: "custom-action",
        properties: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const customEvent = events.find(
        (e) => e.resourceName === "custom-action",
      );
      expect(customEvent!.properties).toBeUndefined();
    });
  });

  describe("no callbacks configured", () => {
    it("should not add tags or properties when not configured", async () => {
      track(server, "test-project", {});

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      // No customer tags at all — only AgentCat's own handle tags.
      expect(customerTags(toolCallEvent!)).toEqual({});
      expectHandleTags(toolCallEvent!);
      expect(toolCallEvent!.properties).toBeUndefined();
    });
  });

  describe("tags/properties when track() runs before the client connects", () => {
    // `initialize` is no longer intercepted, so there is no initialize event to
    // assert on. The track()-before-connect ordering is still worth covering —
    // the shared fixture connects first — so this now drives a tool call and
    // asserts tags/properties resolve on the mcp:tools/call event.
    it("should attach tags and properties to tool call events", async () => {
      // Create a fresh server/client pair without auto-connect
      const { McpServer } =
        await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { Client } =
        await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } =
        await import("@modelcontextprotocol/sdk/inMemory.js");
      const { z } = await import("zod");

      const freshServer = new McpServer({
        name: "test server",
        version: "1.0",
      });
      freshServer.tool(
        "test_tool",
        "A test tool",
        { input: z.string() },
        async (args) => ({
          content: [{ type: "text", text: `Got: ${args.input}` }],
        }),
      );

      // Track BEFORE connecting
      track(freshServer, "test-project", {
        eventTags: async () => ({ env: "test", source: "init" }),
        eventProperties: async () => ({ device: "desktop" }),
      });

      const freshClient = new Client(
        { name: "test client", version: "1.0" },
        { capabilities: {} },
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();

      await Promise.all([
        freshClient.connect(clientTransport),
        freshServer.server.connect(serverTransport),
      ]);

      await freshClient.callTool({
        name: "test_tool",
        arguments: { input: "hi" },
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(customerTags(toolCallEvent!)).toEqual({
        env: "test",
        source: "init",
      });
      expectHandleTags(toolCallEvent!);
      expect(toolCallEvent!.properties).toEqual({ device: "desktop" });

      await clientTransport.close?.();
      await serverTransport.close?.();
    });
  });

  describe("tags/properties after a tools/list round-trip", () => {
    // tools/list no longer publishes an event of its own; what still matters is
    // that the list wrapper leaves tag/property resolution on the following
    // tool call intact.
    it("should attach tags and properties to the tool call that follows", async () => {
      track(server, "test-project", {
        eventTags: async () => ({ env: "test", action: "list" }),
        eventProperties: async () => ({ source: "list-test" }),
      });

      const { ListToolsResultSchema } =
        await import("@modelcontextprotocol/sdk/types.js");
      await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );
      await client.request(
        {
          method: "tools/call",
          params: { name: "add_todo", arguments: { text: "Test todo" } },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      expect(
        events.find(
          (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsList,
        ),
      ).toBeUndefined();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(customerTags(toolCallEvent!)).toEqual({
        env: "test",
        action: "list",
      });
      expectHandleTags(toolCallEvent!);
      expect(toolCallEvent!.properties).toEqual({ source: "list-test" });
    });
  });

  describe("redaction bypass", () => {
    it("should not redact tags or properties when redactSensitiveInformation is configured", async () => {
      track(server, "test-project", {
        redactSensitiveInformation: async () => "[REDACTED]",
        eventTags: async () => ({
          env: "production",
          trace_id: "abc-123",
        }),
        eventProperties: async () => ({
          device: "desktop",
          app_version: "2.1.0",
          feature_flags: ["dark_mode", "beta_ui"],
        }),
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 100));
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      // Tags should NOT be redacted — customer explicitly provides this data
      expect(customerTags(toolCallEvent!)).toEqual({
        env: "production",
        trace_id: "abc-123",
      });
      expectHandleTags(toolCallEvent!);
      // Properties should NOT be redacted
      expect(toolCallEvent!.properties).toEqual({
        device: "desktop",
        app_version: "2.1.0",
        feature_flags: ["dark_mode", "beta_ui"],
      });
    });
  });

  describe("callback receives correct arguments", () => {
    it("should pass request and extra to eventTags callback", async () => {
      let capturedRequest: any;
      let capturedExtra: any;

      track(server, "test-project", {
        eventTags: async (request, extra) => {
          capturedRequest = request;
          capturedExtra = extra;
          return { env: "test" };
        },
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Callback args test" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.params?.name).toBe("add_todo");
      expect(capturedRequest.params?.arguments?.text).toBe(
        "Callback args test",
      );
      expect(capturedExtra).toBeDefined();
    });

    it("should pass request and extra to eventProperties callback", async () => {
      let capturedRequest: any;
      let capturedExtra: any;

      track(server, "test-project", {
        eventProperties: async (request, extra) => {
          capturedRequest = request;
          capturedExtra = extra;
          return { device: "test" };
        },
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Props callback args test" },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.params?.name).toBe("add_todo");
      expect(capturedExtra).toBeDefined();
    });
  });
});
