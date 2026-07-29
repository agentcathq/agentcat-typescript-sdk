import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AgentCatData,
  HighLevelMCPServerLike,
  MCPServerLike,
  UnredactedEvent,
  RegisteredTool,
  CompatibleRequestHandlerExtra,
} from "../types.js";
import { writeToLog } from "./logging.js";
import {
  getServerTrackingData,
  resolveIdentity,
  resolveEventTags,
  resolveEventProperties,
} from "./internal.js";
import {
  resolveHandles,
  cloneRequestWithoutHandles,
  stripHandles,
  stampHandlesOnEvent,
  appendMintBack,
  ResolvedHandles,
  HandleOwnership,
} from "./handles.js";
import { declaredHandleParam } from "./handle-parameters.js";
import { PublishEventRequestEventTypeEnum } from "agentcat-api";
import { publishEvent } from "./eventQueue.js";
import { handleReportMissing } from "./tools.js";
import { setupListToolsTracing } from "./tracing.js";
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

/**
 * Whether the called tool owns `task_id`/`agent_id` itself.
 *
 * The high-level registry is exact and needs no cached state, so it is asked
 * first — and it answers with the parameter name, which is what the collision
 * tag records. `handleCollisionTools`, recorded during tools/list, is the
 * fallback for tools the registry cannot answer for; it can only say *that*
 * the tool collides.
 *
 * THE single ownership authority. Both the tools/call wrapper and the
 * callback wrapper must call this and nothing else: when they disagreed, a
 * schema the registry reader could not parse left the call half-protected —
 * the outer wrapper spared the argument and the inner one still ate it.
 */
function resolveHandleOwnership(
  data: AgentCatData | undefined,
  highLevelServer: HighLevelMCPServerLike | undefined,
  toolName: string | undefined,
): HandleOwnership {
  if (!toolName) return false;
  const registered = highLevelServer?._registeredTools?.[toolName];
  if (registered) {
    const param = declaredHandleParam(registered.inputSchema);
    if (param) return param;
  }
  return data?.handleCollisionTools.has(toolName) ?? false;
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
  server: HighLevelMCPServerLike,
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

    // Never strip a parameter we did not inject: a tool that declares its own
    // task_id/agent_id must receive it intact. Same authority the tools/call
    // wrapper uses — the two must never be able to disagree.
    const ownsHandle = Boolean(
      resolveHandleOwnership(
        server?.server ? getServerTrackingData(server.server) : undefined,
        server,
        toolName,
      ),
    );
    const dropHandles = (a: any): any => (ownsHandle ? a : stripHandles(a));

    const removeInjectedParams = (args: any): any => {
      if (args && typeof args === "object") {
        const { context: _context, ...rest } = args as Record<string, unknown>;
        return dropHandles(rest);
      }
      return args;
    };

    // get_more_tools keeps its own context (its handler needs it) but must
    // still have the handles removed.
    const cleanedArgs =
      toolName === "get_more_tools"
        ? dropHandles(args)
        : removeInjectedParams(args);

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
      server,
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
      const wrappedHandler = createToolsCallWrapper(
        handler,
        lowLevelServer,
        server,
      );
      return originalSetRequestHandler(requestSchema, wrappedHandler);
    }

    // Pass through all other handlers unchanged
    return originalSetRequestHandler(requestSchema, handler);
  } as any;
}

function createToolsCallWrapper(
  originalHandler: any,
  server: MCPServerLike,
  highLevelServer?: HighLevelMCPServerLike,
): any {
  return async (request: any, extra: any) => {
    const startTime = new Date();
    let shouldPublishEvent = false;
    let event: UnredactedEvent | null = null;
    // Hoisted so the return paths below can append the mint-back block.
    let handles: ResolvedHandles | undefined;
    let ownsHandle: HandleOwnership = false;

    try {
      const data = getServerTrackingData(server);

      if (!data) {
        writeToLog(
          "Warning: AgentCat is unable to find server tracking data. Please ensure you have called track(server, options) before using tool calls.",
        );
      } else {
        shouldPublishEvent = true;

        ownsHandle = resolveHandleOwnership(
          data,
          highLevelServer,
          request.params?.name,
        );
        if (ownsHandle) {
          writeToLog(
            `WARN: Tool "${request.params?.name}" declares its own '${
              typeof ownsHandle === "string" ? ownsHandle : "task_id/agent_id"
            }' parameter. AgentCat will not extract, strip, or mint-back handles for this call.`,
          );
        }

        handles = await resolveHandles(data, request, extra, ownsHandle);

        event = {
          sessionId: handles.taskId,
          resourceName: request.params?.name || "Unknown Tool",
          parameters: { request, extra },
          eventType: PublishEventRequestEventTypeEnum.mcpToolsCall,
          timestamp: startTime,
          redactionFn: data.options.redactSensitiveInformation,
        };

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

    // Two reasons to pass the request straight through: the tool owns the
    // parameter (never touch what we did not inject), or handle resolution
    // never ran at all (untracked server / tracing setup threw), in which case
    // AgentCat must be transparent rather than half-applied.
    const applyHandles = Boolean(handles) && !ownsHandle;
    const finalize = (result: any): any =>
      applyHandles ? appendMintBack(result, handles!) : result;
    const delegatedRequest = applyHandles
      ? cloneRequestWithoutHandles(request)
      : request;

    // If this is get_more_tools, handle it directly without relying on server registration
    if (request?.params?.name === "get_more_tools") {
      try {
        const result = await handleReportMissing({
          context: request?.params?.arguments?.context,
        });
        const finalResult = finalize(result);

        if (event && shouldPublishEvent) {
          event.userIntent = request?.params?.arguments?.context;
          event.response = finalResult;
          event.duration = new Date().getTime() - startTime.getTime();
          publishEvent(server, event);
        }
        return finalResult;
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
      const result = await originalHandler(delegatedRequest, extra);
      const finalResult = finalize(result);

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

        event.response = finalResult;
        event.duration = new Date().getTime() - startTime.getTime();
        publishEvent(server, event);
      }

      return finalResult;
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
