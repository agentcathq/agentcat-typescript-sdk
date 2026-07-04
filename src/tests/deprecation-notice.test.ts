import { describe, it, expect, vi, afterEach } from "vitest";
import * as logging from "../modules/logging";
import { track } from "../index.js";
import { setupTestServerAndClient } from "./test-utils/client-server-factory";

describe("deprecation notice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the rename notice on track(), once per process", async () => {
    const spy = vi.spyOn(logging, "writeToLog").mockImplementation(() => {});
    const first = await setupTestServerAndClient();
    const second = await setupTestServerAndClient();
    try {
      track(first.server, "proj_test123");
      track(second.server, "proj_test456");

      const noticeCalls = spy.mock.calls.filter(([message]) =>
        message.includes("mcpcat has been renamed to agentcat"),
      );
      expect(noticeCalls).toHaveLength(1);
      expect(noticeCalls[0][0]).toContain("npm install agentcat");
      expect(noticeCalls[0][0]).toContain("MIGRATION.md");
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});
