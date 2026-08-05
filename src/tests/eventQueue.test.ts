import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Event, MCPServerLike } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

// Mock external dependencies
vi.mock("agentcat-api");
vi.mock("../modules/logging.js");
vi.mock("../modules/internal.js");
// Session metadata is now built per event by buildSessionInfo(server, identity,
// clientInfo) — there is no cached session-info getter to mock any more.
vi.mock("../modules/session.js", () => ({
  buildSessionInfo: vi.fn(),
  getClientInfoForRequest: vi.fn(),
  getProtocolVersion: vi.fn(),
}));
vi.mock("../thirdparty/ksuid/index.js");

// Import mocked modules
import { Configuration, EventsApi } from "agentcat-api";
import { writeToLog } from "../modules/logging.js";
import { getServerTrackingData } from "../modules/internal.js";
import { buildSessionInfo } from "../modules/session.js";
import KSUID from "../thirdparty/ksuid/index.js";
import { setBackgroundTaskRegistrar } from "../modules/backgroundTasks.js";

// Import the module under test - need to do this after mocking
const { publishEvent, eventQueue } = await import("../modules/eventQueue.js");

// publishEvent falls back to server.getClientVersion() when no clientInfo is
// supplied on the context, so every mock server must expose it.
const makeMockServer = (): MCPServerLike =>
  ({ getClientVersion: () => undefined }) as any as MCPServerLike;

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
      options: { enableTracing: true },
    });

    // Mock the per-event session info builder
    (buildSessionInfo as any).mockReturnValue({
      ipAddress: "127.0.0.1",
      sdkLanguage: "typescript",
      agentcatVersion: "1.0.0",
      serverName: "test-server",
      serverVersion: "1.0.0",
      clientName: "test-client",
      clientVersion: "1.0.0",
      identifyActorGivenId: undefined,
      identifyActorName: undefined,
      identifyActorData: {},
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("publishEvent", () => {
    it("should publish event with server tracking data and session info", async () => {
      const mockServer = makeMockServer();
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
      expect(buildSessionInfo).toHaveBeenCalled();
    });

    it("should not publish event when server tracking data is missing", () => {
      (getServerTrackingData as any).mockReturnValue(null);

      const mockServer = makeMockServer();
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
        options: { enableTracing: false },
      });

      const mockServer = makeMockServer();
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(buildSessionInfo).not.toHaveBeenCalled();
    });

    it("should calculate duration when not provided", () => {
      const mockServer = makeMockServer();
      const timestamp = new Date(Date.now() - 1000); // 1 second ago
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp,
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      // Duration should be calculated based on timestamp difference
      expect(buildSessionInfo).toHaveBeenCalled();
    });

    it("should preserve existing duration", () => {
      const mockServer = makeMockServer();
      const event: Event = {
        sessionId: "test-session",
        tool: "test-tool",
        timestamp: new Date(),
        duration: 500,
        arguments: { test: "value" },
      };

      publishEvent(mockServer, event);

      expect(buildSessionInfo).toHaveBeenCalled();
    });

    it("should publish an absent sessionId as empty string and send it as null", async () => {
      // There is no data.sessionId fallback any more: a caller that supplies
      // no sessionId gets "" on the event, which the wire mapping turns into
      // an explicit null rather than dropping the field.
      (eventQueue as any).apiClient = mockApiClient;
      const addSpy = vi.spyOn(eventQueue, "add");

      try {
        publishEvent(makeMockServer(), {
          eventType: "mcp:tools/call",
          resourceName: "do_thing",
          timestamp: new Date(),
        } as any);

        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(addSpy.mock.calls[0][0].sessionId).toBe("");

        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(mockPublishEvent).toHaveBeenCalledTimes(1);
        const sent = mockPublishEvent.mock.calls[0][0].publishEventRequest;
        expect(sent.sessionId).toBeNull();
      } finally {
        addSpy.mockRestore();
      }
    });
  });

  describe("background delivery lifecycle", () => {
    afterEach(() => {
      setBackgroundTaskRegistrar(undefined);
    });

    it("keeps the registered task pending until AgentCat ingestion completes", async () => {
      let finishSend: (() => void) | undefined;
      mockPublishEvent.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishSend = resolve;
          }),
      );
      (eventQueue as any).apiClient = mockApiClient;

      const registeredTasks: Promise<void>[] = [];
      setBackgroundTaskRegistrar((task) => registeredTasks.push(task));

      publishEvent(makeMockServer(), {
        sessionId: "test-session",
        eventType: "mcp:tools/call",
        resourceName: "slow_tool",
        timestamp: new Date(),
      });

      await vi.waitFor(() => expect(registeredTasks).toHaveLength(1));
      await vi.waitFor(() => expect(finishSend).toBeTypeOf("function"));

      let settled = false;
      void registeredTasks[0].then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      finishSend!();
      await registeredTasks[0];
      expect(settled).toBe(true);
    });

    it("settles fail-open when AgentCat ingestion exhausts retries", async () => {
      mockPublishEvent.mockRejectedValue(new Error("ingestion unavailable"));
      (eventQueue as any).apiClient = mockApiClient;
      const originalMaxRetries = (eventQueue as any).maxRetries;
      (eventQueue as any).maxRetries = 0;

      const registeredTasks: Promise<void>[] = [];
      setBackgroundTaskRegistrar((task) => registeredTasks.push(task));

      try {
        publishEvent(makeMockServer(), {
          sessionId: "test-session",
          eventType: "mcp:tools/call",
          resourceName: "failing_tool",
          timestamp: new Date(),
        });

        await vi.waitFor(() => expect(registeredTasks).toHaveLength(1));
        await expect(registeredTasks[0]).resolves.toBeUndefined();
        expect(writeToLog).toHaveBeenCalledWith(
          expect.stringContaining(
            "Failed to deliver AgentCat event after retries",
          ),
        );
      } finally {
        (eventQueue as any).maxRetries = originalMaxRetries;
      }
    });

    it("does not register telemetry-only events", async () => {
      const registrar = vi.fn();
      setBackgroundTaskRegistrar(registrar);

      eventQueue.add({
        sessionId: "telemetry-session",
        eventType: "mcp:tools/call",
        timestamp: new Date(),
      });

      await vi.waitFor(() =>
        expect(eventQueue.getStats().activeRequests).toBe(0),
      );
      expect(registrar).not.toHaveBeenCalled();
    });

    it("does not hold AgentCat delivery open for custom exporters", async () => {
      let finishTelemetry: (() => void) | undefined;
      let telemetryCompleted = false;
      const telemetryExport = new Promise<void>((resolve) => {
        finishTelemetry = () => {
          telemetryCompleted = true;
          resolve();
        };
      });
      const originalTelemetryManager = (eventQueue as any).telemetryManager;
      (eventQueue as any).telemetryManager = {
        export: vi.fn(() => telemetryExport),
      };
      (eventQueue as any).apiClient = mockApiClient;

      const registeredTasks: Promise<void>[] = [];
      setBackgroundTaskRegistrar((task) => registeredTasks.push(task));

      try {
        publishEvent(makeMockServer(), {
          sessionId: "test-session",
          eventType: "mcp:tools/call",
          timestamp: new Date(),
        });

        await vi.waitFor(() => expect(registeredTasks).toHaveLength(1));
        await expect(registeredTasks[0]).resolves.toBeUndefined();
        expect(telemetryCompleted).toBe(false);
      } finally {
        finishTelemetry?.();
        (eventQueue as any).telemetryManager = originalTelemetryManager;
      }
    });

    it("settles an event when queue overflow drops it", async () => {
      const originalConcurrency = (eventQueue as any).concurrency;
      const originalMaxQueueSize = (eventQueue as any).maxQueueSize;
      (eventQueue as any).concurrency = 0;
      (eventQueue as any).maxQueueSize = 1;
      (eventQueue as any).apiClient = mockApiClient;

      const registeredTasks: Promise<void>[] = [];
      setBackgroundTaskRegistrar((task) => registeredTasks.push(task));

      try {
        eventQueue.add({
          sessionId: "dropped-session",
          projectId: "test-project",
          eventType: "mcp:tools/call",
          timestamp: new Date(),
        });
        eventQueue.add({
          sessionId: "retained-session",
          projectId: "test-project",
          eventType: "mcp:tools/call",
          timestamp: new Date(),
        });

        expect(registeredTasks).toHaveLength(2);
        await expect(registeredTasks[0]).resolves.toBeUndefined();
        expect(writeToLog).toHaveBeenCalledWith(
          "Event queue full, dropping oldest event",
        );
      } finally {
        (eventQueue as any).concurrency = originalConcurrency;
        (eventQueue as any).maxQueueSize = originalMaxQueueSize;
        void (eventQueue as any).process();
        await registeredTasks[1];
      }
    });

    it("continues delivery when runtime task registration throws", async () => {
      (eventQueue as any).apiClient = mockApiClient;
      setBackgroundTaskRegistrar(() => {
        throw new Error("no active request context");
      });

      expect(() =>
        publishEvent(makeMockServer(), {
          sessionId: "test-session",
          eventType: "mcp:tools/call",
          timestamp: new Date(),
        }),
      ).not.toThrow();

      await vi.waitFor(() => expect(mockPublishEvent).toHaveBeenCalled());
      expect(writeToLog).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to register AgentCat event delivery as a background task",
        ),
      );
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
      const mockServer = makeMockServer();
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
      expect(buildSessionInfo).toHaveBeenCalled();
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
      const mockServer = makeMockServer();
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
      const mockServer = makeMockServer();

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
      expect(buildSessionInfo).toHaveBeenCalled();
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
        options: { enableTracing: true, redactEvent: hook },
      });

      publishEvent(makeMockServer(), {
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
        options: { enableTracing: true, redactEvent: () => null },
      });

      publishEvent(makeMockServer(), {
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
        options: {
          enableTracing: true,
          redactEvent: () => {
            throw new Error("hook exploded");
          },
        },
      });

      publishEvent(makeMockServer(), {
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
        options: {
          enableTracing: true,
          redactEvent: (event: any) => {
            seenByEventHook.push(event.userIntent);
            return { ...event, userIntent: `${event.userIntent} (reviewed)` };
          },
        },
      });

      publishEvent(makeMockServer(), {
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
