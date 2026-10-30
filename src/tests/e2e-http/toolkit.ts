// Shared logical toolkit for the real-HTTP e2e matrix. Both majors expose the
// SAME six tools so scenario expectations are lane-uniform:
//
//   echo          {msg: string}                 — plain happy path
//   loose         passthrough / looseObject     — unknown keys reach the handler
//   strict        .strict() / strictObject      — additionalProperties: false
//   structured    input {msg} + outputSchema    — returns structuredContent
//   boom          throws new Error("boom")      — error path
//   complete_task {task: string}                — publishes a custom event
//                                                 (server form, no sessionId)
//
// EVERY handler pushes { tool, args } into the provided sink — the sink is the
// strip-proof channel: it shows exactly what the customer handler received
// after agentcat's inner tap ran (session_id/context/agent_id must NOT appear).
import { McpServer as V1McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as V2McpServer } from "@modelcontextprotocol/server";
import { z as z3 } from "zod";
import { z as z4 } from "zod4";
import * as agentcat from "../../index.js";

export const E2E_PROJECT_ID = "proj_test";

/** resourceName of the custom event the complete_task tool publishes. */
export const TASK_COMPLETED_EVENT = "task_completed";

export interface SinkEntry {
  tool: string;
  args: Record<string, unknown>;
}

/** What customer tool handlers actually saw, in call order. */
export type ToolSink = SinkEntry[];

const record =
  (sink: ToolSink, tool: string) => (args: Record<string, unknown>) =>
    sink.push({ tool, args: { ...args } });

/** v1 (zod v3) toolkit on a v1 high-level McpServer. */
export function buildV1Toolkit(sink: ToolSink): V1McpServer {
  const server = new V1McpServer({ name: "e2e-http-v1", version: "1.0.0" });

  // Raw-shape registration style (the dominant v1 customer idiom — cribbed
  // from test-utils/client-server-factory.ts).
  server.tool(
    "echo",
    "Echo a message back",
    { msg: z3.string().describe("Message to echo") },
    async (args) => {
      record(sink, "echo")(args);
      return { content: [{ type: "text", text: String(args.msg) }] };
    },
  );

  // Full ZodObject inputSchema (AnySchema) so passthrough survives parsing.
  server.registerTool(
    "loose",
    {
      description: "Loose schema: unknown keys pass through to the handler",
      inputSchema: z3.object({ msg: z3.string().optional() }).passthrough(),
    },
    async (args: Record<string, unknown>) => {
      record(sink, "loose")(args);
      return { content: [{ type: "text", text: JSON.stringify(args) }] };
    },
  );

  server.registerTool(
    "strict",
    {
      description: "Strict schema: additionalProperties are rejected",
      inputSchema: z3.object({ msg: z3.string() }).strict(),
    },
    async (args: { msg: string }) => {
      record(sink, "strict")(args);
      return { content: [{ type: "text", text: args.msg }] };
    },
  );

  server.registerTool(
    "structured",
    {
      description: "Returns structuredContent per its outputSchema",
      inputSchema: { msg: z3.string() },
      outputSchema: { echoed: z3.string().describe("The echoed message") },
    },
    async (args) => {
      record(sink, "structured")(args);
      return {
        content: [{ type: "text", text: args.msg }],
        structuredContent: { echoed: args.msg },
      };
    },
  );

  server.registerTool(
    "boom",
    {
      description: "Always throws",
      inputSchema: z3.object({}).passthrough(),
    },
    async (args: Record<string, unknown>) => {
      record(sink, "boom")(args);
      throw new Error("boom");
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Completes a task and records it as a custom event",
      inputSchema: { task: z3.string() },
    },
    async (args) => {
      record(sink, "complete_task")(args);
      await agentcat.publishCustomEvent(server, E2E_PROJECT_ID, {
        resourceName: TASK_COMPLETED_EVENT,
      });
      return { content: [{ type: "text", text: `completed ${args.task}` }] };
    },
  );

  return server;
}

/** v2 (zod v4) toolkit on a v2 McpServer. */
export function buildV2Toolkit(sink: ToolSink): V2McpServer {
  const server = new V2McpServer(
    { name: "e2e-http-v2", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "echo",
    {
      description: "Echo a message back",
      inputSchema: z4.object({ msg: z4.string().describe("Message to echo") }),
    },
    async (args: { msg: string }) => {
      record(sink, "echo")(args);
      return { content: [{ type: "text" as const, text: String(args.msg) }] };
    },
  );

  server.registerTool(
    "loose",
    {
      description: "Loose schema: unknown keys pass through to the handler",
      inputSchema: z4.looseObject({ msg: z4.string().optional() }),
    },
    async (args: Record<string, unknown>) => {
      record(sink, "loose")(args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(args) }],
      };
    },
  );

  server.registerTool(
    "strict",
    {
      description: "Strict schema: additionalProperties are rejected",
      inputSchema: z4.strictObject({ msg: z4.string() }),
    },
    async (args: { msg: string }) => {
      record(sink, "strict")(args);
      return { content: [{ type: "text" as const, text: args.msg }] };
    },
  );

  server.registerTool(
    "structured",
    {
      description: "Returns structuredContent per its outputSchema",
      inputSchema: z4.object({ msg: z4.string() }),
      outputSchema: z4.object({
        echoed: z4.string().describe("The echoed message"),
      }),
    },
    async (args: { msg: string }) => {
      record(sink, "structured")(args);
      return {
        content: [{ type: "text" as const, text: args.msg }],
        structuredContent: { echoed: args.msg },
      };
    },
  );

  server.registerTool(
    "boom",
    {
      description: "Always throws",
      inputSchema: z4.looseObject({}),
    },
    async (args: Record<string, unknown>) => {
      record(sink, "boom")(args);
      throw new Error("boom");
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Completes a task and records it as a custom event",
      inputSchema: z4.object({ task: z4.string() }),
    },
    async (args: { task: string }) => {
      record(sink, "complete_task")(args);
      await agentcat.publishCustomEvent(server, E2E_PROJECT_ID, {
        resourceName: TASK_COMPLETED_EVENT,
      });
      return {
        content: [{ type: "text" as const, text: `completed ${args.task}` }],
      };
    },
  );

  return server;
}
