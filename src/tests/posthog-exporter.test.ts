import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PostHogExporter } from "../modules/exporters/posthog.js";
import { Event } from "../types.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { validate as uuidValidate, version as uuidVersion } from "uuid";
import KSUID from "../thirdparty/ksuid/index.js";

function expectUUIDv7(value: string) {
  expect(uuidValidate(value)).toBe(true);
  expect(uuidVersion(value)).toBe(7);
}

describe("PostHogExporter", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("ok"),
    });
    globalThis.fetch = fetchSpy;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeEvent(overrides: Partial<Event> = {}): Event {
    return {
      id: "evt_test123",
      sessionId: "ses_session456",
      projectId: "proj_1",
      eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
      timestamp: new Date("2025-01-15T10:00:00Z"),
      resourceName: "get_weather",
      serverName: "weather-server",
      serverVersion: "1.0.0",
      clientName: "claude-desktop",
      clientVersion: "2.0.0",
      duration: 150,
      isError: false,
      ...overrides,
    };
  }

  it("should send correct payload structure for regular events", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(makeEvent());

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0];

    expect(url).toBe("https://us.i.posthog.com/batch");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(options.body);
    expect(body.api_key).toBe("phc_test_key");
    expect(body.batch).toHaveLength(1);

    const event = body.batch[0];
    expect(event.event).toBe("mcp_tool_call");
    expect(event.type).toBe("capture");
    expect(event.distinct_id).toBe("ses_session456");
    expect(event.timestamp).toBe("2025-01-15T10:00:00.000Z");

    // Verify properties
    expectUUIDv7(event.properties.$session_id);
    expect(event.properties.tool_name).toBe("get_weather");
    expect(event.properties.resource_name).toBe("get_weather");
    expect(event.properties.duration_ms).toBe(150);
    expect(event.properties.server_name).toBe("weather-server");
    expect(event.properties.server_version).toBe("1.0.0");
    expect(event.properties.client_name).toBe("claude-desktop");
    expect(event.properties.client_version).toBe("2.0.0");
    expect(event.properties.project_id).toBe("proj_1");
    expect(event.properties.is_error).toBe(false);
  });

  it("should use custom host when provided", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      host: "https://eu.i.posthog.com",
    });

    await exporter.export(makeEvent());

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://eu.i.posthog.com/batch");
  });

  it("should strip trailing slash from host", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      host: "https://my-posthog.example.com/",
    });

    await exporter.export(makeEvent());

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://my-posthog.example.com/batch");
  });

  it("should use identifyActorGivenId as distinct_id when available", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(makeEvent({ identifyActorGivenId: "user_abc123" }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch[0].distinct_id).toBe("user_abc123");
  });

  it("should fall back to sessionId when identifyActorGivenId is not set", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(makeEvent({ identifyActorGivenId: undefined }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch[0].distinct_id).toBe("ses_session456");
  });

  it("should send $exception event alongside regular event when isError is true", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(
      makeEvent({
        isError: true,
        error: {
          message: "Connection timeout",
          type: "TimeoutError",
          stack:
            "TimeoutError: Connection timeout\n    at fetch (/app/index.js:10:5)",
        },
      }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch).toHaveLength(2);

    // First event: regular capture
    expect(body.batch[0].event).toBe("mcp_tool_call");
    expect(body.batch[0].properties.is_error).toBe(true);

    // Second event: $exception
    const exceptionEvent = body.batch[1];
    expect(exceptionEvent.event).toBe("$exception");
    expect(exceptionEvent.distinct_id).toBe("ses_session456");
    expect(exceptionEvent.properties.$exception_message).toBe(
      "Connection timeout",
    );
    expect(exceptionEvent.properties.$exception_type).toBe("TimeoutError");
    expect(exceptionEvent.properties.$exception_stacktrace).toBe(
      "TimeoutError: Connection timeout\n    at fetch (/app/index.js:10:5)",
    );
    expect(exceptionEvent.properties.$exception_source).toBe("backend");
    expectUUIDv7(exceptionEvent.properties.$session_id);
    expect(exceptionEvent.properties.resource_name).toBe("get_weather");
    expect(exceptionEvent.properties.tool_name).toBe("get_weather");
    expect(exceptionEvent.properties.server_name).toBe("weather-server");
  });

  it("should not send $exception event when isError is false", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(makeEvent({ isError: false }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].event).toBe("mcp_tool_call");
  });

  it("should not throw when fetch fails", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    // Should not throw
    await expect(exporter.export(makeEvent())).resolves.toBeUndefined();
  });

  it("should not throw when fetch returns non-ok response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad Request"),
    });

    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await expect(exporter.export(makeEvent())).resolves.toBeUndefined();
  });

  it("should include $set person properties from identity data", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(
      makeEvent({
        identifyActorGivenId: "user_abc",
        identifyActorName: "Alice",
        identifyActorData: { email: "alice@example.com", plan: "pro" },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const props = body.batch[0].properties;

    expect(props.$set).toEqual({
      name: "Alice",
      email: "alice@example.com",
      plan: "pro",
    });
  });

  it("should not include $set when no identity data is present", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(makeEvent());

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch[0].properties.$set).toBeUndefined();
  });

  it("should pass through parameters and response as-is (objects stay objects)", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(
      makeEvent({
        parameters: { city: "London", units: "celsius" },
        response: { temperature: 15, condition: "cloudy" },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const props = body.batch[0].properties;

    expect(props.parameters).toEqual({ city: "London", units: "celsius" });
    expect(props.response).toEqual({ temperature: 15, condition: "cloudy" });
  });

  it("should pass through string parameters and response as-is", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(
      makeEvent({
        parameters: "raw input",
        response: "raw output",
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const props = body.batch[0].properties;

    expect(props.parameters).toBe("raw input");
    expect(props.response).toBe("raw output");
  });

  it("should only set tool_name for tools/call events", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    // tools/call should have tool_name
    await exporter.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
        resourceName: "get_weather",
      }),
    );
    let body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch[0].properties.tool_name).toBe("get_weather");
    expect(body.batch[0].properties.resource_name).toBe("get_weather");

    // resources/read should NOT have tool_name
    fetchSpy.mockClear();
    await exporter.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpResourcesRead,
        resourceName: "my_resource",
      }),
    );
    body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch[0].properties.tool_name).toBeUndefined();
    expect(body.batch[0].properties.resource_name).toBe("my_resource");
  });

  it("should map event types to PostHog event names", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    const eventTypes: Record<string, string> = {
      [PublishEventRequestEventTypeEnum.mcpToolsCall]: "mcp_tool_call",
      [PublishEventRequestEventTypeEnum.mcpToolsList]: "mcp_tools_list",
      [PublishEventRequestEventTypeEnum.mcpInitialize]: "mcp_initialize",
      [PublishEventRequestEventTypeEnum.mcpResourcesRead]: "mcp_resource_read",
      [PublishEventRequestEventTypeEnum.mcpResourcesList]: "mcp_resources_list",
      [PublishEventRequestEventTypeEnum.mcpPromptsGet]: "mcp_prompt_get",
      [PublishEventRequestEventTypeEnum.mcpPromptsList]: "mcp_prompts_list",
      "mcp:custom/type": "mcp_custom_type",
    };

    for (const [input, expected] of Object.entries(eventTypes)) {
      fetchSpy.mockClear();
      await exporter.export(makeEvent({ eventType: input }));

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.batch[0].event).toBe(expected);
    }
  });

  it("should spread customer-defined tags directly into properties", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(
      makeEvent({
        tags: { env: "production", trace_id: "abc-123" },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const props = body.batch[0].properties;
    expect(props.env).toBe("production");
    expect(props.trace_id).toBe("abc-123");
  });

  it("should spread customer-defined properties directly into properties", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(
      makeEvent({
        properties: { device: "mobile", feature_flags: ["dark_mode"] },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const props = body.batch[0].properties;
    expect(props.device).toBe("mobile");
    expect(props.feature_flags).toEqual(["dark_mode"]);
  });

  it("should not include customer tag or property keys when not set on event", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(makeEvent());

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const props = body.batch[0].properties;
    // Only AgentCat-set properties should exist, no customer tags/properties
    expect(props.source).toBe("agentcat");
    expect(props.env).toBeUndefined();
    expect(props.device).toBeUndefined();
  });

  it("should include userIntent in properties", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });

    await exporter.export(
      makeEvent({ userIntent: "Check the weather in London" }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch[0].properties.user_intent).toBe(
      "Check the weather in London",
    );
  });

  it("should emit $ai_span alongside regular event for tool calls when enableAITracing is true", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      enableAITracing: true,
    });

    await exporter.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
        resourceName: "get_weather",
        duration: 250,
        parameters: { city: "London" },
        response: { temp: 15 },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch).toHaveLength(2); // regular + $ai_span

    const regular = body.batch[0];
    expect(regular.event).toBe("mcp_tool_call");

    const span = body.batch[1];
    expect(span.event).toBe("$ai_span");
    expect(span.type).toBe("capture");
    expect(span.distinct_id).toBe("ses_session456");
    expect(span.timestamp).toBe("2025-01-15T10:00:00.000Z");

    // Core $ai_* properties — full property schema verification
    expect(span.properties.$ai_session_id).toBe("agentcat_ses_session456");
    expect(span.properties.$ai_trace_id).toBeDefined();
    expect(span.properties.$ai_span_id).toBeDefined();
    expect(span.properties.$ai_trace_id).not.toBe(span.properties.$ai_span_id); // trace from session, span from event
    expect(span.properties.$ai_span_name).toBe("get_weather");
    expect(span.properties.$ai_latency).toBeCloseTo(0.25); // 250ms → 0.25s
    expect(span.properties.$ai_is_error).toBe(false);
    expect(span.properties.$ai_input_state).toEqual({ city: "London" });
    expect(span.properties.$ai_output_state).toEqual({ temp: 15 });
    expectUUIDv7(span.properties.$session_id);
    expect(span.properties.source).toBe("agentcat");
    expect(span.properties.server_name).toBe("weather-server");
    expect(span.properties.client_name).toBe("claude-desktop");
  });

  it("should generate deterministic UUIDs for $ai_span trace and span IDs", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      enableAITracing: true,
    });

    // Use real KSUIDs so toUUIDv7 can parse the embedded timestamp deterministically
    const sesId = KSUID.withPrefix("ses").randomSync();
    const evtA = KSUID.withPrefix("evt").randomSync();
    const evtB = KSUID.withPrefix("evt").randomSync();

    // Export event A
    await exporter.export(makeEvent({ id: evtA, sessionId: sesId }));
    const bodyA = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const spanA = bodyA.batch.find((e: any) => e.event === "$ai_span");

    // Export event B — same session, different event
    fetchSpy.mockClear();
    await exporter.export(makeEvent({ id: evtB, sessionId: sesId }));
    const bodyB = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const spanB = bodyB.batch.find((e: any) => e.event === "$ai_span");

    // Export event A again — verify determinism
    fetchSpy.mockClear();
    await exporter.export(makeEvent({ id: evtA, sessionId: sesId }));
    const bodyC = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const spanC = bodyC.batch.find((e: any) => e.event === "$ai_span");

    // Same sessionId → same $ai_session_id and $ai_trace_id
    expect(spanA.properties.$ai_session_id).toBe(`agentcat_${sesId}`);
    expect(spanA.properties.$ai_session_id).toBe(
      spanB.properties.$ai_session_id,
    );
    expect(spanA.properties.$ai_trace_id).toBe(spanB.properties.$ai_trace_id);

    // Different eventId → different $ai_span_id
    expect(spanA.properties.$ai_span_id).not.toBe(spanB.properties.$ai_span_id);

    // Same eventId → same $ai_span_id (deterministic)
    expect(spanA.properties.$ai_span_id).toBe(spanC.properties.$ai_span_id);

    // trace_id (from session) != span_id (from event)
    expect(spanA.properties.$ai_trace_id).not.toBe(
      spanA.properties.$ai_span_id,
    );

    // Valid UUIDv7s
    expectUUIDv7(spanA.properties.$ai_trace_id);
    expectUUIDv7(spanA.properties.$ai_span_id);
  });

  it("should NOT emit $ai_span when enableAITracing is false or unset", async () => {
    // Unset (default)
    const exporter1 = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
    });
    await exporter1.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
      }),
    );
    let body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].event).toBe("mcp_tool_call");

    // Explicitly false
    fetchSpy.mockClear();
    const exporter2 = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      enableAITracing: false,
    });
    await exporter2.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
      }),
    );
    body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0].event).toBe("mcp_tool_call");
  });

  it("should NOT emit $ai_span for non-tool-call events even with enableAITracing", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      enableAITracing: true,
    });

    const nonToolCallTypes = [
      PublishEventRequestEventTypeEnum.mcpInitialize,
      PublishEventRequestEventTypeEnum.mcpToolsList,
      PublishEventRequestEventTypeEnum.mcpResourcesRead,
      PublishEventRequestEventTypeEnum.mcpResourcesList,
      PublishEventRequestEventTypeEnum.mcpPromptsGet,
      PublishEventRequestEventTypeEnum.mcpPromptsList,
    ];

    for (const eventType of nonToolCallTypes) {
      fetchSpy.mockClear();
      await exporter.export(makeEvent({ eventType }));
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const aiSpan = body.batch.find((e: any) => e.event === "$ai_span");
      expect(aiSpan).toBeUndefined();
    }
  });

  it("should spread customer tags and properties directly on $ai_span (not namespaced)", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      enableAITracing: true,
    });

    await exporter.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
        tags: { env: "production", region: "us-east" },
        properties: { feature_flag: "new_ui", count: 42 },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const span = body.batch.find((e: any) => e.event === "$ai_span");

    // Tags spread directly (NOT as agentcat_tag_*)
    expect(span.properties.env).toBe("production");
    expect(span.properties.region).toBe("us-east");

    // Properties spread directly
    expect(span.properties.feature_flag).toBe("new_ui");
    expect(span.properties.count).toBe(42);

    // Regular event also spreads directly (same behavior)
    const regular = body.batch.find((e: any) => e.event === "mcp_tool_call");
    expect(regular.properties.env).toBe("production");
    expect(regular.properties.feature_flag).toBe("new_ui");
    expect(regular.properties.count).toBe(42);
  });

  it("should allow customer tags to override $ai_* defaults on $ai_span", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      enableAITracing: true,
    });

    const customTraceId = "custom-trace-uuid-from-customer";
    await exporter.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
        tags: { $ai_trace_id: customTraceId, $ai_span_name: "custom_name" },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const span = body.batch.find((e: any) => e.event === "$ai_span");

    // Customer tag overrides AgentCat's generated $ai_trace_id
    expect(span.properties.$ai_trace_id).toBe(customTraceId);
    expect(span.properties.$ai_span_name).toBe("custom_name");
  });

  it("should emit regular + $exception + $ai_span for error tool calls with enableAITracing", async () => {
    const exporter = new PostHogExporter({
      type: "posthog",
      apiKey: "phc_test_key",
      enableAITracing: true,
    });

    await exporter.export(
      makeEvent({
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
        isError: true,
        error: {
          message: "Tool execution failed",
          type: "ExecutionError",
        },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.batch).toHaveLength(3);

    // Event order: regular, $exception, $ai_span
    expect(body.batch[0].event).toBe("mcp_tool_call");
    expect(body.batch[1].event).toBe("$exception");
    expect(body.batch[2].event).toBe("$ai_span");

    // Verify $ai_span error properties
    const span = body.batch[2];
    expect(span.properties.$ai_is_error).toBe(true);
    expect(span.properties.$ai_error).toEqual({
      message: "Tool execution failed",
      type: "ExecutionError",
    });
  });
});
