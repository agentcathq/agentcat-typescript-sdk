import { describe, it, expect, vi } from "vitest";
import { runSignalShutdown } from "../modules/eventQueue.js";

function deps(overrides: Record<string, any> = {}) {
  return {
    destroy: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    listenerCount: vi.fn(() => 0),
    reRaise: vi.fn(),
    ...overrides,
  };
}

describe("runSignalShutdown", () => {
  it("re-raises the signal after the flush settles so default termination proceeds", async () => {
    const d = deps();
    await runSignalShutdown("SIGTERM", d);
    expect(d.destroy).toHaveBeenCalled();
    expect(d.flush).toHaveBeenCalled();
    expect(d.reRaise).toHaveBeenCalledWith("SIGTERM");
    // Ordering: the flush must have settled before the re-raise.
    expect(d.reRaise.mock.invocationCallOrder[0]).toBeGreaterThan(
      d.destroy.mock.invocationCallOrder[0],
    );
  });

  it("does not re-raise when the customer has their own listener for the signal", async () => {
    const d = deps({ listenerCount: vi.fn(() => 1) });
    await runSignalShutdown("SIGINT", d);
    expect(d.reRaise).not.toHaveBeenCalled();
  });

  it("re-raises even when the flush itself fails", async () => {
    const d = deps({
      destroy: vi.fn(async () => {
        throw new Error("drain boom");
      }),
    });
    await runSignalShutdown("SIGTERM", d);
    expect(d.reRaise).toHaveBeenCalledWith("SIGTERM");
  });

  it("never throws even when re-raise fails", async () => {
    const d = deps({
      reRaise: vi.fn(() => {
        throw new Error("kill boom");
      }),
    });
    await expect(runSignalShutdown("SIGTERM", d)).resolves.toBeUndefined();
  });
});
