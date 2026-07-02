import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { track } from "../index.js";
import {
  flushDiagnostics,
  _resetDiagnosticsForTest,
} from "../modules/diagnostics.js";

describe("diagnostics integration with track()", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetDiagnosticsForTest();
    // Force-enable past the test-environment auto-disable; fetch is mocked.
    process.env.DISABLE_DIAGNOSTICS = "false";
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy;
  });
  afterEach(() => {
    _resetDiagnosticsForTest();
    globalThis.fetch = originalFetch;
    delete process.env.DISABLE_DIAGNOSTICS;
  });

  it("captures and ships diagnostics when track() runs on an invalid server", async () => {
    // Passing an incompatible server makes track() hit its catch → writeToLog.
    track({} as any, "proj_int");
    await flushDiagnostics();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const records = body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records.length).toBeGreaterThan(0);
  });

  it("ships nothing when disabled via option", async () => {
    track({} as any, "proj_int", { disableDiagnostics: true });
    await flushDiagnostics();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
