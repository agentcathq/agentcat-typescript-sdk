import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  HighLevelMCPServerLike,
  MCPServerLike,
  UnredactedEvent,
} from "../types.js";
import { writeToLog } from "./logging.js";
import { handleReportMissing } from "./tools.js";
import {
  getServerTrackingData,
  resolveIdentity,
  resolveEventTags,
  resolveEventProperties,
} from "./internal.js";
import {
  resolveHandles,
  cloneRequestWithoutHandles,
  stampHandlesOnEvent,
  appendMintBack,
  newTaskId,
  ResolvedHandles,
} from "./handles.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { publishEvent } from "./eventQueue.js";
import { captureException } from "./exceptions.js";
import { addContextParameterToTools } from "./context-parameters.js";
import {
  addHandleParametersToTools,
  recordHandleCollisions,
} from "./handle-parameters.js";
import {
  GET_MORE_TOOLS_NAME,
  getReportMissingToolDescriptor,
} from "./tools.js";

function isToolResultError(result: any): boolean {
  return result && typeof result === "object" && result.isError === true;
}

// Track if we've already set up list tools tracing per server instance
const listToolsTracingSetup = new WeakMap<MCPServerLike, boolean>();

export function setupListToolsTracing(
  highLevelServer: HighLevelMCPServerLike,
): void {
  const server = highLevelServer.server;

  // Check if server supports tools capability
  if (!(server as any)._capabilities?.tools) {
    // Server doesn't support tools yet, skip setup
    return;
  }

  // Check if we've already set up tracing for this server instance
  if (listToolsTracingSetup.get(server)) {
    return;
  }

  const handlers = server._requestHandlers;
  const originalListToolsHandler = handlers.get("tools/list");

  // No handler to override yet
  if (!originalListToolsHandler) {
    return;
  }

  try {
    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const data = getServerTrackingData(server);

      const originalResponse = (await originalListToolsHandler(
        request,
        extra,
      )) as ListToolsResult;
      let tools: any[] = originalResponse.tools || [];

      if (!data) {
        writeToLog(
          "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
        );
        return { tools };
      }

      if (tools.length === 0) {
        writeToLog(
          "Warning: No tools found in the original list. This is likely due to the tools not being registered before AgentCat.track().",
        );
        return { tools };
      }

      // get_more_tools is pushed first so handle injection reaches it.
      if (data.options.enableReportMissing) {
        const alreadyPresent = tools.some(
          (t: any) => t?.name === GET_MORE_TOOLS_NAME,
        );
        if (!alreadyPresent) tools.push(getReportMissingToolDescriptor());
      }

      recordHandleCollisions(data, tools);

      if (data.options.enableTracing) {
        tools = addHandleParametersToTools(
          tools,
          data.options.enableAgentTracking ?? true,
        );
      }

      if (data.options.enableToolCallContext) {
        tools = addContextParameterToTools(
          tools,
          data.options.customContextDescription,
        );
      }

      return { tools };
    });

    // Mark as setup successful for this server instance
    listToolsTracingSetup.set(server, true);
  } catch (error) {
    writeToLog(`Warning: Failed to override list tools handler - ${error}`);
  }
}

export function setupToolCallTracing(server: MCPServerLike): void {
  try {
    const handlers = server._requestHandlers;

    const originalCallToolHandler = handlers.get("tools/call");

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const data = getServerTrackingData(server);
      if (!data) {
        writeToLog(
          "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
        );
        return await originalCallToolHandler?.(request, extra);
      }

      // There is no tool registry on this path, so the collision set recorded
      // during tools/list is the only source of truth — and it can only say
      // *that* the tool collides, never which parameter.
      const ownsHandle: boolean = data.handleCollisionTools.has(
        request.params?.name,
      );
      if (ownsHandle) {
        writeToLog(
          `WARN: Tool "${request.params?.name}" declares its own 'task_id/agent_id' parameter. AgentCat will not extract, strip, or mint-back handles for this call.`,
        );
      }

      // Handle resolution must never be able to fail a customer's tool call.
      // tracingV2 gets this from its setup try/catch, which logs and continues
      // to the original handler; this path's try/catch wraps the handler call
      // itself, so the degradation is local: fall back to a freshly minted
      // task rather than propagating.
      let handles: ResolvedHandles;
      try {
        handles = await resolveHandles(data, request, extra, ownsHandle);
      } catch (error) {
        writeToLog(
          `Warning: AgentCat handle resolution failed for tool ${request.params?.name}, minting a task instead - ${error}`,
        );
        handles = { taskId: newTaskId(), taskIdSource: "minted" };
      }

      let event: UnredactedEvent = {
        sessionId: handles.taskId,
        resourceName: request.params?.name || "Unknown Tool Name",
        parameters: {
          request: request,
          extra: extra,
        },
        eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
        timestamp: new Date(),
        redactionFn: data.options.redactSensitiveInformation,
      };

      try {
        // Resolve the actor for this request and stamp it on this event only
        const identity = await resolveIdentity(data, request, extra);
        if (identity) {
          event.identifyActorGivenId = identity.userId;
          event.identifyActorName = identity.userName;
          event.identifyActorData = identity.userData;
        }

        const resolvedTags = await resolveEventTags(data, request, extra);
        if (resolvedTags) event.tags = resolvedTags;
        const resolvedProperties = await resolveEventProperties(
          data,
          request,
          extra,
        );
        if (resolvedProperties) event.properties = resolvedProperties;

        // AFTER the customer's tags, so ours always survive validateTags().
        stampHandlesOnEvent(event, handles);

        // Check for missing context if enableToolCallContext is true and it's not report_missing
        if (
          data.options.enableToolCallContext &&
          request.params?.name !== "get_more_tools"
        ) {
          const hasContext =
            request.params?.arguments &&
            typeof request.params.arguments === "object" &&
            "context" in request.params.arguments;
          if (hasContext) {
            event.userIntent = request.params.arguments.context;
          }
        }

        let result;
        if (request.params?.name === "get_more_tools") {
          result = await handleReportMissing(request.params.arguments.context);
          event.userIntent = request.params.arguments.context;
        } else if (originalCallToolHandler) {
          // A tool that owns the parameter keeps its arguments untouched.
          result = await originalCallToolHandler(
            ownsHandle ? request : cloneRequestWithoutHandles(request),
            extra,
          );
        } else {
          event.isError = true;
          event.error = {
            message: `Tool call handler not found for ${request.params?.name || "unknown"}`,
          };
          event.duration =
            (event.timestamp &&
              new Date().getTime() - event.timestamp.getTime()) ||
            undefined;
          publishEvent(server, event);
          throw new Error(`Unknown tool: ${request.params?.name || "unknown"}`);
        }

        // Check if the result indicates an error
        if (isToolResultError(result)) {
          event.isError = true;
          event.error = captureException(result);
        }

        const finalResult = ownsHandle
          ? result
          : appendMintBack(result, handles);

        event.response = finalResult;
        publishEvent(server, event);
        return finalResult;
      } catch (error) {
        event.isError = true;
        event.error = captureException(error);
        publishEvent(server, event);
        throw error;
      }
    });
  } catch (error) {
    writeToLog(`Warning: Failed to setup tool call tracing - ${error}`);
    throw error;
  }
}
