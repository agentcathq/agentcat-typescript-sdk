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
      expect(toolCallEvent!.tags).toEqual({ env: "test", trace_id: "abc-123" });
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
      // When callback throws, resolveEventTags returns null, and conditional assignment means field stays undefined
      expect(toolCallEvent!.tags).toBeUndefined();
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
      expect(toolCallEvent!.tags).toBeUndefined();
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
      expect(toolCallEvent!.tags).toEqual({ valid: "value" });
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
      expect(toolCallEvent!.tags).toEqual({ env: "test" });
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
      expect(toolCallEvent!.tags).toBeUndefined();
      expect(toolCallEvent!.properties).toBeUndefined();
    });
  });

  describe("tags/properties on initialize event", () => {
    it("should attach tags and properties to initialize events", async () => {
      // track() must be called BEFORE connecting so that the initialize handler is wrapped
      // setupTestServerAndClient connects automatically, so we need a fresh setup
      // The initialize event fires during client.connect(), which already happened.
      // But the initialize handler IS wrapped — we just need to trigger a new connection.
      // Since the test factory already connected, let's verify via a reconnection approach.
      // Actually: the initialize event was already emitted during beforeEach setup.
      // We need to set up tracking BEFORE the client connects.

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

      // Connect triggers the initialize event
      await Promise.all([
        freshClient.connect(clientTransport),
        freshServer.server.connect(serverTransport),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const events = eventCapture.getEvents();
      const initEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpInitialize,
      );
      expect(initEvent).toBeDefined();
      expect(initEvent!.tags).toEqual({ env: "test", source: "init" });
      expect(initEvent!.properties).toEqual({ device: "desktop" });

      await clientTransport.close?.();
      await serverTransport.close?.();
    });
  });

  describe("tags/properties on tools/list event", () => {
    it("should attach tags and properties to tools/list events", async () => {
      track(server, "test-project", {
        eventTags: async () => ({ env: "test", action: "list" }),
        eventProperties: async () => ({ source: "list-test" }),
      });

      // Trigger a tools/list request
      const { ListToolsResultSchema } =
        await import("@modelcontextprotocol/sdk/types.js");
      await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();
      const listEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsList,
      );
      expect(listEvent).toBeDefined();
      expect(listEvent!.tags).toEqual({ env: "test", action: "list" });
      expect(listEvent!.properties).toEqual({ source: "list-test" });
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
      expect(toolCallEvent!.tags).toEqual({
        env: "production",
        trace_id: "abc-123",
      });
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
