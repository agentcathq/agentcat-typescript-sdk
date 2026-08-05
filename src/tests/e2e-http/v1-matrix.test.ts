// v1 lanes × scenarios over real HTTP.
//
// Phase 1 base shipped the baseline-defaults smoke proving both v1 lane
// topologies end to end; Phase 2 (agent A) extends the `scenarios` array in
// place with the remaining scenario scripts from the plan's table — configs
// come from scenario-types.ts via scenarioConfig(name). Assertion strength
// mirrors the src/tests/v2/* suites: exact tag values, mint-back text
// prefixes, exact event counts, /^ses_/ regexes, and RAW-on-event
// vs STRIPPED-in-sink proofs. All assertions go through EventCapture + the
// toolkit sink — never ~/agentcat.log (concurrent suites interleave it).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { EventCapture, sid } from "../test-utils.js";
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
  CUSTOMER_PROP_KEY,
  CUSTOMER_PROP_VALUE,
  type Scenario,
} from "./scenario-types.js";
import type { ToolSink } from "./toolkit.js";
import {
  AGENTCAT_TAG_AGENT_ID,
  AGENTCAT_TAG_AGENT_SOURCE,
  AGENTCAT_TAG_PROTOCOL_VERSION,
  AGENTCAT_TAG_SESSION_SOURCE,
  DEFAULT_CONTEXT_PARAMETER_DESCRIPTION,
  META_PROTOCOL_VERSION_KEY,
  MINT_BACK_HEADER_SESSION,
} from "../../modules/constants.js";

const lanes: Lane[] = [laneById("v1-stateful"), laneById("v1-stateless")];

const findTool = (tools: any[], name: string) =>
  tools.find((t: any) => t.name === name);

/** RAW args as recorded on the published event (pre-strip, post-redaction). */
const rawArgsOf = (event: any): Record<string, unknown> =>
  (event.parameters as any).request.params.arguments;

const scenarios: Scenario[] = [
  // ── 1 ── baseline: injection, mint-back, one event (RAW) + sink (STRIPPED)
  {
    ...scenarioConfig("baseline-defaults"),
    script: async ({ client, capture, sink }) => {
      // Listing: agentcat injected context + session_id and added get_more_tools.
      const { tools } = await client.listTools();
      const names = tools.map((t: any) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("get_more_tools");
      const echo = findTool(tools, "echo")!;
      expect(echo.inputSchema.properties.context).toBeDefined();
      expect(echo.inputSchema.properties.context.description).toBe(
        DEFAULT_CONTEXT_PARAMETER_DESCRIPTION,
      );
      expect(echo.inputSchema.properties.session_id).toBeDefined();
      // Handles are never required — omission is the minting signal.
      expect(echo.inputSchema.required ?? []).not.toContain("session_id");

      // Call with context but no session_id → SDK mints and announces the handle.
      const result = await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "e2e smoke intent" },
      });
      const mintBack = mintBackOf(result);
      expect(mintBack).toBeDefined();
      expect(mintBack).toContain(MINT_BACK_HEADER_SESSION);
      const sessionId = handleFrom(mintBack!, "session_id");
      expect(sessionId).toMatch(/^ses_/);

      // Exactly one event: minted ses_ session + captured intent + RAW args.
      const events = await waitForEvents(capture, 1);
      expect(events).toHaveLength(1);
      const [event] = capture.findEventsByResourceName("echo");
      expect(event.sessionId).toBe(sessionId);
      expect(event.userIntent).toBe("e2e smoke intent");
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
      });
      // RAW on the event: context survives exactly as sent over the wire.
      expect(rawArgsOf(event).context).toBe("e2e smoke intent");
      expect(rawArgsOf(event).msg).toBe("hi");

      // Strip-proof: the customer handler saw msg but no injected params.
      const seen = sink.filter((entry) => entry.tool === "echo");
      expect(seen).toHaveLength(1);
      expect(seen[0].args.msg).toBe("hi");
      expect(seen[0].args.session_id).toBeUndefined();
      expect(seen[0].args.context).toBeUndefined();
    },
  },

  // ── 2 ── tracing off: no injection, no mint-back, zero events
  {
    ...scenarioConfig("tracing-off"),
    script: async ({ client, capture, sink }) => {
      const { tools } = await client.listTools();
      const echo = findTool(tools, "echo")!;
      // enableTracing:false skips HANDLE injection wholesale (spec guard in
      // engine/listWrap.ts); the context param is gated independently by
      // enableToolCallContext (default true), so it is still advertised.
      expect(echo.inputSchema.properties?.session_id).toBeUndefined();
      expect(echo.inputSchema.properties?.agent_id).toBeUndefined();
      expect(echo.inputSchema.properties?.context).toBeDefined();

      const result = await client.callTool({
        name: "echo",
        arguments: { msg: "hi" },
      });
      expect(result.content[0].text).toBe("hi");
      expect(mintBackOf(result)).toBeUndefined();

      await settle();
      expect(capture.getEvents()).toHaveLength(0);
      expect(sink.filter((e) => e.tool === "echo")).toHaveLength(1);
    },
  },

  // ── 3 ── tracing off × report-missing on: gmt still listed + answered, 0 events
  {
    ...scenarioConfig("tracing-off-x-report-missing-on"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      expect(findTool(tools, "get_more_tools")).toBeDefined();

      const result = await client.callTool({
        name: "get_more_tools",
        arguments: { context: "need a search tool" },
      });
      expect(result.content[0].text).toContain(
        "we have shown you the full tool list",
      );
      expect(mintBackOf(result)).toBeUndefined();

      await settle();
      expect(capture.getEvents()).toHaveLength(0);
    },
  },

  // ── 4 ── report-missing off: no gmt; handle/context injection unaffected
  {
    ...scenarioConfig("report-missing-off"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      expect(findTool(tools, "get_more_tools")).toBeUndefined();
      const echo = findTool(tools, "echo")!;
      expect(echo.inputSchema.properties.session_id).toBeDefined();
      expect(echo.inputSchema.properties.context).toBeDefined();

      // Injection still functions end to end: minting + event flow intact.
      const result = await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "no gmt" },
      });
      expect(handleFrom(mintBackOf(result)!, "session_id")).toMatch(/^ses_/);
      const events = await waitForEvents(capture, 1);
      expect(events).toHaveLength(1);
    },
  },

  // ── 5 ── get_more_tools call: canned text; event with userIntent; wire-only mint-back
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
      const block = mintBackOf(result)!;
      expect(handleFrom(block, "session_id")).toMatch(/^ses_/);

      const events = await waitForEvents(capture, 1);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event.resourceName).toBe("get_more_tools");
      expect(event.userIntent).toBe(missing);
      expect(event.sessionId).toBe(handleFrom(block, "session_id"));
      // Mint-back is wire-only — never recorded on the published event.
      expect(JSON.stringify(event.response)).not.toContain(
        "[MCP INSTRUCTIONS]",
      );
    },
  },

  // ── 6 ── context off: no context param; supplied task honored; no userIntent
  {
    ...scenarioConfig("context-off"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      const echo = findTool(tools, "echo")!;
      expect(echo.inputSchema.properties?.context).toBeUndefined();
      // Handles are independent of the context feature.
      expect(echo.inputSchema.properties.session_id).toBeDefined();

      await client.callTool({
        name: "echo",
        arguments: { msg: "hi", session_id: sid("ctxoff") },
      });
      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe(sid("ctxoff"));
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "supplied",
      });
      expect(event.userIntent).toBeUndefined();
    },
  },

  // ── 7 ── custom context description on customer tools; gmt keeps its own
  {
    ...scenarioConfig("context-custom-description"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      const echo = findTool(tools, "echo")!;
      expect(echo.inputSchema.properties.context.description).toBe(
        CUSTOM_CONTEXT_DESCRIPTION,
      );
      expect(echo.inputSchema.properties.context.description).not.toBe(
        DEFAULT_CONTEXT_PARAMETER_DESCRIPTION,
      );
      // get_more_tools keeps its bespoke context parameter untouched.
      const gmt = findTool(tools, "get_more_tools")!;
      expect(gmt.inputSchema.properties.context.description).not.toBe(
        CUSTOM_CONTEXT_DESCRIPTION,
      );

      await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "custom description intent" },
      });
      const [event] = await waitForEvents(capture, 1);
      expect(event.resourceName).toBe("echo");
      expect(event.userIntent).toBe("custom description intent");
    },
  },

  // ── 8 ── agent tracking: agent_id is self-chosen, required on schema, and
  // omission yields a task-only mint-back (no server-side agent minting).
  {
    ...scenarioConfig("agent-tracking-mint"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      const structured = findTool(tools, "structured")!;
      expect(structured.inputSchema.properties.agent_id).toBeDefined();
      expect(structured.inputSchema.properties.session_id).toBeDefined();
      expect(structured.inputSchema.required).toContain("agent_id");
      const gmt = findTool(tools, "get_more_tools")!;
      expect(gmt.inputSchema.properties.agent_id).toBeDefined();
      expect(gmt.inputSchema.required).toContain("agent_id");

      // structured declares an outputSchema, so the mirror rides
      // structuredContent — and the v1 client ajv-validates it against the
      // injected outputSchema it just listed.
      const result = await client.callTool({
        name: "structured",
        arguments: { msg: "hi", context: "agent minting" },
      });
      const block = mintBackOf(result)!;
      expect(block).toContain(MINT_BACK_HEADER_SESSION);
      expect(block).not.toContain("agent_id");
      const sessionId = handleFrom(block, "session_id");
      expect(sessionId).toMatch(/^ses_/);

      const mirror = result.structuredContent._mcp_instructions;
      expect(mirror.session_id).toBe(sessionId);
      expect(mirror.agent_id).toBeUndefined();
      expect(result.structuredContent.echoed).toBe("hi");

      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe(sessionId);
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
      });
      expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
      expect(event.tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_SOURCE);
    },
  },

  // ── 9 ── agent tracking: supplying a self-chosen agent_id on call 2 tags
  // it "supplied" verbatim; call 1 (agent omitted) carries no agent tag.
  {
    ...scenarioConfig("agent-tracking-supplied"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const first = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "agent supplied 1" },
      });
      const block = mintBackOf(first)!;
      expect(block).toContain(MINT_BACK_HEADER_SESSION);
      expect(block).not.toContain("agent_id");
      const sessionId = handleFrom(block, "session_id");

      const second = await client.callTool({
        name: "echo",
        arguments: {
          msg: "two",
          context: "agent supplied 2",
          session_id: sessionId,
          agent_id: "opus-4.80-1m|claude-code|k3n9x",
        },
      });
      // Nothing minted → no mint-back at all on the second call.
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events).toHaveLength(2);
      expect(events[0].tags).not.toHaveProperty(AGENTCAT_TAG_AGENT_ID);
      expect(events[1].sessionId).toBe(sessionId);
      expect(events[1].tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "supplied",
        [AGENTCAT_TAG_AGENT_ID]: "opus-4.80-1m|claude-code|k3n9x",
        [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
      });
    },
  },

  // ── 10 ── agent tracking × task hook: no session_id param; hook mode never
  // emits a text mint-back block, agent supplied or not — the agent must
  // self-choose its id since there is no server-side minting to announce.
  {
    ...scenarioConfig("agent-tracking-x-hook"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      for (const name of ["echo", "get_more_tools"]) {
        const tool = findTool(tools, name)!;
        expect(tool.inputSchema.properties?.session_id).toBeUndefined();
        expect(tool.inputSchema.properties.agent_id).toBeDefined();
        expect(tool.inputSchema.required).toContain("agent_id");
      }

      const result = await client.callTool({
        name: "echo",
        arguments: {
          msg: "hi",
          context: "hook plus agent",
          agent_id: "opus-4.80-1m|claude-code|k3n9x",
        },
      });
      expect(mintBackOf(result)).toBeUndefined();

      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toMatch(/^ses_/);
      expect(event.tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "hook",
        [AGENTCAT_TAG_AGENT_ID]: "opus-4.80-1m|claude-code|k3n9x",
        [AGENTCAT_TAG_AGENT_SOURCE]: "supplied",
      });
    },
  },

  // ── 11 ── deterministic hook: same ses_ across calls (and, on the
  // per-request lane, across fresh tracked instances) — derivation is
  // stateless and stable; no mint-back ever in hook mode.
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
      expect(mintBackOf(first)).toBeUndefined();
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events).toHaveLength(2);
      expect(events[0].sessionId).toMatch(/^ses_/);
      expect(events[0].sessionId).toBe(events[1].sessionId);
      for (const event of events) {
        expect(event.tags).toMatchObject({
          [AGENTCAT_TAG_SESSION_SOURCE]: "hook",
        });
      }
    },
  },

  // ── 12 ── hook null: silent per-call mint, distinct ses_ per call
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
      // The agent can never learn a silently minted id → nothing prompted.
      expect(mintBackOf(first)).toBeUndefined();
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events).toHaveLength(2);
      for (const event of events) {
        expect(event.sessionId).toMatch(/^ses_/);
        expect(event.tags).toMatchObject({
          [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
        });
      }
      expect(events[0].sessionId).not.toBe(events[1].sessionId);
    },
  },

  // ── 13 ── minted → supplied continuity across two calls
  {
    ...scenarioConfig("task-supplied-continuity"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const first = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "continuity 1" },
      });
      const sessionId = handleFrom(mintBackOf(first)!, "session_id");
      expect(sessionId).toMatch(/^ses_/);

      const second = await client.callTool({
        name: "echo",
        arguments: {
          msg: "two",
          context: "continuity 2",
          session_id: sessionId,
        },
      });
      expect(mintBackOf(second)).toBeUndefined();

      const events = await waitForEvents(capture, 2);
      expect(events).toHaveLength(2);
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[1].sessionId).toBe(sessionId);
      expect(events[0].tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
      });
      expect(events[1].tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "supplied",
      });
    },
  },

  // ── 14 ── structured mirror: text mint-back + _mcp_instructions, schema-valid
  {
    ...scenarioConfig("mint-back-structured-mirror"),
    script: async ({ client, capture }) => {
      const { tools } = await client.listTools();
      // The injected outputSchema declares the mirror field the client will
      // validate against.
      const listed = findTool(tools, "structured")!;
      expect(listed.outputSchema.properties._mcp_instructions).toBeDefined();

      // listTools above cached the outputSchema client-side, so this result
      // was ajv-validated against the injected declaration on the way in —
      // "passes declared outputSchema" is proven by the call not throwing.
      const result = await client.callTool({
        name: "structured",
        arguments: { msg: "mirrored", context: "structured mirror" },
      });
      const block = mintBackOf(result)!;
      const sessionId = handleFrom(block, "session_id");
      const mirror = result.structuredContent._mcp_instructions;
      expect(mirror.session_id).toBe(sessionId);
      expect(mirror.instructions).toContain("session_id issued");
      expect(result.structuredContent.echoed).toBe("mirrored");

      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe(sessionId);
      // The mirror is wire-only: the published response never carries it.
      expect(JSON.stringify(event.response)).not.toContain("_mcp_instructions");
    },
  },

  // ── 15 ── strict schema: additionalProperties dropped; handles ride along
  {
    ...scenarioConfig("strict-schema-injection"),
    script: async ({ client, capture, sink }) => {
      const { tools } = await client.listTools();
      const strict = findTool(tools, "strict")!;
      // zod .strict() serializes to additionalProperties:false — injection
      // must drop it so optional handles can ride along.
      expect(strict.inputSchema.additionalProperties).toBeUndefined();
      expect(strict.inputSchema.properties.session_id).toBeDefined();
      expect(strict.inputSchema.properties.context).toBeDefined();

      // Handles riding on the call succeed over real HTTP because agentcat
      // strips them BEFORE the customer's strict zod parse runs.
      const result = await client.callTool({
        name: "strict",
        arguments: {
          msg: "strict ok",
          context: "strict schema test",
          session_id: sid("strict1"),
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content.find((c: any) => c.type === "text").text).toBe(
        "strict ok",
      );

      const [event] = await waitForEvents(capture, 1);
      expect(event.sessionId).toBe(sid("strict1"));
      const seen = sink.filter((entry) => entry.tool === "strict");
      expect(seen).toHaveLength(1);
      expect(seen[0].args).toEqual({ msg: "strict ok" });
    },
  },

  // ── 16 ── strip proof on a loose schema: RAW on event, STRIPPED in sink
  {
    ...scenarioConfig("strip-proof-loose"),
    script: async ({ client, capture, sink }) => {
      await client.listTools();
      await client.callTool({
        name: "loose",
        arguments: {
          msg: "keep",
          customer_extra: "customer says hi",
          context: "strip proof",
          session_id: sid("raw1"),
        },
      });

      // Sink: the passthrough schema delivered the customer's unknown key,
      // yet the injected params never reached the handler.
      const seen = sink.filter((entry) => entry.tool === "loose");
      expect(seen).toHaveLength(1);
      expect(seen[0].args.msg).toBe("keep");
      expect(seen[0].args.customer_extra).toBe("customer says hi");
      expect(seen[0].args.session_id).toBeUndefined();
      expect(seen[0].args.context).toBeUndefined();

      // Event: the RAW wire args survive in full on the published event.
      const [event] = await waitForEvents(capture, 1);
      expect(rawArgsOf(event)).toEqual({
        msg: "keep",
        customer_extra: "customer says hi",
        context: "strip proof",
        session_id: sid("raw1"),
      });
      expect(event.sessionId).toBe(sid("raw1"));
      expect(event.userIntent).toBe("strip proof");
    },
  },

  // ── 17 ── error path: isError event with intent + minted handle; instance survives
  {
    ...scenarioConfig("error-path"),
    script: async ({ client, capture }) => {
      await client.listTools();
      const result = await client.callTool({
        name: "boom",
        arguments: { context: "error path intent" },
      });
      expect(result.isError).toBe(true);
      // Mint-back applies to isError results too (handles.ts): the agent
      // still learns its session handle from a failed call.
      const block = mintBackOf(result)!;
      const sessionId = handleFrom(block, "session_id");
      expect(sessionId).toMatch(/^ses_/);

      const [errorEvent] = await waitForEvents(capture, 1);
      expect(errorEvent.isError).toBe(true);
      expect(errorEvent.error).toBeDefined();
      expect(errorEvent.error!.message).toContain("boom");
      expect(errorEvent.userIntent).toBe("error path intent");
      expect(errorEvent.sessionId).toBe(sessionId);
      expect(errorEvent.tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
      });

      // The same instance keeps serving after a handler throw.
      const followUp = await client.callTool({
        name: "echo",
        arguments: { msg: "still alive", context: "post-error" },
      });
      expect(followUp.isError).toBeFalsy();
      const events = await waitForEvents(capture, 2);
      expect(events).toHaveLength(2);
      expect(events[1].resourceName).toBe("echo");
      expect(events[1].isError).toBeUndefined();
    },
  },

  // ── 18 ── identify + eventTags (collision) + eventProperties
  {
    ...scenarioConfig("hooks-identity-tags-props"),
    script: async ({ client, capture }) => {
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: { msg: "hi", context: "hooks combo" },
      });

      const [event] = await waitForEvents(capture, 1);
      // Identity stamped straight onto the tool-call event.
      expect(event.identifyActorGivenId).toBe(IDENTITY_USER_ID);
      expect(event.identifyActorName).toBe(IDENTITY_USER_NAME);
      expect(event.identifyActorData).toEqual(IDENTITY_USER_DATA);
      // Customer tag present; the SDK's own value wins the collision on
      // AGENTCAT_TAG_SESSION_SOURCE (no task supplied → "minted", never the
      // customer's collision value).
      expect(event.tags![CUSTOMER_TAG_KEY]).toBe(CUSTOMER_TAG_VALUE);
      expect(event.tags![AGENTCAT_TAG_SESSION_SOURCE]).toBe("minted");
      // Properties merged from the customer callback.
      expect(event.properties).toMatchObject({
        [CUSTOMER_PROP_KEY]: CUSTOMER_PROP_VALUE,
      });
    },
  },

  // ── 19 ── redaction: secret scrubbed from response/args/userIntent
  {
    ...scenarioConfig("redaction"),
    script: async ({ client, capture }) => {
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: {
          msg: `payload with ${REDACTION_SECRET} inside`,
          context: `intent mentioning ${REDACTION_SECRET}`,
          session_id: sid("redact"),
        },
      });

      // The pipeline (redact → sanitize → truncate) mutates the queued event
      // asynchronously after add(); settle before asserting.
      await waitForEvents(capture, 1);
      await settle();

      const [event] = capture.getEvents();
      const responseText = JSON.stringify(event.response);
      expect(responseText).toContain(REDACTION_REPLACEMENT);
      expect(responseText).not.toContain(REDACTION_SECRET);
      expect(rawArgsOf(event).msg).toBe(
        `payload with ${REDACTION_REPLACEMENT} inside`,
      );
      expect(event.userIntent).toBe(
        `intent mentioning ${REDACTION_REPLACEMENT}`,
      );
      // Protected fields survive redaction untouched.
      expect(event.sessionId).toBe(sid("redact"));
      expect(event.resourceName).toBe("echo");
    },
  },

  // ── 20 ── client identity ladder, branched per v1 lane
  {
    ...scenarioConfig("client-identity-ladder"),
    script: async ({ client, capture, lane }) => {
      await client.listTools();
      await client.callTool({
        name: "echo",
        arguments: { msg: "who am I", context: "identity ladder" },
      });

      const [event] = await waitForEvents(capture, 1);
      if (lane.id === "v1-stateful") {
        // Handshake identity: the ONE long-lived tracked server saw this
        // client's initialize, so server.getClientVersion() resolves the
        // connecting client's Implementation.
        expect(event.clientName).toBe("agentcat-e2e-client");
        expect(event.clientVersion).toBe("1.0.0");
      } else {
        // v1-stateless (empirically pinned): the initialize handshake landed
        // on a per-request instance that died with its response; the fresh
        // instance serving tools/call never saw it, and the 2025-era v1
        // client sends no per-request _meta clientInfo — so the ladder
        // bottoms out at undefined identity.
        expect(event.clientName).toBeUndefined();
        expect(event.clientVersion).toBeUndefined();
      }
      // No envelope and no _meta protocol version on the 2025 wire → no
      // protocol tag on either v1 lane.
      expect(event.tags ?? {}).not.toHaveProperty(
        AGENTCAT_TAG_PROTOCOL_VERSION,
      );

      // But a _meta-carried protocol version IS honored per request.
      await (client as any).callTool({
        name: "echo",
        arguments: { msg: "again", context: "identity ladder meta" },
        _meta: { [META_PROTOCOL_VERSION_KEY]: "2026-07-28" },
      });
      const events = await waitForEvents(capture, 2);
      expect(events[1].tags![AGENTCAT_TAG_PROTOCOL_VERSION]).toBe("2026-07-28");
    },
  },

  // ── 21 ── rebuild-on-demand (per-request lanes): call before ANY list
  {
    ...scenarioConfig("rebuild-on-demand"),
    script: async ({ client, capture, sink }) => {
      // No listTools() anywhere: on this lane every request is served by a
      // fresh tracked instance, so the instance handling this call has never
      // built its injection registries. Use the low-level request() verb —
      // the typed callTool() does cache/output-validator pre-work that can
      // itself fetch tools/list and defeat the premise (see
      // src/tests/v2/track-lowlevel.test.ts for the same pattern).
      const result = await (client as any).request(
        {
          method: "tools/call",
          params: {
            name: "echo",
            arguments: { msg: "cold start", context: "rebuild on demand" },
          },
        },
        CallToolResultSchema,
      );

      const block = mintBackOf(result)!;
      const sessionId = handleFrom(block, "session_id");
      expect(sessionId).toMatch(/^ses_/);

      const events = await waitForEvents(capture, 1);
      expect(events).toHaveLength(1);
      expect(events[0].resourceName).toBe("echo");
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[0].userIntent).toBe("rebuild on demand");

      // The on-demand rebuild also restored stripping — not the heuristic.
      const seen = sink.filter((entry) => entry.tool === "echo");
      expect(seen).toHaveLength(1);
      expect(seen[0].args).toEqual({ msg: "cold start" });
    },
  },

  // ── 22 ── stateful session continuity: one mcp-session-id, minted→supplied
  {
    ...scenarioConfig("session-continuity-stateful"),
    script: async ({ client, capture }) => {
      // The v1 client transport pins the mcp-session-id it was issued at
      // initialize; it must not churn across calls on the stateful lane.
      const transport = (client as any).transport;
      const httpSessionId = transport.sessionId;
      expect(typeof httpSessionId).toBe("string");
      expect(httpSessionId.length).toBeGreaterThan(0);

      await client.listTools();
      const first = await client.callTool({
        name: "echo",
        arguments: { msg: "one", context: "session continuity 1" },
      });
      const sessionId = handleFrom(mintBackOf(first)!, "session_id");

      const second = await client.callTool({
        name: "echo",
        arguments: {
          msg: "two",
          context: "session continuity 2",
          session_id: sessionId,
        },
      });
      expect(mintBackOf(second)).toBeUndefined();

      // Same HTTP session end to end.
      expect(transport.sessionId).toBe(httpSessionId);

      const events = await waitForEvents(capture, 2);
      expect(events).toHaveLength(2);
      expect(events[0].sessionId).toBe(sessionId);
      expect(events[1].sessionId).toBe(sessionId);
      expect(events[0].tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "minted",
      });
      expect(events[1].tags).toMatchObject({
        [AGENTCAT_TAG_SESSION_SOURCE]: "supplied",
      });
    },
  },
];

describe.each(lanes)("e2e-http v1 lane: $id", (lane) => {
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
