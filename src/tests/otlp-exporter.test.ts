import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OTLPExporter } from "../modules/exporters/otlp.js";
import { Event } from "../types.js";
import KSUID from "../thirdparty/ksuid/index.js";

describe("OTLPExporter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve("ok"),
    });
    globalThis.fetch = fetchSpy as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeExporter() {
    return new OTLPExporter({
      type: "otlp",
      endpoint: "https://collector.example.com",
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

  /** The single span from the most recent POST. */
  function sentSpan(callIndex = 0): any {
    const [, options] = fetchSpy.mock.calls[callIndex];
    const body = JSON.parse(options.body);
    return body.resourceSpans[0].scopeSpans[0].spans[0];
  }

  function attribute(span: any, key: string): any {
    return span.attributes.find((a: any) => a.key === key);
  }

  it("appends /v1/traces to the configured endpoint", async () => {
    await makeExporter().export(makeEvent());
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://collector.example.com/v1/traces",
    );
  });

  it("includes mcp.session_id for a session-ful event", async () => {
    const sessionId = KSUID.withPrefix("ses").randomSync();
    await makeExporter().export(makeEvent({ sessionId }));

    const attr = attribute(sentSpan(), "mcp.session_id");
    expect(attr).toBeDefined();
    expect(attr.value.stringValue).toBe(sessionId);
  });

  it("omits mcp.session_id entirely for a session-less event", async () => {
    // Not `""`. A backend grouping on this attribute would fuse every
    // session-less event across every server into one bogus bucket.
    await makeExporter().export(makeEvent({ sessionId: undefined }));

    const span = sentSpan();
    expect(attribute(span, "mcp.session_id")).toBeUndefined();
    expect(
      span.attributes.map((a: any) => a.key).includes("mcp.session_id"),
    ).toBe(false);
    // The rest of the span is unaffected.
    expect(attribute(span, "mcp.resource_name").value.stringValue).toBe(
      "get_weather",
    );
  });

  it("puts a session-less event on a deterministic trace of its own", async () => {
    // getTraceId returns randomBytes(16) for a falsy input, so an unguarded
    // event.sessionId would land each export of the same event on a different,
    // nonexistent trace — and eventQueue re-exports on retry.
    const exporter = makeExporter();
    const event = makeEvent({ sessionId: undefined });

    await exporter.export(event);
    await exporter.export(event);

    const first = sentSpan(0);
    const second = sentSpan(1);
    expect(first.traceId).toBe(second.traceId);
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.spanId).toBe(second.spanId);
  });

  it("gives two session-less events different traces", async () => {
    const exporter = makeExporter();
    await exporter.export(makeEvent({ sessionId: undefined }));
    await exporter.export(makeEvent({ sessionId: undefined }));

    expect(sentSpan(0).traceId).not.toBe(sentSpan(1).traceId);
  });

  it("keeps a session-ful event's trace keyed off the Task ID, not the event id", async () => {
    const exporter = makeExporter();
    const sessionId = KSUID.withPrefix("ses").randomSync();

    await exporter.export(makeEvent({ sessionId }));
    await exporter.export(makeEvent({ sessionId }));

    // Same task, different events: one trace, two spans.
    expect(sentSpan(0).traceId).toBe(sentSpan(1).traceId);
    expect(sentSpan(0).spanId).not.toBe(sentSpan(1).spanId);
  });

  it("drops empty-valued attributes but keeps populated ones", async () => {
    await makeExporter().export(
      makeEvent({ userIntent: undefined, identifyActorName: "Ada" }),
    );

    const span = sentSpan();
    expect(attribute(span, "mcp.user_intent")).toBeUndefined();
    expect(attribute(span, "mcp.actor_name").value.stringValue).toBe("Ada");
  });

  it("throws when the collector rejects the export", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    });

    await expect(makeExporter().export(makeEvent())).rejects.toThrow(
      /OTLP export/,
    );
  });
});
