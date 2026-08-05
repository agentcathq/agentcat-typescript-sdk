// src/tests/diagnostics-record.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initDiagnostics,
  _buildRecordForTest,
  _resetDiagnosticsForTest,
} from "../modules/diagnostics.js";
import packageJson from "../../package.json" with { type: "json" };

function asMap(attrs: { key: string; value: { stringValue: string } }[]) {
  return Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
}

describe("diagnostics record building", () => {
  beforeEach(() => {
    _resetDiagnosticsForTest();
    initDiagnostics({ projectId: "proj_1" });
  });
  afterEach(() => _resetDiagnosticsForTest());

  it("carries the raw message as the body, verbatim", () => {
    const rec = _buildRecordForTest("[2026-01-01T00:00:00Z] Warning: boom");
    expect(rec.body.stringValue).toBe("[2026-01-01T00:00:00Z] Warning: boom");
  });

  it("infers severity from message content", () => {
    expect(_buildRecordForTest("Warning: x").severityText).toBe("WARN");
    expect(_buildRecordForTest("Failed to send event").severityText).toBe(
      "ERROR",
    );
    expect(_buildRecordForTest("Some error happened").severityText).toBe(
      "ERROR",
    );
    expect(_buildRecordForTest("Initialized telemetry").severityText).toBe(
      "INFO",
    );
  });

  it("prioritizes fail/error over the Warning prefix", () => {
    expect(
      _buildRecordForTest("Warning: Failed to track server - boom")
        .severityText,
    ).toBe("ERROR");
    expect(_buildRecordForTest("warning: nothing here").severityText).toBe(
      "INFO",
    );
    expect(_buildRecordForTest("").severityText).toBe("INFO");
  });

  it("sets a nanosecond timestamp string", () => {
    const rec = _buildRecordForTest("hello");
    expect(rec.timeUnixNano).toMatch(/^\d+$/);
  });

  it("attaches sdk, node, and mcp versions as record attributes", () => {
    const m = asMap(_buildRecordForTest("hello").attributes);
    expect(m["agentcat.sdk.version"]).toBe(packageJson.version);
    expect(m["process.runtime.version"]).toBe(process.version);
    expect(m["agentcat.mcp_sdk.version"]).toMatch(/^1\./); // devDep is ~1.30.0
    expect(m["agentcat.mcp_sdk_v2.version"]).toMatch(/^2\./); // devDep is ^2
  });
});
