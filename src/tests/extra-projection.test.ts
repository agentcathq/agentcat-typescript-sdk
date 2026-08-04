import { describe, it, expect, vi } from "vitest";

// Mock the logging module (convention: see engine-callwrap.test.ts)
vi.mock("../modules/logging", () => ({
  writeToLog: vi.fn(),
}));

import { projectExtraForEvent } from "../modules/extra-projection.js";

describe("projectExtraForEvent", () => {
  describe("v2: web Request under http.req", () => {
    it("projects a real Request into plain { method, url, headers }", () => {
      const req = new Request("http://localhost:4105/mcp", {
        method: "POST",
        headers: { "x-agentcat-health-run": "run:server" },
      });
      const authInfo = { token: "t" };
      const mcpReq = { id: 7 };
      const extra = { sessionId: "s", mcpReq, http: { authInfo, req } };

      const out = projectExtraForEvent(extra) as any;

      expect(out.http.req).toEqual({
        method: "POST",
        url: "http://localhost:4105/mcp",
        headers: expect.objectContaining({
          "x-agentcat-health-run": "run:server",
        }),
      });
      // The whole point: the header survives plain JSON serialization.
      const roundTrip = JSON.parse(JSON.stringify(out));
      expect(roundTrip.http.req.headers["x-agentcat-health-run"]).toBe(
        "run:server",
      );
      // Only the rewritten levels are copied; siblings pass by reference.
      expect(out.http.authInfo).toBe(authInfo);
      expect(out.mcpReq).toBe(mcpReq);
      expect(out.sessionId).toBe("s");
    });

    it("lowercases header names (Headers semantics)", () => {
      const req = new Request("http://localhost/", {
        headers: { "X-Mixed-Case": "v" },
      });
      const out = projectExtraForEvent({ http: { req } }) as any;
      expect(out.http.req.headers["x-mixed-case"]).toBe("v");
      expect(out.http.req.headers["X-Mixed-Case"]).toBeUndefined();
    });

    it("is idempotent: a projected req has no headers.entries and passes through", () => {
      const req = new Request("http://localhost/", {
        headers: { "x-a": "1" },
      });
      const first = projectExtraForEvent({ http: { req } });
      const second = projectExtraForEvent(first);
      expect(second).toBe(first);
    });

    it("returns the original extra when headers.entries throws", () => {
      const extra = {
        http: {
          req: {
            headers: {
              entries: () => {
                throw new Error("boom");
              },
            },
          },
        },
      };
      expect(projectExtraForEvent(extra)).toBe(extra);
    });
  });

  describe("v1: URL instance under requestInfo.url", () => {
    it("replaces the URL instance with its href, headers untouched by reference", () => {
      const headers = { "x-corr": "1" };
      const extra = {
        requestInfo: {
          headers,
          url: new URL("http://localhost:4105/mcp?q=1"),
        },
      };
      const out = projectExtraForEvent(extra) as any;
      expect(out.requestInfo.url).toBe("http://localhost:4105/mcp?q=1");
      expect(out.requestInfo.headers).toBe(headers);
    });

    it("passes an already-string url through unchanged", () => {
      const extra = {
        requestInfo: { headers: { a: "b" }, url: "http://localhost/mcp" },
      };
      expect(projectExtraForEvent(extra)).toBe(extra);
    });
  });

  describe("pass-through", () => {
    it("returns non-rewritable values by identity", () => {
      const stdio = { sessionId: "s", mcpReq: { id: 1 } };
      expect(projectExtraForEvent(stdio)).toBe(stdio);
      expect(projectExtraForEvent(null)).toBe(null);
      expect(projectExtraForEvent(undefined)).toBe(undefined);
      expect(projectExtraForEvent("nope")).toBe("nope");
      const noReq = { http: {} };
      expect(projectExtraForEvent(noReq)).toBe(noReq);
      const plainHeaders = { http: { req: { headers: { a: "b" } } } };
      expect(projectExtraForEvent(plainHeaders)).toBe(plainHeaders);
      const weirdHeaders = { http: { req: { headers: 42 } } };
      expect(projectExtraForEvent(weirdHeaders)).toBe(weirdHeaders);
    });
  });

  describe("snapshot semantics", () => {
    it("later top-level mutations of the original do not appear in the projection", () => {
      const req = new Request("http://localhost/", {
        headers: { "x-a": "1" },
      });
      const extra: any = { http: { req } };
      const out = projectExtraForEvent(extra) as any;
      extra.__agentcat_error = new Error("stashed mid-handler");
      expect(out).not.toBe(extra);
      expect("__agentcat_error" in out).toBe(false);
    });
  });
});
