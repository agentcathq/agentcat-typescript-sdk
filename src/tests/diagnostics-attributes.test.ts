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
    expect(m["mcpcat.project_id"]).toBe("proj_ABC");
    expect(m["mcpcat.install_id"]).toBeUndefined();
  });

  it("falls back to a stable install_id when projectId is absent", () => {
    initDiagnostics({ projectId: null });
    const a = asMap(_getStaticAttributesForTest());
    expect(a["mcpcat.project_id"]).toBeUndefined();
    expect(a["mcpcat.install_id"]).toBeTruthy();

    // Stability: same environment → same install_id across inits.
    _resetDiagnosticsForTest();
    initDiagnostics({ projectId: null });
    const b = asMap(_getStaticAttributesForTest());
    expect(b["mcpcat.install_id"]).toBe(a["mcpcat.install_id"]);
  });

  it("includes sdk language, sdk version, and os/runtime metadata", () => {
    initDiagnostics({ projectId: "proj_1" });
    const m = asMap(_getStaticAttributesForTest());
    expect(m["mcpcat.sdk.language"]).toBe("typescript");
    expect(m["mcpcat.sdk.version"]).toBeTruthy();
    expect(m["os.type"]).toBeTruthy();
    expect(m["process.runtime.name"]).toBeTruthy();
  });
});
