import { AgentCatData, MCPServerLike } from "../types.js";
import { writeToLog } from "../modules/logging.js";
import { getServerTrackingData } from "../modules/internal.js";
import { addContextParameterToTools } from "../modules/context-parameters.js";
import { addHandleParametersToTools } from "../modules/handle-injection.js";
import {
  GET_MORE_TOOLS_NAME,
  getReportMissingToolDescriptor,
} from "../modules/tools.js";
import {
  InjectedParamsRegistry,
  OutputInjectionRegistry,
  getEngineState,
  getReportedConflicts,
  setInjectedParamsRegistry,
  setOutputInjectionRegistry,
} from "./registry.js";
import { rewrapAllTools } from "./innerTap.js";

export interface InjectedList {
  tools: any[];
  registry: InjectedParamsRegistry;
  outputRegistry: OutputInjectionRegistry;
}

/**
 * The injection pipeline, pure: (config, listed tools) -> (advertised tools,
 * registries). Deterministic and config-derived, so rebuild-on-demand
 * (callWrap) can reproduce registries exactly on a fresh per-request
 * instance that never served tools/list.
 */
export function buildInjectedList(
  data: AgentCatData,
  tools: any[],
): InjectedList {
  let result = [...tools];

  // Append get_more_tools BEFORE injection so it receives handle params.
  // The context injector skips it by name (bespoke context), so early
  // placement cannot double-inject context.
  if (data.options.enableReportMissing) {
    const alreadyPresent = result.some(
      (t: any) => t?.name === GET_MORE_TOOLS_NAME,
    );
    if (!alreadyPresent) result.push(getReportMissingToolDescriptor());
  }

  // Order matters: handles first, then context ->
  // { ...customerParams, session_id, agent_id, context }
  // enableTracing:false skips handle injection wholesale (spec guard).
  const tracingEnabled = data.options.enableTracing !== false;
  const registry: InjectedParamsRegistry = new Map();
  const outputRegistry: OutputInjectionRegistry = new Set();
  result = addHandleParametersToTools(
    result,
    {
      injectSessionId: tracingEnabled && !data.options.resolveSessionId,
      injectAgentId:
        tracingEnabled && data.options.enableAgentTracking === true,
      reportedConflicts: getReportedConflicts(data),
    },
    registry,
    outputRegistry,
  );
  if (data.options.enableToolCallContext) {
    result = addContextParameterToTools(
      result,
      data.options.customContextDescription,
      registry,
    );
  }
  // Tools that received zero injections still get an (empty) entry: the
  // strip fallback must apply only to tools never seen in any listing.
  for (const t of result) {
    const name = (t as any)?.name;
    if (name && !registry.has(name)) registry.set(name, new Set());
  }
  return { tools: result, registry, outputRegistry };
}

/**
 * Wraps the stored tools/list handler via the _requestHandlers map seam.
 * Idempotent: re-invoking after a customer re-registration captures the new
 * handler; when our wrapper is already current, no-op.
 */
export function installListWrap(server: MCPServerLike): void {
  const st = getEngineState(server);
  if (!st) return;
  const handlers = server._requestHandlers;
  const current = handlers.get("tools/list");
  if (!current) return; // no handler yet; registrationPatch re-arms us
  if (st.listWrapper && current === st.listWrapper) return;

  const originalHandler = current;
  st.originalList = originalHandler;

  const wrapper = async (request: any, extra?: any) => {
    const originalResponse = await originalHandler(request, extra);
    const data = getServerTrackingData(server);
    if (!data) {
      writeToLog(
        "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
      );
      return originalResponse;
    }
    const tools = originalResponse?.tools;
    if (!Array.isArray(tools) || tools.length === 0) {
      writeToLog(
        "Warning: No tools found in the original list. This is likely due to the tools not being registered before AgentCat.track().",
      );
      return originalResponse;
    }

    const injected = buildInjectedList(data, tools);
    setInjectedParamsRegistry(server, injected.registry);
    setOutputInjectionRegistry(server, injected.outputRegistry);

    // Inner-tap re-sweep: catches tools registered or update()d since the
    // last wrap pass (v2 update() regenerates executor).
    if (st.highLevel) rewrapAllTools(server, st.highLevel, st.adapter);

    // Spread: nextCursor, result _meta, and any future fields pass through.
    return { ...originalResponse, tools: injected.tools };
  };

  st.listWrapper = wrapper;
  handlers.set("tools/list", wrapper);
}
