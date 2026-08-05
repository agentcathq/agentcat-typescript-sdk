import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTestServerAndClient,
  resetTodos,
} from "./test-utils/client-server-factory";
import { EventCapture } from "./test-utils";
import { track } from "../index";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types";
import { setDiagnosticsSink } from "../modules/logging.js";
import { _resetDiagnosticsForTest } from "../modules/diagnostics.js";
import { HighLevelMCPServerLike } from "../types";
import { randomUUID } from "node:crypto";

// The diagnostics sink publishes every writeToLog entry, verbatim, to AgentCat's
// central collector. These tests register a capturing sink on that exact path
// and assert that real tool calls never push actual event payloads (tool-call
// arguments, actor PII, user free-text) through it — only metadata.
describe("diagnostics sink never receives event payloads", () => {
  let server: HighLevelMCPServerLike;
  let client: any;
  let cleanup: () => Promise<void>;
  let eventCapture: EventCapture;
  let captured: string[];

  beforeEach(async () => {
    resetTodos();
    // Keep the real diagnostics module fully disabled (no network); we only
    // exercise the raw sink hook that writeToLog tees to.
    process.env.DISABLE_DIAGNOSTICS = "1";
    _resetDiagnosticsForTest();
    captured = [];

    const setup = await setupTestServerAndClient();
    server = setup.server;
    client = setup.client;
    cleanup = setup.cleanup;

    // Stub the event queue's network send so no real HTTP leaves the test.
    eventCapture = new EventCapture();
    await eventCapture.start();
  });

  afterEach(async () => {
    setDiagnosticsSink(null);
    delete process.env.DISABLE_DIAGNOSTICS;
    _resetDiagnosticsForTest();
    await eventCapture.stop();
    await cleanup();
  });

  it("resolved identity is stamped on the event but never reaches the sink", async () => {
    const userId = `actor-${randomUUID()}`;
    const SECRET_NAME = `name-${randomUUID()}`;
    const SECRET_DATA = `data-${randomUUID()}`;

    setDiagnosticsSink((entry) => captured.push(entry));

    track(server, "test-project", {
      enableTracing: true,
      identify: async () => ({
        userId,
        userName: SECRET_NAME,
        userData: { secret: SECRET_DATA },
      }),
    });

    await client.request(
      {
        method: "tools/call",
        params: {
          name: "add_todo",
          arguments: { text: "hi", context: "adding a todo" },
        },
      },
      CallToolResultSchema,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Identity now rides on the event itself — there is no identify event and
    // no "Identified session" diagnostics line to carry it.
    const toolCallEvent = eventCapture.findEventByType("mcp:tools/call");
    expect(toolCallEvent).toBeDefined();
    expect(toolCallEvent!.identifyActorGivenId).toBe(userId);
    expect(toolCallEvent!.identifyActorName).toBe(SECRET_NAME);

    // No identity data — id, name or custom payload — is ever published to the
    // diagnostics sink, and the old full-object dump is gone.
    expect(captured.some((l) => l.includes("with identity:"))).toBe(false);
    expect(captured.some((l) => l.includes(userId))).toBe(false);
    expect(captured.some((l) => l.includes(SECRET_NAME))).toBe(false);
    expect(captured.some((l) => l.includes(SECRET_DATA))).toBe(false);
  });

  it("emits start + complete setup beacons (metadata only) on track()", async () => {
    setDiagnosticsSink((entry) => captured.push(entry));

    track(server, "test-project", { enableTracing: true });

    const started = captured.find((l) => l.includes("AgentCat setup started"));
    const complete = captured.find((l) =>
      l.includes("AgentCat setup complete"),
    );

    // Start beacon anchors the install to its project id and the detection
    // fingerprint (SDK major/flavor + raw feature-detection signals).
    expect(started).toBeDefined();
    expect(started).toContain("test-project");
    expect(started).toContain("sdk v1/high");
    expect(started).toContain("signals ");

    // Complete beacon confirms success and records the resolved feature flags.
    expect(complete).toBeDefined();
    expect(complete).toContain("test-project");
    expect(complete).toContain("tracing=true");
    expect(complete).toContain("reportMissing=true");
  });

  it("report-missing log carries only the context length, not the text", async () => {
    setDiagnosticsSink((entry) => captured.push(entry));

    track(server, "test-project", { enableTracing: true });

    const SECRET_CONTEXT = `i-wish-there-was-a-tool-for-${randomUUID()}`;
    await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_more_tools",
          arguments: { context: SECRET_CONTEXT },
        },
      },
      CallToolResultSchema,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const reportLine = captured.find((l) =>
      l.includes("Missing tool reported"),
    );
    expect(reportLine).toBeDefined();
    expect(reportLine).toContain(`context length: ${SECRET_CONTEXT.length}`);
    expect(captured.some((l) => l.includes(SECRET_CONTEXT))).toBe(false);
  });
});
