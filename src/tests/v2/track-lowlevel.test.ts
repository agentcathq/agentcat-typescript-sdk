import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/server";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { EventCapture } from "../test-utils.js";
import { readFileSync, existsSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// writeToLog() targets the home directory, not cwd (see modules/logging.ts).
const LOG_PATH = join(homedir(), "agentcat.log");

function buildLowLevel() {
  const server = new Server(
    { name: "v2-low", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo",
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
      },
    ],
    nextCursor: "page-2", // must survive the wrap
  }));
  server.setRequestHandler("tools/call", async (request: any) => ({
    content: [{ type: "text", text: `echo:${request.params?.arguments?.msg}` }],
  }));
  return server;
}

describe("track() on v2 low-level Server", () => {
  let capture: EventCapture;
  beforeEach(async () => {
    capture = new EventCapture();
    await capture.start();
  });
  afterEach(async () => {
    await capture.stop();
  });

  it("wraps handlers registered via method strings; preserves nextCursor", async () => {
    const server = buildLowLevel();
    agentcat.track(server, "proj_test");
    const client = await connectClient(server);

    const page = await client.request(
      { method: "tools/list", params: {} },
      // schema-less spec request returns the typed result on v2
    );
    expect((page as any).nextCursor).toBe("page-2");
    const names = (page as any).tools.map((t: any) => t.name);
    expect(names).toContain("get_more_tools");
    expect(
      (page as any).tools[0].inputSchema.properties.session_id,
    ).toBeDefined();

    const result = (await client.callTool({
      name: "echo",
      arguments: { msg: "hi", session_id: "ses_abc", context: "why" },
    })) as any;
    expect(result.content[0].text).toBe("echo:hi");
    const [event] = capture.getEvents();
    expect(event.sessionId).toBe("ses_abc");
    await client.close();
  });

  it("rebuilds registries on demand when tools/call arrives before any tools/list", async () => {
    const server = buildLowLevel();
    agentcat.track(server, "proj_test");
    const client = await connectClient(server);

    // Record the log offset so we only accept a beacon written by THIS call
    // (the home-dir log accumulates across runs).
    const logOffsetBefore = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;

    // No listTools() first — fresh-instance topology. Use the low-level
    // request() verb: the typed callTool() does cache/output-validator
    // pre-work that can itself fetch tools/list and defeat the premise.
    await client.request({
      method: "tools/call",
      params: {
        name: "echo",
        arguments: { msg: "hi", session_id: "ses_abc", context: "why" },
      },
    });
    const [event] = capture.getEvents();
    expect(event.sessionId).toBe("ses_abc");
    // Rebuild happened (log beacon), not the heuristic fallback:
    expect(existsSync(LOG_PATH)).toBe(true);
    const appended = readFileSync(LOG_PATH)
      .subarray(logOffsetBefore)
      .toString("utf8");
    expect(appended).toContain("Rebuilt injection registries on demand");
    await client.close();
  });
});
