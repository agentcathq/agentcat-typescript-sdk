import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { track } from "../index.js";
import { AgentCatOptions, Event } from "../types.js";
import { EventCapture } from "./test-utils.js";

/**
 * The regression test for the shared-mutable-state bug this whole redesign
 * exists to remove. Before explicit handles, one `AgentCatData.sessionId` field
 * and one identity cache keyed off it were shared by every in-flight request:
 * `getServerSessionId` wrote the field at the top of a tool call and the event
 * builder read it back after the customer's handler had run, so under
 * `Promise.all` the last writer won for every published event.
 *
 * Two things make this test able to detect that, and both are load-bearing:
 *
 *  1. The customer's tool handler awaits a REAL timer, so every call is
 *     genuinely suspended while the others run. A handler that only awaits an
 *     already-resolved promise never leaves the current macrotask, which is the
 *     regime in which this class of bug can hide entirely — and a concurrency
 *     test that passes against the buggy implementation is worse than none.
 *  2. Every asserted value is derived per call from that call's own arguments —
 *     Task ID, agent ID, actor, and response — so a value belonging to a
 *     different call is visible as a mismatch rather than merely as a missing
 *     field.
 *
 * Verified to FAIL at pre-refactor commit eb27b93 on both paths, with the
 * signature of the bug rather than an incidental error: every one of the 20
 * events carried a single shared Task ID and one single call's actor.
 */

const CONCURRENT_CALLS = 20;
const FIRST_CALL_RACERS = 10;

const settle = () => new Promise((r) => setTimeout(r, 100));

/**
 * A genuine macrotask delay, deliberately longest for the FIRST call and
 * shortest for the last. The reversal guarantees the calls complete out of
 * issue order — so "last writer wins" is observable every run rather than only
 * on a lucky interleaving — while the random component keeps the interleaving
 * itself varied rather than a single fixed schedule.
 */
function jitter(index: number, total: number): Promise<void> {
  const staggered = (total - 1 - index) * 2; // 0-38ms at 20 calls
  const random = Math.random() * 4;
  return new Promise((r) => setTimeout(r, staggered + random));
}

interface Harness {
  client: Client;
  cleanup: () => Promise<void>;
}

/** High-level path: `McpServer` + `server.tool(...)`, wrapped by tracingV2. */
async function createHighLevelHarness(
  total: number,
  options: AgentCatOptions,
): Promise<Harness> {
  const server = new McpServer({
    name: "concurrency server",
    version: "1.0",
  });

  server.tool(
    "slow_echo",
    "Echoes its label after a jittered delay",
    { label: z.string(), index: z.number() },
    async (args: { label: string; index: number }) => {
      await jitter(args.index, total);
      return {
        content: [{ type: "text" as const, text: `echo:${args.label}` }],
      };
    },
  );

  const client = new Client({ name: "test client", version: "1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.server.connect(serverTransport),
  ]);
  track(server, "proj_test", options);

  return {
    client,
    cleanup: async () => {
      await clientTransport.close?.();
      await serverTransport.close?.();
    },
  };
}

/**
 * Low-level path: raw `Server` + `setRequestHandler(CallToolRequestSchema, …)`,
 * wrapped by tracing.ts. Covered here because it is wrapped by a completely
 * separate code path from the high-level one and had no concurrency coverage.
 */
async function createLowLevelHarness(
  total: number,
  options: AgentCatOptions,
): Promise<Harness> {
  const server = new Server(
    { name: "low level concurrency server", version: "1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "slow_echo",
        description: "Echoes its label after a jittered delay",
        inputSchema: {
          type: "object",
          properties: {
            label: { type: "string" },
            index: { type: "number" },
          },
          required: ["label", "index"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as unknown as {
      label: string;
      index: number;
    };
    await jitter(args.index, total);
    return {
      content: [{ type: "text" as const, text: `echo:${args.label}` }],
    };
  });

  const client = new Client({ name: "test client", version: "1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  track(server, "proj_test", options);
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    cleanup: async () => {
      await clientTransport.close?.();
      await serverTransport.close?.();
    },
  };
}

const PATHS: {
  name: string;
  create: (total: number, options: AgentCatOptions) => Promise<Harness>;
}[] = [
  {
    name: "high-level (McpServer + server.tool)",
    create: createHighLevelHarness,
  },
  {
    name: "low-level (Server + setRequestHandler)",
    create: createLowLevelHarness,
  },
];

/**
 * The label this event's REQUEST carried. Read off `event.parameters` rather
 * than off the response, so the response can be asserted independently — an
 * event that picked up another call's result is then a mismatch, not an
 * invisible swap.
 */
function requestLabel(event: Event): string | undefined {
  const args = (event.parameters as any)?.request?.params?.arguments;
  return typeof args?.label === "string" ? args.label : undefined;
}

function responseText(event: Event): string | undefined {
  const content = (event.response as any)?.content;
  return Array.isArray(content) && typeof content[0]?.text === "string"
    ? content[0].text
    : undefined;
}

for (const path of PATHS) {
  describe(`concurrent tool calls — ${path.name}`, () => {
    let capture: EventCapture;
    let cleanup: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      capture = new EventCapture();
      await capture.start();
    });

    afterEach(async () => {
      await capture.stop();
      if (cleanup) await cleanup();
      cleanup = undefined;
    });

    it("never cross-contaminates task IDs, agent IDs, actors or responses", async () => {
      const harness = await path.create(CONCURRENT_CALLS, {
        // Derived from this request's own arguments, and deliberately async:
        // the old implementation wrote the resolved identity into a cache keyed
        // by the shared session ID, so a suspended request came back to find
        // somebody else's actor.
        identify: async (request: any) => {
          await new Promise((r) => setTimeout(r, Math.random() * 4));
          return { userId: `user-${request.params.arguments.task_id}` };
        },
      });
      cleanup = harness.cleanup;

      await Promise.all(
        Array.from({ length: CONCURRENT_CALLS }, (_, i) =>
          harness.client.callTool({
            name: "slow_echo",
            arguments: {
              label: `call-${i}`,
              index: i,
              context: "concurrent",
              task_id: `ses_task_${i}`,
              agent_id: `agt_agent_${i}`,
            },
          }),
        ),
      );
      await settle();

      const events = capture
        .getEvents()
        .filter((e) => e.eventType === "mcp:tools/call");
      expect(events.length).toBe(CONCURRENT_CALLS);

      const byLabel = new Map<string, Event>();
      for (const event of events) {
        const label = requestLabel(event);
        expect(
          label,
          `event without a request label: ${event.sessionId}`,
        ).toBeDefined();
        byLabel.set(label!, event);
      }
      expect(byLabel.size).toBe(CONCURRENT_CALLS);

      // Mismatches are collected rather than asserted one at a time so a
      // failure shows the whole contamination pattern in one list — "19 of 20
      // events carry call-15's actor" is the diagnosis, and stopping at the
      // first mismatch would hide it. Every read is defensive for the same
      // reason: a TypeError on a missing field would mask the real report.
      const mismatches: string[] = [];
      const check = (label: string, actual: unknown, expected: string) => {
        if (actual !== expected)
          mismatches.push(`${label}: ${String(actual)} (want ${expected})`);
      };

      for (let i = 0; i < CONCURRENT_CALLS; i++) {
        const event = byLabel.get(`call-${i}`);
        if (!event) {
          mismatches.push(`call-${i}: no event`);
          continue;
        }
        // Each of these is the value THIS call supplied. Anything else means
        // the event was built from another in-flight call's state.
        check(`call-${i} task_id`, event.sessionId, `ses_task_${i}`);
        check(
          `call-${i} agent_id`,
          event.tags?.agentcat_agent_id,
          `agt_agent_${i}`,
        );
        check(
          `call-${i} actor`,
          event.identifyActorGivenId,
          `user-ses_task_${i}`,
        );
        check(`call-${i} response`, responseText(event), `echo:call-${i}`);
        check(
          `call-${i} task_id_source`,
          event.tags?.agentcat_task_id_source,
          "supplied",
        );
        check(
          `call-${i} agent_id_source`,
          event.tags?.agentcat_agent_id_source,
          "supplied",
        );
      }
      expect(mismatches).toEqual([]);

      // Whole-set distinctness: the old shared field collapsed every event onto
      // a single session, which shows up here even if the per-call mapping
      // above were somehow satisfied.
      expect(new Set(events.map((e) => e.sessionId)).size).toBe(
        CONCURRENT_CALLS,
      );
      expect(new Set(events.map((e) => e.tags!.agentcat_agent_id)).size).toBe(
        CONCURRENT_CALLS,
      );
      expect(new Set(events.map((e) => e.identifyActorGivenId)).size).toBe(
        CONCURRENT_CALLS,
      );
    });

    it("mints a distinct task ID per concurrent first call", async () => {
      // Documented, expected behaviour — not a bug. Handles are resolved
      // statelessly per request, so N concurrent calls that all legitimately
      // omit task_id have nothing to correlate on and each get their own task.
      // There is no server-side fix available: the agent-facing copy's "do not
      // issue parallel tool calls until the server has issued your task_id" is
      // the only defence. Pinned here so the behaviour is documented rather
      // than rediscovered as a surprise.
      const harness = await path.create(FIRST_CALL_RACERS, {});
      cleanup = harness.cleanup;

      await Promise.all(
        Array.from({ length: FIRST_CALL_RACERS }, (_, i) =>
          harness.client.callTool({
            name: "slow_echo",
            arguments: { label: `call-${i}`, index: i, context: "concurrent" },
          }),
        ),
      );
      await settle();

      const events = capture
        .getEvents()
        .filter((e) => e.eventType === "mcp:tools/call");
      expect(events.length).toBe(FIRST_CALL_RACERS);
      expect(new Set(events.map((e) => e.sessionId)).size).toBe(
        FIRST_CALL_RACERS,
      );
      expect(new Set(events.map((e) => e.tags!.agentcat_agent_id)).size).toBe(
        FIRST_CALL_RACERS,
      );
      for (const event of events) {
        expect(event.sessionId!.startsWith("ses_")).toBe(true);
        expect(event.tags!.agentcat_task_id_source).toBe("minted");
      }
    });
  });
}
