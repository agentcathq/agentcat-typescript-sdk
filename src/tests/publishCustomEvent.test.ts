import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { MCPServerLike, CustomEventData, AgentCatOptions } from "../types.js";
import { EventCapture, setupTestHooks, sid } from "./test-utils.js";
import { mintBackOf, handleFrom } from "./v2/harness.js";

// Partial mocks: each mocked function runs the real implementation unless a
// test overrides it, so the same file drives both stubbed unit tests and real
// tracked servers.
vi.mock("../modules/logging.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/logging.js")>()),
  writeToLog: vi.fn(),
}));
vi.mock("../modules/internal.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../modules/internal.js")>();
  return {
    ...actual,
    getServerTrackingData: vi.fn(actual.getServerTrackingData),
  };
});
vi.mock("../modules/eventQueue.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../modules/eventQueue.js")>();
  return { ...actual, publishEvent: vi.fn(actual.publishEvent) };
});

// Import mocked modules
import { writeToLog } from "../modules/logging.js";
import { getServerTrackingData } from "../modules/internal.js";
import {
  publishEvent as publishEventToQueue,
  eventQueue,
} from "../modules/eventQueue.js";
import { deriveSessionId } from "../modules/handles.js";
import { AGENTCAT_TAG_SESSION_SOURCE } from "../modules/constants.js";

// Import the function under test
import { publishCustomEvent, track } from "../index.js";

const NO_SESSION_WARNING =
  "publishCustomEvent: no sessionId provided; event will be published without a session. Pass eventData.sessionId to attribute it to a task.";

describe("publishCustomEvent", () => {
  setupTestHooks();

  let mockEventQueue: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock logging
    (writeToLog as any).mockImplementation(() => {});

    // Mock event queue
    mockEventQueue = {
      add: vi.spyOn(eventQueue, "add").mockImplementation(() => {}),
    };

    // Mock publishEventToQueue
    (publishEventToQueue as any).mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  describe("with tracked server", () => {
    let mockServer: MCPServerLike;
    const projectId = "proj_test123";

    beforeEach(() => {
      mockServer = {} as any;

      // Mock server tracking data
      (getServerTrackingData as any).mockReturnValue({
        projectId: "proj_tracked",
        sessionId: "ses_tracked12300000000000000000",
        options: {},
      });
    });

    it("should publish custom event with tracked server", async () => {
      const eventData: CustomEventData = {
        sessionId: "ses_srv000000000000000000000000",
        resourceName: "custom-action",
        parameters: { action: "test" },
        message: "Testing custom event",
      };

      await publishCustomEvent(mockServer, projectId, eventData);

      expect(getServerTrackingData).toHaveBeenCalledWith(mockServer);
      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          sessionId: "ses_srv000000000000000000000000",
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
        sessionId: "ses_srv000000000000000000000000",
      });

      expect(publishEventToQueue).toHaveBeenCalledWith(
        mockServer,
        expect.objectContaining({
          sessionId: "ses_srv000000000000000000000000",
        }),
      );
    });

    it("publishes without a session outside any tool call", async () => {
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
      expect(writeToLog).toHaveBeenCalledWith(NO_SESSION_WARNING);
      expect(writeToLog).toHaveBeenCalledWith(
        "Published custom event without a session with type 'agentcat:custom'",
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
        sessionId: "ses_wins00000000000000000000000",
      });

      expect(mockEventQueue.add).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "ses_wins00000000000000000000000",
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

describe("publishCustomEvent inside a tool call", () => {
  setupTestHooks();

  const PROJECT_ID = "proj_custom_events";
  const TOOL = "complete_task";
  const CUSTOM = "task_completed";
  const cleanups: Array<() => Promise<void>> = [];
  let capture: EventCapture;

  beforeEach(async () => {
    vi.mocked(writeToLog).mockClear();
    capture = new EventCapture();
    await capture.start();
  });

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
    await capture.stop();
  });

  /**
   * A real tracked server with one tool, `complete_task`, whose body is
   * `onCall` (it receives the server the tool belongs to), connected to a
   * real client over an in-memory pair.
   */
  async function setupTaskServer(
    onCall: (server: McpServer) => unknown,
    options: AgentCatOptions = {},
  ) {
    const server = new McpServer({ name: "task server", version: "1.0" });
    server.registerTool(
      TOOL,
      {
        description: "Completes a task",
        inputSchema: { task: z.string() },
      },
      async (args) => {
        await onCall(server);
        return { content: [{ type: "text", text: `completed ${args.task}` }] };
      },
    );
    track(server, PROJECT_ID, options);

    const client = new Client({ name: "test client", version: "1.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    cleanups.push(async () => {
      await clientTransport.close();
      await serverTransport.close();
    });
    return { server, client };
  }

  const publishFromTool = (
    server: McpServer,
    eventData: CustomEventData = {},
  ) =>
    publishCustomEvent(server, PROJECT_ID, {
      resourceName: CUSTOM,
      ...eventData,
    });

  /** The tool-call event and the custom event, after the pipeline ran. */
  async function publishedPair() {
    await vi.waitFor(() => {
      expect(capture.findEventsByResourceName(TOOL)).toHaveLength(1);
      expect(capture.findEventsByResourceName(CUSTOM)).toHaveLength(1);
    });
    await capture.flush();
    return {
      toolEvent: capture.findEventsByResourceName(TOOL)[0],
      customEvent: capture.findEventsByResourceName(CUSTOM)[0],
    };
  }

  const logLines = () => vi.mocked(writeToLog).mock.calls.map((c) => c[0]);

  it("joins the session of the enclosing tool call when no sessionId is given", async () => {
    const { client } = await setupTaskServer(
      (server) => publishFromTool(server),
      {
        identify: async () => ({ userId: "actor-1" }),
        eventTags: () => ({ team: "billing" }),
        eventProperties: () => ({ plan: "pro" }),
      },
    );
    const issued = sid("issuedtask");

    await client.callTool({
      name: TOOL,
      arguments: { task: "t1", session_id: issued },
    });

    const { toolEvent, customEvent } = await publishedPair();
    expect(toolEvent.sessionId).toBe(issued);
    expect(customEvent.sessionId).toBe(toolEvent.sessionId);
    expect(logLines()).not.toContain(NO_SESSION_WARNING);
    expect(logLines()).toContain(
      `Published custom event for session ${issued} with type 'agentcat:custom'`,
    );

    // Only the session joins: identity, tags and properties stay the tool call's.
    expect(toolEvent.identifyActorGivenId).toBe("actor-1");
    expect(toolEvent.tags).toMatchObject({ team: "billing" });
    expect(toolEvent.properties).toEqual({ plan: "pro" });
    expect(customEvent.identifyActorGivenId).toBeUndefined();
    expect(customEvent.tags).toBeUndefined();
    expect(customEvent.properties).toBeUndefined();
  });

  it("joins the minted session when the tool call starts a new task", async () => {
    const { client } = await setupTaskServer((server) =>
      publishFromTool(server),
    );

    const result: any = await client.callTool({
      name: TOOL,
      arguments: { task: "t1", session_id: "start" },
    });

    const minted = handleFrom(mintBackOf(result)!, "session_id");
    expect(minted).toMatch(/^ses_/);
    const { toolEvent, customEvent } = await publishedPair();
    expect(toolEvent.sessionId).toBe(minted);
    expect(customEvent.sessionId).toBe(minted);
    expect(logLines()).not.toContain(NO_SESSION_WARNING);
  });

  it("shares the hook-mode session of the enclosing tool call", async () => {
    // A hook that settles only after the call returned: neither the tool nor
    // the custom event publish may wait for it on the request path.
    let releaseHook!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const derived = await setupTaskServer((server) => publishFromTool(server), {
      resolveSessionId: async () => {
        await hookGate;
        return "corr-42";
      },
    });

    await derived.client.callTool({ name: TOOL, arguments: { task: "t1" } });
    expect(logLines()).toContain(
      "Published custom event for the session of the current tool call with type 'agentcat:custom'",
    );
    releaseHook();

    const first = await publishedPair();
    const expected = deriveSessionId("corr-42", PROJECT_ID);
    expect(first.toolEvent.sessionId).toBe(expected);
    expect(first.customEvent.sessionId).toBe(expected);
    expect(first.toolEvent.tags?.[AGENTCAT_TAG_SESSION_SOURCE]).toBe("hook");
    expect(first.customEvent.tags).toBeUndefined();
    expect(logLines()).not.toContain(NO_SESSION_WARNING);

    // A null hook mints once per call: both events carry the same minted ID.
    capture.clear();
    const minted = await setupTaskServer((server) => publishFromTool(server), {
      resolveSessionId: () => null,
    });
    await minted.client.callTool({ name: TOOL, arguments: { task: "t2" } });

    const second = await publishedPair();
    expect(second.toolEvent.sessionId).toMatch(/^ses_/);
    expect(second.toolEvent.sessionId).not.toBe(expected);
    expect(second.customEvent.sessionId).toBe(second.toolEvent.sessionId);
    expect(second.toolEvent.tags?.[AGENTCAT_TAG_SESSION_SOURCE]).toBe("minted");
  });

  it("joins the session from async work that the tool starts and that publishes after the call returns", async () => {
    let releaseWork!: () => void;
    const workGate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const { client } = await setupTaskServer((server) => {
      void workGate
        .then(() => new Promise((resolve) => setTimeout(resolve, 5)))
        .then(() => publishFromTool(server));
    });
    const issued = sid("background");

    await client.callTool({
      name: TOOL,
      arguments: { task: "t1", session_id: issued },
    });
    await vi.waitFor(() =>
      expect(capture.findEventsByResourceName(TOOL)).toHaveLength(1),
    );
    expect(capture.findEventsByResourceName(CUSTOM)).toHaveLength(0);
    releaseWork();

    const { toolEvent, customEvent } = await publishedPair();
    expect(toolEvent.sessionId).toBe(issued);
    expect(customEvent.sessionId).toBe(issued);
    expect(logLines()).not.toContain(NO_SESSION_WARNING);
  });

  it("lets eventData.sessionId win over the enclosing tool call", async () => {
    const explicit = sid("explicit");
    const { client } = await setupTaskServer((server) =>
      publishFromTool(server, { sessionId: explicit }),
    );

    await client.callTool({
      name: TOOL,
      arguments: { task: "t1", session_id: sid("enclosing") },
    });

    const { toolEvent, customEvent } = await publishedPair();
    expect(toolEvent.sessionId).toBe(sid("enclosing"));
    expect(customEvent.sessionId).toBe(explicit);
    expect(logLines()).toContain(
      `Published custom event for session ${explicit} with type 'agentcat:custom'`,
    );
  });

  it("publishes without a session for a different tracked server than the enclosing call's", async () => {
    const other = new McpServer({ name: "other server", version: "1.0" });
    track(other, PROJECT_ID);
    const { client } = await setupTaskServer(() =>
      publishCustomEvent(other, PROJECT_ID, { resourceName: CUSTOM }),
    );

    await client.callTool({
      name: TOOL,
      arguments: { task: "t1", session_id: sid("enclosing") },
    });

    const { toolEvent, customEvent } = await publishedPair();
    expect(toolEvent.sessionId).toBe(sid("enclosing"));
    expect(customEvent.sessionId).toBe("");
    expect(logLines()).toContain(NO_SESSION_WARNING);
    expect(logLines()).toContain(
      "Published custom event without a session with type 'agentcat:custom'",
    );
  });

  it("keeps the session-ID-string form verbatim inside a tool call", async () => {
    const { client } = await setupTaskServer(() =>
      publishCustomEvent("my-own-task-7", PROJECT_ID, { resourceName: CUSTOM }),
    );

    await client.callTool({
      name: TOOL,
      arguments: { task: "t1", session_id: sid("enclosing") },
    });

    const { toolEvent, customEvent } = await publishedPair();
    expect(toolEvent.sessionId).toBe(sid("enclosing"));
    expect(customEvent.sessionId).toBe("my-own-task-7");
    expect(logLines()).toContain(
      "Published custom event for session my-own-task-7 with type 'agentcat:custom'",
    );
  });

  it("publishes without a session when the enclosing call has an invalid session_id", async () => {
    const { client } = await setupTaskServer((server) =>
      publishFromTool(server),
    );

    await client.callTool({
      name: TOOL,
      arguments: { task: "t1", session_id: "not-a-session" },
    });

    const { toolEvent, customEvent } = await publishedPair();
    expect(toolEvent.sessionId).toBe("");
    expect(toolEvent.tags?.[AGENTCAT_TAG_SESSION_SOURCE]).toBe("invalid");
    expect(customEvent.sessionId).toBe("");
    expect(logLines()).not.toContain(NO_SESSION_WARNING);
    expect(logLines()).toContain(
      "Published custom event without a session with type 'agentcat:custom'",
    );
  });
});
