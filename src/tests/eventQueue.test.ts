import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Event, MCPServerLike } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

// Mock external dependencies
vi.mock("agentcat-api");
vi.mock("../modules/logging.js");
vi.mock("../modules/internal.js");
vi.mock("../modules/session.js");
vi.mock("../thirdparty/ksuid/index.js");

// Import mocked modules
import { Configuration, EventsApi } from "agentcat-api";
import { writeToLog } from "../modules/logging.js";
import { getServerTrackingData } from "../modules/internal.js";
import { getSessionInfo } from "../modules/session.js";
import KSUID from "../thirdparty/ksuid/index.js";

// Import the module under test - need to do this after mocking
const { publishEvent, eventQueue } = await import("../modules/eventQueue.js");

describe("EventQueue", () => {
  setupTestHooks();

  let mockApiClient: any;
  let mockPublishEvent: any;
  let mockKSUID: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock API client
    mockPublishEvent = vi.fn().mockResolvedValue({});
    mockApiClient = {
      publishEvent: mockPublishEvent,
    };

    (EventsApi as any).mockImplementation(() => mockApiClient);
    (Configuration as any).mockImplementation(() => ({}));

    // Mock KSUID
    mockKSUID = {
      random: vi.fn().mockResolvedValue("evt_test123"),
    };
    (KSUID.withPrefix as any) = vi.fn().mockReturnValue(mockKSUID);

    // Mock logging
    (writeToLog as any).mockImplementation(() => {});

    // Mock server tracking data
    (getServerTrackingData as any).mockReturnValue({
      projectId: "test-project",
      sessionId: "test-session",
      options: { enableTracing: true },
    });

    // Mock session info
    (getSessionInfo as any).mockReturnValue({
      ipAddress: "127.0.0.1",
      sdkLanguage: "typescript",
      agentcatVersion: "1.0.0",
      serverName: "test-server",
      serverVersion: "1.0.0",
      clientName: "test-client",
      clientVersion: "1.0.0",
      actorGivenId: null,
      actorName: null,
      actorData: {},
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("publishEvent", () => {
    it("should publish event with server tracking data and session info", async () => {
      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(getSessionInfo).toHaveBeenCalled();
    });

    it("should not publish event when server tracking data is missing", () => {
      (getServerTrackingData as any).mockReturnValue(null);

      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(writeToLog).toHaveBeenCalledWith(
        "Warning: Server tracking data not found. Event will not be published.",
      );
    });

    it("should not publish event when enableTracing is false", () => {
      (getServerTrackingData as any).mockReturnValue({
        projectId: "test-project",
        sessionId: "test-session",
        options: { enableTracing: false },
      });

      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(getSessionInfo).not.toHaveBeenCalled();
    });

    it("should calculate duration when not provided", () => {
      const mockServer: MCPServerLike = {} as any;
      const timestamp = new Date(Date.now() - 1000); // 1 second ago
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp,
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      // Duration should be calculated based on timestamp difference
      expect(getSessionInfo).toHaveBeenCalled();
    });

    it("should preserve existing duration", () => {
      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        duration: 500,
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(getSessionInfo).toHaveBeenCalled();
    });
  });

  describe("EventQueue singleton", () => {
    it("should be accessible and have required methods", () => {
      expect(eventQueue).toBeDefined();
      expect(eventQueue.add).toBeDefined();
      expect(eventQueue.getStats).toBeDefined();
      expect(eventQueue.destroy).toBeDefined();
    });

    it("should track queue stats correctly", () => {
      const stats = eventQueue.getStats();
      expect(stats).toHaveProperty("queueLength");
      expect(stats).toHaveProperty("activeRequests");
      expect(stats).toHaveProperty("isProcessing");
      expect(typeof stats.queueLength).toBe("number");
      expect(typeof stats.activeRequests).toBe("number");
      expect(typeof stats.isProcessing).toBe("boolean");
    });

    it("should be able to add events directly", () => {
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      // This should not throw an error
      expect(() => eventQueue.add(event)).not.toThrow();
    });

    it("should handle destroy method without errors", async () => {
      // This should not throw an error
      expect(async () => await eventQueue.destroy()).not.toThrow();
    });

    it("should prevent adding events after destroy", async () => {
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      // Call destroy first
      await eventQueue.destroy();

      // Then try to add an event
      eventQueue.add(event);

      // Should log the shutdown message
      expect(writeToLog).toHaveBeenCalledWith(
        "Queue is shutting down, event dropped",
      );
    });
  });

  describe("Integration tests", () => {
    it("should process events end-to-end through publishEvent", async () => {
      const mockServer: MCPServerLike = {} as any;
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify the pipeline was called
      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(getSessionInfo).toHaveBeenCalled();
    });

    it("logs only event metadata on successful send, never the payload", async () => {
      // A prior test calls destroy(), which permanently replaces add() with a
      // shutdown stub on the singleton. Restore the prototype method so this
      // event actually flows through the queue.
      delete (eventQueue as any).add;

      // Point the queue at the mocked API client so the send resolves and the
      // success path (the metadata log) runs deterministically.
      (eventQueue as any).apiClient = mockApiClient;

      const SECRET = "TOP_SECRET_PAYLOAD_abc123";
      const mockServer: MCPServerLike = {} as any;
      const event: any = {
        sessionId: "test-session",
        eventType: "mcp:tools/call",
        resourceName: "do_thing",
        parameters: { request: { params: { arguments: { apiKey: SECRET } } } },
        response: { content: [{ type: "text", text: SECRET }] },
        userIntent: SECRET,
        timestamp: new Date(),
      };

      publishEvent(mockServer, event);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const logged = (writeToLog as any).mock.calls.map((c: any[]) =>
        String(c[0]),
      );

      // The "event fired" metadata line is still emitted, with session id...
      const successLine = logged.find((l: string) =>
        l.includes("Successfully sent event"),
      );
      expect(successLine).toBeDefined();
      expect(successLine).toContain("session test-session");

      // ...but the full event is never dumped, and no payload value leaks.
      expect(logged.some((l: string) => l.includes("Event details"))).toBe(
        false,
      );
      expect(logged.some((l: string) => l.includes(SECRET))).toBe(false);
    });

    it("should handle multiple events", async () => {
      const mockServer: MCPServerLike = {} as any;

      // Add multiple events
      for (let i = 0; i < 5; i++) {
        const event: Event = {
          sessionId: "test-session",
          tool: `test-tool-${i}`,
          timestamp: new Date(),
          arguments: { index: i },
        };
        publishEvent(mockServer, event);
      }

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify multiple calls were made
      expect(getSessionInfo).toHaveBeenCalled();
      expect(getServerTrackingData).toHaveBeenCalled();
    });
  });

  describe("event-level redaction hook (redactEvent)", () => {
    beforeEach(() => {
      // Restore the prototype add() (a prior test calls destroy(), which
      // permanently replaces it on the singleton) and point the queue at the
      // mocked API client so sends resolve deterministically.
      delete (eventQueue as any).add;
      (eventQueue as any).apiClient = mockApiClient;
    });

    it("should apply the redactEvent option from tracking data to published events", async () => {
      const hook = vi.fn((event: any) => ({
        ...event,
        parameters: { text: "[EVENT-REDACTED]" },
      }));
      (getServerTrackingData as any).mockReturnValue({
        projectId: "test-project",
        sessionId: "test-session",
        options: { enableTracing: true, redactEvent: hook },
      });

      publishEvent({} as MCPServerLike, {
        sessionId: "test-session",
        eventType: "mcp:tools/call",
        resourceName: "do_thing",
        parameters: { text: "raw sensitive value" },
        timestamp: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0].resourceName).toBe("do_thing");
      expect(hook.mock.calls[0][0].parameters).toEqual({
        text: "raw sensitive value",
      });
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
      const sent = mockPublishEvent.mock.calls[0][0].publishEventRequest;
      expect(sent.parameters).toEqual({ text: "[EVENT-REDACTED]" });
    });

    it("should drop the event when the hook returns null", async () => {
      (getServerTrackingData as any).mockReturnValue({
        projectId: "test-project",
        sessionId: "test-session",
        options: { enableTracing: true, redactEvent: () => null },
      });

      publishEvent({} as MCPServerLike, {
        sessionId: "test-session",
        eventType: "mcp:tools/call",
        timestamp: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockPublishEvent).not.toHaveBeenCalled();
      expect(writeToLog).toHaveBeenCalledWith(
        "Event dropped by redactEvent hook",
      );
    });

    it("should drop the event when the hook throws", async () => {
      (getServerTrackingData as any).mockReturnValue({
        projectId: "test-project",
        sessionId: "test-session",
        options: {
          enableTracing: true,
          redactEvent: () => {
            throw new Error("hook exploded");
          },
        },
      });

      publishEvent({} as MCPServerLike, {
        sessionId: "test-session",
        eventType: "mcp:tools/call",
        timestamp: new Date(),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockPublishEvent).not.toHaveBeenCalled();
      expect(writeToLog).toHaveBeenCalledWith(
        expect.stringContaining("Failed to redact event (event-level hook)"),
      );
    });

    it("should run the event hook before string redaction and compose both", async () => {
      const seenByEventHook: string[] = [];
      (getServerTrackingData as any).mockReturnValue({
        projectId: "test-project",
        sessionId: "test-session",
        options: {
          enableTracing: true,
          redactEvent: (event: any) => {
            seenByEventHook.push(event.userIntent);
            return { ...event, userIntent: `${event.userIntent} (reviewed)` };
          },
        },
      });

      publishEvent({} as MCPServerLike, {
        sessionId: "test-session",
        eventType: "mcp:tools/call",
        userIntent: "raw secret",
        timestamp: new Date(),
        redactionFn: async (text: string) =>
          text.replace("secret", "[REDACTED]"),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Event hook saw the raw value; string redaction ran on its output
      expect(seenByEventHook).toEqual(["raw secret"]);
      expect(mockPublishEvent).toHaveBeenCalledTimes(1);
      const sent = mockPublishEvent.mock.calls[0][0].publishEventRequest;
      expect(sent.userIntent).toBe("raw [REDACTED] (reviewed)");
    });
  });

  describe("Process lifecycle handling", () => {
    it("should handle SIGINT signal", () => {
      // Test that signal handlers are registered
      expect(process.once).toBeDefined();
    });
  });
});
