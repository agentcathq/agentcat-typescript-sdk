import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the logging module (convention: see compatibility.test.ts)
vi.mock("../modules/logging", () => ({
  writeToLog: vi.fn(),
}));

import { writeToLog } from "../modules/logging.js";
import {
  wrapToolEntry,
  rewrapAllTools,
  installRegistryProxy,
} from "../engine/innerTap.js";
import { setInjectedParamsRegistry } from "../engine/registry.js";
import { v1Adapter } from "../adapters/v1.js";
import { v2Adapter } from "../adapters/v2.js";
import { Server as V1Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { patchSetRequestHandler } from "../engine/registrationPatch.js";

describe("wrapToolEntry", () => {
  it("wraps v2 executor in place: strips injected args, preserves customer args", async () => {
    const server = {};
    setInjectedParamsRegistry(
      server,
      new Map([["echo", new Set(["task_id", "context"])]]),
    );
    let seen: any;
    const tool = {
      executor: async (args: any, _ctx: any) => {
        seen = args;
        return { content: [] };
      },
    };
    wrapToolEntry(tool, "echo", server as any, v2Adapter);
    await tool.executor(
      { msg: "hi", task_id: "ses_x", context: "why" },
      { sessionId: undefined },
    );
    expect(seen).toEqual({ msg: "hi" });
  });

  it("captures thrown errors onto extra.__agentcat_error and rethrows", async () => {
    const server = {};
    const boom = new Error("boom");
    const tool = {
      handler: async (_args: any, _extra: any) => {
        throw boom;
      },
    };
    wrapToolEntry(tool, "t", server as any, v1Adapter);
    const extra: any = {};
    await expect(tool.handler({ a: 1 }, extra)).rejects.toThrow("boom");
    expect(extra.__agentcat_error).toBe(boom);
  });

  it("supports the v1 no-args callback arity (extra only)", async () => {
    const server = {};
    let gotExtra: any;
    const tool = {
      callback: async (extra: any) => {
        gotExtra = extra;
        return { content: [] };
      },
    };
    wrapToolEntry(tool, "t", server as any, v1Adapter);
    const extra = { sessionId: "s" };
    await (tool.callback as any)(extra);
    expect(gotExtra).toBe(extra);
  });

  it("preserves ctx position for v2 schema-less executors (args undefined)", async () => {
    const server = {};
    let seenCtx: any;
    const tool = {
      executor: async (_args: any, ctx: any) => {
        seenCtx = ctx;
        return { content: [] };
      },
    };
    wrapToolEntry(tool, "t", server as any, v2Adapter);
    // v2 dispatch always invokes executor(args, ctx) with two positional
    // arguments — for schema-less tools args is undefined but ctx must
    // stay in position 2.
    await tool.executor(undefined, { sessionId: "s" });
    expect(seenCtx).toEqual({ sessionId: "s" });
  });

  it("is idempotent — wrapping twice does not double-wrap", async () => {
    const server = {};
    let calls = 0;
    const tool = {
      executor: async () => {
        calls++;
        return { content: [] };
      },
    };
    wrapToolEntry(tool, "t", server as any, v2Adapter);
    const once = tool.executor;
    wrapToolEntry(tool, "t", server as any, v2Adapter);
    expect(tool.executor).toBe(once);
    await tool.executor(undefined as any, {});
    expect(calls).toBe(1);
  });

  it("rewrapAllTools sweeps every registry entry", async () => {
    const server = {};
    const a = { executor: async () => ({ content: [] }) };
    const b = { executor: async () => ({ content: [] }) };
    const high = { _registeredTools: { a, b }, server } as any;
    rewrapAllTools(server as any, high, v2Adapter);
    const wrappedA = a.executor;
    rewrapAllTools(server as any, high, v2Adapter);
    expect(a.executor).toBe(wrappedA); // idempotent
    expect(b.executor).not.toBeUndefined();
  });
});

// AgentCat failure must never break the customer's server: every fault below
// stays contained — logged, swallowed, and the customer's registration wins.
describe("inner-tap fault containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rewrapAllTools swallows a _registeredTools whose enumeration throws", () => {
    const server = {};
    const tools = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys boom");
        },
      },
    );
    const high = { _registeredTools: tools } as any;
    expect(() => rewrapAllTools(server as any, high, v2Adapter)).not.toThrow();
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("inner-tap sweep failed"),
    );
  });

  it("registry proxy set-trap: a tool whose executor getter throws still lands in the registry", () => {
    const server = {};
    const high = { _registeredTools: {} } as any;
    let registrations = 0;
    installRegistryProxy(server as any, high, v2Adapter, () => registrations++);

    const evil: any = {};
    Object.defineProperty(evil, "executor", {
      enumerable: true,
      get() {
        throw new Error("getter boom");
      },
    });
    expect(() => {
      high._registeredTools.evil = evil;
    }).not.toThrow();
    // Reflect.set fallback: the customer's tool must still be registered.
    expect("evil" in high._registeredTools).toBe(true);
    expect(Object.keys(high._registeredTools)).toContain("evil");
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("Error in registry proxy for tool evil"),
    );
  });

  it("installRegistryProxy swallows a highLevel whose _registeredTools assignment throws", () => {
    const high: any = {};
    Object.defineProperty(high, "_registeredTools", {
      get: () => ({}),
      set() {
        throw new Error("assignment boom");
      },
    });
    expect(() =>
      installRegistryProxy({} as any, high, v2Adapter, () => {}),
    ).not.toThrow();
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("Failed to setup listener for registered tools"),
    );
  });
});

describe("patchSetRequestHandler on v1", () => {
  it("introspects Zod schema registrations for the method literal", () => {
    const server = new V1Server(
      { name: "t", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    let fired = 0;
    patchSetRequestHandler(server as any, () => fired++);
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [],
    }));
    expect(fired).toBe(1);
  });

  it("registration still succeeds when the re-arm callback throws", () => {
    vi.clearAllMocks();
    const server: any = {
      _requestHandlers: new Map<string, any>(),
      setRequestHandler(method: string, handler: any) {
        this._requestHandlers.set(method, handler);
      },
    };
    patchSetRequestHandler(server, () => {
      throw new Error("re-arm boom");
    });
    const handler = async () => ({ content: [] });
    expect(() => server.setRequestHandler("tools/call", handler)).not.toThrow();
    // The customer's handler landed despite our callback exploding.
    expect(server._requestHandlers.get("tools/call")).toBe(handler);
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("engine re-arm failed"),
    );
  });
});
