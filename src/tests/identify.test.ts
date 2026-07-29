import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory";
import { track } from "../index";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types";
import { EventCapture } from "./test-utils";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { getServerTrackingData } from "../modules/internal";
import { HighLevelMCPServerLike, UserIdentity } from "../types";
import { randomUUID } from "node:crypto";
import { z } from "zod";

describe("Identify Feature", () => {
  let server: HighLevelMCPServerLike;
  let client: any;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    resetTodos();
    const setup = await setupTestServerAndClient();
    server = setup.server;
    client = setup.client;
    cleanup = setup.cleanup;
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("Basic Identification Test", () => {
    it("should call identify function on tool invocation and stamp the actor on the event", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      let identifyCalled = false;
      const testUserId = `user-${randomUUID()}`;
      const testUserData = {
        name: `Test User ${randomUUID()}`,
        email: `test-${randomUUID()}@example.com`,
      };

      // Enable tracking with identify function
      track(server, "test-project", {
        enableTracing: true,
        identify: async (request, extra) => {
          identifyCalled = true;
          expect(request).toBeDefined();
          expect(extra).toBeDefined();
          return {
            userId: testUserId,
            userData: testUserData,
          };
        },
      });

      // Call a tool - this should trigger identify
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Test todo for identification",
              context: "Adding a todo item for identification test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain("Added todo");
      expect(identifyCalled).toBe(true);

      // Wait for events to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The actor rides on the tool call event itself
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.resourceName).toBe("add_todo");
      expect(toolCallEvent?.identifyActorGivenId).toBe(testUserId);
      expect(toolCallEvent?.identifyActorData).toEqual(testUserData);

      await eventCapture.stop();
    });

    it("runs identify on every tool call and stamps the actor on each event", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      const calls: number[] = [];
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => {
          calls.push(1);
          return {
            userId: "user-1",
            userName: "Ada",
            userData: { plan: "pro" },
          };
        },
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "a", context: "c" },
          },
        },
        CallToolResultSchema,
      );
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "b", context: "c" },
          },
        },
        CallToolResultSchema,
      );
      await new Promise((r) => setTimeout(r, 50));

      expect(calls.length).toBe(2);
      const events = eventCapture
        .getEvents()
        .filter(
          (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
        );
      expect(events.length).toBe(2);
      for (const event of events) {
        expect(event.identifyActorGivenId).toBe("user-1");
        expect(event.identifyActorName).toBe("Ada");
        expect(event.identifyActorData).toEqual({ plan: "pro" });
      }

      await eventCapture.stop();
    });

    it("publishes no separate agentcat:identify event", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      track(server, "test-project", {
        enableTracing: true,
        identify: async () => ({ userId: "user-1" }),
      });
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: { text: "a", context: "c" },
          },
        },
        CallToolResultSchema,
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(eventCapture.findEventByType("agentcat:identify")).toBeUndefined();

      await eventCapture.stop();
    });

    it("should properly identify when calling tools added after track()", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      let identifyCalled = false;
      const testUserId = `post-track-user-${randomUUID()}`;
      const testUserData = {
        name: `Post Track User ${randomUUID()}`,
        email: `post-track-${randomUUID()}@example.com`,
      };

      // Enable tracking with identify function FIRST
      track(server, "test-project", {
        enableTracing: true,
        enableToolCallContext: true,
        identify: async (request, extra) => {
          identifyCalled = true;
          expect(request).toBeDefined();
          expect(extra).toBeDefined();
          return {
            userId: testUserId,
            userData: testUserData,
          };
        },
      });

      // Add a new tool AFTER track() has been called
      server.tool!(
        "post_track_tool",
        "A tool added after tracking was enabled",
        {
          message: z.string().describe("A message to process"),
        },
        async (args: any) => {
          return {
            content: [
              {
                type: "text",
                text: `Processed message: ${args.message}`,
              },
            ],
          };
        },
      );

      // Call the newly added tool - this should trigger identify
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "post_track_tool",
            arguments: {
              message: "Testing post-track identification",
              context:
                "Verifying identification works for dynamically added tools",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain(
        "Processed message: Testing post-track identification",
      );
      expect(identifyCalled).toBe(true);

      // Wait for events to be processed
      await new Promise((resolve) => setTimeout(resolve, 50));

      const events = eventCapture.getEvents();

      // Verify tool call event was tracked with user intent AND the actor
      const toolCallEvent = events.find(
        (e) =>
          e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall &&
          e.resourceName === "post_track_tool",
      );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.userIntent).toBe(
        "Verifying identification works for dynamically added tools",
      );
      expect(toolCallEvent?.identifyActorGivenId).toBe(testUserId);
      expect(toolCallEvent?.identifyActorData).toEqual(testUserData);

      await eventCapture.stop();
    });
  });

  describe("User Data Across Tool Calls", () => {
    it("should stamp the actor on every event across multiple tool calls", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      const testUserId = `persistent-user-${randomUUID()}`;
      const testUserData = {
        name: `Persistent User ${randomUUID()}`,
        department: "Engineering",
        customField: `custom-value-${randomUUID()}`,
      };

      // Enable tracking with identify function
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => ({
          userId: testUserId,
          userData: testUserData,
        }),
      });

      // Make multiple tool calls
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Todo 1",
              context: "Adding a todo item for reset task",
            },
          },
        },
        CallToolResultSchema,
      );

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Todo 2",
              context: "Adding a todo item for reset task",
            },
          },
        },
        CallToolResultSchema,
      );

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "list_todos",
            arguments: { context: "Listing todos for reset task" },
          },
        },
        CallToolResultSchema,
      );

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get all tool call events
      const events = eventCapture.getEvents();
      const toolCallEvents = events.filter(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvents.length).toBe(3);

      // Every event carries the actor - nothing is cached between requests
      for (const event of toolCallEvents) {
        expect(event.identifyActorGivenId).toBe(testUserId);
        expect(event.identifyActorData).toEqual(testUserData);
      }

      await eventCapture.stop();
    });
  });

  describe("Null/Undefined Identity Handling", () => {
    it("should handle when identify function returns null", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      // Enable tracking with identify function that returns null
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => null,
      });

      // Call a tool
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Test todo",
              context: "Adding a todo item for null identity test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain("Added todo");

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The tool call event publishes with no actor attached
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBeUndefined();
      expect(toolCallEvent?.identifyActorName).toBeUndefined();
      expect(toolCallEvent?.identifyActorData).toBeUndefined();

      await eventCapture.stop();
    });

    it("should work without identify function (anonymous sessions)", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      // Enable tracking WITHOUT identify function
      track(server, "test-project", {
        enableTracing: true,
        // No identify function provided
      });

      // Call tools
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Anonymous todo",
              context: "Adding a todo item for anonymous test",
            },
          },
        },
        CallToolResultSchema,
      );

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "list_todos",
            arguments: { context: "Listing todos for anonymous test" },
          },
        },
        CallToolResultSchema,
      );

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Verify tool events were published with session IDs and no actor
      const events = eventCapture.getEvents();
      const toolCallEvents = events.filter(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvents.length).toBe(2);
      toolCallEvents.forEach((event) => {
        expect(event.sessionId).toBeDefined();
        expect(event.sessionId).not.toBe("");
        expect(event.identifyActorGivenId).toBeUndefined();
      });

      await eventCapture.stop();
    });
  });

  describe("Identity Data on Events", () => {
    it("should populate actorGivenId, actorName, and actorData on the tool call event", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      const testUserId = `session-user-${randomUUID()}`;
      const testUserName = `Session User ${randomUUID()}`;
      const testUserData = {
        name: `Session Test User ${randomUUID()}`,
        role: "Developer",
        team: "Platform",
      };

      // Enable tracking with identify function
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => ({
          userId: testUserId,
          userName: testUserName,
          userData: testUserData,
        }),
      });

      // Call a tool to trigger identification
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Test session info",
              context: "Adding a todo item for session info test",
            },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      const toolCallEvent = eventCapture
        .getEvents()
        .find(
          (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
        );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBe(testUserId);
      expect(toolCallEvent?.identifyActorName).toBe(testUserName);
      expect(toolCallEvent?.identifyActorData).toEqual(testUserData);

      await eventCapture.stop();
    });

    it("should not leak identity onto session info", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      const testUserId = `event-user-${randomUUID()}`;

      track(server, "test-project", {
        enableTracing: true,
        identify: async () => ({
          userId: testUserId,
          userName: "Event User",
          userData: { subscription: "premium" },
        }),
      });

      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Test event data",
              context: "Adding a todo item for event data test",
            },
          },
        },
        CallToolResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Identity is per-request: it must never be stashed on shared session state
      const toolCallEvent = eventCapture
        .getEvents()
        .find(
          (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
        );
      expect(toolCallEvent?.identifyActorGivenId).toBe(testUserId);

      const data = getServerTrackingData(server.server);
      expect(data).toBeDefined();
      expect(Object.keys(data!.sessionInfo)).not.toContain(
        "identifyActorGivenId",
      );
      expect(Object.keys(data!.sessionInfo)).not.toContain("identifyActorName");
      expect(Object.keys(data!.sessionInfo)).not.toContain("identifyActorData");
      expect(data).not.toHaveProperty("identifiedSessions");

      await eventCapture.stop();
    });
  });

  describe("Async Identity Resolution", () => {
    it("should handle async operations in identify function", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      let asyncOperationCompleted = false;
      const asyncUserId = `async-user-${randomUUID()}`;

      // Enable tracking with async identify function
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => {
          // Simulate async operation (e.g., database lookup, API call)
          await new Promise((resolve) => setTimeout(resolve, 100));
          asyncOperationCompleted = true;

          return {
            userId: asyncUserId,
            userData: {
              name: `Async User ${randomUUID()}`,
              source: "async-lookup",
            },
          };
        },
      });

      // Call a tool
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Async test todo",
              context: "Adding a todo item for async test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain("Added todo");
      expect(asyncOperationCompleted).toBe(true);

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The tool call event waited on identify, so it has measurable duration
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBe(asyncUserId);
      expect(toolCallEvent?.duration).toBeGreaterThan(0);

      await eventCapture.stop();
    });

    it("should handle errors in identify function gracefully", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      const errorMessage = "Failed to identify user";

      // Enable tracking with identify function that throws
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => {
          throw new Error(errorMessage);
        },
      });

      // Call a tool - should not fail despite identify error
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Error test todo",
              context: "Adding a todo item for error test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain("Added todo");

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The tool call event still publishes, just without an actor
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBeUndefined();
      expect(toolCallEvent?.identifyActorName).toBeUndefined();
      expect(toolCallEvent?.identifyActorData).toBeUndefined();

      await eventCapture.stop();
    });

    it("should handle identify function that returns invalid data", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      // Enable tracking with identify function that returns invalid structure
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => {
          // Return invalid structure (missing required fields)
          return { invalidField: "invalid" } as any as UserIdentity;
        },
      });

      // Call a tool
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Invalid identity test",
              context: "Adding a todo item for invalid identity test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(result.content[0].text).toContain("Added todo");

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The system should handle this gracefully: the event publishes with
      // whatever the callback supplied, which here means no actor fields.
      const events = eventCapture.getEvents();
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBeUndefined();
      expect(toolCallEvent?.identifyActorName).toBeUndefined();

      await eventCapture.stop();
    });
  });
});
