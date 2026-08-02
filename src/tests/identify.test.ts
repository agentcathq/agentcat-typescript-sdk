import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory";
import { track } from "../index";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types";
import { EventCapture, sid } from "./test-utils";
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
    it("should call identify on the tool call and stamp the identity onto that event", async () => {
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

      // No separate identify event exists any more — the resolved identity is
      // stamped directly onto the tool call event it belongs to.
      const events = eventCapture.getEvents();
      expect(
        events.some(
          (e) =>
            e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
        ),
      ).toBe(false);

      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.resourceName).toBe("add_todo");
      expect(toolCallEvent?.identifyActorGivenId).toBe(testUserId);
      expect(toolCallEvent?.identifyActorData).toEqual(testUserData);

      // Nothing is cached on the server: the tracking data is config only —
      // no session id, no identity map, no session info.
      const data = getServerTrackingData(server.server);
      expect(data).toBeDefined();
      expect(Object.keys(data!).sort()).toEqual(["options", "projectId"]);

      await eventCapture.stop();
    });

    it("should call identify on every tool call and stamp every event, with no dedup", async () => {
      let identifyCallCount = 0;
      const userId = `user-${randomUUID()}`;
      const userName = `Another User ${randomUUID()}`;

      const eventCapture = new EventCapture();
      await eventCapture.start();

      // Enable tracking with identify function
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => {
          identifyCallCount++;
          return {
            userId: userId,
            userData: { name: userName },
          };
        },
      });

      // First tool call - identify runs and stamps this call's event
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "First todo",
              context: "Adding a todo item for identification test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(identifyCallCount).toBe(1);

      // Second tool call - identify runs AGAIN; there is no dedup cache
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "list_todos",
            arguments: {
              context: "Adding a todo item for identification test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(identifyCallCount).toBe(2); // Called again

      // Third tool call - identify runs a third time
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "complete_todo",
            arguments: {
              id: "1",
              context: "Completing a todo item for identification test",
            },
          },
        },
        CallToolResultSchema,
      );

      expect(identifyCallCount).toBe(3); // Called again

      await new Promise((resolve) => setTimeout(resolve, 50));
      const events = eventCapture.getEvents();

      // Zero identify events — the event type is gone entirely.
      expect(
        events.filter(
          (e) =>
            e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
        ),
      ).toHaveLength(0);

      // Instead, EVERY tool call event carries the resolved identity.
      const toolCallEvents = events.filter(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvents).toHaveLength(3);
      for (const event of toolCallEvents) {
        expect(event.identifyActorGivenId).toBe(userId);
        expect(event.identifyActorData).toEqual({ name: userName });
      }

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
      server.tool(
        "post_track_tool",
        "A tool added after tracking was enabled",
        {
          message: z.string().describe("A message to process"),
        },
        async (args) => {
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

      // No identify event; the identity lands on the tool call event instead.
      expect(
        events.some(
          (e) =>
            e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
        ),
      ).toBe(false);

      // Verify tool call event was tracked with user intent AND the identity
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

  describe("User Data Persistence Across Tool Calls", () => {
    it("should maintain user identification across multiple tool calls", async () => {
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

      // The agent echoes one session_id across the whole workflow — that, not any
      // server-side cache, is what keeps these calls on the same task now.
      const sessionId = sid("identify_persistence");

      // Make multiple tool calls
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "add_todo",
            arguments: {
              text: "Todo 1",
              context: "Adding a todo item for reset task",
              session_id: sessionId,
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
              session_id: sessionId,
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
            arguments: {
              context: "Listing todos for reset task",
              session_id: sessionId,
            },
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

      // Verify all events landed on the supplied task
      expect(toolCallEvents.length).toBe(3);
      const sessionIds = toolCallEvents.map((e) => e.sessionId);
      expect(new Set(sessionIds)).toEqual(new Set([sessionId]));

      // Verify the identity is re-resolved and stamped on every one of them
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

      const events = eventCapture.getEvents();
      const identifyEvent = events.find(
        (e) =>
          e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
      );

      expect(identifyEvent).toBeUndefined();

      // The tool call event still publishes, just anonymously.
      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBeUndefined();
      expect(toolCallEvent?.identifyActorName).toBeUndefined();
      expect(toolCallEvent?.identifyActorData).toEqual({});

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

      // Verify tool events were published with session IDs
      const events = eventCapture.getEvents();
      const toolCallEvents = events.filter(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );

      expect(toolCallEvents.length).toBe(2);
      toolCallEvents.forEach((event) => {
        expect(event.sessionId).toBeDefined();
        expect(event.sessionId).not.toBe("");
      });

      // Verify no identify events were published
      const identifyEvent = events.find(
        (e) =>
          e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
      );
      expect(identifyEvent).toBeUndefined();

      await eventCapture.stop();
    });
  });

  describe("Identity Data on Published Events", () => {
    it("should populate actorGivenId, actorName, and actorData on the event", async () => {
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

      // Session info is built per event now — the server holds config only,
      // so there is nothing cached to read it from.
      const data = getServerTrackingData(server.server);
      expect(data).toBeDefined();
      expect(Object.keys(data!).sort()).toEqual(["options", "projectId"]);

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

    it("should re-resolve identity per request so a changed identity lands on the next event", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      const firstUserId = `event-user-a-${randomUUID()}`;
      const secondUserId = `event-user-b-${randomUUID()}`;
      const identities = [
        { userId: firstUserId, userName: "First", userData: { seat: "a" } },
        { userId: secondUserId, userName: "Second", userData: { seat: "b" } },
      ];
      let call = 0;

      // The old dedup cache would have suppressed the second identity entirely.
      track(server, "test-project", {
        enableTracing: true,
        identify: async () => identities[call++],
      });

      for (const text of ["First call", "Second call"]) {
        await client.request(
          {
            method: "tools/call",
            params: {
              name: "add_todo",
              arguments: {
                text,
                context: "Adding a todo item for event data test",
              },
            },
          },
          CallToolResultSchema,
        );
      }

      // Wait for events
      await new Promise((resolve) => setTimeout(resolve, 50));

      const toolCallEvents = eventCapture
        .getEvents()
        .filter(
          (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
        );

      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0].identifyActorGivenId).toBe(firstUserId);
      expect(toolCallEvents[0].identifyActorName).toBe("First");
      expect(toolCallEvents[0].identifyActorData).toEqual({ seat: "a" });
      expect(toolCallEvents[1].identifyActorGivenId).toBe(secondUserId);
      expect(toolCallEvents[1].identifyActorName).toBe("Second");
      expect(toolCallEvents[1].identifyActorData).toEqual({ seat: "b" });

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
            userData: { source: "async-lookup" },
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

      // The awaited identity lands on the tool call event, and the call is
      // held open for it — so the event's duration covers the async lookup.
      const toolCallEvent = eventCapture
        .getEvents()
        .find(
          (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
        );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBe(asyncUserId);
      expect(toolCallEvent?.identifyActorData).toEqual({
        source: "async-lookup",
      });
      // 95, not 100: setTimeout can fire ~1ms early and Date truncates to ms.
      expect(toolCallEvent?.duration).toBeGreaterThanOrEqual(95);

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

      // A throwing identify degrades to anonymous: the tool call event still
      // publishes, just with no actor fields.
      const events = eventCapture.getEvents();
      const identifyEvent = events.find(
        (e) =>
          e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
      );

      expect(identifyEvent).toBeUndefined();

      const toolCallEvent = events.find(
        (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
      );
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBeUndefined();
      expect(toolCallEvent?.identifyActorName).toBeUndefined();
      expect(toolCallEvent?.identifyActorData).toEqual({});

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

      // The system should handle this gracefully: the event publishes, and the
      // fields the invalid identity did not supply simply come out empty.
      const toolCallEvent = eventCapture
        .getEvents()
        .find(
          (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
        );

      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent?.identifyActorGivenId).toBeUndefined();
      expect(toolCallEvent?.identifyActorName).toBeUndefined();
      expect(toolCallEvent?.identifyActorData).toEqual({});

      await eventCapture.stop();
    });
  });

  describe("tools/list no longer identifies or publishes", () => {
    it("should not run identify or publish an event for a tools/list request", async () => {
      const eventCapture = new EventCapture();
      await eventCapture.start();

      let identifyCalled = false;
      const testUserId = `list-tools-user-${randomUUID()}`;
      const testUserName = `List Tools User ${randomUUID()}`;
      const testUserData = {
        plan: "premium",
        org: `org-${randomUUID()}`,
      };

      track(server, "test-project", {
        enableTracing: true,
        identify: async () => {
          identifyCalled = true;
          return {
            userId: testUserId,
            userName: testUserName,
            userData: testUserData,
          };
        },
      });

      // tools/list is now schema injection only: no event is published, so
      // there is no identity to resolve and the customer's identify callback
      // is never invoked for it.
      await client.request(
        {
          method: "tools/list",
          params: {},
        },
        ListToolsResultSchema,
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(identifyCalled).toBe(false);
      expect(eventCapture.getEvents()).toHaveLength(0);

      await eventCapture.stop();
    });
  });
});
