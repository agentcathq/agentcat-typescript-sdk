// src/tests/diagnostics-export.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeToLog } from "../modules/logging.js";
import {
  initDiagnostics,
  flushDiagnostics,
  _resetDiagnosticsForTest,
} from "../modules/diagnostics.js";

describe("diagnostics export", () => {
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

  it("POSTs buffered entries as OTLP logs JSON to /v1/logs", async () => {
    initDiagnostics({ projectId: "proj_1" });
    writeToLog("Warning: something happened");
    await flushDiagnostics();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/v1\/logs$/);
    const body = JSON.parse((opts as any).body);
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body.stringValue).toContain("something happened");
    const resAttrs = Object.fromEntries(
      body.resourceLogs[0].resource.attributes.map((a: any) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(resAttrs["agentcat.project_id"]).toBe("proj_1");
  });

  it("resolves even when fetch rejects (fire-and-forget isolation)", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    initDiagnostics({ projectId: "proj_1" });
    writeToLog("Failed to send event");
    await expect(flushDiagnostics()).resolves.toBeUndefined();
  });

  it("does nothing when disabled", async () => {
    initDiagnostics({ projectId: "proj_1", disabled: true });
    writeToLog("Warning: ignored");
    await flushDiagnostics();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
