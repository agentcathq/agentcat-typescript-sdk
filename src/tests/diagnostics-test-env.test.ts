// src/tests/diagnostics-test-env.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { track } from "../index.js";
import {
  flushDiagnostics,
  initDiagnostics,
  isDiagnosticsEnabled,
  _resetDiagnosticsForTest,
} from "../modules/diagnostics.js";

describe("diagnostics are disabled in test environments", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetDiagnosticsForTest();
    // Simulate a customer test suite with no explicit opt-out; vitest itself
    // provides the test-environment signals (VITEST, NODE_ENV=test).
    delete process.env.DISABLE_DIAGNOSTICS;
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy;
  });
  afterEach(() => {
    _resetDiagnosticsForTest();
    globalThis.fetch = originalFetch;
    delete process.env.DISABLE_DIAGNOSTICS;
  });

  it("track() without options does not enable diagnostics under vitest", async () => {
    track({} as any, "proj_test_env");
    expect(isDiagnosticsEnabled()).toBe(false);
    await flushDiagnostics();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("DISABLE_DIAGNOSTICS=false force-enables diagnostics even under vitest", () => {
    process.env.DISABLE_DIAGNOSTICS = "false";
    initDiagnostics({ projectId: "proj_test_env" });
    expect(isDiagnosticsEnabled()).toBe(true);
  });
});
