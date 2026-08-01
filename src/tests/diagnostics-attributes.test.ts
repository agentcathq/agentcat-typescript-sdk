// src/tests/diagnostics-attributes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  initDiagnostics,
  _getStaticAttributesForTest,
  _resetDiagnosticsForTest,
} from "../modules/diagnostics.js";

function asMap(attrs: { key: string; value: { stringValue: string } }[]) {
  return Object.fromEntries(attrs.map((a) => [a.key, a.value.stringValue]));
}

describe("diagnostics static attributes", () => {
  beforeEach(() => {
    _resetDiagnosticsForTest();
    // Force-enable past the test-environment auto-disable.
    process.env.DISABLE_DIAGNOSTICS = "false";
  });
  afterEach(() => {
    _resetDiagnosticsForTest();
    delete process.env.DISABLE_DIAGNOSTICS;
  });

  it("uses projectId verbatim when present", () => {
    initDiagnostics({ projectId: "proj_ABC" });
    const m = asMap(_getStaticAttributesForTest());
    expect(m["agentcat.project_id"]).toBe("proj_ABC");
    expect(m["agentcat.install_id"]).toBeUndefined();
  });

  it("falls back to a stable install_id when projectId is absent", () => {
    initDiagnostics({ projectId: null });
    const a = asMap(_getStaticAttributesForTest());
    expect(a["agentcat.project_id"]).toBeUndefined();
    expect(a["agentcat.install_id"]).toBeTruthy();

    // Stability: same environment → same install_id across inits.
    _resetDiagnosticsForTest();
    initDiagnostics({ projectId: null });
    const b = asMap(_getStaticAttributesForTest());
    expect(b["agentcat.install_id"]).toBe(a["agentcat.install_id"]);
  });

  it("includes sdk language, sdk version, and os/runtime metadata", () => {
    initDiagnostics({ projectId: "proj_1" });
    const m = asMap(_getStaticAttributesForTest());
    expect(m["agentcat.sdk.language"]).toBe("typescript");
    expect(m["agentcat.sdk.version"]).toBeTruthy();
    expect(m["os.type"]).toBeTruthy();
    expect(m["process.runtime.name"]).toBeTruthy();
  });

  it("reports the installed v1 SDK version despite the exports stub", () => {
    _resetDiagnosticsForTest();
    initDiagnostics({ projectId: "proj_test", disabled: false });
    const attrs = _getStaticAttributesForTest();
    const v1 = attrs.find((a) => a.key === "agentcat.mcp_sdk.version");
    expect(v1?.value.stringValue).toMatch(/^1\./); // devDep is ~1.30.0
  });

  it("reports the installed v2 SDK version despite sealed exports", () => {
    _resetDiagnosticsForTest();
    initDiagnostics({ projectId: "proj_test", disabled: false });
    const attrs = _getStaticAttributesForTest();
    const v2 = attrs.find((a) => a.key === "agentcat.mcp_sdk_v2.version");
    expect(v2?.value.stringValue).toMatch(/^2\./); // devDep is ^2
  });
});
