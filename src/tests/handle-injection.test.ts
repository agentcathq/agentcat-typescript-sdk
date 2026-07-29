import { describe, it, expect } from "vitest";
import { addHandleParametersToTools } from "../modules/handle-parameters.js";
import { addContextParameterToTools } from "../modules/context-parameters.js";
import {
  TASK_ID_PARAMETER_DESCRIPTION,
  AGENT_ID_PARAMETER_DESCRIPTION,
} from "../modules/constants.js";

const tool = (name: string, inputSchema: any) => ({ name, inputSchema }) as any;

describe("handle parameter injection", () => {
  it("injects both handles as optional properties", () => {
    const [out] = addHandleParametersToTools(
      [
        tool("add_todo", {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        }),
      ],
      true,
    ) as any[];
    expect(out.inputSchema.properties.task_id.type).toBe("string");
    expect(out.inputSchema.properties.agent_id.type).toBe("string");
    expect(out.inputSchema.required).toEqual(["text"]);
    // Pin the injected copy to the constants: a re-typed inline literal at the
    // injection site must not be able to diverge from constants.ts silently.
    expect(out.inputSchema.properties.task_id.description).toBe(
      TASK_ID_PARAMETER_DESCRIPTION,
    );
    expect(out.inputSchema.properties.agent_id.description).toBe(
      AGENT_ID_PARAMETER_DESCRIPTION,
    );
  });

  it("omits agent_id when agent tracking is disabled", () => {
    const [out] = addHandleParametersToTools(
      [tool("add_todo", { type: "object", properties: {} })],
      false,
    ) as any[];
    expect(out.inputSchema.properties.task_id).toBeDefined();
    expect(out.inputSchema.properties.agent_id).toBeUndefined();
  });

  it("orders properties customerParams, task_id, agent_id, context", () => {
    let tools: any[] = [
      tool("add_todo", {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
    ];
    tools = addHandleParametersToTools(tools, true) as any[];
    tools = addContextParameterToTools(tools) as any[];
    expect(Object.keys(tools[0].inputSchema.properties)).toEqual([
      "text",
      "task_id",
      "agent_id",
      "context",
    ]);
  });

  it("injects into get_more_tools (deliberately not exempted)", () => {
    // get_more_tools is deliberately NOT skipped for handles.
    const [out] = addHandleParametersToTools(
      [
        tool("get_more_tools", {
          type: "object",
          properties: { context: { type: "string" } },
          required: ["context"],
        }),
      ],
      true,
    ) as any[];
    expect(out.inputSchema.properties.task_id).toBeDefined();
    expect(out.inputSchema.properties.agent_id).toBeDefined();
  });

  it("skips a tool that already declares task_id", () => {
    const original = tool("x", {
      type: "object",
      properties: { task_id: { type: "number" } },
    });
    const [out] = addHandleParametersToTools([original], true) as any[];
    expect(out.inputSchema.properties.task_id.type).toBe("number");
    expect(out.inputSchema.properties.agent_id).toBeUndefined();
  });

  it.each(["oneOf", "allOf", "anyOf"])(
    "skips complex schemas (%s)",
    (keyword) => {
      const [out] = addHandleParametersToTools(
        [tool("x", { [keyword]: [{ type: "object" }] })],
        true,
      ) as any[];
      expect(out.inputSchema.properties).toBeUndefined();
    },
  );

  it("removes additionalProperties: false so the schema stays valid", () => {
    const [out] = addHandleParametersToTools(
      [
        tool("x", {
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
      ],
      true,
    ) as any[];
    expect(out.inputSchema.additionalProperties).toBeUndefined();
    expect(out.inputSchema.properties.task_id).toBeDefined();
  });

  it("does not mutate the original tool", () => {
    const original = tool("x", { type: "object", properties: {} });
    addHandleParametersToTools([original], true);
    expect(original.inputSchema.properties.task_id).toBeUndefined();
  });
});
