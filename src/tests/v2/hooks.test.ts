import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod4";
import { randomUUID } from "node:crypto";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { EventCapture } from "../test-utils.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { getServerTrackingData } from "../../modules/internal.js";
import { AgentCatOptions, UserIdentity } from "../../types.js";
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
  AGENTCAT_TAG_SESSION_SOURCE,
} from "../../modules/constants.js";

// Same split as the v1 twin (event-tags-properties.test.ts): keep customer-tag
// assertions exact by separating the SDK-owned handle tags.
const SDK_TAG_KEYS = [
  AGENTCAT_TAG_SESSION_SOURCE,
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
];

function customerTags(
  tags: Record<string, string> | undefined,
): Record<string, string> {
  const out = { ...(tags ?? {}) };
  for (const key of SDK_TAG_KEYS) delete out[key];
  return out;
}

function sdkTags(
  tags: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SDK_TAG_KEYS) {
    if (tags && key in tags) out[key] = tags[key];
  }
  return out;
}

/**
 * Builds a tracked v2 McpServer with one strict-schema tool and connects a
 * real client. listTools() populates the injection registries so stripping is
 * registry-driven, exactly as an agent-facing deployment behaves.
 */
async function setupHighLevel(trackOptions: AgentCatOptions = {}) {
  const mcp = new McpServer(
    { name: "v2-hooks", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.registerTool(
    "add_note",
    { description: "Adds a note", inputSchema: z.object({ text: z.string() }) },
    async (args: { text: string }) => ({
      content: [{ type: "text" as const, text: `Added note: ${args.text}` }],
    }),
  );
  agentcat.track(mcp, "test-project", trackOptions);
  const client = await connectClient(mcp);
  await client.listTools();
  return { mcp, client };
}

const toolCallEventsOf = (capture: EventCapture) =>
  capture
    .getEvents()
    .filter(
      (e) => e.eventType === PublishEventRequestEventTypeEnum.mcpToolsCall,
    );

describe("v2 hooks: identify", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("runs identify on the tool call and stamps the identity onto that event", async () => {
    let identifyCalled = false;
    const testUserId = `user-${randomUUID()}`;
    const testUserData = {
      name: `Test User ${randomUUID()}`,
      email: `test-${randomUUID()}@example.com`,
    };
    const { mcp, client } = await setupHighLevel({
      identify: async (request, extra) => {
        identifyCalled = true;
        expect(request).toBeDefined();
        expect(extra).toBeDefined();
        return { userId: testUserId, userData: testUserData };
      },
    });

    const result: any = await client.callTool({
      name: "add_note",
      arguments: { text: "hello", context: "identification test" },
    });
    expect(result.content[0].text).toContain("Added note");
    expect(identifyCalled).toBe(true);

    // No separate identify event exists — the resolved identity is stamped
    // directly onto the tool call event it belongs to.
    const events = capture.getEvents();
    expect(
      events.some(
        (e) =>
          e.eventType === PublishEventRequestEventTypeEnum.agentcatIdentify,
      ),
    ).toBe(false);

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent.resourceName).toBe("add_note");
    expect(toolCallEvent.identifyActorGivenId).toBe(testUserId);
    expect(toolCallEvent.identifyActorData).toEqual(testUserData);

    // Nothing is cached on the server: the tracking data is config only —
    // no session id, no identity map, no session info (v1 invariant twin).
    const data = getServerTrackingData((mcp as any).server);
    expect(data).toBeDefined();
    expect(Object.keys(data!).sort()).toEqual(["options", "projectId"]);
    await client.close();
  });

  it("runs identify on every tool call and stamps every event, with no dedup", async () => {
    let identifyCallCount = 0;
    const userId = `user-${randomUUID()}`;
    const { client } = await setupHighLevel({
      identify: async () => {
        identifyCallCount++;
        return { userId, userData: { name: "Another User" } };
      },
    });

    for (const text of ["first", "second", "third"]) {
      await client.callTool({
        name: "add_note",
        arguments: { text, context: "no-dedup test" },
      });
    }
    expect(identifyCallCount).toBe(3);

    const toolCallEvents = toolCallEventsOf(capture);
    expect(toolCallEvents).toHaveLength(3);
    for (const event of toolCallEvents) {
      expect(event.identifyActorGivenId).toBe(userId);
      expect(event.identifyActorData).toEqual({ name: "Another User" });
    }
    await client.close();
  });

  it("re-resolves identity per request so a changed identity lands on the next event", async () => {
    const identities: UserIdentity[] = [
      { userId: "event-user-a", userName: "First", userData: { seat: "a" } },
      { userId: "event-user-b", userName: "Second", userData: { seat: "b" } },
    ];
    let call = 0;
    const { client } = await setupHighLevel({
      identify: async () => identities[call++],
    });

    for (const text of ["First call", "Second call"]) {
      await client.callTool({
        name: "add_note",
        arguments: { text, context: "identity churn test" },
      });
    }

    const toolCallEvents = toolCallEventsOf(capture);
    expect(toolCallEvents).toHaveLength(2);
    expect(toolCallEvents[0].identifyActorGivenId).toBe("event-user-a");
    expect(toolCallEvents[0].identifyActorName).toBe("First");
    expect(toolCallEvents[0].identifyActorData).toEqual({ seat: "a" });
    expect(toolCallEvents[1].identifyActorGivenId).toBe("event-user-b");
    expect(toolCallEvents[1].identifyActorName).toBe("Second");
    expect(toolCallEvents[1].identifyActorData).toEqual({ seat: "b" });
    await client.close();
  });

  it("publishes anonymously when identify returns null", async () => {
    const { client } = await setupHighLevel({ identify: async () => null });

    const result: any = await client.callTool({
      name: "add_note",
      arguments: { text: "anon", context: "null identity test" },
    });
    expect(result.content[0].text).toContain("Added note");

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent.identifyActorGivenId).toBeUndefined();
    expect(toolCallEvent.identifyActorName).toBeUndefined();
    expect(toolCallEvent.identifyActorData).toEqual({});
    await client.close();
  });

  it("degrades to anonymous when identify throws; the tool call still succeeds", async () => {
    const { client } = await setupHighLevel({
      identify: async () => {
        throw new Error("Failed to identify user");
      },
    });

    const result: any = await client.callTool({
      name: "add_note",
      arguments: { text: "err", context: "identify error test" },
    });
    expect(result.content[0].text).toContain("Added note");

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent.identifyActorGivenId).toBeUndefined();
    expect(toolCallEvent.identifyActorName).toBeUndefined();
    expect(toolCallEvent.identifyActorData).toEqual({});
    await client.close();
  });

  it("handles identify returning invalid data by leaving actor fields empty", async () => {
    const { client } = await setupHighLevel({
      identify: async () =>
        ({ invalidField: "invalid" }) as any as UserIdentity,
    });

    const result: any = await client.callTool({
      name: "add_note",
      arguments: { text: "invalid", context: "invalid identity test" },
    });
    expect(result.content[0].text).toContain("Added note");

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent.identifyActorGivenId).toBeUndefined();
    expect(toolCallEvent.identifyActorName).toBeUndefined();
    expect(toolCallEvent.identifyActorData).toEqual({});
    await client.close();
  });

  it("holds the call open for async identify; the event's duration covers the lookup", async () => {
    let asyncOperationCompleted = false;
    const { client } = await setupHighLevel({
      identify: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        asyncOperationCompleted = true;
        return { userId: "async-user", userData: { source: "async-lookup" } };
      },
    });

    const result: any = await client.callTool({
      name: "add_note",
      arguments: { text: "async", context: "async identify test" },
    });
    expect(result.content[0].text).toContain("Added note");
    expect(asyncOperationCompleted).toBe(true);

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent.identifyActorGivenId).toBe("async-user");
    expect(toolCallEvent.identifyActorData).toEqual({
      source: "async-lookup",
    });
    // 95, not 100: setTimeout can fire ~1ms early and Date truncates to ms.
    expect(toolCallEvent.duration).toBeGreaterThanOrEqual(95);
    await client.close();
  });

  it("does not run identify or publish an event for tools/list", async () => {
    let identifyCalled = false;
    const { client } = await setupHighLevel({
      identify: async () => {
        identifyCalled = true;
        return { userId: "list-user" };
      },
    });

    await client.listTools();
    expect(identifyCalled).toBe(false);
    expect(capture.getEvents()).toHaveLength(0);
    await client.close();
  });
});

describe("v2 hooks: eventTags", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("attaches customer tags; SDK handle tags ride alongside", async () => {
    const { client } = await setupHighLevel({
      enableAgentTracking: true,
      eventTags: async () => ({ env: "test", trace_id: "abc-123" }),
    });

    await client.callTool({
      name: "add_note",
      arguments: {
        text: "tags",
        context: "tag test",
        agent_id: "opus-4.80-1m|claude-code|k3n9x",
      },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent).toBeDefined();
    expect(customerTags(toolCallEvent.tags)).toEqual({
      env: "test",
      trace_id: "abc-123",
    });
    expect(toolCallEvent.tags![AGENTCAT_TAG_SESSION_SOURCE]).toBe("minted");
    expect(toolCallEvent.tags![AGENTCAT_TAG_AGENT_SOURCE]).toBe("supplied");
    expect(toolCallEvent.tags![AGENTCAT_TAG_AGENT_ID]).toBe(
      "opus-4.80-1m|claude-code|k3n9x",
    );
    await client.close();
  });

  it("SDK tag wins when a customer tag collides with an SDK tag name", async () => {
    const { client } = await setupHighLevel({
      eventTags: async () => ({
        [AGENTCAT_TAG_SESSION_SOURCE]: "customer-value",
        env: "test",
      }),
    });

    await client.callTool({
      name: "add_note",
      arguments: {
        text: "collision",
        context: "tag test",
        session_id: "ses_supplied",
      },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    // SDK tags are merged last, so ours wins the collision.
    expect(toolCallEvent.tags![AGENTCAT_TAG_SESSION_SOURCE]).toBe("supplied");
    expect(customerTags(toolCallEvent.tags)).toEqual({ env: "test" });
    await client.close();
  });

  it("does not block tool calls when the callback throws; only SDK tags remain", async () => {
    const { client } = await setupHighLevel({
      eventTags: async () => {
        throw new Error("Tags callback failed");
      },
    });

    const result: any = await client.callTool({
      name: "add_note",
      arguments: { text: "throw", context: "tag test" },
    });
    expect(result.content[0].text).toContain("Added note");

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(customerTags(toolCallEvent.tags)).toEqual({});
    expect(sdkTags(toolCallEvent.tags)).toHaveProperty(
      AGENTCAT_TAG_SESSION_SOURCE,
    );
    await client.close();
  });

  it("handles null return from the callback", async () => {
    const { client } = await setupHighLevel({ eventTags: async () => null });

    await client.callTool({
      name: "add_note",
      arguments: { text: "null", context: "tag test" },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(customerTags(toolCallEvent.tags)).toEqual({});
    expect(sdkTags(toolCallEvent.tags)).toHaveProperty(
      AGENTCAT_TAG_SESSION_SOURCE,
    );
    await client.close();
  });

  it("validates tags from the callback, dropping invalid keys", async () => {
    const { client } = await setupHighLevel({
      eventTags: async () => ({ valid: "value", "invalid!": "value" }),
    });

    await client.callTool({
      name: "add_note",
      arguments: { text: "validate", context: "tag test" },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(customerTags(toolCallEvent.tags)).toEqual({ valid: "value" });
    await client.close();
  });
});

describe("v2 hooks: eventProperties", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("attaches properties to tool call events", async () => {
    const { client } = await setupHighLevel({
      eventProperties: async () => ({
        device: "desktop",
        feature_flags: ["dark_mode"],
        nested: { key: "value" },
      }),
    });

    await client.callTool({
      name: "add_note",
      arguments: { text: "props", context: "props test" },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent.properties).toEqual({
      device: "desktop",
      feature_flags: ["dark_mode"],
      nested: { key: "value" },
    });
    await client.close();
  });

  it("does not block tool calls when the callback throws", async () => {
    const { client } = await setupHighLevel({
      eventProperties: async () => {
        throw new Error("Properties callback failed");
      },
    });

    const result: any = await client.callTool({
      name: "add_note",
      arguments: { text: "throw", context: "props test" },
    });
    expect(result.content[0].text).toContain("Added note");
    await client.close();
  });

  it("omits properties when the callback returns null", async () => {
    const { client } = await setupHighLevel({
      eventProperties: async () => null,
    });

    await client.callTool({
      name: "add_note",
      arguments: { text: "null", context: "props test" },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(toolCallEvent.properties).toBeUndefined();
    await client.close();
  });

  it("attaches both tags and properties to the same event", async () => {
    const { client } = await setupHighLevel({
      eventTags: async () => ({ env: "test" }),
      eventProperties: async () => ({ device: "mobile" }),
    });

    await client.callTool({
      name: "add_note",
      arguments: { text: "both", context: "combined test" },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(customerTags(toolCallEvent.tags)).toEqual({ env: "test" });
    expect(toolCallEvent.properties).toEqual({ device: "mobile" });
    await client.close();
  });

  it("adds neither tags nor properties when no callbacks are configured", async () => {
    const { client } = await setupHighLevel({});

    await client.callTool({
      name: "add_note",
      arguments: { text: "bare", context: "no callback test" },
    });

    const [toolCallEvent] = toolCallEventsOf(capture);
    expect(customerTags(toolCallEvent.tags)).toEqual({});
    expect(sdkTags(toolCallEvent.tags)).toHaveProperty(
      AGENTCAT_TAG_SESSION_SOURCE,
    );
    expect(toolCallEvent.properties).toBeUndefined();
    await client.close();
  });
});

describe("v2 hooks: (request, extra) arguments carry the v2 ServerContext", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("passes the raw request and the v2 ServerContext to every hook", async () => {
    const seen: Record<string, { request: any; extra: any }> = {};
    const record =
      (name: string, value: any) => async (request: any, extra: any) => {
        seen[name] = { request, extra };
        return value;
      };
    const { client } = await setupHighLevel({
      identify: record("identify", { userId: "ctx-user" }),
      eventTags: record("eventTags", { env: "test" }),
      eventProperties: record("eventProperties", { device: "desktop" }),
    });

    await client.callTool({
      name: "add_note",
      arguments: { text: "ctx", context: "extra shape test" },
    });

    for (const name of ["identify", "eventTags", "eventProperties"]) {
      const { request, extra } = seen[name];
      expect(request.params?.name).toBe("add_note");
      // Hooks see the raw request, injected params included.
      expect(request.params?.arguments?.text).toBe("ctx");
      expect(request.params?.arguments?.context).toBe("extra shape test");
      // The v2 `extra` is the SDK's ServerContext: the wrapped JSON-RPC
      // request rides on extra.mcpReq with its id populated.
      expect(extra).toBeDefined();
      expect(extra.mcpReq).toBeDefined();
      expect(extra.mcpReq.id).toBeDefined();
    }
    await client.close();
  });
});

describe("v2 real-wire client identity", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("stamps the connecting client's own identity onto captured events", async () => {
    // No synthetic ctx anywhere: the identity must arrive over the real wire
    // from the harness client's initialize handshake / request envelope.
    const { client } = await setupHighLevel();

    await client.callTool({
      name: "add_note",
      arguments: { text: "who am I", context: "real-wire identity test" },
    });

    const [event] = toolCallEventsOf(capture);
    expect(event).toBeDefined();
    expect(event.clientName).toBe("agentcat-test-client");
    expect(event.clientVersion).toBe("1.0.0");
    await client.close();
  });
});
