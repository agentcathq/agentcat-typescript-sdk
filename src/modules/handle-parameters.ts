import { AgentCatData, RegisteredTool } from "../types.js";
import {
  TASK_ID_PARAMETER_DESCRIPTION,
  AGENT_ID_PARAMETER_DESCRIPTION,
} from "./constants.js";
import { TASK_ID_PARAM, AGENT_ID_PARAM } from "./handles.js";
import { getObjectShape, isZ4Schema } from "./mcp-sdk-compat.js";
import { writeToLog } from "./logging.js";

/**
 * True when a tool's own JSON Schema already declares task_id or agent_id.
 *
 * This is the single source of truth for the collision guard: injection skips
 * such tools, and the call path must never extract or strip a parameter we did
 * not inject.
 */
export function toolDeclaresHandle(inputSchema: unknown): boolean {
  const properties = (inputSchema as Record<string, any> | undefined)
    ?.properties;
  if (!properties || typeof properties !== "object") return false;
  return Boolean(properties[TASK_ID_PARAM] || properties[AGENT_ID_PARAM]);
}

/**
 * The parameter names a schema declares, across every representation the SDK
 * can hand us:
 *
 * - JSON Schema (`{ properties: {...} }`) — what tools/list serves.
 * - A Zod object — what the high-level server stores in
 *   `_registeredTools[name].inputSchema`. NOT JSON Schema: reading
 *   `.properties` off it silently yields nothing, which would disable the
 *   collision guard on the high-level tools/call path entirely.
 * - A bare Zod shape (`{ text: z.string() }`) — older high-level SDKs.
 *
 * Zod is read through `getObjectShape`, the project's single Zod reader, and
 * never by hand. @modelcontextprotocol/sdk accepts `zod ^3.25 || ^4.0` and
 * normalises every v4 shape through `objectFromShape` -> `z4mini.object()`; a
 * ZodMiniObject has no `_def` at all (its shape is at `_zod.def.shape`) and
 * enumerating its own keys yields method names, so a hand-rolled `_def.shape`
 * chain misses v4 collisions entirely.
 */
function schemaParameterNames(inputSchema: unknown): string[] {
  if (!inputSchema || typeof inputSchema !== "object") return [];
  const schema = inputSchema as Record<string, any>;

  if (schema.properties && typeof schema.properties === "object") {
    return Object.keys(schema.properties);
  }

  const shape = getObjectShape(schema);
  if (shape) return Object.keys(shape);

  // Anything Zod-shaped that got here is a non-object schema with no
  // parameters to report; only a bare shape lists its parameters as own keys.
  if (isZ4Schema(schema) || schema._def) return [];
  return Object.keys(schema);
}

/**
 * The handle parameter a tool declares as its own, or undefined. Returning the
 * name (not a boolean) is what lets the collision tag say which parameter
 * collided — `handleCollisionTools` records tool names only, so the parameter
 * is unrecoverable after the fact.
 */
export function declaredHandleParam(
  inputSchema: unknown,
): typeof TASK_ID_PARAM | typeof AGENT_ID_PARAM | undefined {
  const names = schemaParameterNames(inputSchema);
  if (names.includes(TASK_ID_PARAM)) return TASK_ID_PARAM;
  if (names.includes(AGENT_ID_PARAM)) return AGENT_ID_PARAM;
  return undefined;
}

/**
 * Adds task_id and agent_id to a tool's JSON Schema as OPTIONAL properties.
 * Optionality is the minting mechanism: an omitted handle is the signal for the
 * server to issue one, so these are never added to `required`.
 *
 * Must run BEFORE addContextParameterToTool — both append by key assignment and
 * JS objects preserve insertion order, which is what produces the intended
 * { ...customerParams, task_id, agent_id, context } ordering.
 *
 * Unlike the context injection, get_more_tools is NOT skipped: its calls are
 * published as events, so without a handle it would mint a fresh task every time.
 */
export function addHandleParametersToTool(
  tool: RegisteredTool,
  enableAgentTracking: boolean,
): RegisteredTool {
  // Create a shallow copy of the tool to avoid modifying the original
  const modifiedTool = { ...tool };
  const toolName = (tool as any).name || "unknown";
  const schema = modifiedTool.inputSchema as Record<string, any> | undefined;

  // Skip tools that already declare either handle - avoid collision
  if (toolDeclaresHandle(schema)) {
    writeToLog(
      `WARN: Tool "${toolName}" already has a '${TASK_ID_PARAM}' or '${AGENT_ID_PARAM}' parameter. Skipping handle injection.`,
    );
    return modifiedTool;
  }

  // Skip complex schemas that can't safely have properties added at root level
  if (schema?.oneOf || schema?.allOf || schema?.anyOf) {
    writeToLog(
      `WARN: Tool "${toolName}" has complex schema (oneOf/allOf/anyOf). Skipping handle injection.`,
    );
    return modifiedTool;
  }

  if (!modifiedTool.inputSchema) {
    modifiedTool.inputSchema = { type: "object", properties: {}, required: [] };
  }

  // Deep copy the inputSchema to avoid mutations
  modifiedTool.inputSchema = JSON.parse(
    JSON.stringify(modifiedTool.inputSchema),
  );

  if (!modifiedTool.inputSchema.properties) {
    modifiedTool.inputSchema.properties = {};
  }

  // additionalProperties: false would invalidate the schema once handles are added
  if (modifiedTool.inputSchema.additionalProperties === false) {
    delete modifiedTool.inputSchema.additionalProperties;
  }

  // task_id first: the agent_id description forward-references it.
  modifiedTool.inputSchema.properties[TASK_ID_PARAM] = {
    type: "string",
    description: TASK_ID_PARAMETER_DESCRIPTION,
  };

  if (enableAgentTracking) {
    modifiedTool.inputSchema.properties[AGENT_ID_PARAM] = {
      type: "string",
      description: AGENT_ID_PARAMETER_DESCRIPTION,
    };
  }

  return modifiedTool;
}

export function addHandleParametersToTools(
  tools: RegisteredTool[],
  enableAgentTracking: boolean,
): RegisteredTool[] {
  return tools.map((tool) =>
    addHandleParametersToTool(tool, enableAgentTracking),
  );
}

/**
 * Records which tools declare their own task_id/agent_id, so the tools/call
 * path can leave those arguments alone. tools/list is the only place that sees
 * every tool's schema, which is why the bookkeeping lives here.
 *
 * Call this BEFORE handle injection — afterwards every tool declares a handle.
 *
 * The delete on the else branch keeps the set accurate when a server
 * re-registers a tool without the colliding parameter.
 */
export function recordHandleCollisions(
  data: AgentCatData,
  tools: RegisteredTool[],
): void {
  for (const t of tools) {
    const name = (t as any)?.name;
    if (typeof name !== "string") continue;
    if (toolDeclaresHandle((t as any).inputSchema)) {
      data.handleCollisionTools.add(name);
      writeToLog(
        `WARN: Tool "${name}" declares its own task_id/agent_id. AgentCat will not inject, extract, or strip handles for it.`,
      );
    } else {
      data.handleCollisionTools.delete(name);
    }
  }
}
