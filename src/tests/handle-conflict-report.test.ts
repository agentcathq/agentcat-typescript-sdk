import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../modules/logging", () => ({
  writeToLog: vi.fn(),
}));

import { writeToLog } from "../modules/logging.js";
import { addHandleParametersToTools } from "../modules/handle-injection.js";
import { buildInjectedList } from "../engine/listWrap.js";
import { getReportedConflicts } from "../engine/registry.js";
import { AgentCatData } from "../types.js";

beforeEach(() => {
  (writeToLog as any).mockClear();
});

function data(overrides: Partial<AgentCatData["options"]> = {}): AgentCatData {
  return {
    projectId: "proj_test",
    options: {
      enableReportMissing: false,
      enableTracing: true,
      enableToolCallContext: false,
      enableAgentTracking: false,
      ...overrides,
    },
  };
}

const ownSessionTool = () => ({
  name: "own_session",
  inputSchema: {
    type: "object",
    properties: { session_id: { type: "string" } },
  },
});

describe("session_id collision report", () => {
  it("reports a session_id collision once per tool, as an error with remediation", () => {
    const tool = {
      name: "own_session",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
      },
    } as any;
    const reportedConflicts = new Set<string>();
    const opts = {
      injectSessionId: true,
      injectAgentId: false,
      reportedConflicts,
    };

    addHandleParametersToTools([tool], opts, new Map());
    addHandleParametersToTools([tool], opts, new Map());
    addHandleParametersToTools([tool], opts, new Map());

    const collisionLogs = (writeToLog as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m: string) => m.includes("own_session"));

    expect(collisionLogs).toHaveLength(1);
    expect(collisionLogs[0]).toContain("ERROR:");
    expect(collisionLogs[0]).toContain("resolveSessionId");
    expect(collisionLogs[0]).toContain("without a session");
  });

  it("reports two different colliding tools each once", () => {
    const toolA = {
      name: "tool_a",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
      },
    } as any;
    const toolB = {
      name: "tool_b",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
      },
    } as any;
    const reportedConflicts = new Set<string>();
    const opts = {
      injectSessionId: true,
      injectAgentId: false,
      reportedConflicts,
    };

    addHandleParametersToTools([toolA, toolB], opts, new Map());
    addHandleParametersToTools([toolA, toolB], opts, new Map());

    const logsFor = (name: string) =>
      (writeToLog as any).mock.calls
        .map((c: any[]) => String(c[0]))
        .filter((m: string) => m.includes(name));

    expect(logsFor("tool_a")).toHaveLength(1);
    expect(logsFor("tool_b")).toHaveLength(1);
  });

  // Defensive-only path: listWrap always supplies a set, so this documents
  // what the `?.` guard does rather than any production behavior.
  it("logs the error even without a dedupe set — once per pass, no dedupe", () => {
    const tool = {
      name: "own_session",
      inputSchema: {
        type: "object",
        properties: { session_id: { type: "string" } },
      },
    } as any;
    const opts = {
      injectSessionId: true,
      injectAgentId: false,
    };

    expect(() =>
      addHandleParametersToTools([tool], opts, new Map()),
    ).not.toThrow();
    addHandleParametersToTools([tool], opts, new Map());

    const collisionLogs = (writeToLog as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m: string) => m.includes("own_session"));

    // Two passes, two logs: nothing remembers the first report.
    expect(collisionLogs).toHaveLength(2);
    expect(collisionLogs[0]).toContain("ERROR:");
    expect(collisionLogs[1]).toContain("ERROR:");
  });

  it("getReportedConflicts returns a stable set per key, and independent sets for different keys", () => {
    const keyA = {};
    const keyB = {};

    const setA1 = getReportedConflicts(keyA);
    const setA2 = getReportedConflicts(keyA);
    const setB = getReportedConflicts(keyB);

    // Same key -> same Set instance across calls (stable per-key storage).
    expect(setA2).toBe(setA1);
    // Different keys -> independent Sets, not the same object or shared state.
    expect(setB).not.toBe(setA1);

    setA1.add("tool_x");
    expect(setB.has("tool_x")).toBe(false);
    expect(getReportedConflicts(keyA).has("tool_x")).toBe(true);
  });

  it("buildInjectedList dedupes per AgentCatData object: repeat tools/list on the same server logs once, a second server logs its own once", () => {
    const serverA = data();
    const serverB = data();

    // Three tools/list passes on the same server (data object) -> one log.
    buildInjectedList(serverA, [ownSessionTool()]);
    buildInjectedList(serverA, [ownSessionTool()]);
    buildInjectedList(serverA, [ownSessionTool()]);

    const logsAfterServerA = (writeToLog as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m: string) => m.includes("own_session"));
    expect(logsAfterServerA).toHaveLength(1);

    // A distinct server (distinct AgentCatData object, e.g. a second track()
    // call) must not be silenced by serverA's report -- it gets its own.
    buildInjectedList(serverB, [ownSessionTool()]);
    buildInjectedList(serverB, [ownSessionTool()]);

    const logsAfterServerB = (writeToLog as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m: string) => m.includes("own_session"));
    expect(logsAfterServerB).toHaveLength(2);
  });
});
