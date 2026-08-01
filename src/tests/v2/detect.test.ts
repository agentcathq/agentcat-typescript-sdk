import { describe, it, expect } from "vitest";
import {
  Server as ServerV2,
  McpServer as McpServerV2,
} from "@modelcontextprotocol/server";
import { Server as ServerV1 } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  detectServer,
  describeSignals,
  fingerprintServerShape,
} from "../../detect.js";

describe("detectServer", () => {
  it("detects a v1 high-level McpServer", () => {
    const s = new McpServerV1({ name: "t", version: "1.0.0" });
    const d = detectServer(s);
    expect(d).toMatchObject({ major: 1, flavor: "high" });
    expect(d!.lowLevel).toBe((s as any).server);
    expect(d!.highLevel).toBe(s);
  });

  it("detects a v1 low-level Server", () => {
    const s = new ServerV1(
      { name: "t", version: "1.0.0" },
      { capabilities: {} },
    );
    const d = detectServer(s);
    expect(d).toMatchObject({ major: 1, flavor: "low" });
    expect(d!.lowLevel).toBe(s);
  });

  it("detects a v2 high-level McpServer (no .tool method)", () => {
    const s = new McpServerV2(
      { name: "t", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const d = detectServer(s);
    expect(d).toMatchObject({ major: 2, flavor: "high" });
    expect((s as any).tool).toBeUndefined();
    expect(d!.lowLevel).toBe((s as any).server);
  });

  it("detects a v2 low-level Server", () => {
    const s = new ServerV2(
      { name: "t", version: "1.0.0" },
      { capabilities: {} },
    );
    const d = detectServer(s);
    expect(d).toMatchObject({ major: 2, flavor: "low" });
  });

  it("returns null for non-server shapes", () => {
    expect(detectServer(null)).toBeNull();
    expect(detectServer("nope")).toBeNull();
    expect(detectServer({})).toBeNull();
    expect(detectServer({ server: {} })).toBeNull(); // high-level shell, no signals
    expect(
      detectServer({ setRequestHandler() {}, _requestHandlers: {} }), // not a Map
    ).toBeNull();
  });

  it("returns null for a high-level shell passing low-level gates but with neither .tool nor registerTool", () => {
    const shape = {
      server: {
        setRequestHandler() {},
        _requestHandlers: new Map(),
        getClientVersion() {},
        _serverInfo: { name: "x" },
      },
    };
    expect(detectServer(shape)).toBeNull();
  });

  it("describeSignals lists only true signals", () => {
    expect(describeSignals({ a: true, b: false, c: true })).toBe("a,c");
  });
});

describe("fingerprintServerShape", () => {
  it("reports the same signals detection computes for a v2 McpServer", () => {
    const s = new McpServerV2(
      { name: "t", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const names = fingerprintServerShape(s).split(",");
    expect(names).toContain("hasServerProp");
    expect(names).toContain("hasRegisterTool");
    expect(names).not.toContain("hasTool");
  });

  it("returns the empty string for null and non-objects", () => {
    expect(fingerprintServerShape(null)).toBe("");
    expect(fingerprintServerShape(undefined)).toBe("");
    expect(fingerprintServerShape("nope")).toBe("");
    expect(fingerprintServerShape(42)).toBe("");
  });
});
