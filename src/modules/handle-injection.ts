import { RegisteredTool } from "../types.js";
import { SESSION_ID_PARAM, AGENT_ID_PARAM } from "./handles.js";
import {
  SESSION_ID_PARAM_DESCRIPTION,
  SESSION_ID_PARAM_PATTERN,
  AGENT_ID_PARAM_DESCRIPTION,
  MCP_SESSION_KEY,
  MCP_SESSION_FIELD_DESCRIPTION,
  MCP_SESSION_FIELD_DESCRIPTION_HOOK_MODE,
  MCP_SESSION_SESSION_ID_DESCRIPTION,
  MCP_SESSION_AGENT_ID_DESCRIPTION,
  MCP_SESSION_STATUS_DESCRIPTION,
} from "./constants.js";
import { GET_MORE_TOOLS_NAME } from "./tools.js";
import { writeToLog } from "./logging.js";

export {
  InjectedParamsRegistry,
  OutputInjectionRegistry,
  setInjectedParamsRegistry,
  getInjectedParamsRegistry,
  setOutputInjectionRegistry,
  getOutputInjectionRegistry,
} from "../engine/registry.js";
import type {
  InjectedParamsRegistry,
  OutputInjectionRegistry,
} from "../engine/registry.js";

const CONTEXT_PARAM = "context";
const ALL_INJECTABLE = [SESSION_ID_PARAM, AGENT_ID_PARAM, CONTEXT_PARAM];

function recordInjected(
  registry: InjectedParamsRegistry,
  toolName: string,
  param: string,
): void {
  const existing = registry.get(toolName);
  if (existing) existing.add(param);
  else registry.set(toolName, new Set([param]));
}

/**
 * Adds a param to the schema's required array: created if absent, appended
 * without duplicating, customer entries never removed or reordered.
 * Requiredness rides injection exactly — only a param AgentCat injected on
 * this tool is ever added — and enforcement stays soft: callWrap tolerates
 * omission (session minted / event without agent identity), so the flag
 * drives schema-aware clients only.
 */
function addToRequired(schema: Record<string, any>, param: string): void {
  const required = schema.required;
  if (Array.isArray(required)) {
    if (!required.includes(param)) required.push(param);
  } else {
    schema.required = [param];
  }
}

export interface HandleInjectionOptions {
  injectSessionId: boolean; // false in hook mode
  injectAgentId: boolean; // false when enableAgentTracking is false
  /** Tools already reported for a session_id collision; prevents log spam. */
  reportedConflicts?: Set<string>;
  /**
   * Collects the tools whose schema declares `session_id` itself. callWrap
   * reads it to decide whether the argument is ours: a tool NOT in here is
   * ours (nothing declared it), including tools we skipped for schema shape.
   */
  declaredSessionParams?: Set<string>;
}

/**
 * Injects session_id/agent_id into each tool's JSON Schema (post-Zod), both
 * schema-required with soft enforcement (see addToRequired).
 * Order: customer params, session_id, agent_id — context is appended afterwards
 * by addContextParameterToTools, so this MUST run first. Unlike the context
 * injector, get_more_tools is NOT exempt: its calls publish events, so it
 * must be able to carry handles.
 */
export function addHandleParametersToTools(
  tools: RegisteredTool[],
  opts: HandleInjectionOptions,
  registry: InjectedParamsRegistry,
  outputRegistry?: OutputInjectionRegistry,
): RegisteredTool[] {
  if (!opts.injectSessionId && !opts.injectAgentId) return tools;
  return tools.map((tool) => {
    try {
      return addHandleParametersToTool(tool, opts, registry, outputRegistry);
    } catch (error) {
      // One tool's schema must never poison the listing: serve it unmodified
      // and roll back any partial registry writes so call-time stripping and
      // output mirroring never act on state the advertised schema lacks.
      const toolName = (tool as any)?.name || "unknown";
      registry.delete(toolName);
      outputRegistry?.delete(toolName);
      writeToLog(
        `WARN: Handle injection failed for tool "${toolName}"; listing it unmodified - ${error}`,
      );
      return tool;
    }
  });
}

function addHandleParametersToTool(
  tool: RegisteredTool,
  opts: HandleInjectionOptions,
  registry: InjectedParamsRegistry,
  outputRegistry?: OutputInjectionRegistry,
): RegisteredTool {
  const modifiedTool = { ...tool };
  const toolName = (tool as any).name || "unknown";
  const schema = modifiedTool.inputSchema as Record<string, any> | undefined;

  if (schema?.oneOf || schema?.allOf || schema?.anyOf) {
    // Injection is skipped, but ownership still has to be recorded: a schema
    // that composes AND declares session_id at its root is the customer's
    // parameter, not ours to read at call time. (Only the root bag is
    // visible here — a session_id nested inside a branch is unreachable,
    // same limitation as the injection itself.)
    if (opts.injectSessionId && schema.properties?.[SESSION_ID_PARAM]) {
      opts.declaredSessionParams?.add(toolName);
    }
    writeToLog(
      `WARN: Tool "${toolName}" has complex schema (oneOf/allOf/anyOf). Skipping handle injection.`,
    );
    return modifiedTool;
  }

  if (!modifiedTool.inputSchema) {
    modifiedTool.inputSchema = { type: "object", properties: {}, required: [] };
  }
  modifiedTool.inputSchema = JSON.parse(
    JSON.stringify(modifiedTool.inputSchema),
  );
  if (!modifiedTool.inputSchema.properties)
    modifiedTool.inputSchema.properties = {};
  if (modifiedTool.inputSchema.additionalProperties === false) {
    delete modifiedTool.inputSchema.additionalProperties;
  }
  const properties = modifiedTool.inputSchema.properties;

  if (opts.injectSessionId) {
    if (properties[SESSION_ID_PARAM]) {
      // The customer owns this name on this tool: record it so call-time
      // resolution never reads their value as an AgentCat handle.
      opts.declaredSessionParams?.add(toolName);
      if (!opts.reportedConflicts?.has(toolName)) {
        opts.reportedConflicts?.add(toolName);
        writeToLog(
          `ERROR: Tool "${toolName}" already declares a '${SESSION_ID_PARAM}' parameter. ` +
            `AgentCat will not inject its own, and calls to this tool are published without a session, ` +
            `so they cannot be correlated. Your parameter is untouched and still reaches your handler. ` +
            `If you already manage sessions, pass a resolveSessionId hook to track() — AgentCat will ` +
            `derive its session from your identifier and stop injecting ${SESSION_ID_PARAM} entirely.`,
        );
      }
    } else {
      properties[SESSION_ID_PARAM] = {
        type: "string",
        description: SESSION_ID_PARAM_DESCRIPTION,
        pattern: SESSION_ID_PARAM_PATTERN,
      };
      recordInjected(registry, toolName, SESSION_ID_PARAM);
      addToRequired(modifiedTool.inputSchema, SESSION_ID_PARAM);
    }
  }

  if (opts.injectAgentId) {
    if (properties[AGENT_ID_PARAM]) {
      writeToLog(
        `WARN: Tool "${toolName}" already has '${AGENT_ID_PARAM}' parameter. Skipping agent_id injection.`,
      );
    } else {
      properties[AGENT_ID_PARAM] = {
        type: "string",
        // One description for both modes: the copy never references the
        // session_id parameter, so it reads the same with or without one.
        description: AGENT_ID_PARAM_DESCRIPTION,
      };
      recordInjected(registry, toolName, AGENT_ID_PARAM);
      // agent_id is self-chosen by the agent (no pattern to advertise), and
      // schema-required like session_id above — see addToRequired for the
      // soft-enforcement contract.
      addToRequired(modifiedTool.inputSchema, AGENT_ID_PARAM);
    }
  }

  if (outputRegistry) {
    addMcpSessionToOutputSchema(modifiedTool, opts, outputRegistry, toolName);
  }
  return modifiedTool;
}

/**
 * Injects the optional mcp_session property into a declared plain-object
 * outputSchema so validating clients accept the mirrored field. The MCP TS
 * client ajv-validates structuredContent against the listed schema, and
 * zod-to-json-schema emits additionalProperties: false for plain z.object —
 * an undeclared key would fail the whole result, so declaration is what makes
 * mirroring safe. Composed schemas (oneOf/allOf/anyOf) have no single
 * properties bag to extend and are skipped, same policy as the input side.
 * Sub-properties mirror the modes: no session_id or status in hook mode, no
 * agent_id when tracking is off — every response state the schema
 * pre-announces is one the agent can actually receive.
 */
function addMcpSessionToOutputSchema(
  tool: RegisteredTool,
  opts: HandleInjectionOptions,
  outputRegistry: OutputInjectionRegistry,
  toolName: string,
): void {
  const schema = (tool as any).outputSchema as Record<string, any> | undefined;
  if (!schema) return;
  if (schema.oneOf || schema.allOf || schema.anyOf) {
    writeToLog(
      `WARN: Tool "${toolName}" has complex outputSchema (oneOf/allOf/anyOf). Skipping ${MCP_SESSION_KEY} injection; mint-back stays content-only for this tool.`,
    );
    return;
  }
  const copy = JSON.parse(JSON.stringify(schema));
  if (!copy.properties) copy.properties = {};
  if (copy.properties[MCP_SESSION_KEY]) {
    writeToLog(
      `WARN: Tool "${toolName}" already declares '${MCP_SESSION_KEY}' in outputSchema. Skipping injection.`,
    );
    return;
  }
  const subProperties: Record<string, any> = {};
  if (opts.injectSessionId) {
    subProperties[SESSION_ID_PARAM] = {
      type: "string",
      description: MCP_SESSION_SESSION_ID_DESCRIPTION,
    };
  }
  if (opts.injectAgentId) {
    subProperties[AGENT_ID_PARAM] = {
      type: "string",
      description: MCP_SESSION_AGENT_ID_DESCRIPTION,
    };
  }
  if (opts.injectSessionId) {
    subProperties.status = {
      type: "string",
      enum: ["issued", "active", "unrecognized"],
      description: MCP_SESSION_STATUS_DESCRIPTION,
    };
  }
  copy.properties[MCP_SESSION_KEY] = {
    type: "object",
    description: opts.injectSessionId
      ? MCP_SESSION_FIELD_DESCRIPTION
      : MCP_SESSION_FIELD_DESCRIPTION_HOOK_MODE,
    properties: subProperties,
  };
  (tool as any).outputSchema = copy;
  outputRegistry.add(toolName);
}

/**
 * Strips ONLY the params AgentCat injected for this tool. Without a registry
 * entry (tools/call before any tools/list), falls back to stripping all three
 * names — except get_more_tools' bespoke context, which is a real parameter.
 */
export function stripInjectedArguments(
  args: any,
  toolName: string,
  registry?: InjectedParamsRegistry,
): any {
  if (!args || typeof args !== "object") return args;
  let names: Iterable<string>;
  const recorded = registry?.get(toolName);
  if (recorded) {
    names = recorded;
  } else {
    names =
      toolName === GET_MORE_TOOLS_NAME
        ? [SESSION_ID_PARAM, AGENT_ID_PARAM]
        : ALL_INJECTABLE;
  }
  const cleaned = { ...(args as Record<string, unknown>) };
  for (const name of names) delete cleaned[name];
  return cleaned;
}

/** Clones request with stripped arguments; the original (kept on the event) is untouched. */
export function cloneRequestWithStrippedArguments(
  request: any,
  registry?: InjectedParamsRegistry,
): any {
  const args = request?.params?.arguments;
  if (!args || typeof args !== "object") return request;
  return {
    ...request,
    params: {
      ...request.params,
      arguments: stripInjectedArguments(args, request.params?.name, registry),
    },
  };
}
