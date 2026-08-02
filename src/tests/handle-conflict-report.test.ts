import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../modules/logging", () => ({
  writeToLog: vi.fn(),
}));

import { writeToLog } from "../modules/logging.js";
import { addHandleParametersToTools } from "../modules/handle-injection.js";

beforeEach(() => {
  (writeToLog as any).mockClear();
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

  it("does not report when reportedConflicts is not provided", () => {
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

    const collisionLogs = (writeToLog as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m: string) => m.includes("own_session"));

    expect(collisionLogs).toHaveLength(1);
    expect(collisionLogs[0]).toContain("ERROR:");
  });
});
