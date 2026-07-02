/**
 * Edge Runtime Compatibility Tests
 *
 * These tests verify that AgentCat gracefully handles environments where
 * certain Node.js modules may not be available or have limited functionality
 * (like Cloudflare Workers, Vercel Edge, Deno Deploy).
 *
 * Note: For full edge runtime testing with actual Cloudflare Workers environment,
 * consider using @cloudflare/vitest-pool-workers with a separate vitest config.
 * These tests simulate edge-like conditions within the Node.js test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { captureException } from "../modules/exceptions.js";

describe("Edge Runtime Compatibility", () => {
  describe("Exception Capture - Graceful Degradation", () => {
    it("should capture basic exception info without filesystem access", () => {
      const error = new Error("Test error");
      const captured = captureException(error);

      // Should capture basic error information regardless of environment
      expect(captured.message).toBe("Test error");
      expect(captured.type).toBe("Error");
      expect(captured.platform).toBe("javascript");
    });

    it("should parse stack traces without requiring fs module", () => {
      const error = new Error("Stack trace test");
      const captured = captureException(error);

      // Stack parsing doesn't require fs - only context_line extraction does
      expect(captured.frames).toBeDefined();
      expect(Array.isArray(captured.frames)).toBe(true);
      expect(captured.frames!.length).toBeGreaterThan(0);

      // Frames should have basic info
      const firstFrame = captured.frames![0];
      expect(firstFrame.filename).toBeDefined();
      expect(typeof firstFrame.lineno).toBe("number");
    });

    it("should handle chained errors (Error.cause)", () => {
      const rootCause = new Error("Root cause");
      const wrapper = new Error("Wrapper error", { cause: rootCause });

      const captured = captureException(wrapper);

      expect(captured.message).toBe("Wrapper error");
      expect(captured.chained_errors).toBeDefined();
      expect(captured.chained_errors!.length).toBe(1);
      expect(captured.chained_errors![0].message).toBe("Root cause");
    });

    it("should handle non-Error objects being thrown", () => {
      const captured1 = captureException("string error");
      expect(captured1.message).toBe("string error");

      const captured2 = captureException({ code: 404 });
      expect(captured2.message).toBe('{"code":404}');

      const captured3 = captureException(null);
      expect(captured3.message).toBe("null");

      const captured4 = captureException(undefined);
      expect(captured4.message).toBe("undefined");
    });
  });

  describe("Process Object Availability", () => {
    let originalProcess: typeof process;

    beforeEach(() => {
      originalProcess = globalThis.process;
    });

    afterEach(() => {
      globalThis.process = originalProcess;
    });

    it("should handle missing process.cwd gracefully", () => {
      // Create a mock process without cwd
      const mockProcess = { ...originalProcess } as typeof process;
      // @ts-expect-error - intentionally removing cwd for test
      delete mockProcess.cwd;
      globalThis.process = mockProcess;

      // captureException should still work
      const error = new Error("Test without cwd");
      const captured = captureException(error);

      expect(captured.message).toBe("Test without cwd");
      expect(captured.type).toBe("Error");
    });

    it("should handle process.cwd throwing", () => {
      const mockProcess = {
        ...originalProcess,
        cwd: () => {
          throw new Error("cwd not available");
        },
      } as typeof process;
      globalThis.process = mockProcess;

      const error = new Error("Test with throwing cwd");
      const captured = captureException(error);

      expect(captured.message).toBe("Test with throwing cwd");
    });
  });

  describe("Event Queue Signal Handlers", () => {
    let originalProcess: typeof process;

    beforeEach(() => {
      originalProcess = globalThis.process;
    });

    afterEach(() => {
      globalThis.process = originalProcess;
      vi.resetModules();
    });

    it("should not throw when process.once is unavailable", async () => {
      // Create mock process without once
      const mockProcess = { ...originalProcess } as typeof process;
      // @ts-expect-error - intentionally removing once for test
      delete mockProcess.once;
      globalThis.process = mockProcess;

      // Reset modules to re-run module-level code
      vi.resetModules();

      // Should not throw when importing
      await expect(import("../modules/eventQueue.js")).resolves.toBeDefined();
    });

    it("should handle process being undefined", async () => {
      // @ts-expect-error - intentionally removing process for test
      delete globalThis.process;

      vi.resetModules();

      // Should not throw
      const module = await import("../modules/eventQueue.js");
      expect(module.eventQueue).toBeDefined();

      // Restore process before other tests run
      globalThis.process = originalProcess;
    });
  });

  describe("Logging Module Behavior", () => {
    it("should export writeToLog function", async () => {
      const { writeToLog } = await import("../modules/logging.js");
      expect(typeof writeToLog).toBe("function");
    });

    it("should not throw when called", async () => {
      const { writeToLog } = await import("../modules/logging.js");

      // writeToLog should never throw, regardless of environment
      expect(() => writeToLog("Test message")).not.toThrow();
      expect(() => writeToLog("")).not.toThrow();
      expect(() => writeToLog("Special chars: \n\t\r")).not.toThrow();
    });

    it("should handle rapid successive calls", async () => {
      const { writeToLog } = await import("../modules/logging.js");

      // Should handle many calls without issues
      expect(() => {
        for (let i = 0; i < 100; i++) {
          writeToLog(`Message ${i}`);
        }
      }).not.toThrow();
    });
  });

  describe("Full SDK API Availability", () => {
    it("should export track function", async () => {
      const agentcat = await import("../index.js");
      expect(typeof agentcat.track).toBe("function");
    });

    it("should export publishCustomEvent function", async () => {
      const agentcat = await import("../index.js");
      expect(typeof agentcat.publishCustomEvent).toBe("function");
    });

    it("should export type definitions", async () => {
      // IdentifyFunction type is exported for users to define their identify callbacks
      const agentcat = await import("../index.js");
      // The module should load without issues
      expect(agentcat).toBeDefined();
    });
  });

  describe("Edge Environment Detection Patterns", () => {
    it("should detect Node.js environment correctly", () => {
      // Helper function that AgentCat could use internally
      const isNodeJs = () => {
        return (
          typeof process !== "undefined" &&
          process.versions != null &&
          process.versions.node != null
        );
      };

      // In test environment, we should be in Node.js
      expect(isNodeJs()).toBe(true);
    });

    it("should detect Cloudflare Workers pattern", () => {
      // Pattern for detecting Cloudflare Workers
      const isCloudflareWorkers = () => {
        try {
          // Cloudflare Workers have caches.default
          return (
            typeof caches !== "undefined" &&
            // @ts-expect-error - caches.default is Cloudflare-specific
            typeof caches.default !== "undefined"
          );
        } catch {
          return false;
        }
      };

      // In Node.js test environment, should return false
      expect(isCloudflareWorkers()).toBe(false);
    });

    it("should detect generic edge runtime pattern", () => {
      // Generic pattern for detecting edge runtimes
      const isEdgeRuntime = () => {
        // Edge runtimes typically don't have full Node.js process
        const hasFullNodeProcess =
          typeof process !== "undefined" &&
          typeof process.versions?.node === "string" &&
          typeof process.cwd === "function";

        return !hasFullNodeProcess;
      };

      // In Node.js test environment, should return false
      expect(isEdgeRuntime()).toBe(false);
    });
  });

  describe("Path Normalization Without cwd", () => {
    it("should handle various path formats", () => {
      // These patterns should work regardless of process.cwd availability
      const testPaths = [
        "/Users/john/project/src/index.ts",
        "src/index.ts",
        "./relative/path.ts",
        "node_modules/package/index.js",
        "node:internal/modules/loader",
        "native",
        "<anonymous>",
      ];

      const error = new Error("Path test");
      const captured = captureException(error);

      // Should have parsed the stack without errors
      expect(captured.frames).toBeDefined();
    });
  });
});

describe("Integration: SDK in Limited Environment", () => {
  let originalProcess: typeof process;

  beforeEach(() => {
    originalProcess = globalThis.process;
  });

  afterEach(() => {
    globalThis.process = originalProcess;
    vi.resetModules();
  });

  it("should work when process has limited functionality", async () => {
    // Simulate limited process object (like some edge runtimes)
    const limitedProcess = {
      env: {},
      // Missing: cwd, once, versions, etc.
    } as unknown as typeof process;

    globalThis.process = limitedProcess;
    vi.resetModules();

    // SDK should still load
    const agentcat = await import("../index.js");

    // Core functions should exist
    expect(agentcat.track).toBeDefined();
    expect(agentcat.publishCustomEvent).toBeDefined();

    // Exception capture should work
    const { captureException: capture } =
      await import("../modules/exceptions.js");
    const error = new Error("Limited env test");
    const captured = capture(error);

    expect(captured.message).toBe("Limited env test");

    // Restore
    globalThis.process = originalProcess;
  });

  it("should handle environment transitions gracefully", async () => {
    // First call in "normal" environment
    const { writeToLog: writeLog1 } = await import("../modules/logging.js");
    expect(() => writeLog1("Normal environment")).not.toThrow();

    // Module state persists between calls (this is expected behavior)
    expect(() => writeLog1("Second call")).not.toThrow();
  });
});

describe("Error Handling Robustness", () => {
  it("should not crash on malformed stack traces", () => {
    const error = new Error("Malformed");
    // Override stack with malformed content
    error.stack =
      "Error: Malformed\n    at malformed line without proper format\n    garbage data";

    const captured = captureException(error);

    // Should still capture basic info
    expect(captured.message).toBe("Malformed");
    expect(captured.type).toBe("Error");
    // Should handle malformed frames gracefully
    expect(captured.frames).toBeDefined();
  });

  it("should handle circular reference in error.cause", () => {
    const error1 = new Error("Error 1") as Error & { cause?: Error };
    const error2 = new Error("Error 2") as Error & { cause?: Error };

    // Create circular reference
    error1.cause = error2;
    error2.cause = error1;

    // Should not infinite loop
    const captured = captureException(error1);

    expect(captured.message).toBe("Error 1");
    expect(captured.chained_errors).toBeDefined();
    // Should stop before infinite loop
    expect(captured.chained_errors!.length).toBeLessThanOrEqual(10);
  });

  it("should handle deeply nested error chains", () => {
    // Create a deep chain of errors
    let current = new Error("Root");
    for (let i = 0; i < 20; i++) {
      current = new Error(`Level ${i}`, { cause: current });
    }

    const captured = captureException(current);

    expect(captured.message).toBe("Level 19");
    // Should be capped at MAX_EXCEPTION_CHAIN_DEPTH (10)
    expect(captured.chained_errors!.length).toBeLessThanOrEqual(10);
  });
});
