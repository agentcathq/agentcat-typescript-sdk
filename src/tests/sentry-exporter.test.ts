import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SentryExporter } from "../modules/exporters/sentry.js";
import { Event } from "../types.js";
import KSUID from "../thirdparty/ksuid/index.js";

const DSN = "https://abc123def456@o123.ingest.sentry.io/456";

describe("SentryExporter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("ok"),
    });
    globalThis.fetch = fetchSpy as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeEvent(overrides: Partial<Event> = {}): Event {
    return {
      id: KSUID.withPrefix("evt").randomSync(),
      sessionId: KSUID.withPrefix("ses").randomSync(),
      projectId: "proj_1",
      eventType: "mcp:tools/call",
      timestamp: new Date("2025-01-15T10:00:00Z"),
      resourceName: "get_weather",
      duration: 150,
      isError: false,
      ...overrides,
    };
  }

  /** Every trace_id carried by the envelopes sent during one export(). */
  function sentTraceIds(): string[] {
    return fetchSpy.mock.calls.map(([, options]) => {
      const [, itemHeader, payload] = (options.body as string)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      if (itemHeader.type === "log") return payload.items[0].trace_id;
      return payload.contexts.trace.trace_id;
    });
  }

  it("puts every envelope for one event on a single trace", async () => {
    const exporter = new SentryExporter({
      type: "sentry",
      dsn: DSN,
      enableTracing: true,
    });

    await exporter.export(
      makeEvent({ isError: true, error: { message: "boom" } }),
    );

    // log + transaction + error event
    const traceIds = sentTraceIds();
    expect(traceIds).toHaveLength(3);
    expect(new Set(traceIds).size).toBe(1);
  });

  it("puts every envelope for a session-less event on a single trace", async () => {
    // Regression guard: traceContext.getTraceId returns fresh random bytes for
    // a falsy input, and export() derives a trace id three times. Without the
    // event-id fallback these three envelopes land on three unrelated traces,
    // so the log never appears under its own transaction and the error lands
    // somewhere else again.
    const exporter = new SentryExporter({
      type: "sentry",
      dsn: DSN,
      enableTracing: true,
    });

    await exporter.export(
      makeEvent({
        sessionId: undefined,
        isError: true,
        error: { message: "boom" },
      }),
    );

    const traceIds = sentTraceIds();
    expect(traceIds).toHaveLength(3);
    expect(new Set(traceIds).size).toBe(1);
    expect(traceIds[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps session-less events in separate traces from one another", async () => {
    // The fallback must not fuse unrelated session-less events the way a fixed
    // placeholder would: each is its own trace, keyed by its own event id.
    const exporter = new SentryExporter({ type: "sentry", dsn: DSN });

    await exporter.export(makeEvent({ sessionId: undefined }));
    await exporter.export(makeEvent({ sessionId: undefined }));

    const [traceA, traceB] = sentTraceIds();
    expect(traceA).not.toBe(traceB);
  });

  it("derives a stable trace id from the session across separate exports", async () => {
    const exporter = new SentryExporter({ type: "sentry", dsn: DSN });
    const sessionId = KSUID.withPrefix("ses").randomSync();

    await exporter.export(makeEvent({ sessionId }));
    await exporter.export(makeEvent({ sessionId }));

    const [traceA, traceB] = sentTraceIds();
    expect(traceA).toBe(traceB);
  });
});
