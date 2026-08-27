import { describe, it, expect } from "vitest";
import {
  addHandleParametersToTools,
  stripInjectedArguments,
  cloneRequestWithStrippedArguments,
  setInjectedParamsRegistry,
  getInjectedParamsRegistry,
  InjectedParamsRegistry,
  setOutputInjectionRegistry,
  getOutputInjectionRegistry,
  OutputInjectionRegistry,
} from "../modules/handle-injection.js";
import { addContextParameterToTools } from "../modules/context-parameters.js";
import {
  SESSION_ID_PARAM_DESCRIPTION,
  SESSION_ID_PARAM_PATTERN,
  AGENT_ID_PARAM_DESCRIPTION,
  MCP_SESSION_KEY,
  MCP_SESSION_FIELD_DESCRIPTION,
  MCP_SESSION_FIELD_DESCRIPTION_HOOK_MODE,
  MCP_SESSION_STATUS_DESCRIPTION,
} from "../modules/constants.js";

const makeTool = (name: string, schema?: any) =>
  ({
    name,
    inputSchema: schema,
    callback: async () => ({ content: [] }),
  }) as any;

const customerSchema = () => ({
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
});

describe("addHandleParametersToTools", () => {
  it("injects session_id and agent_id after customer params, both required", () => {
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("add_todo", customerSchema())],
      { injectSessionId: true, injectAgentId: true },
      registry,
    );
    const keys = Object.keys(tool.inputSchema.properties);
    expect(keys).toEqual(["text", "session_id", "agent_id"]);
    // Requiredness rides injection: both injected params join required, and
    // the customer's own entries stay first and untouched. Enforcement is
    // soft — a call that still omits them succeeds (minted / unattributed).
    expect(tool.inputSchema.required).toEqual([
      "text",
      "session_id",
      "agent_id",
    ]);
    expect(tool.inputSchema.properties.session_id.description).toBe(
      SESSION_ID_PARAM_DESCRIPTION,
    );
    // The injected session_id advertises the start|ses_ value contract as a
    // JSON Schema pattern; self-chosen agent_id has no pattern in any mode.
    expect(tool.inputSchema.properties.session_id.pattern).toBe(
      SESSION_ID_PARAM_PATTERN,
    );
    expect(tool.inputSchema.properties.agent_id.description).toBe(
      AGENT_ID_PARAM_DESCRIPTION,
    );
    expect(tool.inputSchema.properties.agent_id.pattern).toBeUndefined();
    expect(registry.get("add_todo")).toEqual(
      new Set(["session_id", "agent_id"]),
    );
  });

  it("creates the required array when the schema has none", () => {
    const tool: any = {
      name: "bare",
      inputSchema: { type: "object", properties: {} },
    };
    const registry = new Map();
    const [out]: any[] = addHandleParametersToTools(
      [tool],
      { injectSessionId: true, injectAgentId: true },
      registry,
    );
    expect(out.inputSchema.required).toEqual(["session_id", "agent_id"]);
  });

  it("does not duplicate session_id in an existing required array", () => {
    const tool: any = {
      name: "weird_session",
      inputSchema: {
        type: "object",
        properties: {},
        required: ["session_id"],
      },
    };
    const registry = new Map();
    const [out]: any[] = addHandleParametersToTools(
      [tool],
      { injectSessionId: true, injectAgentId: false },
      registry,
    );
    expect(out.inputSchema.required).toEqual(["session_id"]);
  });

  it("does not duplicate agent_id in an existing required array", () => {
    // A schema can list a name in required without declaring the property;
    // injection must not push a second copy.
    const tool: any = {
      name: "weird",
      inputSchema: {
        type: "object",
        properties: {},
        required: ["agent_id"],
      },
    };
    const registry = new Map();
    const [out]: any[] = addHandleParametersToTools(
      [tool],
      { injectSessionId: false, injectAgentId: true },
      registry,
    );
    expect(out.inputSchema.required).toEqual(["agent_id"]);
  });

  it("leaves required untouched when the customer declares agent_id", () => {
    const tool: any = {
      name: "owns_agent",
      inputSchema: {
        type: "object",
        properties: { agent_id: { type: "string", description: "mine" } },
        required: [],
      },
    };
    const registry = new Map();
    const [out]: any[] = addHandleParametersToTools(
      [tool],
      { injectSessionId: false, injectAgentId: true },
      registry,
    );
    expect(out.inputSchema.required).toEqual([]);
    expect(out.inputSchema.properties.agent_id.description).toBe("mine");
  });

  it("full order with context injector: customer, session_id, agent_id, context", () => {
    const registry: InjectedParamsRegistry = new Map();
    let tools = addHandleParametersToTools(
      [makeTool("add_todo", customerSchema())],
      { injectSessionId: true, injectAgentId: true },
      registry,
    );
    tools = addContextParameterToTools(tools, undefined, registry);
    expect(Object.keys(tools[0].inputSchema.properties)).toEqual([
      "text",
      "session_id",
      "agent_id",
      "context",
    ]);
    expect(tools[0].inputSchema.required).toEqual([
      "text",
      "session_id",
      "agent_id",
      "context",
    ]);
    expect(registry.get("add_todo")).toEqual(
      new Set(["session_id", "agent_id", "context"]),
    );
  });

  it("hook mode: no session_id, agent_id uses the same single description", () => {
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("add_todo", customerSchema())],
      { injectSessionId: false, injectAgentId: true },
      registry,
    );
    expect(tool.inputSchema.properties.session_id).toBeUndefined();
    expect(tool.inputSchema.properties.agent_id.description).toBe(
      AGENT_ID_PARAM_DESCRIPTION,
    );
    expect(tool.inputSchema.required).toEqual(["text", "agent_id"]);
    expect(registry.get("add_todo")).toEqual(new Set(["agent_id"]));
  });

  it("skips a param the tool already defines, and does not record it", () => {
    const schema = customerSchema();
    schema.properties.session_id = {
      type: "string",
      description: "customer's own",
    };
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("deploy", schema)],
      { injectSessionId: true, injectAgentId: true },
      registry,
    );
    // The customer's foreign session_id is completely untouched: no pattern,
    // and never added to required — requiredness rides injection only.
    // agent_id WAS injected on this tool, so it alone joins required.
    expect(tool.inputSchema.properties.session_id.description).toBe(
      "customer's own",
    );
    expect(tool.inputSchema.properties.session_id.pattern).toBeUndefined();
    expect(tool.inputSchema.required).toEqual(["text", "agent_id"]);
    expect(registry.get("deploy")).toEqual(new Set(["agent_id"]));
  });

  it("skips complex schemas entirely", () => {
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("odd", { oneOf: [{ type: "object" }] })],
      { injectSessionId: true, injectAgentId: true },
      registry,
    );
    expect(tool.inputSchema.properties).toBeUndefined();
    // Composed schemas get no required changes either — fully untouched.
    expect(tool.inputSchema.required).toBeUndefined();
    expect(registry.has("odd")).toBe(false);
  });

  it("removes additionalProperties:false and handles missing schemas", () => {
    const registry: InjectedParamsRegistry = new Map();
    const strict = { ...customerSchema(), additionalProperties: false };
    const tools = addHandleParametersToTools(
      [makeTool("strict", strict), makeTool("bare")],
      { injectSessionId: true, injectAgentId: true },
      registry,
    );
    expect(tools[0].inputSchema.additionalProperties).toBeUndefined();
    expect(Object.keys(tools[1].inputSchema.properties)).toEqual([
      "session_id",
      "agent_id",
    ]);
    expect(tools[1].inputSchema.required).toEqual(["session_id", "agent_id"]);
  });

  it("does NOT skip get_more_tools (handles are injected; context stays bespoke)", () => {
    const registry: InjectedParamsRegistry = new Map();
    const gmt = makeTool("get_more_tools", {
      type: "object",
      properties: { context: { type: "string", description: "bespoke" } },
      required: ["context"],
    });
    let tools = addHandleParametersToTools(
      [gmt],
      { injectSessionId: true, injectAgentId: true },
      registry,
    );
    tools = addContextParameterToTools(tools, undefined, registry);
    expect(Object.keys(tools[0].inputSchema.properties)).toEqual([
      "context",
      "session_id",
      "agent_id",
    ]);
    expect(tools[0].inputSchema.properties.context.description).toBe("bespoke");
    // Its own required context leads; the injected handles append after it.
    expect(tools[0].inputSchema.required).toEqual([
      "context",
      "session_id",
      "agent_id",
    ]);
    expect(registry.get("get_more_tools")).toEqual(
      new Set(["session_id", "agent_id"]),
    );
  });

  it("agent_id copy prescribes the self-chosen model|harness|nonce format", () => {
    expect(AGENT_ID_PARAM_DESCRIPTION).toContain(
      "required on every call including your first",
    );
    expect(AGENT_ID_PARAM_DESCRIPTION).toContain(
      "opus-4.80-1m|claude-code|k3n9x",
    );
    expect(AGENT_ID_PARAM_DESCRIPTION).toContain("never inherited");
    // agent_id is self-chosen: the copy never promises server issuance.
    expect(AGENT_ID_PARAM_DESCRIPTION).not.toContain("the server will issue");
    // Single constant in both modes: the copy never references the session_id
    // parameter, so it reads the same with or without one.
    expect(AGENT_ID_PARAM_DESCRIPTION).not.toContain("session_id");
  });
});

describe("stripInjectedArguments", () => {
  const registry: InjectedParamsRegistry = new Map([
    ["add_todo", new Set(["session_id", "agent_id", "context"])],
    ["deploy", new Set(["agent_id", "context"])], // tool owns session_id
  ]);

  it("strips exactly what was injected", () => {
    expect(
      stripInjectedArguments(
        {
          text: "x",
          session_id: "ses_1",
          agent_id: "agt_1",
          context: "why",
        },
        "add_todo",
        registry,
      ),
    ).toEqual({ text: "x" });
  });

  it("preserves the customer's own session_id param", () => {
    expect(
      stripInjectedArguments(
        { session_id: "prod-42", agent_id: "agt_1", context: "why" },
        "deploy",
        registry,
      ),
    ).toEqual({ session_id: "prod-42" });
  });

  it("falls back to stripping all three when no registry entry exists", () => {
    expect(
      stripInjectedArguments(
        { text: "x", session_id: "a", agent_id: "b", context: "c" },
        "unlisted_tool",
        registry,
      ),
    ).toEqual({ text: "x" });
    expect(
      stripInjectedArguments({ text: "x", session_id: "a" }, "any", undefined),
    ).toEqual({ text: "x" });
  });

  it("fallback never strips get_more_tools' own context", () => {
    expect(
      stripInjectedArguments(
        { context: "need a tool", session_id: "a", agent_id: "b" },
        "get_more_tools",
        undefined,
      ),
    ).toEqual({ context: "need a tool" });
  });

  it("handles non-object args", () => {
    expect(
      stripInjectedArguments(undefined, "add_todo", registry),
    ).toBeUndefined();
  });
});

describe("registry storage + request cloning", () => {
  it("stores per server object", () => {
    const server = {};
    const registry: InjectedParamsRegistry = new Map([
      ["t", new Set(["session_id"])],
    ]);
    setInjectedParamsRegistry(server, registry);
    expect(getInjectedParamsRegistry(server)).toBe(registry);
    expect(getInjectedParamsRegistry({})).toBeUndefined();
  });

  it("clones the request with stripped arguments, leaving the original intact", () => {
    const registry: InjectedParamsRegistry = new Map([
      ["add_todo", new Set(["session_id", "agent_id", "context"])],
    ]);
    const request = {
      params: {
        name: "add_todo",
        arguments: { text: "x", session_id: "ses_1", context: "why" },
      },
    };
    const cloned = cloneRequestWithStrippedArguments(request, registry);
    expect(cloned.params.arguments).toEqual({ text: "x" });
    expect(request.params.arguments.session_id).toBe("ses_1"); // untouched (event keeps raw)
  });
});

const structuredTool = (name: string, outputSchema: any) =>
  ({
    name,
    inputSchema: customerSchema(),
    outputSchema,
    callback: async () => ({ content: [] }),
  }) as any;

const objectOutputSchema = () => ({
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
  additionalProperties: false,
});

describe("outputSchema injection", () => {
  it("injects mcp_session into a plain object outputSchema and registers the tool", () => {
    const output: OutputInjectionRegistry = new Set();
    const [tool] = addHandleParametersToTools(
      [structuredTool("get_stats", objectOutputSchema())],
      { injectSessionId: true, injectAgentId: true },
      new Map(),
      output,
    );
    const prop = tool.outputSchema.properties[MCP_SESSION_KEY];
    expect(prop.type).toBe("object");
    expect(prop.description).toBe(MCP_SESSION_FIELD_DESCRIPTION);
    expect(Object.keys(prop.properties)).toEqual([
      "session_id",
      "agent_id",
      "status",
    ]);
    // status is the machine-readable session state, pre-announced as an enum.
    expect(prop.properties.status).toEqual({
      type: "string",
      enum: ["issued", "active", "unrecognized"],
      description: MCP_SESSION_STATUS_DESCRIPTION,
    });
    // The customer's declared contract is otherwise untouched — including
    // additionalProperties: false, which stays (our property is declared).
    expect(tool.outputSchema.required).toEqual(["count"]);
    expect(tool.outputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema.properties.count).toEqual({ type: "number" });
    expect(output.has("get_stats")).toBe(true);
  });

  it("sub-properties track modes: hook mode drops session_id and status, tracking off drops agent_id", () => {
    const o1: OutputInjectionRegistry = new Set();
    const [hookTool] = addHandleParametersToTools(
      [structuredTool("t", objectOutputSchema())],
      { injectSessionId: false, injectAgentId: true }, // hook mode
      new Map(),
      o1,
    );
    const hookProp = hookTool.outputSchema.properties[MCP_SESSION_KEY];
    expect(Object.keys(hookProp.properties)).toEqual(["agent_id"]);
    // Hook mode has no session continuity to describe.
    expect(hookProp.description).toBe(MCP_SESSION_FIELD_DESCRIPTION_HOOK_MODE);

    const o2: OutputInjectionRegistry = new Set();
    const [sessionOnlyTool] = addHandleParametersToTools(
      [structuredTool("t", objectOutputSchema())],
      { injectSessionId: true, injectAgentId: false }, // agent tracking off
      new Map(),
      o2,
    );
    const sessionProp =
      sessionOnlyTool.outputSchema.properties[MCP_SESSION_KEY];
    expect(Object.keys(sessionProp.properties)).toEqual([
      "session_id",
      "status",
    ]);
    expect(sessionProp.description).toBe(MCP_SESSION_FIELD_DESCRIPTION);
  });

  it("does not mutate the customer's outputSchema object", () => {
    const schema = objectOutputSchema();
    addHandleParametersToTools(
      [structuredTool("t", schema)],
      { injectSessionId: true, injectAgentId: true },
      new Map(),
      new Set(),
    );
    expect(schema.properties).not.toHaveProperty(MCP_SESSION_KEY);
  });

  it("skips complex outputSchema (oneOf/allOf/anyOf) and does not register", () => {
    const output: OutputInjectionRegistry = new Set();
    const complex = {
      oneOf: [{ type: "object", properties: { a: { type: "string" } } }],
    };
    const [tool] = addHandleParametersToTools(
      [structuredTool("poly", complex)],
      { injectSessionId: true, injectAgentId: true },
      new Map(),
      output,
    );
    expect(tool.outputSchema).toEqual(complex);
    expect(output.size).toBe(0);
    // input side still injected — content footer still needs echo params
    expect(tool.inputSchema.properties).toHaveProperty("session_id");
  });

  it("composed inputSchema: early-return skips output injection too, nothing registered", () => {
    const output: OutputInjectionRegistry = new Set();
    const tool = structuredTool("mixed", objectOutputSchema());
    tool.inputSchema = {
      oneOf: [{ type: "object", properties: { a: { type: "string" } } }],
    };
    const [result] = addHandleParametersToTools(
      [tool],
      { injectSessionId: true, injectAgentId: true },
      new Map(),
      output,
    );
    expect(result.outputSchema).toEqual(objectOutputSchema());
    expect(result.outputSchema.properties).not.toHaveProperty(MCP_SESSION_KEY);
    expect(output.size).toBe(0);
  });

  it("collision: a customer-declared mcp_session is never clobbered", () => {
    const output: OutputInjectionRegistry = new Set();
    const schema = {
      type: "object",
      properties: { [MCP_SESSION_KEY]: { type: "string" } },
    };
    const [tool] = addHandleParametersToTools(
      [structuredTool("t", schema)],
      { injectSessionId: true, injectAgentId: true },
      new Map(),
      output,
    );
    expect(tool.outputSchema.properties[MCP_SESSION_KEY]).toEqual({
      type: "string",
    });
    expect(output.size).toBe(0);
  });

  it("no outputSchema: untouched, nothing registered", () => {
    const output: OutputInjectionRegistry = new Set();
    const [plain] = addHandleParametersToTools(
      [makeTool("t", customerSchema())],
      { injectSessionId: true, injectAgentId: true },
      new Map(),
      output,
    );
    expect(plain.outputSchema).toBeUndefined();
    expect(output.size).toBe(0);
  });

  it("no injection at all (neither handle) leaves outputSchema alone", () => {
    const output: OutputInjectionRegistry = new Set();
    const [tool] = addHandleParametersToTools(
      [structuredTool("t", objectOutputSchema())],
      { injectSessionId: false, injectAgentId: false },
      new Map(),
      output,
    );
    expect(tool.outputSchema.properties).not.toHaveProperty(MCP_SESSION_KEY);
    expect(output.size).toBe(0);
  });

  it("output registry accessors are keyed per server object", () => {
    const server = {};
    expect(getOutputInjectionRegistry(server)).toBeUndefined();
    const reg: OutputInjectionRegistry = new Set(["a"]);
    setOutputInjectionRegistry(server, reg);
    expect(getOutputInjectionRegistry(server)).toBe(reg);
    expect(getOutputInjectionRegistry({})).toBeUndefined();
  });
});
