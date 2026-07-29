import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPServerLike, CustomEventData } from "../types.js";
import { setupTestHooks } from "./test-utils.js";

// Mock external dependencies
vi.mock("../modules/logging.js");
vi.mock("../modules/internal.js");
vi.mock("../modules/session.js");
vi.mock("../modules/handles.js");
vi.mock("../modules/eventQueue.js");
vi.mock("../thirdparty/ksuid/index.js");

// Import mocked modules
import { writeToLog } from "../modules/logging.js";
import { getServerTrackingData } from "../modules/internal.js";
import { deriveTaskId, newTaskId } from "../modules/handles.js";
import {
  publishEvent as publishEventToQueue,
  eventQueue,
} from "../modules/eventQueue.js";
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

    // Mock the Task ID primitives
    (deriveTaskId as any).mockImplementation(
      (id: string, projectId: string) => {
        return `ses_derived_${id}_${projectId}`;
      },
    );
    (newTaskId as any).mockReturnValue("ses_minted123");

    // Mock publishEventToQueue
    (publishEventToQueue as any).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("with tracked server", () => {
    let mockServer: MCPServerLike;
    const projectId = "proj_test123";

    beforeEach(() => {
      mockServer = {} as any;

      // Mock server tracking data. A tracked server no longer carries an
      // ambient session id — Task IDs are per request — so a custom event
      // published against a server carries no session id unless the caller
      // supplies one via `taskId`.
      (getServerTrackingData as any).mockReturnValue({
        projectId: "proj_tracked",
        options: {},
      });
    });

    it("should publish custom event with tracked server", async () => {
      const eventData: CustomEventData = {
        resourceName: "custom-action",
        parameters: { action: "test" },
        message: "Testing custom event",
      };

      await publishCustomEvent(mockServer, projectId, eventData);

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          sessionId: undefined,
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

  describe("with custom session ID", () => {
    const customSessionId = "user-session-12345";
    const projectId = "proj_test123";

    it("should publish custom event with derived session ID", async () => {
      const eventData: CustomEventData = {
        resourceName: "custom-action",
        parameters: { action: "test" },
      };

      await publishCustomEvent(customSessionId, projectId, eventData);

      expect(deriveTaskId).toHaveBeenCalledWith(customSessionId, projectId);
      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: `ses_derived_${customSessionId}_${projectId}`,
          projectId,
          eventType: "agentcat:custom",
          resourceName: "custom-action",
          parameters: { action: "test" },
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

  describe("task ID resolution", () => {
    const projectId = "proj_test123";

    it("uses a string first argument verbatim when it is already a Task ID", async () => {
      await publishCustomEvent("ses_verbatim", projectId, {
        resourceName: "x",
      });

      expect(deriveTaskId).not.toHaveBeenCalled();
      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "ses_verbatim" }),
      );
    });

    it("derives a string first argument that is not a Task ID", async () => {
      // Same derivation resolveHandles applies to the resolveTaskId hook, so a
      // customer's own workflow id correlates with their tool calls.
      await publishCustomEvent("workflow-42", projectId, {
        resourceName: "x",
      });

      expect(deriveTaskId).toHaveBeenCalledWith("workflow-42", projectId);
      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: `ses_derived_workflow-42_${projectId}`,
        }),
      );
    });

    it("prefers an explicit taskId over the string first argument", async () => {
      await publishCustomEvent("ses_positional", projectId, {
        taskId: "ses_explicit",
        resourceName: "x",
      });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "ses_explicit" }),
      );
    });

    it("prefers an explicit taskId when a tracked server is passed", async () => {
      (getServerTrackingData as any).mockReturnValue({
        projectId: "proj_tracked",
        options: {},
      });
      const mockServer = {} as MCPServerLike;

      await publishCustomEvent(mockServer, projectId, {
        taskId: "ses_explicit",
        resourceName: "x",
      });

      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({ sessionId: "ses_explicit" }),
      );
    });

    it("derives an explicit taskId that is not a Task ID", async () => {
      await publishCustomEvent("ses_positional", projectId, {
        taskId: "workflow-42",
      });

      expect(deriveTaskId).toHaveBeenCalledWith("workflow-42", projectId);
      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: `ses_derived_workflow-42_${projectId}`,
        }),
      );
    });

    it("emits no session ID when a tracked server has no task ID", async () => {
      (getServerTrackingData as any).mockReturnValue({
        projectId: "proj_tracked",
        options: {},
      });
      const mockServer = {} as MCPServerLike;

      await publishCustomEvent(mockServer, projectId, { resourceName: "x" });

      expect(newTaskId).not.toHaveBeenCalled();
      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({ sessionId: undefined }),
      );
      expect(writeToLog).toHaveBeenCalledWith(
        expect.stringContaining("no taskId"),
      );
    });
  });

  describe("actor attribution", () => {
    const projectId = "proj_test123";

    it("maps an explicit actor onto the identify fields", async () => {
      await publishCustomEvent("ses_actor", projectId, {
        resourceName: "x",
        actor: {
          userId: "user-1",
          userName: "Ada",
          userData: { plan: "pro" },
        },
      });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          identifyActorGivenId: "user-1",
          identifyActorName: "Ada",
          identifyActorData: { plan: "pro" },
        }),
      );
    });

    it("leaves the identify fields undefined when no actor is supplied", async () => {
      await publishCustomEvent("ses_actor", projectId, { resourceName: "x" });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          identifyActorGivenId: undefined,
          identifyActorName: undefined,
          identifyActorData: undefined,
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
        "First parameter must be either an MCP server object or a task ID string",
      );

      await expect(publishCustomEvent(null as any, "proj_123")).rejects.toThrow(
        "First parameter must be either an MCP server object or a task ID string",
      );

      await expect(
        publishCustomEvent(undefined as any, "proj_123"),
      ).rejects.toThrow(
        "First parameter must be either an MCP server object or a task ID string",
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
