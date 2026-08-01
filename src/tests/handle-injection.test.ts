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
  TASK_ID_PARAM_DESCRIPTION,
  AGENT_ID_PARAM_DESCRIPTION,
  AGENT_ID_PARAM_DESCRIPTION_HOOK_MODE,
  MCP_INSTRUCTIONS_KEY,
  MCP_INSTRUCTIONS_FIELD_DESCRIPTION,
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
  it("injects optional task_id and required agent_id after customer params", () => {
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("add_todo", customerSchema())],
      { injectTaskId: true, injectAgentId: true },
      registry,
    );
    const keys = Object.keys(tool.inputSchema.properties);
    expect(keys).toEqual(["text", "task_id", "agent_id"]);
    // task_id is never required — omission is the minting signal. agent_id is
    // self-chosen and required when injected.
    expect(tool.inputSchema.required).toEqual(["text", "agent_id"]);
    expect(tool.inputSchema.properties.task_id.description).toBe(
      TASK_ID_PARAM_DESCRIPTION,
    );
    expect(tool.inputSchema.properties.agent_id.description).toBe(
      AGENT_ID_PARAM_DESCRIPTION,
    );
    expect(registry.get("add_todo")).toEqual(new Set(["task_id", "agent_id"]));
  });

  it("creates the required array when the schema has none", () => {
    const tool: any = {
      name: "bare",
      inputSchema: { type: "object", properties: {} },
    };
    const registry = new Map();
    const [out]: any[] = addHandleParametersToTools(
      [tool],
      { injectTaskId: true, injectAgentId: true },
      registry,
    );
    expect(out.inputSchema.required).toEqual(["agent_id"]);
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
      { injectTaskId: false, injectAgentId: true },
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
      { injectTaskId: false, injectAgentId: true },
      registry,
    );
    expect(out.inputSchema.required).toEqual([]);
    expect(out.inputSchema.properties.agent_id.description).toBe("mine");
  });

  it("full order with context injector: customer, task_id, agent_id, context", () => {
    const registry: InjectedParamsRegistry = new Map();
    let tools = addHandleParametersToTools(
      [makeTool("add_todo", customerSchema())],
      { injectTaskId: true, injectAgentId: true },
      registry,
    );
    tools = addContextParameterToTools(tools, undefined, registry);
    expect(Object.keys(tools[0].inputSchema.properties)).toEqual([
      "text",
      "task_id",
      "agent_id",
      "context",
    ]);
    expect(registry.get("add_todo")).toEqual(
      new Set(["task_id", "agent_id", "context"]),
    );
  });

  it("hook mode: no task_id, agent_id uses the standalone description", () => {
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("add_todo", customerSchema())],
      { injectTaskId: false, injectAgentId: true },
      registry,
    );
    expect(tool.inputSchema.properties.task_id).toBeUndefined();
    expect(tool.inputSchema.properties.agent_id.description).toBe(
      AGENT_ID_PARAM_DESCRIPTION_HOOK_MODE,
    );
    expect(tool.inputSchema.required).toEqual(["text", "agent_id"]);
    expect(registry.get("add_todo")).toEqual(new Set(["agent_id"]));
  });

  it("skips a param the tool already defines, and does not record it", () => {
    const schema = customerSchema();
    schema.properties.task_id = {
      type: "string",
      description: "customer's own",
    };
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("deploy", schema)],
      { injectTaskId: true, injectAgentId: true },
      registry,
    );
    expect(tool.inputSchema.properties.task_id.description).toBe(
      "customer's own",
    );
    expect(registry.get("deploy")).toEqual(new Set(["agent_id"]));
  });

  it("skips complex schemas entirely", () => {
    const registry: InjectedParamsRegistry = new Map();
    const [tool] = addHandleParametersToTools(
      [makeTool("odd", { oneOf: [{ type: "object" }] })],
      { injectTaskId: true, injectAgentId: true },
      registry,
    );
    expect(tool.inputSchema.properties).toBeUndefined();
    expect(registry.has("odd")).toBe(false);
  });

  it("removes additionalProperties:false and handles missing schemas", () => {
    const registry: InjectedParamsRegistry = new Map();
    const strict = { ...customerSchema(), additionalProperties: false };
    const tools = addHandleParametersToTools(
      [makeTool("strict", strict), makeTool("bare")],
      { injectTaskId: true, injectAgentId: true },
      registry,
    );
    expect(tools[0].inputSchema.additionalProperties).toBeUndefined();
    expect(Object.keys(tools[1].inputSchema.properties)).toEqual([
      "task_id",
      "agent_id",
    ]);
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
      { injectTaskId: true, injectAgentId: true },
      registry,
    );
    tools = addContextParameterToTools(tools, undefined, registry);
    expect(Object.keys(tools[0].inputSchema.properties)).toEqual([
      "context",
      "task_id",
      "agent_id",
    ]);
    expect(tools[0].inputSchema.properties.context.description).toBe("bespoke");
    expect(registry.get("get_more_tools")).toEqual(
      new Set(["task_id", "agent_id"]),
    );
  });

  it("agent_id copy prescribes the self-chosen model|harness|nonce format", () => {
    for (const copy of [
      AGENT_ID_PARAM_DESCRIPTION,
      AGENT_ID_PARAM_DESCRIPTION_HOOK_MODE,
    ]) {
      expect(copy).toContain("REQUIRED on every call, including your first");
      expect(copy).toContain("opus-4.80-1m|claude-code|k3n9x");
      expect(copy).toContain("generate its own");
      // The old mint-back protocol must be gone from the copy.
      expect(copy).not.toContain("the server will issue one");
      expect(copy).not.toContain("Omit it");
    }
    // Only the standard variant ties the agent to the task wording.
    expect(AGENT_ID_PARAM_DESCRIPTION).toContain("working this task");
    expect(AGENT_ID_PARAM_DESCRIPTION_HOOK_MODE).not.toContain(
      "working this task",
    );
  });
});

describe("stripInjectedArguments", () => {
  const registry: InjectedParamsRegistry = new Map([
    ["add_todo", new Set(["task_id", "agent_id", "context"])],
    ["deploy", new Set(["agent_id", "context"])], // tool owns task_id
  ]);

  it("strips exactly what was injected", () => {
    expect(
      stripInjectedArguments(
        { text: "x", task_id: "ses_1", agent_id: "agt_1", context: "why" },
        "add_todo",
        registry,
      ),
    ).toEqual({ text: "x" });
  });

  it("preserves the customer's own task_id param", () => {
    expect(
      stripInjectedArguments(
        { task_id: "prod-42", agent_id: "agt_1", context: "why" },
        "deploy",
        registry,
      ),
    ).toEqual({ task_id: "prod-42" });
  });

  it("falls back to stripping all three when no registry entry exists", () => {
    expect(
      stripInjectedArguments(
        { text: "x", task_id: "a", agent_id: "b", context: "c" },
        "unlisted_tool",
        registry,
      ),
    ).toEqual({ text: "x" });
    expect(
      stripInjectedArguments({ text: "x", task_id: "a" }, "any", undefined),
    ).toEqual({ text: "x" });
  });

  it("fallback never strips get_more_tools' own context", () => {
    expect(
      stripInjectedArguments(
        { context: "need a tool", task_id: "a", agent_id: "b" },
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
      ["t", new Set(["task_id"])],
    ]);
    setInjectedParamsRegistry(server, registry);
    expect(getInjectedParamsRegistry(server)).toBe(registry);
    expect(getInjectedParamsRegistry({})).toBeUndefined();
  });

  it("clones the request with stripped arguments, leaving the original intact", () => {
    const registry: InjectedParamsRegistry = new Map([
      ["add_todo", new Set(["task_id", "agent_id", "context"])],
    ]);
    const request = {
      params: {
        name: "add_todo",
        arguments: { text: "x", task_id: "ses_1", context: "why" },
      },
    };
    const cloned = cloneRequestWithStrippedArguments(request, registry);
    expect(cloned.params.arguments).toEqual({ text: "x" });
    expect(request.params.arguments.task_id).toBe("ses_1"); // untouched (event keeps raw)
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
  it("injects _mcp_instructions into a plain object outputSchema and registers the tool", () => {
    const output: OutputInjectionRegistry = new Set();
    const [tool] = addHandleParametersToTools(
      [structuredTool("get_stats", objectOutputSchema())],
      { injectTaskId: true, injectAgentId: true },
      new Map(),
      output,
    );
    const prop = tool.outputSchema.properties[MCP_INSTRUCTIONS_KEY];
    expect(prop.type).toBe("object");
    expect(prop.description).toBe(MCP_INSTRUCTIONS_FIELD_DESCRIPTION);
    expect(Object.keys(prop.properties)).toEqual([
      "task_id",
      "agent_id",
      "instructions",
    ]);
    // The customer's declared contract is otherwise untouched — including
    // additionalProperties: false, which stays (our property is declared).
    expect(tool.outputSchema.required).toEqual(["count"]);
    expect(tool.outputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema.properties.count).toEqual({ type: "number" });
    expect(output.has("get_stats")).toBe(true);
  });

  it("sub-properties track modes: hook mode drops task_id, tracking off drops agent_id", () => {
    const o1: OutputInjectionRegistry = new Set();
    const [hookTool] = addHandleParametersToTools(
      [structuredTool("t", objectOutputSchema())],
      { injectTaskId: false, injectAgentId: true }, // hook mode
      new Map(),
      o1,
    );
    expect(
      Object.keys(
        hookTool.outputSchema.properties[MCP_INSTRUCTIONS_KEY].properties,
      ),
    ).toEqual(["agent_id", "instructions"]);

    const o2: OutputInjectionRegistry = new Set();
    const [taskOnlyTool] = addHandleParametersToTools(
      [structuredTool("t", objectOutputSchema())],
      { injectTaskId: true, injectAgentId: false }, // agent tracking off
      new Map(),
      o2,
    );
    expect(
      Object.keys(
        taskOnlyTool.outputSchema.properties[MCP_INSTRUCTIONS_KEY].properties,
      ),
    ).toEqual(["task_id", "instructions"]);
  });

  it("does not mutate the customer's outputSchema object", () => {
    const schema = objectOutputSchema();
    addHandleParametersToTools(
      [structuredTool("t", schema)],
      { injectTaskId: true, injectAgentId: true },
      new Map(),
      new Set(),
    );
    expect(schema.properties).not.toHaveProperty(MCP_INSTRUCTIONS_KEY);
  });

  it("skips complex outputSchema (oneOf/allOf/anyOf) and does not register", () => {
    const output: OutputInjectionRegistry = new Set();
    const complex = {
      oneOf: [{ type: "object", properties: { a: { type: "string" } } }],
    };
    const [tool] = addHandleParametersToTools(
      [structuredTool("poly", complex)],
      { injectTaskId: true, injectAgentId: true },
      new Map(),
      output,
    );
    expect(tool.outputSchema).toEqual(complex);
    expect(output.size).toBe(0);
    // input side still injected — content footer still needs echo params
    expect(tool.inputSchema.properties).toHaveProperty("task_id");
  });

  it("composed inputSchema: early-return skips output injection too, nothing registered", () => {
    const output: OutputInjectionRegistry = new Set();
    const tool = structuredTool("mixed", objectOutputSchema());
    tool.inputSchema = {
      oneOf: [{ type: "object", properties: { a: { type: "string" } } }],
    };
    const [result] = addHandleParametersToTools(
      [tool],
      { injectTaskId: true, injectAgentId: true },
      new Map(),
      output,
    );
    expect(result.outputSchema).toEqual(objectOutputSchema());
    expect(result.outputSchema.properties).not.toHaveProperty(
      MCP_INSTRUCTIONS_KEY,
    );
    expect(output.size).toBe(0);
  });

  it("collision: a customer-declared _mcp_instructions is never clobbered", () => {
    const output: OutputInjectionRegistry = new Set();
    const schema = {
      type: "object",
      properties: { [MCP_INSTRUCTIONS_KEY]: { type: "string" } },
    };
    const [tool] = addHandleParametersToTools(
      [structuredTool("t", schema)],
      { injectTaskId: true, injectAgentId: true },
      new Map(),
      output,
    );
    expect(tool.outputSchema.properties[MCP_INSTRUCTIONS_KEY]).toEqual({
      type: "string",
    });
    expect(output.size).toBe(0);
  });

  it("no outputSchema: untouched, nothing registered", () => {
    const output: OutputInjectionRegistry = new Set();
    const [plain] = addHandleParametersToTools(
      [makeTool("t", customerSchema())],
      { injectTaskId: true, injectAgentId: true },
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
      { injectTaskId: false, injectAgentId: false },
      new Map(),
      output,
    );
    expect(tool.outputSchema.properties).not.toHaveProperty(
      MCP_INSTRUCTIONS_KEY,
    );
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
