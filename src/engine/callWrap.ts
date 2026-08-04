import {
  MCPServerLike,
  PendingEventFields,
  UnredactedEvent,
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
  invokeSessionHook,
  buildHandleTags,
  buildMintBackText,
  appendMintBack,
  buildStructuredMintBack,
  mirrorStructuredMintBack,
  HandleResolution,
} from "../modules/handles.js";
import { cloneRequestWithStrippedArguments } from "../modules/handle-injection.js";
import { projectExtraForEvent } from "../modules/extra-projection.js";
import {
  getClientInfoForRequest,
  getProtocolVersion,
} from "../modules/session.js";
import { GET_MORE_TOOLS_NAME, handleReportMissing } from "../modules/tools.js";
import { AGENTCAT_TAG_MRTR } from "../modules/constants.js";
import {
  getDeclaredSessionParams,
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
 * The rebuild runs the CUSTOMER's list handler on the tools/call request
 * path, so it must be time-bounded: a hanging list handler would otherwise
 * hang every tool call on this instance. On timeout the call proceeds with
 * the heuristic strip fallback; the next call retries the rebuild.
 */
const REGISTRY_REBUILD_TIMEOUT_MS = 5_000;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const listPromise = Promise.resolve(
      originalList({ method: "tools/list", params: {} }, extra),
    );
    // The abandoned promise must never surface as an unhandled rejection.
    listPromise.catch(() => {});
    const response: any = await Promise.race([
      listPromise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `tools/list did not respond within ${REGISTRY_REBUILD_TIMEOUT_MS}ms`,
              ),
            ),
          REGISTRY_REBUILD_TIMEOUT_MS,
        );
      }),
    ]);
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
    // The report-missing intercept answers by NAME, so it must be gated on
    // the feature actually being on — otherwise a customer's own
    // get_more_tools tool would be unreachable with the feature disabled.
    // (When enabled, AgentCat answers even for a customer-owned name; the
    // listing warns once about the shadowing.)
    const interceptReportMissing = (name: any) =>
      data?.options?.enableReportMissing === true &&
      name === GET_MORE_TOOLS_NAME;

    // Tracing off: no resolution, no mint-back, no event.
    if (data && data.options.enableTracing === false) {
      if (interceptReportMissing(request?.params?.name)) {
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
      clientInfo: ServerClientInfoLike | undefined;
    } | null = null;

    if (!data) {
      writeToLog(
        "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
      );
    } else {
      try {
        await ensureRegistries(server, extra);
        // A session_id is the customer's only when their own schema declared
        // it — recorded at the collision site during listing. Everything else
        // is ours, including tools we skipped for schema shape
        // (oneOf/allOf/anyOf), which carry no injection record but no
        // customer session_id either. A tool never seen in any listing is
        // likewise ours, so a pre-listing call still validates (spec:
        // degrades to `invalid`, not `foreign`).
        const toolName = request?.params?.name;
        const sessionParamIsOurs = !(
          toolName && getDeclaredSessionParams(data).has(toolName)
        );

        const resolution = resolveHandles(
          data.options,
          data.projectId || undefined,
          request,
          extra,
          sessionParamIsOurs,
        );
        const clientInfo = getClientInfoForRequest(server, request, extra);

        // Fire the customer hooks NOW, awaited only in the background event
        // pipeline — a slow or hanging hook can never hold up the tool call.
        // Each invocation yields a non-rejecting promise (the internal.ts
        // resolvers catch everything; invokeSessionHook contains sync throws
        // with its rejection handler attached at creation), so leaving them
        // un-awaited cannot surface an unhandled rejection. Hooks receive the
        // raw request: injected params are visible to them by contract.
        const pending: PendingEventFields = {};
        if (resolution.hookMode) {
          pending.sessionHookValue = invokeSessionHook(
            data.options,
            request,
            extra,
          );
        }
        if (data.options.identify) {
          pending.identity = resolveIdentity(data, request, extra);
        }
        if (data.options.eventTags) {
          pending.tags = resolveEventTags(data, request, extra);
        }
        if (data.options.eventProperties) {
          pending.properties = resolveEventProperties(data, request, extra);
        }

        const event: UnredactedEvent = {
          sessionId: resolution.sessionId,
          resourceName: request?.params?.name || "Unknown Tool",
          // Raw request on purpose: the event records exactly what the agent
          // sent, handles included. Stripping applies only to the handler copy.
          // extra is projected at capture time: v2's live web Request (and
          // v1's URL instance) become plain JSON the pipeline walkers can
          // traverse — headers would otherwise flatten to {}. Contract: the
          // redactEvent hook sees this projection, i.e. what ships.
          parameters: { request, extra: projectExtraForEvent(extra) },
          eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
          timestamp: startTime,
          redactionFn: data.options.redactSensitiveInformation,
        };
        if (Object.keys(pending).length > 0) event.pending = pending;

        // On-path tags are SDK-owned only. Customer eventTags resolve in the
        // background and merge UNDER these (SDK tags stay last-writer).
        event.tags = {
          ...mrtrContinuationTags(extra),
          ...buildHandleTags(resolution, getProtocolVersion(request, extra)),
        };

        if (
          data.options.enableToolCallContext &&
          request?.params?.name !== GET_MORE_TOOLS_NAME &&
          request?.params?.arguments &&
          typeof request.params.arguments === "object" &&
          "context" in request.params.arguments
        ) {
          event.userIntent = request.params.arguments.context;
        }

        tracing = { event, resolution, clientInfo };
      } catch (error) {
        writeToLog(
          `Warning: AgentCat tracing failed for tool ${request?.params?.name}, falling back to original handler - ${error}`,
        );
      }
    }

    // Degraded path: run the tool unstripped — no event, no mint-back.
    if (!tracing) {
      if (interceptReportMissing(request?.params?.name)) {
        return handleReportMissing({
          context: request?.params?.arguments?.context,
        });
      }
      return originalHandler(request, extra);
    }

    const { event, resolution, clientInfo } = tracing;

    const finish = (result: any) => {
      // The handler has already succeeded: nothing in this stage may reach
      // the client as an error. Any failure here forfeits decoration and
      // analytics for this call and returns the customer's result untouched.
      try {
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
        publishEvent(server, event, { clientInfo });
        return finalResult;
      } catch (error) {
        writeToLog(
          `Warning: AgentCat post-handler processing failed for tool ${request?.params?.name}; returning the customer's result untouched - ${error}`,
        );
        return result;
      }
    };

    try {
      if (interceptReportMissing(request?.params?.name)) {
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
      publishEvent(server, event, { clientInfo });
      throw error;
    }
  };

  st.callWrapper = wrapper;
  handlers.set("tools/call", wrapper);
}
