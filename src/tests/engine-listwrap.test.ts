import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the logging module (convention: see compatibility.test.ts)
vi.mock("../modules/logging", () => ({
  writeToLog: vi.fn(),
}));

import { writeToLog } from "../modules/logging.js";
import { buildInjectedList, installListWrap } from "../engine/listWrap.js";
import {
  initEngineState,
  getInjectedParamsRegistry,
} from "../engine/registry.js";
import { v2Adapter } from "../adapters/v2.js";
import { setServerTrackingData } from "../modules/internal.js";
import { AgentCatData } from "../types.js";

function data(overrides: Partial<AgentCatData["options"]> = {}): AgentCatData {
  return {
    projectId: "proj_test",
    options: {
      enableReportMissing: true,
      enableTracing: true,
      enableToolCallContext: true,
      enableAgentTracking: false,
      ...overrides,
    },
  };
}

const echoTool = () => ({
  name: "echo",
  description: "Echo",
  inputSchema: {
    type: "object",
    properties: { msg: { type: "string" } },
    required: ["msg"],
  },
});

describe("buildInjectedList", () => {
  it("appends get_more_tools and injects session_id + context", () => {
    const { tools, registry, outputRegistry } = buildInjectedList(data(), [
      echoTool(),
    ]);
    const names = tools.map((t: any) => t.name);
    expect(names).toEqual(["echo", "get_more_tools"]);
    const echo = tools[0] as any;
    expect(echo.inputSchema.properties.session_id).toBeDefined();
    expect(echo.inputSchema.properties.context).toBeDefined();
    expect(registry.get("echo")).toEqual(new Set(["session_id", "context"]));
    // get_more_tools gets handles but keeps its bespoke context param
    expect(registry.get("get_more_tools")).toEqual(new Set(["session_id"]));
    expect(outputRegistry.size).toBe(0); // no outputSchema declared
  });

  it("skips get_more_tools when enableReportMissing is false", () => {
    const { tools } = buildInjectedList(data({ enableReportMissing: false }), [
      echoTool(),
    ]);
    expect(tools.map((t: any) => t.name)).toEqual(["echo"]);
  });

  it("skips handle injection entirely when tracing is off, but still registers empty entries", () => {
    const { tools, registry } = buildInjectedList(
      data({ enableTracing: false, enableToolCallContext: false }),
      [echoTool()],
    );
    expect((tools[0] as any).inputSchema.properties.session_id).toBeUndefined();
    expect(registry.get("echo")).toEqual(new Set());
  });

  it("does not mutate the input tool objects", () => {
    const input = echoTool();
    buildInjectedList(data(), [input]);
    expect(input.inputSchema.properties).not.toHaveProperty("session_id");
  });
});

// Synthetic map-seam harness (crib of engine-callwrap.test.ts's fakeServer):
// a fake low-level server that is just the four probed properties.
function fakeListServer(listHandler: (req: any, extra?: any) => Promise<any>) {
  const handlers = new Map<string, any>();
  handlers.set("tools/list", listHandler);
  return {
    _requestHandlers: handlers,
    setRequestHandler() {},
    getClientVersion: () => undefined,
    _serverInfo: { name: "fake", version: "0" },
  } as any;
}

describe("installListWrap (synthetic seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the original response through verbatim and warns when tracking data is missing", async () => {
    const originalResponse = {
      tools: [echoTool()],
      nextCursor: "page-2",
    };
    const server = fakeListServer(async () => originalResponse);
    // Engine state but NO tracking data.
    initEngineState(server, { adapter: v2Adapter });
    installListWrap(server);
    const wrapped = server._requestHandlers.get("tools/list");
    const res = await wrapped({ method: "tools/list", params: {} }, {});
    expect(res).toBe(originalResponse); // same object, untouched
    expect(res.tools).toHaveLength(1);
    expect(res.tools[0].name).toBe("echo");
    expect(res.nextCursor).toBe("page-2");
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("unable to find server tracking data"),
    );
  });

  it("passes through and warns on empty or missing tools; registries stay unset", async () => {
    let response: any = { tools: [] };
    const server = fakeListServer(async () => response);
    setServerTrackingData(server, data());
    initEngineState(server, { adapter: v2Adapter });
    installListWrap(server);
    const wrapped = server._requestHandlers.get("tools/list");

    const emptyRes = await wrapped({ method: "tools/list", params: {} }, {});
    expect(emptyRes).toBe(response);
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("No tools found in the original list"),
    );
    expect(getInjectedParamsRegistry(server)).toBeUndefined();

    vi.clearAllMocks();
    response = {}; // no tools key at all
    const noToolsRes = await wrapped({ method: "tools/list", params: {} }, {});
    expect(noToolsRes).toBe(response);
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("No tools found in the original list"),
    );
    expect(getInjectedParamsRegistry(server)).toBeUndefined();
  });
});

describe("tools/list fault containment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function listWith(tools: any[]) {
    const server = fakeListServer(async () => ({ tools }));
    setServerTrackingData(server, data());
    initEngineState(server, { adapter: v2Adapter });
    installListWrap(server);
    const wrapped = server._requestHandlers.get("tools/list");
    return {
      server,
      res: await wrapped({ method: "tools/list", params: {} }, {}),
    };
  }

  it("lists a boolean-schema tool uninjected while the healthy tool keeps its handles", async () => {
    // JSON Schema allows `true` as a schema; property assignment on the
    // primitive throws in strict mode.
    const { res } = await listWith([
      { name: "poison", description: "p", inputSchema: true },
      echoTool(),
    ]);
    const byName = Object.fromEntries(res.tools.map((t: any) => [t.name, t]));
    expect(byName.poison.inputSchema).toBe(true); // passed through untouched
    expect(byName.echo.inputSchema.properties.session_id).toBeDefined();
    expect(byName.echo.inputSchema.properties.context).toBeDefined();
    expect(writeToLog).toHaveBeenCalledWith(expect.stringContaining("poison"));
  });

  it("passes a null tools-array entry through and injects the rest", async () => {
    const { res } = await listWith([null, echoTool()]);
    expect(res.tools).toContain(null);
    const echo = res.tools.find((t: any) => t?.name === "echo");
    expect(echo.inputSchema.properties.session_id).toBeDefined();
  });

  it("lists a circular-schema tool uninjected without failing the listing", async () => {
    const node: any = { type: "object", properties: {} };
    node.properties.children = { type: "array", items: node };
    const { res } = await listWith([
      { name: "recursive", description: "r", inputSchema: node },
      echoTool(),
    ]);
    const recursive = res.tools.find((t: any) => t?.name === "recursive");
    expect(recursive.inputSchema).toBe(node); // untouched original
    const echo = res.tools.find((t: any) => t?.name === "echo");
    expect(echo.inputSchema.properties.session_id).toBeDefined();
  });

  it("lists a BigInt-carrying schema uninjected without failing the listing", async () => {
    const { res } = await listWith([
      {
        name: "bigint",
        description: "b",
        inputSchema: {
          type: "object",
          properties: { n: { type: "integer", maximum: 9007199254740993n } },
        },
      },
      echoTool(),
    ]);
    expect(res.tools.find((t: any) => t?.name === "bigint")).toBeDefined();
    const echo = res.tools.find((t: any) => t?.name === "echo");
    expect(echo.inputSchema.properties.session_id).toBeDefined();
  });

  it("warns once when the customer owns get_more_tools while report-missing is enabled", async () => {
    const customerTool = {
      name: "get_more_tools",
      description: "customer version",
      inputSchema: { type: "object", properties: {} },
    };
    const server = fakeListServer(async () => ({
      tools: [customerTool, echoTool()],
    }));
    setServerTrackingData(server, data());
    initEngineState(server, { adapter: v2Adapter });
    installListWrap(server);
    const wrapped = server._requestHandlers.get("tools/list");

    const res = await wrapped({ method: "tools/list", params: {} }, {});
    await wrapped({ method: "tools/list", params: {} }, {});

    // Customer's descriptor is kept, not replaced.
    const listed = res.tools.filter((t: any) => t?.name === "get_more_tools");
    expect(listed).toHaveLength(1);
    expect(listed[0].description).toBe("customer version");
    // Shadow warning is one-time, not per listing.
    const shadowWarns = (writeToLog as any).mock.calls.filter((c: any[]) =>
      String(c[0]).includes("shadow"),
    );
    expect(shadowWarns).toHaveLength(1);
  });

  it("returns the customer's original listing when the whole pipeline fails", async () => {
    // Array.isArray passes, but the spread inside buildInjectedList throws —
    // upstream of the per-tool guards.
    const evil: any = [echoTool()];
    evil[Symbol.iterator] = () => {
      throw new Error("pipeline boom");
    };
    const originalResponse = { tools: evil, nextCursor: "p2" };
    const server = fakeListServer(async () => originalResponse);
    setServerTrackingData(server, data());
    initEngineState(server, { adapter: v2Adapter });
    installListWrap(server);
    const wrapped = server._requestHandlers.get("tools/list");

    const res = await wrapped({ method: "tools/list", params: {} }, {});

    expect(res).toBe(originalResponse);
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("serving the original tool list"),
    );
  });
});
