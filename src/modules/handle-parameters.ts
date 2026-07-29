import { RegisteredTool } from "../types.js";
import {
  TASK_ID_PARAMETER_DESCRIPTION,
  AGENT_ID_PARAMETER_DESCRIPTION,
} from "./constants.js";
import { TASK_ID_PARAM, AGENT_ID_PARAM } from "./handles.js";
import { writeToLog } from "./logging.js";

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
  if (
    schema?.properties?.[TASK_ID_PARAM] ||
    schema?.properties?.[AGENT_ID_PARAM]
  ) {
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
