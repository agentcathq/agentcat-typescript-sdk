import { RegisteredTool } from "../types";
import { DEFAULT_CONTEXT_PARAMETER_DESCRIPTION } from "./constants";
// Type-only import: handle-injection.ts imports from tools.ts at runtime, so a
// value import here would create a runtime cycle.
import type { InjectedParamsRegistry } from "./handle-injection.js";
import { writeToLog } from "./logging.js";

/**
 * Adds a context parameter to a tool's JSON Schema.
 * This function is called AFTER the MCP SDK has converted Zod schemas to JSON Schema,
 * so we only need to handle JSON Schema format.
 *
 * Skips injection (with warning) for:
 * - Tools that already have a 'context' parameter
 * - Complex schemas (oneOf/allOf/anyOf) that can't safely have properties added
 * - Schemas with additionalProperties: false
 */
export function addContextParameterToTool(
  tool: RegisteredTool,
  customContextDescription?: string,
  registry?: InjectedParamsRegistry,
): RegisteredTool {
  // Create a shallow copy of the tool to avoid modifying the original
  const modifiedTool = { ...tool };
  const toolName = (tool as any).name || "unknown";
  const schema = modifiedTool.inputSchema as Record<string, any> | undefined;

  // Check if tool already has context parameter - skip to avoid collision
  if (schema?.properties?.context) {
    writeToLog(
      `WARN: Tool "${toolName}" already has 'context' parameter. Skipping context injection.`,
    );
    return modifiedTool;
  }

  // Skip complex schemas that can't safely have properties added at root level
  if (schema?.oneOf || schema?.allOf || schema?.anyOf) {
    writeToLog(
      `WARN: Tool "${toolName}" has complex schema (oneOf/allOf/anyOf). Skipping context injection.`,
    );
    return modifiedTool;
  }

  // Note: If additionalProperties is false, we'll need to remove that constraint
  // when adding context, otherwise the schema would be invalid. We handle this
  // after the deep copy below.

  if (!modifiedTool.inputSchema) {
    modifiedTool.inputSchema = {
      type: "object",
      properties: {},
      required: [],
    };
  }

  const contextDescription =
    customContextDescription || DEFAULT_CONTEXT_PARAMETER_DESCRIPTION;

  // Deep copy the inputSchema to avoid mutations
  modifiedTool.inputSchema = JSON.parse(
    JSON.stringify(modifiedTool.inputSchema),
  );

  // Ensure properties object exists
  if (!modifiedTool.inputSchema.properties) {
    modifiedTool.inputSchema.properties = {};
  }

  // Handle additionalProperties: false - must remove this constraint since we're adding context
  // The MCP SDK adds this constraint when converting Zod schemas to JSON Schema
  if (modifiedTool.inputSchema.additionalProperties === false) {
    delete modifiedTool.inputSchema.additionalProperties;
  }

  // Add context property
  modifiedTool.inputSchema.properties.context = {
    type: "string",
    description: contextDescription,
  };

  if (registry) {
    const existing = registry.get(toolName);
    if (existing) existing.add("context");
    else registry.set(toolName, new Set(["context"]));
  }

  // Add context to required array
  if (Array.isArray(modifiedTool.inputSchema.required)) {
    if (!modifiedTool.inputSchema.required.includes("context")) {
      modifiedTool.inputSchema.required.push("context");
    }
  } else {
    modifiedTool.inputSchema.required = ["context"];
  }

  return modifiedTool;
}

export function addContextParameterToTools(
  tools: RegisteredTool[],
  customContextDescription?: string,
  registry?: InjectedParamsRegistry,
): RegisteredTool[] {
  return tools.map((tool) => {
    // Skip get_more_tools - it has its own special context parameter
    if ((tool as any)?.name === "get_more_tools") {
      return tool;
    }
    try {
      return addContextParameterToTool(
        tool,
        customContextDescription,
        registry,
      );
    } catch (error) {
      // One tool's schema must never poison the listing: serve it unmodified
      // and roll back the registry record so stripping matches the schema.
      const toolName = (tool as any)?.name || "unknown";
      registry?.get(toolName)?.delete("context");
      writeToLog(
        `WARN: Context injection failed for tool "${toolName}"; listing it unmodified - ${error}`,
      );
      return tool;
    }
  });
}
