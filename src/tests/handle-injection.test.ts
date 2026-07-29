import { describe, it, expect } from "vitest";
import { addHandleParametersToTools } from "../modules/handle-parameters.js";
import { addContextParameterToTools } from "../modules/context-parameters.js";

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

  it("does not inject into get_more_tools's exemption list", () => {
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

  it("skips complex schemas", () => {
    const [out] = addHandleParametersToTools(
      [tool("x", { oneOf: [{ type: "object" }] })],
      true,
    ) as any[];
    expect(out.inputSchema.properties).toBeUndefined();
  });

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
