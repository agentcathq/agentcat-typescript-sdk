import { describe, it, expect } from "vitest";
import { detectServer } from "../detect.js";

// Fake shapes only — no SDK imports. Mirrors the v2-project detect tests so
// the v1 per-project coverage report also exercises detect.ts's null paths.
describe("detectServer (fake shapes)", () => {
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

  it("detects fake high-level shells with .tool (v1) and registerTool (v2)", () => {
    const low = {
      setRequestHandler() {},
      _requestHandlers: new Map(),
    };
    expect(detectServer({ server: low, tool() {} })).toMatchObject({
      major: 1,
      flavor: "high",
    });
    expect(detectServer({ server: low, registerTool() {} })).toMatchObject({
      major: 2,
      flavor: "high",
    });
  });
});
