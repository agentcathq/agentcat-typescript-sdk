// v2 lanes × scenarios over real HTTP.
//
// Phase 1 base shipped ONLY the baseline-defaults smoke, proving all three v2
// lane topologies (createMcpHandler behind toNodeHandler with legacy + auto
// clients, and the long-lived session transport) end to end. Phase 2 (agent B)
// extends the `scenarios` array in place with the remaining scenario scripts —
// configs come from scenario-types.ts via scenarioConfig(name).
//
// Assertion strength mirrors src/tests/v2/*: exact tag values, mint-back
// prefixes, event counts, /^ses_/ shapes, RAW args on the event vs
// STRIPPED args in the sink. All assertions run against EventCapture + the
// toolkit sink only — never ~/agentcat.log (concurrent agents interleave it).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventCapture } from "../test-utils.js";
import {
  laneById,
  waitForEvents,
  settle,
  mintBackOf,
  handleFrom,
  type Lane,
} from "./lanes.js";
import {
  scenarioConfig,
  CUSTOM_CONTEXT_DESCRIPTION,
  REDACTION_SECRET,
  REDACTION_REPLACEMENT,
  IDENTITY_USER_ID,
  IDENTITY_USER_NAME,
  IDENTITY_USER_DATA,
  CUSTOMER_TAG_KEY,
  CUSTOMER_TAG_VALUE,
  COLLIDING_TAG_VALUE,
  CUSTOMER_PROP_KEY,
  CUSTOMER_PROP_VALUE,
  type Scenario,
} from "./scenario-types.js";
import type { ToolSink } from "./toolkit.js";
import {
  AGENTCAT_TAG_CONVERSATION_SOURCE,
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
  DEFAULT_CONTEXT_PARAMETER_DESCRIPTION,
} from "../../modules/constants.js";

const lanes: Lane[] = [
  laneById("v2-handler-legacy"),
  laneById("v2-handler-auto"),
  laneById("v2-longlived"),
];

/** RAW arguments exactly as they arrived on the wire, read off the event. */
const rawArgsOf = (event: any): Record<string, unknown> =>
  event.parameters?.request?.params?.arguments ?? {};

const scenarios: Scenario[] = [
  // ── 1 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("baseline-defaults"),
    script: async ({ client, capture, sink, lane }) => {
      // Listing: agentcat injected context + conversation_id and added get_more_tools.
      const { tools } = await client.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("get_more_tools");
      const echo = tools.find((t: any) => t.name === "echo")!;
      expect(echo.inputSchema.properties.context).toBeDefined();
      expect(echo.inputSchema.properties.conversation_id).toBeDefined();

      // Call with context but no conversation_id → SDK mints and announces the handle.
      const result = await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "e2e smoke intent" },
      });
      const mintBack = mintBackOf(result);
      expect(mintBack).toBeDefined();
      expect(handleFrom(mintBack!, "conversation_id")).toMatch(/^ses_/);

      // Event: minted ses_ session + captured intent + minted source tag.
      await waitForEvents(capture, 1);
      const echoEvents = capture.findEventsByResourceName("echo");
      expect(echoEvents).toHaveLength(1);
      expect(echoEvents[0].sessionId).toMatch(/^ses_/);
      expect(echoEvents[0].userIntent).toBe("e2e smoke intent");
      expect(echoEvents[0].tags).toMatchObject({
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "minted",
      });

      // RAW on the event: injected params are preserved in the recorded request.
      const raw = rawArgsOf(echoEvents[0]);
      expect(raw.msg).toBe("hi");
      expect(raw.context).toBe("e2e smoke intent");

      // Strip-proof: the customer handler saw msg but no injected params.
      const seen = sink.filter((entry) => entry.tool === "echo");
      expect(seen).toHaveLength(1);
      expect(seen[0].args.msg).toBe("hi");
      expect(seen[0].args.conversation_id).toBeUndefined();
      expect(seen[0].args.context).toBeUndefined();

      // On the auto lane the 2026-07-28 era rides every call: the envelope
      // stamps the protocol-version tag onto this baseline event too.
      if (lane.id === "v2-handler-auto") {
        expect(echoEvents[0].tags?.[AGENTCAT_TAG_PROTOCOL_VERSION]).toBe(
          "2026-07-28",
        );
      }
    },
  },

  // ── 2 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("tracing-off"),
    script: async ({ client, capture, sink }) => {
      const { tools } = await client.listTools();
      const echo = tools.find((t: any) => t.name === "echo")!;
      // enableTracing:false skips HANDLE injection wholesale (engine spec
      // guard in src/engine/listWrap.ts). The context param is governed
      // independently by enableToolCallContext (default true), so it stays
      // listed — mirrors src/tests/v2/options.test.ts which asserts only the
      // handles absent.
      expect(echo.inputSchema.properties).not.toHaveProperty("conversation_id");
      expect(echo.inputSchema.properties).not.toHaveProperty("agent_id");
      expect(echo.inputSchema.properties).toHaveProperty("context");

      const result = await client.callTool({
        name: "echo",
        arguments: { msg: "hi" },
      });
      expect(result.content[0].text).toBe("hi");
      expect(mintBackOf(result)).toBeUndefined();

      // Absence proof needs a settle — nothing to wait for.
      await settle(150);
      expect(capture.getEvents()).toHaveLength(0);
      expect(sink.filter((e) => e.tool === "echo")).toHaveLength(1);
    },
  },

  // ── 3 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("tracing-off-x-report-missing-on"),
    script: async ({ client, capture }) => {
      // Report-missing stays on by default even with tracing off.
      const { tools } = await client.listTools();
      expect(tools.find((t: any) => t.name === "get_more_tools")).toBeDefined();

      const result = await client.callTool({
        name: "get_more_tools",
        arguments: { context: "need a search tool" },
      });
      expect(result.content[0].text).toContain(
        "we have shown you the full tool list",
      );
      expect(mintBackOf(result)).toBeUndefined();

      await settle(150);
      expect(capture.getEvents()).toHaveLength(0);
    },
  },

  // ── 4 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("report-missing-off"),
    script: async ({ client }) => {
      const { tools } = await client.listTools();
      expect(
        tools.find((t: any) => t.name === "get_more_tools"),
      ).toBeUndefined();
      // Handle/context injection is unaffected.
      const echo = tools.find((t: any) => t.name === "echo")!;
      expect(echo.inputSchema.properties).toHaveProperty("conversation_id");
      expect(echo.inputSchema.properties).toHaveProperty("context");
    },
  },

  // ── 5 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("report-missing-call"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const missing = "Need a database query tool for SQL operations";
      const result = await client.callTool({
        name: "get_more_tools",
        arguments: { context: missing },
      });
      expect(result.content[0].text).toContain("Unfortunately");
      expect(result.content[0].text).toContain(
        "we have shown you the full tool list",
      );

      const [event] = await waitForEvents(capture, 1);
      expect(event.resourceName).toBe("get_more_tools");
      expect(event.userIntent).toBe(missing);
      expect(event.sessionId).toMatch(/^ses_/);
      // The bespoke context is a real parameter — preserved RAW on the event.
      expect(rawArgsOf(event).context).toBe(missing);
    },
  },

  // ── 6 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("context-off"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      const echo = tools.find((t: any) => t.name === "echo")!;
      expect(echo.inputSchema.properties).not.toHaveProperty("context");
      // Handles are independent of the context feature.
      expect(echo.inputSchema.properties).toHaveProperty("conversation_id");

      await client.callTool({
        name: "echo",
        arguments: { msg: "hi", conversation_id: "ses_ctxoff" },
      });
      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe("ses_ctxoff");
      expect(event.userIntent).toBeUndefined();
    },
  },

  // ── 7 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("context-custom-description"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      const echo = tools.find((t: any) => t.name === "echo")!;
      expect(echo.inputSchema.properties.context.description).toBe(
        CUSTOM_CONTEXT_DESCRIPTION,
      );
      expect(echo.inputSchema.properties.context.description).not.toBe(
        DEFAULT_CONTEXT_PARAMETER_DESCRIPTION,
      );
      // get_more_tools keeps its bespoke context parameter untouched.
      const gmt = tools.find((t: any) => t.name === "get_more_tools")!;
      expect(gmt.inputSchema.properties.context.description).not.toBe(
        CUSTOM_CONTEXT_DESCRIPTION,
      );

      await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "custom description intent" },
      });
      const [event] = await waitForEvents(capture, 1);
      expect(event.userIntent).toBe("custom description intent");
    },
  },

  // ── 8 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("agent-tracking-mint"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      const echo = tools.find((t: any) => t.name === "echo")!;
      expect(echo.inputSchema.properties).toHaveProperty("agent_id");
      expect(echo.inputSchema.properties).toHaveProperty("conversation_id");
      // agent_id is self-chosen and required; conversation_id stays optional —
      // omission is the task-minting signal.
      expect(echo.inputSchema.required).toContain("agent_id");
      expect(echo.inputSchema.required ?? []).not.toContain("conversation_id");

      // The structured tool carries the declared outputSchema, so the
      // mint-back mirrors into structuredContent (and the v2 client
      // validated the result against the injected outputSchema in transit).
      // agent_id is omitted here — there is no server-side agent minting, so
      // the block and mirror carry the conversation_id only.
      const result = await client.callTool({
        name: "structured",
        arguments: { msg: "mint", context: "agent minting" },
      });
      const block = mintBackOf(result)!;
      expect(block).toContain("[MCP INSTRUCTIONS]: conversation_id issued");
      expect(block).not.toContain("agent_id");
      const conversationId = handleFrom(block, "conversation_id");
      expect(conversationId).toMatch(/^ses_/);

      expect(result.structuredContent.echoed).toBe("mint");
      const mirror = result.structuredContent._mcp_instructions;
      expect(mirror.conversation_id).toBe(conversationId);
      expect(mirror.agent_id).toBeUndefined();
      expect(mirror.instructions).toContain("conversation_id issued");

      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe(conversationId);
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "minted",
      });
      expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
      expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_SOURCE);
    },
  },

  // ── 9 ────────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("agent-tracking-supplied"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const first = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "agent supplied — mint first" },
      });
      const block = mintBackOf(first)!;
      expect(block).toContain("[MCP INSTRUCTIONS]: conversation_id issued");
      expect(block).not.toContain("agent_id");
      const conversationId = handleFrom(block, "conversation_id");

      // Call 2 supplies a self-chosen agent_id + call 1's conversation_id → both
      // sources "supplied", echoed verbatim, no mint-back.
      const second = await client.callTool({
        name: "echo",
        arguments: {
          msg: "two",
          context: "agent supplied — reuse",
          conversation_id: conversationId,
          agent_id: "opus-4.80-1m|claude-code|k3n9x",
        },
      });
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events[0].tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
      expect(events[1].sessionId).toBe(conversationId);
      expect(events[1].tags).toMatchObject({
        [AGENTCAT_TAG_AGENT_ID]: "opus-4.80-1m|claude-code|k3n9x",
        [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "supplied",
      });
    },
  },

  // ── 10 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("agent-tracking-x-hook"),
    script: async ({ client, capture }) => {
      // Hook mode: NO conversation_id param anywhere; agent_id stays available and
      // required (self-chosen — there is no server-side agent minting).
      const { tools } = await client.listTools();
      const echo = tools.find((t: any) => t.name === "echo")!;
      expect(echo.inputSchema.properties).not.toHaveProperty("conversation_id");
      expect(echo.inputSchema.properties).toHaveProperty("agent_id");
      expect(echo.inputSchema.required).toContain("agent_id");
      const gmt = tools.find((t: any) => t.name === "get_more_tools")!;
      expect(gmt.inputSchema.properties).not.toHaveProperty("conversation_id");
      expect(gmt.inputSchema.properties).toHaveProperty("agent_id");
      expect(gmt.inputSchema.required).toContain("agent_id");

      const first = await client.callTool({
        name: "echo",
        arguments: {
          msg: "one",
          context: "agent hook",
          agent_id: "opus-4.80-1m|claude-code|k3n9x",
        },
      });
      // Hook mode never emits a text mint-back block, agent supplied or not.
      expect(mintBackOf(first)).toBeUndefined();

      const second = await client.callTool({
        name: "echo",
        arguments: {
          msg: "two",
          context: "agent hook",
          agent_id: "opus-4.80-1m|claude-code|k3n9x",
        },
      });
      expect(mintBackOf(second)).toBeUndefined();

      // Deterministic ses_: same hook value + project → same id across calls
      // (per-request lanes: across fresh tracked instances).
      const events = await waitForEvents(capture, 2);
      expect(events[0].sessionId).toMatch(/^ses_/);
      expect(events[0].sessionId).toBe(events[1].sessionId);
      for (const event of events) {
        expect(event.tags).toMatchObject({
          [AGENTCAT_TAG_CONVERSATION_SOURCE]: "hook",
          [AGENTCAT_TAG_AGENT_ID]: "opus-4.80-1m|claude-code|k3n9x",
          [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
        });
      }
    },
  },

  // ── 11 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("task-hook-deterministic"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const first = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "hook determinism" },
      });
      const second = await client.callTool({
        name: "echo",
        arguments: { msg: "two", context: "hook determinism" },
      });
      // Hook mode never announces the derived id.
      expect(mintBackOf(first)).toBeUndefined();
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events[0].sessionId).toMatch(/^ses_/);
      expect(events[0].sessionId).toBe(events[1].sessionId);
      for (const event of events) {
        expect(event.tags).toMatchObject({
          [AGENTCAT_TAG_CONVERSATION_SOURCE]: "hook",
        });
      }
    },
  },

  // ── 12 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("task-hook-null"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const first = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "hook null" },
      });
      const second = await client.callTool({
        name: "echo",
        arguments: { msg: "two", context: "hook null" },
      });
      // The agent can never learn a silently minted id — nothing is prompted.
      expect(mintBackOf(first)).toBeUndefined();
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.sessionId).toMatch(/^ses_/);
        expect(event.tags).toMatchObject({
          [AGENTCAT_TAG_CONVERSATION_SOURCE]: "minted",
        });
      }
      // One single-event task per null return — never a shared session.
      expect(events[0].sessionId).not.toBe(events[1].sessionId);
    },
  },

  // ── 13 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("task-supplied-continuity"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const first = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "continuity — mint" },
      });
      const conversationId = handleFrom(mintBackOf(first)!, "conversation_id");
      expect(conversationId).toMatch(/^ses_/);

      const second = await client.callTool({
        name: "echo",
        arguments: {
          msg: "two",
          context: "continuity — supply",
          conversation_id: conversationId,
        },
      });
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events[0].sessionId).toBe(conversationId);
      expect(events[1].sessionId).toBe(conversationId);
      expect(events[0].tags).toMatchObject({
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "minted",
      });
      expect(events[1].tags).toMatchObject({
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "supplied",
      });
    },
  },

  // ── 14 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("mint-back-structured-mirror"),
    script: async ({ client, capture }) => {
      // List first so the typed v2 client validates the call result against
      // the injected outputSchema (declaring _mcp_instructions) — a result
      // that failed the declared schema would throw right here.
      await client.listTools();
      const result = await client.callTool({
        name: "structured",
        arguments: { msg: "mirrored", context: "structured mirror" },
      });

      // Text block + structured mirror, consistent with each other.
      const block = mintBackOf(result)!;
      expect(block).toContain("[MCP INSTRUCTIONS]: conversation_id issued");
      const conversationId = handleFrom(block, "conversation_id");
      expect(result.structuredContent.echoed).toBe("mirrored");
      const mirror = result.structuredContent._mcp_instructions;
      expect(mirror.conversation_id).toBe(conversationId);
      expect(mirror.instructions).toContain("conversation_id issued");
      // Agent tracking is off → the mirror carries no agent_id.
      expect(mirror.agent_id).toBeUndefined();

      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe(conversationId);
      // Mint-back is wire-only — never recorded on the event.
      expect(JSON.stringify(event.response)).not.toContain(
        "[MCP INSTRUCTIONS]",
      );
    },
  },

  // ── 15 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("strict-schema-injection"),
    script: async ({ client, capture, sink }) => {
      const { tools } = await client.listTools();
      const strict = tools.find((t: any) => t.name === "strict")!;
      // additionalProperties:false is dropped so optional handles can ride.
      expect(strict.inputSchema.additionalProperties).toBeUndefined();
      expect(strict.inputSchema.properties.conversation_id).toBeDefined();
      expect(strict.inputSchema.properties.context).toBeDefined();

      // The call with handles riding must clear the strictObject zod gate
      // over real HTTP — proof the injected params are stripped pre-handler.
      const result = await client.callTool({
        name: "strict",
        arguments: {
          msg: "strictly",
          context: "strict schema test",
          conversation_id: "ses_strict",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(
        result.content.find((c: any) => c.text === "strictly"),
      ).toBeDefined();

      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe("ses_strict");
      const seen = sink.filter((e) => e.tool === "strict");
      expect(seen).toHaveLength(1);
      expect(seen[0].args).toEqual({ msg: "strictly" });
    },
  },

  // ── 16 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("strip-proof-loose"),
    script: async ({ client, capture, sink }) => {
      // The loose tool's schema passes unknown keys through zod, so the sink
      // is a faithful record of what survived the strip: customer extras must
      // arrive, injected params must not.
      await client.listTools();
      await client.callTool({
        name: "loose",
        arguments: {
          msg: "hi",
          customer_extra: "keep-me",
          context: "strip proof",
          conversation_id: "ses_loose",
        },
      });

      const seen = sink.filter((e) => e.tool === "loose");
      expect(seen).toHaveLength(1);
      expect(seen[0].args.msg).toBe("hi");
      expect(seen[0].args.customer_extra).toBe("keep-me");
      expect(seen[0].args.conversation_id).toBeUndefined();
      expect(seen[0].args.context).toBeUndefined();
      expect(seen[0].args.agent_id).toBeUndefined();

      // The event keeps the RAW wire arguments, injected params included.
      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe("ses_loose");
      const raw = rawArgsOf(event);
      expect(raw.msg).toBe("hi");
      expect(raw.customer_extra).toBe("keep-me");
      expect(raw.conversation_id).toBe("ses_loose");
      expect(raw.context).toBe("strip proof");
    },
  },

  // ── 17 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("error-path"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const result = await client.callTool({
        name: "boom",
        arguments: { context: "error path intent" },
      });
      // v2 McpServer converts handler throws into isError results; the SDK
      // still appends the mint-back to the failed result on the wire.
      expect(result.isError).toBe(true);
      const block = mintBackOf(result)!;
      expect(handleFrom(block, "conversation_id")).toMatch(/^ses_/);

      const [event] = await waitForEvents(capture, 1);
      expect(event.resourceName).toBe("boom");
      expect(event.isError).toBe(true);
      expect(event.error?.message).toContain("boom");
      expect(event.userIntent).toBe("error path intent");
      expect(event.sessionId).toMatch(/^ses_/);
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "minted",
      });
      // Mint-back stays wire-only even on errors.
      expect(JSON.stringify(event.response)).not.toContain(
        "[MCP INSTRUCTIONS]",
      );

      // Follow-up echo on the same lane instance succeeds — the error left
      // no poisoned state behind.
      const followUp = await client.callTool({
        name: "echo",
        arguments: { msg: "after", context: "error recovery" },
      });
      expect(followUp.isError).not.toBe(true);
      const events = await waitForEvents(capture, 2);
      expect(events[1].resourceName).toBe("echo");
      expect(events[1].isError).not.toBe(true);
    },
  },

  // ── 18 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("hooks-identity-tags-props"),
    script: async ({ client, capture }) => {
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: { msg: "hooks", context: "hooks combo" },
      });

      const [event] = await waitForEvents(capture, 1);
      // Identity stamped onto the tool-call event itself.
      expect(event.identifyActorGivenId).toBe(IDENTITY_USER_ID);
      expect(event.identifyActorName).toBe(IDENTITY_USER_NAME);
      expect(event.identifyActorData).toEqual(IDENTITY_USER_DATA);
      // Customer tag present; on the colliding SDK-owned key the SDK wins.
      expect(event.tags?.[CUSTOMER_TAG_KEY]).toBe(CUSTOMER_TAG_VALUE);
      expect(event.tags?.[AGENTCAT_TAG_CONVERSATION_SOURCE]).toBe("minted");
      expect(event.tags?.[AGENTCAT_TAG_CONVERSATION_SOURCE]).not.toBe(
        COLLIDING_TAG_VALUE,
      );
      // Properties merged.
      expect(event.properties).toMatchObject({
        [CUSTOMER_PROP_KEY]: CUSTOMER_PROP_VALUE,
      });
    },
  },

  // ── 19 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("redaction"),
    script: async ({ client, capture }) => {
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: {
          msg: `payload ${REDACTION_SECRET} inside`,
          context: `intent mentioning ${REDACTION_SECRET}`,
          conversation_id: "ses_redact",
        },
      });

      // The pipeline (redact → sanitize → truncate) mutates the queued event
      // in place after add(); wait for the event, then settle for the pass.
      await waitForEvents(capture, 1);
      await settle();

      const [event] = capture.getEvents();
      const responseText = JSON.stringify(event.response);
      expect(responseText).toContain(REDACTION_REPLACEMENT);
      expect(responseText).not.toContain(REDACTION_SECRET);
      const raw = rawArgsOf(event);
      expect(raw.msg).toBe(`payload ${REDACTION_REPLACEMENT} inside`);
      expect(event.userIntent).toBe(
        `intent mentioning ${REDACTION_REPLACEMENT}`,
      );
      // Protected fields survive redaction untouched.
      expect(event.sessionId).toBe("ses_redact");
      expect(event.resourceName).toBe("echo");
    },
  },

  // ── 20 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("client-identity-ladder"),
    script: async ({ client, capture, lane }) => {
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: { msg: "who am I", context: "identity ladder" },
      });
      const [event] = await waitForEvents(capture, 1);

      if (lane.id === "v2-handler-auto") {
        // 2026-07-28 era: identity travels in the per-request envelope, so
        // even a fresh per-request instance knows the caller — plus the
        // envelope-derived protocol-version tag on the event.
        expect(event.clientName).toBe("agentcat-e2e-client");
        expect(event.clientVersion).toBe("1.0.0");
        expect(event.tags?.[AGENTCAT_TAG_PROTOCOL_VERSION]).toBe("2026-07-28");
      } else if (lane.id === "v2-longlived") {
        // Legacy wire on a persistent server: the real initialize handshake
        // ran against THIS instance, so getClientVersion() (rung 3 of the
        // ladder) yields the handshake identity. No envelope → no protocol
        // version tag.
        expect(event.clientName).toBe("agentcat-e2e-client");
        expect(event.clientVersion).toBe("1.0.0");
        expect(event.tags?.[AGENTCAT_TAG_PROTOCOL_VERSION]).toBeUndefined();
      } else {
        // v2-handler-legacy (empirically pinned): the legacy client sends
        // initialize once, but every request is served by a FRESH factory
        // instance that never saw that handshake. No envelope (legacy wire),
        // no _meta clientInfo, and getClientVersion() on the per-request
        // instance has nothing → the ladder bottoms out with no identity.
        expect(event.clientName).toBeUndefined();
        expect(event.clientVersion).toBeUndefined();
        expect(event.tags?.[AGENTCAT_TAG_PROTOCOL_VERSION]).toBeUndefined();
      }
    },
  },

  // ── 21 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("rebuild-on-demand"),
    script: async ({ client, capture }) => {
      // tools/call before ANY tools/list. Use the low-level request() verb:
      // the typed callTool() does cache/output-validator pre-work that can
      // itself fetch tools/list and defeat the premise (see
      // src/tests/v2/track-lowlevel.test.ts). On these per-request lanes the
      // serving instance is fresh either way — this keeps the wire clean of
      // any tools/list at all.
      const result: any = await (client as any).request({
        method: "tools/call",
        params: {
          name: "echo",
          arguments: { msg: "solo", context: "rebuild on demand" },
        },
      });
      expect(
        (result.content as any[]).find((c) => c.text === "solo"),
      ).toBeDefined();
      const block = mintBackOf(result)!;
      const conversationId = handleFrom(block, "conversation_id");
      expect(conversationId).toMatch(/^ses_/);

      const [event] = await waitForEvents(capture, 1);
      expect(event.resourceName).toBe("echo");
      expect(event.sessionId).toBe(conversationId);
      expect(event.userIntent).toBe("rebuild on demand");
    },
  },

  // ── 22 ───────────────────────────────────────────────────────────────────
  {
    ...scenarioConfig("session-continuity-stateful"),
    script: async ({ client, capture }) => {
      // The long-lived lane holds ONE NodeStreamableHTTPServerTransport, which
      // supports a single session — a second connectClient() would be refused
      // with "Server already initialized". Observe the negotiated
      // mcp-session-id through the connected client's own transport (the
      // Protocol base exposes a `transport` getter; the streamable HTTP client
      // transport exposes `sessionId`). The frozen ScenarioClient type just
      // doesn't declare it — hence the cast.
      const transport = (client as any).transport as
        { sessionId?: string } | undefined;
      const httpSessionId = transport?.sessionId;
      expect(httpSessionId).toBeDefined();

      await client.listTools();
      const first: any = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "stateful continuity" },
      });
      const conversationId = handleFrom(mintBackOf(first)!, "conversation_id");
      const second: any = await client.callTool({
        name: "echo",
        arguments: {
          msg: "two",
          context: "stateful continuity",
          conversation_id: conversationId,
        },
      });
      expect(mintBackOf(second)).toBeUndefined();

      // ONE mcp-session-id spanned every request on this transport.
      expect(((client as any).transport as any).sessionId).toBe(httpSessionId);

      const events = await waitForEvents(capture, 2);
      expect(events[0].sessionId).toBe(conversationId);
      expect(events[1].sessionId).toBe(conversationId);
      expect(events[0].tags).toMatchObject({
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "minted",
      });
      expect(events[1].tags).toMatchObject({
        [AGENTCAT_TAG_CONVERSATION_SOURCE]: "supplied",
      });
    },
  },
];

describe.each(lanes)("e2e-http v2 lane: $id", (lane) => {
  const applicable = scenarios.filter(
    (s) => !s.lanes || s.lanes.includes(lane.id),
  );

  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it.each(applicable)("$name", async (scenario) => {
    const sink: ToolSink = [];
    const instance = await lane.start(scenario.options, sink);
    try {
      const client = await instance.connectClient();
      await scenario.script({ client, capture, sink, lane, instance });
    } finally {
      await instance.close();
    }
  });
});
