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
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
  AGENTCAT_TAG_SESSION_SOURCE,
} from "../modules/constants.js";

// Tool-call events now always carry SDK-owned handle tags, merged AFTER the
// customer's tags. These helpers split the two halves so the customer-tag
// assertions stay exact rather than being loosened to toMatchObject.
const SDK_TAG_KEYS = [
  AGENTCAT_TAG_SESSION_SOURCE,
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
];

function customerTags(
  tags: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...(tags ?? {}) };
  for (const key of SDK_TAG_KEYS) delete out[key];
  return out;
}

function sdkTags(
  tags: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SDK_TAG_KEYS) {
    if (tags && key in tags) out[key] = tags[key];
  }
  return out;
}

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
        enableAgentTracking: true,
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
            arguments: {
              text: "Test todo",
              agent_id: "opus-4.80-1m|claude-code|k3n9x",
            },
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
      expect(customerTags(toolCallEvent!.tags)).toEqual({
        env: "test",
        trace_id: "abc-123",
      });
      // SDK handle tags ride alongside the customer's, never replacing them.
      expect(toolCallEvent!.tags![AGENTCAT_TAG_SESSION_SOURCE]).toBe("minted");
      expect(toolCallEvent!.tags![AGENTCAT_TAG_AGENT_SOURCE]).toBe("supplied");
      expect(toolCallEvent!.tags![AGENTCAT_TAG_AGENT_ID]).toBe(
        "opus-4.80-1m|claude-code|k3n9x",
      );
    });

    it("should overwrite a customer tag that collides with an SDK tag name", async () => {
      track(server, "test-project", {
        eventTags: async () => ({
          [AGENTCAT_TAG_SESSION_SOURCE]: "customer-value",
          env: "test",
        }),
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "Test todo", session_id: "ses_supplied" },
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
      // SDK tags are merged last, so ours wins the collision.
      expect(toolCallEvent!.tags![AGENTCAT_TAG_SESSION_SOURCE]).toBe(
        "supplied",
      );
      // Non-colliding customer tags survive untouched.
      expect(customerTags(toolCallEvent!.tags)).toEqual({ env: "test" });
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
      // When the callback throws, resolveEventTags returns null, so no customer
      // tags land on the event — only the SDK's own handle tags remain.
      expect(customerTags(toolCallEvent!.tags)).toEqual({});
      expect(sdkTags(toolCallEvent!.tags)).toHaveProperty(
        AGENTCAT_TAG_SESSION_SOURCE,
      );
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
      expect(customerTags(toolCallEvent!.tags)).toEqual({});
      expect(sdkTags(toolCallEvent!.tags)).toHaveProperty(
        AGENTCAT_TAG_SESSION_SOURCE,
      );
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
      expect(customerTags(toolCallEvent!.tags)).toEqual({ valid: "value" });
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
      expect(customerTags(toolCallEvent!.tags)).toEqual({ env: "test" });
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
      // No customer callbacks means no customer tags; the SDK handle tags are
      // unconditional and always present.
      expect(customerTags(toolCallEvent!.tags)).toEqual({});
      expect(sdkTags(toolCallEvent!.tags)).toHaveProperty(
        AGENTCAT_TAG_SESSION_SOURCE,
      );
      expect(toolCallEvent!.properties).toBeUndefined();
    });
  });

  describe("initialize is no longer an event", () => {
    it("publishes no initialize event even when tag/property callbacks are set", async () => {
      // AgentCat no longer wraps the initialize handler at all. Track BEFORE
      // connecting — the strongest possible setup for an initialize event to
      // appear — and assert none is published.
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
      expect(initEvent).toBeUndefined();

      await clientTransport.close?.();
      await serverTransport.close?.();
    });
  });

  describe("tools/list is no longer an event", () => {
    it("publishes no tools/list event even when tag/property callbacks are set", async () => {
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
      expect(listEvent).toBeUndefined();
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
      expect(customerTags(toolCallEvent!.tags)).toEqual({
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
