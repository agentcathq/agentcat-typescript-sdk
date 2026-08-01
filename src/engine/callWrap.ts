import {
  MCPServerLike,
  UnredactedEvent,
  UserIdentity,
  ServerClientInfoLike,
} from "../types.js";
import { writeToLog } from "../modules/logging.js";
import {
  getServerTrackingData,
  resolveEventTags,
  resolveEventProperties,
  resolveIdentity,
} from "../modules/internal.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { publishEvent } from "../modules/eventQueue.js";
import { captureException } from "../modules/exceptions.js";
import {
  resolveHandles,
  buildHandleTags,
  buildMintBackText,
  appendMintBack,
  buildStructuredMintBack,
  mirrorStructuredMintBack,
  HandleResolution,
} from "../modules/handles.js";
import { cloneRequestWithStrippedArguments } from "../modules/handle-injection.js";
import {
  getClientInfoForRequest,
  getProtocolVersion,
} from "../modules/session.js";
import { GET_MORE_TOOLS_NAME, handleReportMissing } from "../modules/tools.js";
import { AGENTCAT_TAG_MRTR } from "../modules/constants.js";
import {
  getEngineState,
  getInjectedParamsRegistry,
  getOutputInjectionRegistry,
  setInjectedParamsRegistry,
  setOutputInjectionRegistry,
} from "./registry.js";
import { buildInjectedList } from "./listWrap.js";

function isToolResultError(result: any): boolean {
  return result && typeof result === "object" && result.isError === true;
}

/** 2026-era intermediate result of a multi-round-trip tools/call. */
export function isInputRequiredShape(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    (result as { resultType?: unknown }).resultType === "input_required"
  );
}

/** Tag for a retry round carrying the client's input responses. */
export function mrtrContinuationTags(extra: unknown): Record<string, string> {
  const inputResponses = (extra as any)?.mcpReq?.inputResponses;
  return inputResponses && typeof inputResponses === "object"
    ? { [AGENTCAT_TAG_MRTR]: "continuation" }
    : {};
}

/**
 * Registry rebuild-on-demand: a tools/call on an instance that never served
 * tools/list (per-request 2026-era topology) rebuilds the registries by
 * running the original list handler through the same pure injection
 * pipeline. Deterministic, so the rebuilt registries match what any listing
 * instance advertised.
 */
async function ensureRegistries(
  server: MCPServerLike,
  extra: any,
): Promise<void> {
  if (getInjectedParamsRegistry(server)) return;
  const data = getServerTrackingData(server);
  const originalList = getEngineState(server)?.originalList;
  if (!data || !originalList) return; // heuristic strip fallback applies
  try {
    const response = await originalList(
      { method: "tools/list", params: {} },
      extra,
    );
    const tools = response?.tools;
    if (!Array.isArray(tools)) return;
    const injected = buildInjectedList(data, tools);
    setInjectedParamsRegistry(server, injected.registry);
    setOutputInjectionRegistry(server, injected.outputRegistry);
    writeToLog(
      "Rebuilt injection registries on demand (tools/call before tools/list on this instance)",
    );
  } catch (error) {
    writeToLog(`Warning: registry rebuild-on-demand failed - ${error}`);
  }
}

/**
 * Wraps the stored tools/call handler via the _requestHandlers map seam.
 * Outermost layer, run exactly once per request: resolution, event build,
 * publish, and mint-back all live here. The inner tap (innerTap.ts) only
 * strips leftovers and captures stack traces.
 */
export function installCallWrap(server: MCPServerLike): void {
  const st = getEngineState(server);
  if (!st) return;
  const handlers = server._requestHandlers;
  const current = handlers.get("tools/call");
  if (!current) return; // registrationPatch re-arms when it appears
  if (st.callWrapper && current === st.callWrapper) return;

  const originalHandler = current;
  st.originalCall = originalHandler;

  const wrapper = async (request: any, extra: any) => {
    const data = getServerTrackingData(server);
    // Tracing off: no resolution, no mint-back, no event.
    if (data && data.options.enableTracing === false) {
      if (request?.params?.name === GET_MORE_TOOLS_NAME) {
        return handleReportMissing({
          context: request?.params?.arguments?.context,
        });
      }
      return originalHandler(request, extra);
    }

    const startTime = new Date();

    let tracing: {
      event: UnredactedEvent;
      resolution: HandleResolution;
      identity: UserIdentity | null;
      clientInfo: ServerClientInfoLike | undefined;
    } | null = null;

    if (!data) {
      writeToLog(
        "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
      );
    } else {
      try {
        await ensureRegistries(server, extra);
        const resolution = await resolveHandles(
          data.options,
          data.projectId || undefined,
          request,
          extra,
        );
        const identity = await resolveIdentity(data, request, extra);
        const clientInfo = getClientInfoForRequest(server, request, extra);

        const event: UnredactedEvent = {
          sessionId: resolution.taskId,
          resourceName: request?.params?.name || "Unknown Tool",
          // Raw request on purpose: the event records exactly what the agent
          // sent, handles included. Stripping applies only to the handler copy.
          parameters: { request, extra },
          eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
          timestamp: startTime,
          redactionFn: data.options.redactSensitiveInformation,
        };

        const customerTags = await resolveEventTags(data, request, extra);
        // SDK tags LAST: namespaced, exempt from the 50-tag budget.
        event.tags = {
          ...(customerTags ?? {}),
          ...mrtrContinuationTags(extra),
          ...buildHandleTags(resolution, getProtocolVersion(request, extra)),
        };
        const resolvedProperties = await resolveEventProperties(
          data,
          request,
          extra,
        );
        if (resolvedProperties) event.properties = resolvedProperties;

        if (
          data.options.enableToolCallContext &&
          request?.params?.name !== GET_MORE_TOOLS_NAME &&
          request?.params?.arguments &&
          typeof request.params.arguments === "object" &&
          "context" in request.params.arguments
        ) {
          event.userIntent = request.params.arguments.context;
        }

        tracing = { event, resolution, identity, clientInfo };
      } catch (error) {
        writeToLog(
          `Warning: AgentCat tracing failed for tool ${request?.params?.name}, falling back to original handler - ${error}`,
        );
      }
    }

    // Degraded path: run the tool unstripped — no event, no mint-back.
    if (!tracing) {
      if (request?.params?.name === GET_MORE_TOOLS_NAME) {
        return handleReportMissing({
          context: request?.params?.arguments?.context,
        });
      }
      return originalHandler(request, extra);
    }

    const { event, resolution, identity, clientInfo } = tracing;

    const finish = (result: any) => {
      let finalResult = result;
      if (isInputRequiredShape(result)) {
        // Intermediate round: tag it, decorate nothing — the completing
        // round carries the mint-back.
        event.tags = { ...event.tags, [AGENTCAT_TAG_MRTR]: "input_required" };
      } else {
        const text = buildMintBackText(resolution);
        finalResult = text ? appendMintBack(result, text) : result;
        // Structured mirror, gated by the output-injection registry.
        // ensureRegistries makes a missing registry rare (rebuild failed);
        // in that case mirror anyway — the client cannot have a declared
        // schema we know about.
        const outputRegistry = getOutputInjectionRegistry(server);
        if (!outputRegistry || outputRegistry.has(request?.params?.name)) {
          const mint = buildStructuredMintBack(resolution);
          if (mint) finalResult = mirrorStructuredMintBack(finalResult, mint);
        }
      }
      if (isToolResultError(result)) {
        event.isError = true;
        const capturedError = (extra as any)?.__agentcat_error;
        if (capturedError) {
          event.error = captureException(capturedError);
          delete (extra as any).__agentcat_error;
        } else {
          event.error = captureException(result);
        }
      }
      // Mint-back is wire-only: the event records the customer's original result.
      event.response = result;
      event.duration = new Date().getTime() - startTime.getTime();
      publishEvent(server, event, { identity, clientInfo });
      return finalResult;
    };

    try {
      if (request?.params?.name === GET_MORE_TOOLS_NAME) {
        event.userIntent = request?.params?.arguments?.context;
        return finish(
          await handleReportMissing({
            context: request?.params?.arguments?.context,
          }),
        );
      }
      // STRIPPED request through: injected params never reach SDK validation
      // (fixes strict-schema rejection). The event keeps the raw request.
      const strippedRequest = cloneRequestWithStrippedArguments(
        request,
        getInjectedParamsRegistry(server),
      );
      return finish(await originalHandler(strippedRequest, extra));
    } catch (error) {
      event.isError = true;
      event.error = captureException(error);
      event.duration = new Date().getTime() - startTime.getTime();
      publishEvent(server, event, { identity, clientInfo });
      throw error;
    }
  };

  st.callWrapper = wrapper;
  handlers.set("tools/call", wrapper);
}
