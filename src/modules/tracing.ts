import {
  CallToolRequestSchema,
  InitializeRequestSchema,
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
  handleIdentify,
  resolveEventTags,
  resolveEventProperties,
} from "./internal.js";
import { getServerSessionId } from "./session.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { publishEvent } from "./eventQueue.js";
import { getMCPCompatibleErrorMessage } from "./compatibility.js";
import { captureException } from "./exceptions.js";
import { addContextParameterToTools } from "./context-parameters.js";
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
      let tools: any[] = [];
      const data = getServerTrackingData(server);
      let event: UnredactedEvent = {
        sessionId: getServerSessionId(server, extra),
        parameters: {
          request: request,
          extra: extra,
        },
        eventType: PublishEventRequestEventTypeEnum.mcpToolsList,
        timestamp: new Date(),
        redactionFn: data?.options.redactSensitiveInformation,
      };
      if (data) {
        await handleIdentify(server, data, request, extra);
        event.sessionId = data.sessionId;
        const resolvedTags = await resolveEventTags(data, request, extra);
        if (resolvedTags) event.tags = resolvedTags;
        const resolvedProperties = await resolveEventProperties(
          data,
          request,
          extra,
        );
        if (resolvedProperties) event.properties = resolvedProperties;
      }
      try {
        const originalResponse = (await originalListToolsHandler(
          request,
          extra,
        )) as ListToolsResult;
        tools = originalResponse.tools || [];

        // Inject context parameters AFTER MCP SDK has converted Zod to JSON Schema
        if (data?.options.enableToolCallContext) {
          tools = addContextParameterToTools(
            tools,
            data.options.customContextDescription,
          );
        }

        // Add get_more_tools tool when enabled
        if (data?.options.enableReportMissing) {
          const alreadyPresent = tools.some(
            (t: any) => t?.name === GET_MORE_TOOLS_NAME,
          );
          if (!alreadyPresent) tools.push(getReportMissingToolDescriptor());
        }
      } catch (error) {
        // If original handler fails, start with empty tools
        writeToLog(
          `Warning: Original list tools handler failed, this suggests an error MCPCat did not cause - ${error}`,
        );
        event.error = { message: getMCPCompatibleErrorMessage(error) };
        event.isError = true;
        event.duration =
          (event.timestamp &&
            new Date().getTime() - event.timestamp.getTime()) ||
          0;
        publishEvent(server, event);
        throw error;
      }

      if (!data) {
        writeToLog(
          "Warning: MCPCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
        );
        return { tools };
      }

      if (tools.length === 0) {
        writeToLog(
          "Warning: No tools found in the original list. This is likely due to the tools not being registered before MCPCat.track().",
        );
        event.error = { message: "No tools were sent to MCP client." };
        event.isError = true;
        event.duration =
          (event.timestamp &&
            new Date().getTime() - event.timestamp.getTime()) ||
          0;
        publishEvent(server, event);
        return { tools };
      }

      event.response = { tools };
      event.isError = false;
      event.duration =
        (event.timestamp && new Date().getTime() - event.timestamp.getTime()) ||
        0;
      publishEvent(server, event);
      return { tools };
    });

    // Mark as setup successful for this server instance
    listToolsTracingSetup.set(server, true);
  } catch (error) {
    writeToLog(`Warning: Failed to override list tools handler - ${error}`);
  }
}

export function setupInitializeTracing(
  highLevelServer: HighLevelMCPServerLike,
): void {
  const server = highLevelServer.server;
  const handlers = server._requestHandlers;
  const originalInitializeHandler = handlers.get("initialize");

  if (originalInitializeHandler) {
    server.setRequestHandler(
      InitializeRequestSchema,
      async (request, extra) => {
        const data = getServerTrackingData(server);
        if (!data) {
          writeToLog(
            "Warning: MCPCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
          );
          return await originalInitializeHandler(request, extra);
        }

        const sessionId = getServerSessionId(server, extra);

        // Try to identify the session
        await handleIdentify(server, data, request, extra);

        let event: UnredactedEvent = {
          sessionId: sessionId,
          resourceName: request.params?.name || "Unknown Tool Name",
          eventType: PublishEventRequestEventTypeEnum.mcpInitialize,
          parameters: {
            request: request,
            extra: extra,
          },
          timestamp: new Date(),
          redactionFn: data.options.redactSensitiveInformation,
        };

        const resolvedTags = await resolveEventTags(data, request, extra);
        if (resolvedTags) event.tags = resolvedTags;
        const resolvedProperties = await resolveEventProperties(
          data,
          request,
          extra,
        );
        if (resolvedProperties) event.properties = resolvedProperties;

        const result = await originalInitializeHandler(request, extra);
        event.response = result;
        publishEvent(server, event);
        return result;
      },
    );
  }
}

export function setupToolCallTracing(server: MCPServerLike): void {
  try {
    const handlers = server._requestHandlers;

    const originalCallToolHandler = handlers.get("tools/call");
    const originalInitializeHandler = handlers.get("initialize");

    if (originalInitializeHandler) {
      server.setRequestHandler(
        InitializeRequestSchema,
        async (request, extra) => {
          const data = getServerTrackingData(server);
          if (!data) {
            writeToLog(
              "Warning: MCPCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
            );
            return await originalInitializeHandler(request, extra);
          }

          const sessionId = getServerSessionId(server, extra);

          // Try to identify the session
          await handleIdentify(server, data, request, extra);

          let event: UnredactedEvent = {
            sessionId: sessionId,
            resourceName: request.params?.name || "Unknown Tool Name",
            eventType: PublishEventRequestEventTypeEnum.mcpInitialize,
            parameters: {
              request: request,
              extra: extra,
            },
            timestamp: new Date(),
            redactionFn: data.options.redactSensitiveInformation,
          };

          const resolvedTags = await resolveEventTags(data, request, extra);
          if (resolvedTags) event.tags = resolvedTags;
          const resolvedProperties = await resolveEventProperties(
            data,
            request,
            extra,
          );
          if (resolvedProperties) event.properties = resolvedProperties;

          const result = await originalInitializeHandler(request, extra);
          event.response = result;
          publishEvent(server, event);
          return result;
        },
      );
    }

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const data = getServerTrackingData(server);
      if (!data) {
        writeToLog(
          "Warning: MCPCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
        );
        return await originalCallToolHandler?.(request, extra);
      }

      const sessionId = getServerSessionId(server, extra);
      let event: UnredactedEvent = {
        sessionId: sessionId,
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
        // Try to identify the session if we haven't already and identify function is provided
        await handleIdentify(server, data, request, extra);

        const resolvedTags = await resolveEventTags(data, request, extra);
        if (resolvedTags) event.tags = resolvedTags;
        const resolvedProperties = await resolveEventProperties(
          data,
          request,
          extra,
        );
        if (resolvedProperties) event.properties = resolvedProperties;

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
          result = await originalCallToolHandler(request, extra);
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

        event.response = result;
        publishEvent(server, event);
        return result;
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
