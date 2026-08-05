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

function trackFake(server: any, overrides: Record<string, any> = {}) {
  setServerTrackingData(server, {
    projectId: "proj_test",
    options: {
      enableReportMissing: true,
      enableTracing: true,
      enableToolCallContext: true,
      enableAgentTracking: false,
      ...overrides,
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

describe("extra projection on captured events", () => {
  // The event pipeline (redact → sanitize → truncate) mutates queued events
  // in place asynchronously after add(); give it a beat before asserting.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

  let capture: EventCapture;
  beforeEach(async () => {
    vi.clearAllMocks();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  const okHandler = async () => ({
    content: [{ type: "text", text: "ok" }],
  });
  const callEcho = {
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "hi" } },
  };

  it("publishes v1-shaped extra with headers verbatim and url as a string", async () => {
    const wrapped = trackFake(fakeServer(okHandler));
    await wrapped(callEcho, {
      requestInfo: {
        headers: { "x-agentcat-health-run": "run:v1" },
        url: new URL("http://localhost:4105/mcp"),
      },
      authInfo: { token: "tok" },
    });
    await settle();

    const [event] = capture.getEvents();
    const extra = (event.parameters as any).extra;
    // Post-pipeline: values survived redact → sanitize → truncate.
    expect(extra.requestInfo.headers["x-agentcat-health-run"]).toBe("run:v1");
    expect(extra.requestInfo.url).toBe("http://localhost:4105/mcp");
    expect(extra.authInfo.token).toBe("tok");
  });

  it("publishes v2-shaped extra with the web Request as plain { method, url, headers }", async () => {
    const wrapped = trackFake(fakeServer(okHandler));
    await wrapped(callEcho, {
      sessionId: "transport-1",
      mcpReq: { id: 5 },
      http: {
        req: new Request("http://127.0.0.1:4105/mcp", {
          method: "POST",
          headers: { "x-agentcat-health-run": "run:ts_v2" },
        }),
      },
    });
    await settle();

    const [event] = capture.getEvents();
    const extra = (event.parameters as any).extra;
    expect(extra.http.req.method).toBe("POST");
    expect(extra.http.req.url).toBe("http://127.0.0.1:4105/mcp");
    expect(extra.http.req.headers["x-agentcat-health-run"]).toBe("run:ts_v2");
  });
});

describe("get_more_tools gating", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    vi.clearAllMocks();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  const callGetMoreTools = {
    method: "tools/call",
    params: { name: "get_more_tools", arguments: { context: "need csv" } },
  };

  it("does not intercept when enableReportMissing is false — the customer's own tool runs", async () => {
    let customerRan = 0;
    const server = fakeServer(async () => {
      customerRan++;
      return { content: [{ type: "text", text: "customer answer" }] };
    });
    const wrapped = trackFake(server, { enableReportMissing: false });

    const result = await wrapped(callGetMoreTools, {});

    expect(customerRan).toBe(1);
    const text = result.content.map((c: any) => c?.text ?? "").join(" ");
    expect(text).toContain("customer answer");
    expect(text).not.toContain("full tool list");
  });

  it("does not intercept on the tracing-off path when enableReportMissing is false", async () => {
    let customerRan = 0;
    const server = fakeServer(async () => {
      customerRan++;
      return { content: [{ type: "text", text: "customer answer" }] };
    });
    const wrapped = trackFake(server, {
      enableReportMissing: false,
      enableTracing: false,
    });

    const result = await wrapped(callGetMoreTools, {});

    expect(customerRan).toBe(1);
    expect(result.content[0].text).toBe("customer answer");
  });

  it("does not intercept on the degraded path when enableReportMissing is false", async () => {
    let customerRan = 0;
    const server = fakeServer(async () => {
      customerRan++;
      return { content: [{ type: "text", text: "customer answer" }] };
    });
    server.getClientVersion = () => {
      throw new Error("client info boom");
    };
    const wrapped = trackFake(server, { enableReportMissing: false });

    const result = await wrapped(callGetMoreTools, {});

    expect(customerRan).toBe(1);
    expect(result.content[0].text).toBe("customer answer");
  });
});

describe("deferred customer hooks", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    vi.clearAllMocks();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  const callEcho = {
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "hi" } },
  };
  const okHandler = async () => ({ content: [{ type: "text", text: "ok" }] });

  it("a hanging identify hook does not delay the tool call", async () => {
    const wrapped = trackFake(fakeServer(okHandler), {
      identify: () => new Promise(() => {}),
    });
    const result = await wrapped(callEcho, {});
    expect(result.content.some((c: any) => c?.text === "ok")).toBe(true);
  }, 2000);

  it("hanging resolveSessionId/eventTags/eventProperties do not delay the tool call", async () => {
    const never = () => new Promise<never>(() => {});
    const wrapped = trackFake(fakeServer(okHandler), {
      resolveSessionId: never,
      eventTags: never,
      eventProperties: never,
    });
    const result = await wrapped(callEcho, {});
    expect(result.content.some((c: any) => c?.text === "ok")).toBe(true);
  }, 2000);

  it("the handler starts before a slow hook settles", async () => {
    const order: string[] = [];
    let releaseHook!: () => void;
    const wrapped = trackFake(
      fakeServer(async () => {
        order.push("handler");
        return { content: [{ type: "text", text: "ok" }] };
      }),
      {
        identify: () =>
          new Promise((resolve) => {
            releaseHook = () => {
              order.push("hook settled");
              resolve({ userId: "u1" });
            };
          }),
      },
    );

    await wrapped(callEcho, {});
    releaseHook();
    await capture.flush();

    expect(order[0]).toBe("handler");
    const [event] = capture.getEvents();
    expect(event.identifyActorGivenId).toBe("u1");
  });

  it("a synchronously-throwing hook is contained and the event still publishes", async () => {
    const wrapped = trackFake(fakeServer(okHandler), {
      resolveSessionId: () => {
        throw new Error("sync hook boom");
      },
    });

    const result = await wrapped(callEcho, {});
    await capture.flush();

    expect(result.content.some((c: any) => c?.text === "ok")).toBe(true);
    const [event] = capture.getEvents();
    // Hook failure degrades to a silent mint, same as a thrown async hook.
    expect(event.sessionId).toMatch(/^ses_/);
    expect(event.tags?.agentcat_session_id_source).toBe("minted");
  });

  it("redactEvent sees resolved hook state, and pending never reaches it or the processed event", async () => {
    let hookInput: any;
    const wrapped = trackFake(fakeServer(okHandler), {
      identify: async () => ({ userId: "u-redact" }),
      eventTags: async () => ({ env: "prod" }),
      redactEvent: (e: any) => {
        hookInput = { ...e };
        return e;
      },
    });

    await wrapped(callEcho, {});
    await capture.flush();

    // Stage ordering: deferred hooks resolve BEFORE the redactEvent hook.
    expect(hookInput.identifyActorGivenId).toBe("u-redact");
    expect(hookInput.tags.env).toBe("prod");
    expect("pending" in hookInput).toBe(false);
    const [event] = capture.getEvents();
    expect((event as any).pending).toBeUndefined();
  });

  it("error-path events carry hook results resolved after the throw", async () => {
    const wrapped = trackFake(
      fakeServer(async () => {
        throw new Error("handler boom");
      }),
      {
        identify: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { userId: "late-user" };
        },
      },
    );

    await expect(wrapped(callEcho, {})).rejects.toThrow("handler boom");
    await capture.flush();

    const [event] = capture.getEvents();
    expect(event.isError).toBe(true);
    expect(event.identifyActorGivenId).toBe("late-user");
  });
});

describe("registry rebuild bounding", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    vi.clearAllMocks();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await capture.stop();
  });

  function setupWithoutRegistry(listHandler: () => Promise<any>) {
    const server = fakeServer(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    setServerTrackingData(server, {
      projectId: "proj_test",
      options: {
        enableReportMissing: true,
        enableTracing: true,
        enableToolCallContext: true,
        enableAgentTracking: false,
      },
    });
    // No injected-params registry: forces the rebuild-on-demand path.
    initEngineState(server, {
      adapter: v2Adapter,
      originalList: listHandler,
    });
    installCallWrap(server);
    return server._requestHandlers.get("tools/call");
  }

  it("bounds the rebuild: a hanging tools/list handler cannot hang tools/call", async () => {
    // Fake timers are restored inside the test so afterEach stays trivial —
    // a hook doing cleanup for a failed fake-timer state has blown CI's
    // hook timeout before.
    vi.useFakeTimers();
    try {
      const wrapped = setupWithoutRegistry(() => new Promise(() => {}));

      const resultPromise = wrapped(
        {
          method: "tools/call",
          params: { name: "echo", arguments: { msg: "hi" } },
        },
        {},
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;

      expect(result.content.some((c: any) => c?.text === "ok")).toBe(true);
      expect(writeToLog).toHaveBeenCalledWith(
        expect.stringContaining("rebuild-on-demand failed"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps serving calls when the list handler fails every time", async () => {
    const wrapped = setupWithoutRegistry(async () => {
      throw new Error("list boom");
    });

    for (let i = 0; i < 2; i++) {
      const result = await wrapped(
        {
          method: "tools/call",
          params: { name: "echo", arguments: { msg: "hi" } },
        },
        {},
      );
      expect(result.content.some((c: any) => c?.text === "ok")).toBe(true);
    }
  });
});

describe("finish() fault containment", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    vi.clearAllMocks();
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  const callEcho = {
    method: "tools/call",
    params: { name: "echo", arguments: { msg: "hi" } },
  };

  it("returns the customer's isError result when a content entry is null", async () => {
    // A v1 low-level server never validates result shape, so a handler can
    // legitimately return a content array with a null hole.
    const customerResult = {
      isError: true,
      content: [null, { type: "text", text: "quota exceeded, retry later" }],
    };
    const wrapped = trackFake(fakeServer(async () => customerResult));

    const result = await wrapped(callEcho, {});

    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining(customerResult.content),
    );
  });

  it("returns the raw customer result when post-handler decoration throws", async () => {
    // Array.isArray passes but spreading throws — trips appendMintBack
    // inside finish() after the handler has already succeeded.
    const evil: any = [{ type: "text", text: "ok" }];
    evil[Symbol.iterator] = () => {
      throw new Error("decoration boom");
    };
    const customerResult = { content: evil };
    const wrapped = trackFake(fakeServer(async () => customerResult));

    const result = await wrapped(callEcho, {});

    expect(result).toBe(customerResult);
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("post-handler"),
    );
  });
});
