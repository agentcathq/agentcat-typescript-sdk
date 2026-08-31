import { describe, it, expect } from "vitest";
import { Server } from "@modelcontextprotocol/server";
import * as agentcat from "../../index.js";
import { connectClient } from "./harness.js";
import { AgentCatOptions } from "../../types.js";
import { SESSION_ID_PARAM_PATTERN } from "../../modules/constants.js";

/**
 * Injection edge shapes through a real v2 low-level Server: the listing a
 * client actually receives is the assertion surface, mirroring the v1
 * handle-injection coverage of composed schemas, pre-existing params, and
 * outputSchema declaration.
 */
async function listWithTools(tools: any[], trackOptions: AgentCatOptions = {}) {
  const server = new Server(
    { name: "v2-schema-edges", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  agentcat.track(server, "proj_test", {
    enableAgentTracking: true,
    ...trackOptions,
  });
  const client = await connectClient(server);
  const listed = (await client.listTools()).tools;
  await client.close();
  return listed;
}

describe("v2 schema edges: input injection", () => {
  it("skips handle injection entirely on composed (oneOf) input schemas", async () => {
    // type: "object" keeps the v2 wire codec happy (it requires object input
    // schemas); the oneOf is what makes injection conservative.
    const composed = {
      type: "object",
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { type: "object", properties: { b: { type: "string" } } },
      ],
    };
    const listed = await listWithTools([
      { name: "composed", description: "composed", inputSchema: composed },
    ]);
    const tool = listed.find((t) => t.name === "composed")!;
    // Untouched: no single properties bag exists to safely extend, so no
    // handle or context params are advertised anywhere in the schema.
    expect((tool.inputSchema as any).oneOf).toBeDefined();
    const serialized = JSON.stringify(tool.inputSchema);
    expect(serialized).not.toContain("session_id");
    expect(serialized).not.toContain("agent_id");
    expect(serialized).not.toContain('"context"');
  });

  it("builds a default object schema for a tool listed without one", async () => {
    const listed = await listWithTools([
      { name: "bare", description: "no schema" } as any,
    ]);
    const tool = listed.find((t) => t.name === "bare")!;
    const schema = tool.inputSchema as any;
    expect(schema.type).toBe("object");
    expect(schema.properties.session_id).toBeDefined();
    expect(schema.properties.session_id.pattern).toBe(SESSION_ID_PARAM_PATTERN);
    expect(schema.properties.agent_id).toBeDefined();
    expect(schema.properties.context).toBeDefined();
    expect(schema.required).toContain("session_id");
    expect(schema.required).toContain("agent_id");
  });

  it("preserves a customer-declared session_id/agent_id instead of overwriting", async () => {
    const listed = await listWithTools([
      {
        name: "own_handles",
        description: "declares its own",
        inputSchema: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "customer session id",
            },
            agent_id: { type: "string", description: "customer agent id" },
          },
        },
      },
    ]);
    const tool = listed.find((t) => t.name === "own_handles")!;
    const schema = tool.inputSchema as any;
    const props = schema.properties;
    expect(props.session_id.description).toBe("customer session id");
    expect(props.session_id.pattern).toBeUndefined();
    expect(props.agent_id.description).toBe("customer agent id");
    // Skipped injection must not touch the customer's required semantics.
    expect(schema.required ?? []).not.toContain("session_id");
    expect(schema.required ?? []).not.toContain("agent_id");
  });

  it("drops additionalProperties:false so optional handles can ride along", async () => {
    const listed = await listWithTools([
      {
        name: "strict",
        description: "strict",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          additionalProperties: false,
        },
      },
    ]);
    const tool = listed.find((t) => t.name === "strict")!;
    const schema = tool.inputSchema as any;
    expect(schema.additionalProperties).toBeUndefined();
    expect(schema.properties.session_id).toBeDefined();
  });
});

describe("v2 schema edges: outputSchema injection", () => {
  it("declares mcp_session in a listed plain-object outputSchema", async () => {
    const listed = await listWithTools([
      {
        name: "stats",
        description: "returns stats",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
          additionalProperties: false,
        },
      },
    ]);
    const stats = listed.find((t) => t.name === "stats")!;
    const prop = ((stats.outputSchema as any).properties as any).mcp_session;
    expect(prop.type).toBe("object");
    expect(Object.keys(prop.properties)).toEqual([
      "session_id",
      "agent_id",
      "status",
    ]);
  });

  it("omits agent_id from mcp_session when agent tracking is off", async () => {
    const listed = await listWithTools(
      [
        {
          name: "stats",
          description: "returns stats",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
          },
        },
      ],
      { enableAgentTracking: false },
    );
    const stats = listed.find((t) => t.name === "stats")!;
    const prop = ((stats.outputSchema as any).properties as any).mcp_session;
    expect(Object.keys(prop.properties)).toEqual(["session_id", "status"]);
  });

  it("leaves composed (anyOf) outputSchemas untouched", async () => {
    const composed = {
      anyOf: [
        { type: "object", properties: { ok: { type: "boolean" } } },
        { type: "object", properties: { err: { type: "string" } } },
      ],
    };
    const listed = await listWithTools([
      {
        name: "either",
        description: "composed output",
        inputSchema: { type: "object", properties: {} },
        outputSchema: composed,
      },
    ]);
    const tool = listed.find((t) => t.name === "either")!;
    // The engine skips injection (no single properties bag); the v2 wire
    // codec then normalizes the composed schema by nesting it under a
    // `result` property. What matters: the composed shape survives and no
    // mcp_session declaration was forced into it.
    const serialized = JSON.stringify(tool.outputSchema);
    expect(serialized).toContain('"anyOf"');
    expect(serialized).not.toContain("mcp_session");
  });

  it("never overwrites a customer-declared mcp_session output field", async () => {
    const listed = await listWithTools([
      {
        name: "claims_key",
        description: "already declares the key",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            mcp_session: {
              type: "string",
              description: "customer-owned field",
            },
          },
        },
      },
    ]);
    const tool = listed.find((t) => t.name === "claims_key")!;
    const prop = ((tool.outputSchema as any).properties as any).mcp_session;
    expect(prop.type).toBe("string");
    expect(prop.description).toBe("customer-owned field");
  });
});
