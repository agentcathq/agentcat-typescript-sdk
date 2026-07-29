import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatadogExporter } from "../modules/exporters/datadog.js";
import { Event } from "../types.js";
import KSUID from "../thirdparty/ksuid/index.js";

describe("DatadogExporter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: () => Promise.resolve("ok"),
    });
    globalThis.fetch = fetchSpy as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeExporter() {
    return new DatadogExporter({
      type: "datadog",
      apiKey: "dd_key",
      site: "datadoghq.com",
      service: "weather-server",
    });
  }

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

  /** The `dd` block of the single log the exporter POSTs to the logs intake. */
  function sentLogTrace(): { trace_id: string; span_id: string } {
    const call = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes("http-intake.logs"),
    )!;
    return JSON.parse(call[1].body)[0].dd;
  }

  it("puts a session-less event on a deterministic trace of its own", async () => {
    // getTraceId returns randomBytes(16) for a falsy input, so an unguarded
    // event.sessionId would put every export of the same event on a different,
    // nonexistent trace — and eventQueue re-exports on retry. The event id is a
    // real KSUID by export time, so it is the stable fallback.
    const exporter = makeExporter();
    const event = makeEvent({ sessionId: undefined });

    await exporter.export(event);
    const first = sentLogTrace();

    fetchSpy.mockClear();
    await exporter.export(event);
    const second = sentLogTrace();

    expect(first.trace_id).toBe(second.trace_id);
    expect(first.trace_id).toMatch(/^\d+$/);
    expect(first.trace_id).not.toBe("0");
    expect(first.span_id).toBe(second.span_id);
  });

  it("gives two session-less events different traces", async () => {
    const exporter = makeExporter();

    await exporter.export(makeEvent({ sessionId: undefined }));
    const a = sentLogTrace();

    fetchSpy.mockClear();
    await exporter.export(makeEvent({ sessionId: undefined }));
    const b = sentLogTrace();

    expect(a.trace_id).not.toBe(b.trace_id);
  });

  it("keeps a session-ful event's trace keyed off the Task ID, not the event id", async () => {
    const exporter = makeExporter();
    const sessionId = KSUID.withPrefix("ses").randomSync();

    await exporter.export(makeEvent({ sessionId }));
    const a = sentLogTrace();

    fetchSpy.mockClear();
    await exporter.export(makeEvent({ sessionId }));
    const b = sentLogTrace();

    // Same task, different events: one trace, two spans.
    expect(a.trace_id).toBe(b.trace_id);
    expect(a.span_id).not.toBe(b.span_id);
  });
});
