import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../modules/logging.js", () => ({
  writeToLog: vi.fn(),
}));

import { writeToLog } from "../modules/logging.js";
import {
  runInToolCallScope,
  getEnclosingToolCall,
  _setScopeStorageForTest,
  ToolCallScope,
} from "../modules/toolCallScope.js";
import {
  createHookSessionFinalizer,
  PENDING_HOOK_TIMEOUT_MS,
} from "../modules/pendingEvent.js";
import { deriveSessionId } from "../modules/handles.js";
import { MCPServerLike } from "../types.js";

const serverA = { name: "a" } as unknown as MCPServerLike;
const serverB = { name: "b" } as unknown as MCPServerLike;

describe("tool-call scope", () => {
  beforeEach(() => {
    vi.mocked(writeToLog).mockClear();
  });

  afterEach(() => {
    _setScopeStorageForTest(undefined);
  });

  it("returns the enclosing call only for the server that call belongs to", async () => {
    const scope: ToolCallScope = { server: serverA, sessionId: "ses_a" };
    await runInToolCallScope(scope, async () => {
      await Promise.resolve();
      expect(getEnclosingToolCall(serverA)).toBe(scope);
      expect(getEnclosingToolCall(serverB)).toBeUndefined();
    });
    expect(getEnclosingToolCall(serverA)).toBeUndefined();
  });

  it("returns only the innermost call for nested tool calls", async () => {
    const outer: ToolCallScope = { server: serverB, sessionId: "ses_outer" };
    const inner: ToolCallScope = { server: serverA, sessionId: "ses_inner" };
    await runInToolCallScope(outer, () =>
      runInToolCallScope(inner, async () => {
        expect(getEnclosingToolCall(serverA)).toBe(inner);
        expect(getEnclosingToolCall(serverB)).toBeUndefined();
      }),
    );
  });

  it("runs the handler once, unscoped, when the scope cannot be entered", async () => {
    _setScopeStorageForTest({
      run: () => {
        throw new Error("storage broken");
      },
      getStore: () => undefined,
    });
    const handler = vi.fn(async () => "result");

    await expect(
      runInToolCallScope({ server: serverA, sessionId: "ses_a" }, handler),
    ).resolves.toBe("result");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("storage broken"),
    );
  });

  it("rethrows the handler's own synchronous error without running it again", () => {
    const handler = vi.fn(() => {
      throw new Error("customer bug");
    });

    expect(() =>
      runInToolCallScope({ server: serverA, sessionId: "ses_a" }, handler),
    ).toThrow("customer bug");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs the handler unscoped when AsyncLocalStorage is unavailable", async () => {
    _setScopeStorageForTest(null);
    const result = await runInToolCallScope(
      { server: serverA, sessionId: "ses_a" },
      async () => getEnclosingToolCall(serverA),
    );
    expect(result).toBeUndefined();
  });

  it("reports no enclosing call when reading the scope fails", () => {
    _setScopeStorageForTest({
      run: (_store, fn) => fn(),
      getStore: () => {
        throw new Error("lookup broken");
      },
    });
    expect(getEnclosingToolCall(serverA)).toBeUndefined();
    expect(writeToLog).toHaveBeenCalledWith(
      expect.stringContaining("lookup broken"),
    );
  });
});

describe("hook-mode session finalization", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives the session once and shares it with every caller", async () => {
    const finalize = createHookSessionFinalizer(
      Promise.resolve("corr-1"),
      "proj_x",
    );
    const [a, b] = await Promise.all([finalize(), finalize()]);
    expect(a).toEqual({
      sessionId: deriveSessionId("corr-1", "proj_x"),
      sessionSource: "hook",
    });
    expect(b).toBe(a);
  });

  it("mints one ID for every caller when the hook returns null", async () => {
    const finalize = createHookSessionFinalizer(Promise.resolve(null), "p");
    const a = await finalize();
    const b = await finalize();
    expect(a.sessionSource).toBe("minted");
    expect(a.sessionId).toMatch(/^ses_/);
    expect(b.sessionId).toBe(a.sessionId);
  });

  it("mints one ID for every caller when the hook does not settle in time", async () => {
    vi.useFakeTimers();
    const finalize = createHookSessionFinalizer(
      new Promise<string | null>(() => {}),
      "p",
    );
    const first = finalize();
    const second = finalize();
    await vi.advanceTimersByTimeAsync(PENDING_HOOK_TIMEOUT_MS);
    const [a, b] = await Promise.all([first, second]);
    expect(a.sessionSource).toBe("minted");
    expect(b.sessionId).toBe(a.sessionId);
  });
});
