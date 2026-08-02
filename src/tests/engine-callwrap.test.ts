import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the logging module (convention: see compatibility.test.ts)
vi.mock("../modules/logging", () => ({
  writeToLog: vi.fn(),
}));

import { writeToLog } from "../modules/logging.js";
import {
  installCallWrap,
  isInputRequiredShape,
  mrtrContinuationTags,
} from "../engine/callWrap.js";
import {
  initEngineState,
  getEngineState,
  setInjectedParamsRegistry,
  setOutputInjectionRegistry,
} from "../engine/registry.js";
import { v2Adapter } from "../adapters/v2.js";
import { setServerTrackingData } from "../modules/internal.js";
import { EventCapture, sid } from "./test-utils.js";

describe("MRTR helpers", () => {
  it("isInputRequiredShape matches only resultType === 'input_required'", () => {
    expect(isInputRequiredShape({ resultType: "input_required" })).toBe(true);
    expect(isInputRequiredShape({ resultType: "complete" })).toBe(false);
    expect(isInputRequiredShape({ content: [] })).toBe(false);
    expect(isInputRequiredShape(null)).toBe(false);
    expect(isInputRequiredShape([])).toBe(false);
  });

  it("mrtrContinuationTags fires only when inputResponses ride the request", () => {
    expect(
      mrtrContinuationTags({ mcpReq: { inputResponses: { a: {} } } }),
    ).toEqual({
      agentcat_mrtr: "continuation",
    });
    expect(mrtrContinuationTags({ mcpReq: {} })).toEqual({});
    expect(mrtrContinuationTags(undefined)).toEqual({});
  });
});

// Synthetic map-seam harness: a fake low-level server that is just
// { _requestHandlers, setRequestHandler, getClientVersion, _serverInfo }.
function fakeServer(callHandler: (req: any, extra?: any) => Promise<any>) {
  const handlers = new Map<string, any>();
  handlers.set("tools/call", callHandler);
  return {
    _requestHandlers: handlers,
    setRequestHandler() {},
    getClientVersion: () => undefined,
    _serverInfo: { name: "fake", version: "0" },
  } as any;
}

function trackFake(server: any) {
  setServerTrackingData(server, {
    projectId: "proj_test",
    options: {
      enableReportMissing: true,
      enableTracing: true,
      enableToolCallContext: true,
      enableAgentTracking: false,
    },
  });
  initEngineState(server, { adapter: v2Adapter });
  setInjectedParamsRegistry(
    server,
    new Map([["echo", new Set(["session_id", "context"])]]),
  );
  setOutputInjectionRegistry(server, new Set());
  installCallWrap(server);
  return server._requestHandlers.get("tools/call");
}

describe("installCallWrap (synthetic seam)", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    vi.clearAllMocks();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("strips registry-scoped args before the original handler, keeps raw on the event", async () => {
    let seenArgs: any;
    const server = fakeServer(async (req) => {
      seenArgs = req.params.arguments;
      return { content: [{ type: "text", text: "ok" }] };
    });
    const wrapped = trackFake(server);
    const result = await wrapped(
      {
        method: "tools/call",
        params: {
          name: "echo",
          arguments: {
            msg: "hi",
            session_id: sid("supplied"),
            context: "why",
          },
        },
      },
      {},
    );
    expect(seenArgs).toEqual({ msg: "hi" });
    // supplied task honored + mint-back only mints agent/nothing new
    const events = capture.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].sessionId).toBe(sid("supplied"));
    expect(
      (events[0].parameters as any).request.params.arguments.session_id,
    ).toBe(sid("supplied"));
    expect(result.content.length).toBeGreaterThanOrEqual(1);
  });

  it("tags intermediate input_required rounds and skips mint-back on them", async () => {
    const server = fakeServer(async () => ({
      resultType: "input_required",
      inputRequests: [{ id: "q1" }],
    }));
    const wrapped = trackFake(server);
    const result = await wrapped(
      {
        method: "tools/call",
        params: { name: "echo", arguments: { msg: "x" } },
      },
      { mcpReq: { inputResponses: undefined } },
    );
    expect(result.resultType).toBe("input_required");
    expect(result.content).toBeUndefined(); // untouched — no mint-back append
    const [event] = capture.getEvents();
    expect(event.tags?.agentcat_mrtr).toBe("input_required");
  });

  it("tags continuation rounds from mcpReq.inputResponses", async () => {
    const server = fakeServer(async () => ({ content: [] }));
    const wrapped = trackFake(server);
    await wrapped(
      {
        method: "tools/call",
        params: { name: "echo", arguments: { msg: "x" } },
      },
      { mcpReq: { inputResponses: { q1: { value: "answer" } } } },
    );
    const [event] = capture.getEvents();
    expect(event.tags?.agentcat_mrtr).toBe("continuation");
  });

  it("answers get_more_tools directly and publishes its event", async () => {
    const server = fakeServer(async () => {
      throw new Error("should not reach original handler");
    });
    const wrapped = trackFake(server);
    const result = await wrapped(
      {
        method: "tools/call",
        params: {
          name: "get_more_tools",
          arguments: { context: "need csv export" },
        },
      },
      {},
    );
    expect(result.content[0].text).toContain("full tool list");
    const [event] = capture.getEvents();
    expect(event.resourceName).toBe("get_more_tools");
    expect(event.userIntent).toBe("need csv export");
  });

  it("publishes an error event with __agentcat_error stack when present", async () => {
    const server = fakeServer(async (_req, extra) => {
      (extra as any).__agentcat_error = new Error("inner boom");
      return { content: [], isError: true };
    });
    const wrapped = trackFake(server);
    await wrapped(
      { method: "tools/call", params: { name: "echo", arguments: {} } },
      {},
    );
    const [event] = capture.getEvents();
    expect(event.isError).toBe(true);
    expect(event.error?.message).toContain("inner boom");
  });

  it("degrades to the original handler with the UNSTRIPPED request when tracing setup fails", async () => {
    let seenArgs: any;
    const server = fakeServer(async (req) => {
      seenArgs = req.params.arguments;
      return { content: [{ type: "text", text: "ok" }] };
    });
    server.getClientVersion = () => {
      throw new Error("client info boom");
    };
    const wrapped = trackFake(server);
    const result = await wrapped(
      {
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { msg: "hi", session_id: "ses_x", context: "why" },
        },
      },
      {},
    );
    // Degraded: no stripping, no mint-back, no event — just the tool.
    expect(seenArgs).toEqual({
      msg: "hi",
      session_id: "ses_x",
      context: "why",
    });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect(capture.getEvents()).toHaveLength(0);
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "tracing failed for tool echo, falling back to original handler",
      ),
    );
  });

  it("answers get_more_tools directly on the degraded path, without publishing", async () => {
    const server = fakeServer(async () => {
      throw new Error("should not reach original handler");
    });
    server.getClientVersion = () => {
      throw new Error("client info boom");
    };
    const wrapped = trackFake(server);
    const result = await wrapped(
      {
        method: "tools/call",
        params: {
          name: "get_more_tools",
          arguments: { context: "need csv export" },
        },
      },
      {},
    );
    expect(result.content[0].text).toContain("full tool list");
    expect(capture.getEvents()).toHaveLength(0);
  });

  it("publishes an error event and rethrows when the original handler throws", async () => {
    const server = fakeServer(async () => {
      throw new Error("handler boom");
    });
    const wrapped = trackFake(server);
    await expect(
      wrapped(
        {
          method: "tools/call",
          params: { name: "echo", arguments: { msg: "x" } },
        },
        {},
      ),
    ).rejects.toThrow("handler boom");
    const [event] = capture.getEvents();
    expect(event).toBeDefined();
    expect(event.isError).toBe(true);
    expect(event.error?.message).toContain("handler boom");
    expect(event.duration).toBeGreaterThanOrEqual(0);
  });
});
