import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPServerLike, CustomEventData } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

// Mock external dependencies
vi.mock("../modules/logging.js");
vi.mock("../modules/internal.js");
vi.mock("../modules/session.js");
vi.mock("../modules/eventQueue.js");
vi.mock("../modules/constants.js");
vi.mock("../thirdparty/ksuid/index.js");

// Import mocked modules
import { writeToLog } from "../modules/logging.js";
import { getServerTrackingData } from "../modules/internal.js";
import {
  publishEvent as publishEventToQueue,
  eventQueue,
} from "../modules/eventQueue.js";
import { AGENTCAT_CUSTOM_EVENT_TYPE } from "../modules/constants.js";
import KSUID from "../thirdparty/ksuid/index.js";

// Import the function under test
import { publishCustomEvent } from "../index.js";

describe("publishCustomEvent", () => {
  setupTestHooks();

  let mockKSUID: any;
  let mockEventQueue: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock KSUID
    mockKSUID = {
      random: vi.fn().mockResolvedValue("evt_test123"),
      randomSync: vi.fn().mockReturnValue("ses_test123"),
    };
    (KSUID.withPrefix as any) = vi.fn().mockReturnValue(mockKSUID);

    // Mock logging
    (writeToLog as any).mockImplementation(() => {});

    // Mock event queue
    mockEventQueue = {
      add: vi.fn(),
    };
    (eventQueue as any).add = mockEventQueue.add;

    // Mock publishEventToQueue
    (publishEventToQueue as any).mockImplementation(() => {});

    // Mock AGENTCAT_CUSTOM_EVENT_TYPE
    (AGENTCAT_CUSTOM_EVENT_TYPE as any) = "agentcat:custom";
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("with tracked server", () => {
    let mockServer: MCPServerLike;
    const projectId = "proj_test123";

    beforeEach(() => {
      mockServer = {} as any;

      // Mock server tracking data
      (getServerTrackingData as any).mockReturnValue({
        projectId: "proj_tracked",
        sessionId: "ses_tracked123",
        options: {},
      });
    });

    it("should publish custom event with tracked server", async () => {
      const eventData: CustomEventData = {
        sessionId: "ses_srv",
        resourceName: "custom-action",
        parameters: { action: "test" },
        message: "Testing custom event",
      };

      await publishCustomEvent(mockServer, projectId, eventData);

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          sessionId: "ses_srv",
          projectId,
          eventType: "agentcat:custom",
          resourceName: "custom-action",
          parameters: { action: "test" },
          userIntent: "Testing custom event", // message maps to userIntent
        }),
      );
      expect(writeToLog).toHaveBeenCalledWith(
        expect.stringContaining("Published custom event"),
      );
    });

    it("should use eventData.sessionId as the session id, not any ambient server session", async () => {
      await publishCustomEvent(mockServer, projectId, {
        sessionId: "ses_srv",
      });

      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({ sessionId: "ses_srv" }),
      );
    });

    it("should publish with an empty session id and warn when no sessionId is provided", async () => {
      await publishCustomEvent(mockServer, projectId, {
        resourceName: "custom-action",
      });

      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          sessionId: "",
          projectId,
          resourceName: "custom-action",
        }),
      );
      expect(writeToLog).toHaveBeenCalledWith(
        expect.stringContaining("no sessionId provided"),
      );
    });

    it("should handle error data correctly", async () => {
      const eventData: CustomEventData = {
        isError: true,
        error: { message: "Test error", code: "ERR_001" },
      };

      await publishCustomEvent(mockServer, projectId, eventData);

      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          isError: true,
          error: { message: "Test error", code: "ERR_001" },
        }),
      );
    });

    it("should throw error if server is not tracked", async () => {
      (getServerTrackingData as any).mockReturnValue(undefined);

      await expect(publishCustomEvent(mockServer, projectId)).rejects.toThrow(
        "Server is not tracked",
      );
    });

    it("should handle high-level server objects", async () => {
      const highLevelServer = {
        server: mockServer,
      };

      await publishCustomEvent(highLevelServer, projectId);

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
    });
  });

  describe("with session ID string", () => {
    const customSessionId = "user-session-12345";
    const projectId = "proj_test123";

    it("should use the session ID string verbatim as the session ID", async () => {
      const eventData: CustomEventData = {
        resourceName: "custom-action",
        parameters: { action: "test" },
      };

      await publishCustomEvent(customSessionId, projectId, eventData);

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: customSessionId,
          projectId,
          eventType: "agentcat:custom",
          resourceName: "custom-action",
          parameters: { action: "test" },
        }),
      );
    });

    it("should let eventData.sessionId take precedence over the string", async () => {
      await publishCustomEvent("ignored-string", "proj", {
        sessionId: "ses_wins",
      });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "ses_wins",
          projectId: "proj",
        }),
      );
    });

    it("should handle all event data fields", async () => {
      const eventData: CustomEventData = {
        resourceName: "full-test",
        parameters: { key: "value" },
        response: { result: "success" },
        message: "Complete test",
        duration: 1500,
        isError: false,
        error: null,
      };

      await publishCustomEvent(customSessionId, projectId, eventData);

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: "full-test",
          parameters: { key: "value" },
          response: { result: "success" },
          userIntent: "Complete test", // message maps to userIntent
          duration: 1500,
          isError: false,
          error: null,
        }),
      );
    });
  });

  describe("parameter validation", () => {
    it("should throw error if projectId is not provided", async () => {
      await expect(publishCustomEvent("session-id", "")).rejects.toThrow(
        "projectId is required",
      );

      await expect(
        publishCustomEvent("session-id", null as any),
      ).rejects.toThrow("projectId is required");

      await expect(
        publishCustomEvent("session-id", undefined as any),
      ).rejects.toThrow("projectId is required");
    });

    it("should throw error if first parameter is invalid", async () => {
      await expect(publishCustomEvent(123 as any, "proj_123")).rejects.toThrow(
        "First parameter must be either an MCP server object or a session ID string",
      );

      await expect(publishCustomEvent(null as any, "proj_123")).rejects.toThrow(
        "First parameter must be either an MCP server object or a session ID string",
      );

      await expect(
        publishCustomEvent(undefined as any, "proj_123"),
      ).rejects.toThrow(
        "First parameter must be either an MCP server object or a session ID string",
      );
    });
  });

  describe("event structure", () => {
    it("should always use 'agentcat:custom' as event type", async () => {
      const customSessionId = "test-session";
      const projectId = "proj_test";

      await publishCustomEvent(customSessionId, projectId);

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "agentcat:custom",
        }),
      );
    });

    it("should include timestamp", async () => {
      const customSessionId = "test-session";
      const projectId = "proj_test";
      const beforeTime = new Date();

      await publishCustomEvent(customSessionId, projectId);

      const afterTime = new Date();

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(Date),
        }),
      );

      const calledTimestamp = mockEventQueue.add.mock.calls[0][0].timestamp;
      expect(calledTimestamp.getTime()).toBeGreaterThanOrEqual(
        beforeTime.getTime(),
      );
      expect(calledTimestamp.getTime()).toBeLessThanOrEqual(
        afterTime.getTime(),
      );
    });

    it("should handle undefined event data gracefully", async () => {
      const customSessionId = "test-session";
      const projectId = "proj_test";

      await publishCustomEvent(customSessionId, projectId, undefined);

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: undefined,
          parameters: undefined,
          response: undefined,
          userIntent: undefined,
          duration: undefined,
          isError: undefined,
          error: undefined,
        }),
      );
    });

    it("should handle empty event data object", async () => {
      const customSessionId = "test-session";
      const projectId = "proj_test";

      await publishCustomEvent(customSessionId, projectId, {});

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: undefined,
          parameters: undefined,
          response: undefined,
          userIntent: undefined,
          duration: undefined,
          isError: undefined,
          error: undefined,
        }),
      );
    });
  });
});
