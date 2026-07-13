import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  HighLevelMCPServerLike,
  MCPServerLike,
  UnredactedEvent,
  RegisteredTool,
  CompatibleRequestHandlerExtra,
} from "../types.js";
import { writeToLog } from "./logging.js";
import {
  getServerTrackingData,
  handleIdentify,
  resolveEventTags,
  resolveEventProperties,
} from "./internal.js";
import { getServerSessionId } from "./session.js";
import { bindRedactionContext } from "./redaction.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { publishEvent } from "./eventQueue.js";
import { handleReportMissing } from "./tools.js";
import { setupInitializeTracing, setupListToolsTracing } from "./tracing.js";
import { captureException } from "./exceptions.js";
import {
  getToolFunction,
  hasToolFunction,
  createWrappedTool,
  getObjectShape,
  getLiteralValue,
} from "./mcp-sdk-compat.js";

// WeakMap to track which callbacks have already been wrapped
const wrappedCallbacks = new WeakMap<Function, boolean>();

// Symbol to mark tools that have already been processed
const AGENTCAT_PROCESSED = Symbol("__agentcat_processed__");

function isToolResultError(result: any): boolean {
  return result && typeof result === "object" && result.isError === true;
}

function addTracingToToolRegistry(
  tools: Record<string, RegisteredTool>,
  server: HighLevelMCPServerLike,
): Record<string, RegisteredTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => [
      name,
      addTracingToToolCallbackInternal(tool, name, server),
    ]),
  );
}

function setupListenerToRegisteredTools(server: HighLevelMCPServerLike): void {
  try {
    const data = getServerTrackingData(server.server as MCPServerLike);
    if (!data) {
      writeToLog("Warning: Cannot setup listener - no tracking data found");
      return;
    }

    // Create a proxy handler for the _registeredTools object
    const handler: ProxyHandler<Record<string, RegisteredTool>> = {
      set(
        target: Record<string, RegisteredTool>,
        property: string | symbol,
        value: RegisteredTool,
      ): boolean {
        try {
          // Check if this is a tool being registered (has callback or handler property)
          if (
            typeof property === "string" &&
            value &&
            typeof value === "object" &&
            hasToolFunction(value)
          ) {
            // Check if tool has already been processed
            if ((value as any)[AGENTCAT_PROCESSED]) {
              writeToLog(
                `Tool ${String(property)} already processed, skipping proxy wrapping`,
              );
              // Just set the value without processing
              return Reflect.set(target, property, value);
            }

            // Check if callback/handler is already wrapped
            if (wrappedCallbacks.has(getToolFunction(value))) {
              writeToLog(
                `Tool ${String(property)} callback already wrapped, skipping proxy wrapping`,
              );
              // Just set the value without processing
              return Reflect.set(target, property, value);
            }

            // Apply tracing to the callback (context injection happens in setupListToolsTracing)
            value = addTracingToToolCallbackInternal(value, property, server);

            // After adding a tool, try to set up list tools tracing
            // This handles the case where track() is called before tools are registered
            setupListToolsTracing(server);

            // If the tool has an update method, wrap it to handle callback updates
            if (typeof value.update === "function") {
              const originalUpdate = value.update;
              value.update = function (...updateArgs: any[]) {
                // If callback is being updated, wrap the new callback
                // Note: MCP SDK's update() method API uses "callback" property in its interface
                if (updateArgs[0]) {
                  const updateObj = updateArgs[0];
                  if (
                    updateObj.callback &&
                    typeof updateObj.callback === "function"
                  ) {
                    const wrappedTool = addTracingToToolCallbackInternal(
                      { callback: updateObj.callback } as RegisteredTool,
                      property,
                      server,
                    );
                    updateObj.callback = getToolFunction(wrappedTool);
                  }
                }
                return originalUpdate.apply(this, updateArgs);
              };
            }
          }

          // Use Reflect to perform the actual property set
          return Reflect.set(target, property, value);
        } catch (error) {
          writeToLog(
            `Warning: Error in proxy set handler for tool ${String(property)} - ${error}`,
          );
          // Fall back to default behavior on error
          return Reflect.set(target, property, value);
        }
      },

      get(
        target: Record<string, RegisteredTool>,
        property: string | symbol,
      ): any {
        return Reflect.get(target, property);
      },

      deleteProperty(
        target: Record<string, RegisteredTool>,
        property: string | symbol,
      ): boolean {
        return Reflect.deleteProperty(target, property);
      },

      has(
        target: Record<string, RegisteredTool>,
        property: string | symbol,
      ): boolean {
        return Reflect.has(target, property);
      },
    };

    // Replace _registeredTools with a proxied version
    const originalTools = server._registeredTools || {};
    server._registeredTools = new Proxy(originalTools, handler);

    writeToLog("Successfully set up listener for new tool registrations");
  } catch (error) {
    writeToLog(
      `Warning: Failed to setup listener for registered tools - ${error}`,
    );
  }
}

function addTracingToToolCallbackInternal(
  tool: RegisteredTool,
  toolName: string,
  _server: HighLevelMCPServerLike,
): RegisteredTool {
  const originalCallback = getToolFunction(tool);

  if (wrappedCallbacks.has(originalCallback)) {
    writeToLog(`Tool ${toolName} callback already wrapped, skipping re-wrap`);
    return tool;
  }

  if ((tool as any)[AGENTCAT_PROCESSED]) {
    writeToLog(`Tool ${toolName} already processed, skipping re-wrap`);
    return tool;
  }

  const wrappedCallback = async function (
    ...params: any[]
  ): Promise<CallToolResult> {
    let args: any;
    let extra: CompatibleRequestHandlerExtra;

    if (params.length === 2) {
      args = params[0];
      extra = params[1];
    } else {
      args = undefined;
      extra = params[0];
    }

    const removeContextFromArgs = (args: any): any => {
      if (args && typeof args === "object" && "context" in args) {
        const { context: _context, ...argsWithoutContext } = args;
        return argsWithoutContext;
      }
      return args;
    };

    const cleanedArgs =
      toolName === "get_more_tools" ? args : removeContextFromArgs(args);

    try {
      if (cleanedArgs === undefined) {
        const handler = originalCallback as (
          extra: CompatibleRequestHandlerExtra,
        ) => Promise<CallToolResult>;
        return await handler(extra);
      } else {
        const handler = originalCallback as (
          args: any,
          extra: CompatibleRequestHandlerExtra,
        ) => Promise<CallToolResult>;
        return await handler(cleanedArgs, extra);
      }
    } catch (error) {
      if (error instanceof Error) {
        (extra as any).__agentcat_error = error;
      }
      throw error;
    }
  };

  // Mark the original callback as wrapped
  wrappedCallbacks.set(originalCallback, true);

  // Mark the wrapped callback as well (in case it gets re-wrapped)
  wrappedCallbacks.set(wrappedCallback, true);

  // Create a new tool object with the wrapped callback, preserving the property name
  const wrappedTool = createWrappedTool(tool, wrappedCallback);

  // Mark the tool as processed
  (wrappedTool as any)[AGENTCAT_PROCESSED] = true;

  return wrappedTool;
}

function setupToolsCallHandlerWrapping(server: HighLevelMCPServerLike): void {
  const lowLevelServer = server.server as MCPServerLike;

  // Check if tools/call handler already exists
  const existingHandler = lowLevelServer._requestHandlers.get("tools/call");
  if (existingHandler) {
    const wrappedHandler = createToolsCallWrapper(
      existingHandler,
      lowLevelServer,
    );
    lowLevelServer._requestHandlers.set("tools/call", wrappedHandler);
  }

  // Intercept future calls to setRequestHandler for tools registered after track()
  const originalSetRequestHandler =
    lowLevelServer.setRequestHandler.bind(lowLevelServer);

  lowLevelServer.setRequestHandler = function (
    requestSchema: any,
    handler: any,
  ) {
    const shape = getObjectShape(requestSchema);
    const method = shape?.method ? getLiteralValue(shape.method) : undefined;

    // Only wrap tools/call handler
    if (method === "tools/call") {
      const wrappedHandler = createToolsCallWrapper(handler, lowLevelServer);
      return originalSetRequestHandler(requestSchema, wrappedHandler);
    }

    // Pass through all other handlers unchanged
    return originalSetRequestHandler(requestSchema, handler);
  } as any;
}

function createToolsCallWrapper(
  originalHandler: any,
  server: MCPServerLike,
): any {
  return async (request: any, extra: any) => {
    const startTime = new Date();
    let shouldPublishEvent = false;
    let event: UnredactedEvent | null = null;

    try {
      const data = getServerTrackingData(server);

      if (!data) {
        writeToLog(
          "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
        );
      } else {
        shouldPublishEvent = true;

        const sessionId = getServerSessionId(server, extra);

        event = {
          sessionId,
          resourceName: request.params?.name || "Unknown Tool",
          parameters: { request, extra },
          eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
          timestamp: startTime,
          redactionFn: bindRedactionContext(
            data.options.redactSensitiveInformation,
            { request, extra, toolName: request.params?.name },
          ),
        };

        // Identify user session
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

        // Extract context for userIntent
        if (
          data.options.enableToolCallContext &&
          request.params?.arguments?.context
        ) {
          event.userIntent = request.params.arguments.context;
        }
      }
    } catch (error) {
      // If tracing setup fails, log it but continue with tool execution
      writeToLog(
        `Warning: AgentCat tracing failed for tool ${request.params?.name}, falling back to original handler - ${error}`,
      );
    }

    // If this is get_more_tools, handle it directly without relying on server registration
    if (request?.params?.name === "get_more_tools") {
      try {
        const result = await handleReportMissing({
          context: request?.params?.arguments?.context,
        });

        if (event && shouldPublishEvent) {
          event.userIntent = request?.params?.arguments?.context;
          event.response = result;
          event.duration = new Date().getTime() - startTime.getTime();
          publishEvent(server, event);
        }
        return result;
      } catch (error) {
        if (event && shouldPublishEvent) {
          event.isError = true;
          event.error = captureException(error);
          event.duration = new Date().getTime() - startTime.getTime();
          publishEvent(server, event);
        }
        throw error;
      }
    }

    // Execute other tools (even if tracing setup failed)
    try {
      const result = await originalHandler(request, extra);

      if (event && shouldPublishEvent) {
        // Check for execution errors (SDK converts them to CallToolResult)
        if (isToolResultError(result)) {
          event.isError = true;

          // Check if callback captured the original error (has full stack)
          const capturedError = (extra as any).__agentcat_error;

          if (capturedError) {
            // Use captured error from callback
            event.error = captureException(capturedError);
            delete (extra as any).__agentcat_error; // Cleanup
          } else {
            // SDK 1.21.0+ converted error (no stack trace available)
            event.error = captureException(result);
          }
        }

        event.response = result;
        event.duration = new Date().getTime() - startTime.getTime();
        publishEvent(server, event);
      }

      return result;
    } catch (error) {
      // Validation errors, unknown tool, disabled tool
      if (event && shouldPublishEvent) {
        event.isError = true;
        event.error = captureException(error);
        event.duration = new Date().getTime() - startTime.getTime();
        publishEvent(server, event);
      }

      // Re-throw so Protocol converts to JSONRPC error response
      throw error;
    }
  };
}

export function setupTracking(server: HighLevelMCPServerLike): void {
  try {
    const _agentcatData = getServerTrackingData(server.server);

    // Setup handler wrapping before any tools are registered
    setupToolsCallHandlerWrapping(server);

    setupInitializeTracing(server);

    // Modify existing callbacks to include tracing and publishing events
    // This now includes get_more_tools if it was added
    server._registeredTools = addTracingToToolRegistry(
      server._registeredTools,
      server,
    );

    setupListToolsTracing(server);

    // Proxy the high level server's registered tools to ensure new tools are injected with tracing
    // Note: Context parameter injection now happens in setupListToolsTracing (after JSON Schema conversion)
    setupListenerToRegisteredTools(server);
  } catch (error) {
    writeToLog(`Warning: Failed to setup tool call tracing - ${error}`);
  }
}
