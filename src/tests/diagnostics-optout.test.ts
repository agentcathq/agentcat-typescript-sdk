// src/tests/diagnostics-optout.test.ts
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  initDiagnostics,
  isDiagnosticsEnabled,
  _resetDiagnosticsForTest,
} from "../modules/diagnostics.js";

function stubNonTestEnvironment() {
  vi.stubEnv("VITEST", undefined);
  vi.stubEnv("JEST_WORKER_ID", undefined);
  vi.stubEnv("NODE_ENV", undefined);
  vi.stubEnv("DISABLE_DIAGNOSTICS", undefined);
}

describe("diagnostics opt-out", () => {
  beforeEach(() => {
    _resetDiagnosticsForTest();
    delete process.env.DISABLE_DIAGNOSTICS;
  });
  afterEach(() => {
    _resetDiagnosticsForTest();
    vi.unstubAllEnvs();
    delete process.env.DISABLE_DIAGNOSTICS;
  });

  it("is enabled by default outside test environments", () => {
    stubNonTestEnvironment();
    initDiagnostics({ projectId: "proj_1" });
    expect(isDiagnosticsEnabled()).toBe(true);
  });

  it("is disabled via the option", () => {
    stubNonTestEnvironment();
    initDiagnostics({ projectId: "proj_1", disabled: true });
    expect(isDiagnosticsEnabled()).toBe(false);
  });

  it("is disabled via the env var", () => {
    stubNonTestEnvironment();
    vi.stubEnv("DISABLE_DIAGNOSTICS", "1");
    initDiagnostics({ projectId: "proj_1" });
    expect(isDiagnosticsEnabled()).toBe(false);
  });

  it.each(["true", "TRUE", "1", "yes", "on"])(
    "is disabled when DISABLE_DIAGNOSTICS=%s",
    (value) => {
      stubNonTestEnvironment();
      vi.stubEnv("DISABLE_DIAGNOSTICS", value);
      initDiagnostics({ projectId: "proj_1" });
      expect(isDiagnosticsEnabled()).toBe(false);
    },
  );

  // Per Kashish's review: a falsy-looking value must NOT disable diagnostics.
  // It is a deliberate opt-in that also overrides test-environment detection.
  it.each(["false", "FALSE", "0", "no", "off"])(
    "stays enabled when DISABLE_DIAGNOSTICS=%s",
    (value) => {
      process.env.DISABLE_DIAGNOSTICS = value;
      initDiagnostics({ projectId: "proj_1" });
      expect(isDiagnosticsEnabled()).toBe(true);
    },
  );

  it("treats a whitespace-only value as unset (default behavior applies)", () => {
    stubNonTestEnvironment();
    vi.stubEnv("DISABLE_DIAGNOSTICS", "  ");
    initDiagnostics({ projectId: "proj_1" });
    expect(isDiagnosticsEnabled()).toBe(true);
  });

  it.each([
    ["VITEST", "true"],
    ["JEST_WORKER_ID", "1"],
    ["NODE_ENV", "test"],
  ])("is disabled by default when %s=%s (test environment)", (name, value) => {
    stubNonTestEnvironment();
    vi.stubEnv(name, value);
    initDiagnostics({ projectId: "proj_1" });
    expect(isDiagnosticsEnabled()).toBe(false);
  });
});
