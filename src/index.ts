// Import our minimal interface from types
import {
  MCPCatOptions,
  MCPCatData,
  UserIdentity,
  MCPServerLike,
  HighLevelMCPServerLike,
  CustomEventData,
  UnredactedEvent,
} from "./types.js";

// Import from modules
import {
  isCompatibleServerType,
  isHighLevelServer,
} from "./modules/compatibility.js";
import { writeToLog } from "./modules/logging.js";
import { setupMCPCatTools } from "./modules/tools.js";
import { setupToolCallTracing } from "./modules/tracing.js";
import {
  getSessionInfo,
  newSessionId,
  deriveSessionIdFromMCPSession,
} from "./modules/session.js";
import {
  setServerTrackingData,
  getServerTrackingData,
} from "./modules/internal.js";
import { setupTracking } from "./modules/tracingV2.js";
import { TelemetryManager } from "./modules/telemetry.js";
import {
  setTelemetryManager,
  publishEvent as publishEventToQueue,
} from "./modules/eventQueue.js";
import { AGENTCAT_CUSTOM_EVENT_TYPE } from "./modules/constants.js";
import { validateTags } from "./modules/validation.js";
import { eventQueue } from "./modules/eventQueue.js";
import { initDiagnostics } from "./modules/diagnostics.js";

/**
 * Integrates MCPCat analytics into an MCP server to track tool usage patterns and user interactions.
 *
 * @param server - The MCP server instance to track. Must be a compatible MCP server implementation.
 * @param projectId - Your MCPCat project ID obtained from mcpcat.io when creating an account. Pass null for telemetry-only mode.
 * @param options - Optional configuration to customize tracking behavior.
 * @param options.enableReportMissing - Adds a "get_more_tools" tool that allows LLMs to automatically report missing functionality.
 * @param options.enableTracing - Enables tracking of tool calls and usage patterns.
 * @param options.enableToolCallContext - Injects a "context" parameter to existing tools to capture user intent.
 * @param options.customContextDescription - Custom description for the injected context parameter. Only applies when enableToolCallContext is true. Use this to provide domain-specific guidance to LLMs about what context they should provide.
 * @param options.identify - Async function to identify users and attach custom data to their sessions.
 * @param options.redactSensitiveInformation - Function to redact sensitive data before sending to MCPCat.
 * @param options.eventTags - Callback invoked on every auto-captured event (tool calls, tool lists, initialize) to attach string key-value tags. Tags are intended to be indexed and queryable in the MCPCat dashboard — use them for structured metadata you'll want to filter or group by (e.g., trace IDs, environments, regions). Tags are validated client-side: keys must be ≤32 chars matching `[a-zA-Z0-9$_.:\- ]`, values must be strings ≤200 chars with no newlines, max 50 entries per event. Invalid entries are silently dropped with a warning logged to `~/mcpcat.log`. If the callback throws or returns null, tags are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.eventProperties - Callback invoked on every auto-captured event to attach flexible JSON metadata (device info, feature flags, nested context). No constraints beyond standard JSON types. If the callback throws or returns null, properties are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.apiBaseUrl - Custom API base URL for sending events. Falls back to the `AGENTCAT_API_URL` environment variable if not set (then legacy `MCPCAT_API_URL`), then to the default `https://api.agentcat.com`.
 * @param options.disableDiagnostics - Disables MCPCat's internal SDK diagnostics (anonymous error/telemetry reporting used to monitor SDK setup failures). Diagnostics are on by default, automatically disabled in test environments (`VITEST`, `JEST_WORKER_ID`, or `NODE_ENV=test`), and can also be disabled with the `DISABLE_DIAGNOSTICS` environment variable. Local `~/mcpcat.log` logging is unaffected.
 * @param options.exporters - Configure telemetry exporters to send events to external systems. Available exporters:
 *   - `otlp`: OpenTelemetry Protocol exporter (see {@link ../modules/exporters/otlp.OTLPExporter})
 *   - `datadog`: Datadog APM exporter (see {@link ../modules/exporters/datadog.DatadogExporter})
 *   - `sentry`: Sentry Monitoring exporter (see {@link ../modules/exporters/sentry.SentryExporter})
 *
 * @returns The tracked server instance.
 *
 * @remarks
 * Analytics data and debug information are logged to `~/mcpcat.log` since console logs interfere
 * with STDIO-based MCP servers.
 *
 * Do not call `track()` multiple times on the same server instance as this will cause unexpected behavior.
 *
 * @example
 * ```typescript
 * import * as mcpcat from "mcpcat";
 *
 * const mcpServer = new Server({ name: "my-mcp-server", version: "1.0.0" });
 *
 * // Track the server with MCPCat
 * mcpcat.track(mcpServer, "proj_abc123xyz");
 *
 * // Register your tools
 * mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
 *   tools: [{ name: "my_tool", description: "Does something useful" }]
 * }));
 * ```
 *
 * @example
 * ```typescript
 * // With user identification
 * mcpcat.track(mcpServer, "proj_abc123xyz", {
 *   identify: async (request, extra) => {
 *     const user = await getUserFromToken(request.params.arguments.token);
 *     return {
 *       userId: user.id,
 *       userData: { plan: user.plan, company: user.company }
 *     };
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With custom context description
 * mcpcat.track(mcpServer, "proj_abc123xyz", {
 *   enableToolCallContext: true,
 *   customContextDescription: "Explain why you're calling this tool and what business objective it helps achieve"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With sensitive data redaction
 * mcpcat.track(mcpServer, "proj_abc123xyz", {
 *   redactSensitiveInformation: async (text) => {
 *     return text.replace(/api_key_\w+/g, "[REDACTED]");
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With event tags and properties
 * mcpcat.track(mcpServer, "proj_abc123xyz", {
 *   eventTags: async (request, extra) => ({
 *     trace_id: extra?.requestContext?.traceId,
 *     env: process.env.NODE_ENV,
 *     region: "us-east-1",
 *   }),
 *   eventProperties: async (request, extra) => ({
 *     device: "desktop",
 *     app_version: "2.1.0",
 *     feature_flags: ["dark_mode", "beta_ui"],
 *   }),
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Telemetry-only mode (no MCPCat account required)
 * mcpcat.track(mcpServer, null, {
 *   exporters: {
 *     otlp: {
 *       type: "otlp",
 *       endpoint: "http://localhost:4318/v1/traces"
 *     }
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Dual mode - send to both MCPCat and telemetry exporters
 * mcpcat.track(mcpServer, "proj_abc123xyz", {
 *   exporters: {
 *     datadog: {
 *       type: "datadog",
 *       apiKey: process.env.DD_API_KEY,
 *       site: "datadoghq.com"
 *     }
 *   }
 * });
 * ```
 */
function track(
  server: any,
  projectId: string | null,
  options: MCPCatOptions = {},
): any {
  try {
    initDiagnostics({
      projectId,
      disabled: options.disableDiagnostics,
    });

    const validatedServer = isCompatibleServerType(server);

    // Resolve API base URL: option > env var > default
    const apiBaseUrl =
      options.apiBaseUrl ||
      process.env.AGENTCAT_API_URL ||
      process.env.MCPCAT_API_URL;
    if (apiBaseUrl) {
      eventQueue.configure(apiBaseUrl);
    }

    // For high-level servers, we need to pass the underlying server to some functions
    const isHighLevel = isHighLevelServer(validatedServer);
    const lowLevelServer = (
      isHighLevel ? (validatedServer as any).server : validatedServer
    ) as MCPServerLike;

    // Setup-started beacon. Guarantees every install emits at least one
    // diagnostic tied to its project id, and anchors any later setup failure.
    writeToLog(
      `MCPCat setup started | project ${projectId || "(telemetry-only)"} | server ${isHighLevel ? "high-level" : "low-level"}`,
    );

    // Check if server is already being tracked
    const existingData = getServerTrackingData(lowLevelServer);
    if (existingData) {
      writeToLog(
        "[SESSION DEBUG] track() - Server already being tracked, skipping initialization",
      );
      return validatedServer;
    }

    // Initialize telemetry if exporters are configured
    if (options.exporters) {
      const telemetryManager = new TelemetryManager(options.exporters);
      setTelemetryManager(telemetryManager);
      writeToLog(
        `Initialized telemetry with ${Object.keys(options.exporters).length} exporters`,
      );
    }

    // If projectId is null and no exporters, warn the user
    if (!projectId && !options.exporters) {
      writeToLog(
        "Warning: No projectId provided and no exporters configured. Events will not be sent anywhere.",
      );
    }

    const sessionInfo = getSessionInfo(lowLevelServer, undefined);
    const mcpcatData: MCPCatData = {
      projectId: projectId || "", // Use empty string for null projectId
      sessionId: newSessionId(),
      lastActivity: new Date(),
      identifiedSessions: new Map<string, UserIdentity>(),
      sessionInfo,
      options: {
        enableReportMissing: options.enableReportMissing ?? true,
        enableTracing: options.enableTracing ?? true,
        enableToolCallContext: options.enableToolCallContext ?? true,
        customContextDescription: options.customContextDescription,
        identify: options.identify,
        redactSensitiveInformation: options.redactSensitiveInformation,
        eventTags: options.eventTags,
        eventProperties: options.eventProperties,
      },
      sessionSource: "mcpcat", // Initially MCPCat-generated, will change to "mcp" if MCP sessionId is provided in requests
    };

    setServerTrackingData(lowLevelServer, mcpcatData);
    if (isHighLevel) {
      const highLevelServer = validatedServer as HighLevelMCPServerLike;
      setupTracking(highLevelServer);
    } else {
      if (mcpcatData.options.enableReportMissing) {
        try {
          setupMCPCatTools(lowLevelServer);
        } catch (error) {
          writeToLog(`Warning: Failed to setup report missing tool - ${error}`);
        }
      }

      if (mcpcatData.options.enableTracing) {
        try {
          // Pass the low-level server to the current tracing module
          setupToolCallTracing(lowLevelServer);
        } catch (error) {
          writeToLog(`Warning: Failed to setup tool call tracing - ${error}`);
        }
      }
    }

    // Setup-completed beacon. Pairs with the start beacon: start + complete
    // means setup succeeded; start without complete (plus an error) localizes
    // the failure.
    const exporterCount = options.exporters
      ? Object.keys(options.exporters).length
      : 0;
    writeToLog(
      `MCPCat setup complete | project ${projectId || "(telemetry-only)"} | tracing=${mcpcatData.options.enableTracing} context=${mcpcatData.options.enableToolCallContext} reportMissing=${mcpcatData.options.enableReportMissing} exporters=${exporterCount}`,
    );

    return validatedServer;
  } catch (error) {
    writeToLog(`Warning: Failed to track server - ${error}`);
    return server;
  }
}

/**
 * Publishes a custom event to MCPCat with flexible session management.
 *
 * @param serverOrSessionId - Either a tracked MCP server instance or a MCP session ID string
 * @param projectId - Your MCPCat project ID (required)
 * @param eventData - Optional event data to include with the custom event
 *
 * @returns Promise that resolves when the event is queued for publishing
 *
 * @example
 * ```typescript
 * // With a tracked server
 * await mcpcat.publishCustomEvent(
 *   server,
 *   "proj_abc123xyz",
 *   {
 *     resourceName: "custom-action",
 *     parameters: { action: "user-feedback", rating: 5 },
 *     message: "User provided feedback"
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // With a MCP session ID
 * await mcpcat.publishCustomEvent(
 *   "user-session-12345",
 *   "proj_abc123xyz",
 *   {
 *     isError: true,
 *     error: { message: "Custom error occurred", code: "ERR_001" }
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * await mcpcat.publishCustomEvent(
 *   server,
 *   "proj_abc123xyz",
 *   {
 *     resourceName: "feature-usage",
 *   }
 * );
 * ```
 */
export async function publishCustomEvent(
  serverOrSessionId: any | string,
  projectId: string,
  eventData?: CustomEventData,
): Promise<void> {
  // Validate required parameters
  if (!projectId) {
    throw new Error("projectId is required for publishCustomEvent");
  }

  let sessionId: string;

  // Determine if the first parameter is a tracked server or a session ID string
  const isServer =
    typeof serverOrSessionId === "object" && serverOrSessionId !== null;
  let lowLevelServer: MCPServerLike | null = null;

  if (isServer) {
    // Try to get tracking data for the server
    lowLevelServer = serverOrSessionId.server
      ? serverOrSessionId.server
      : serverOrSessionId;
    const trackingData = getServerTrackingData(lowLevelServer as MCPServerLike);

    if (trackingData) {
      // Use the tracked server's session ID and configuration
      sessionId = trackingData.sessionId;
    } else {
      // Server is not tracked - treat it as an error
      throw new Error(
        "Server is not tracked. Please call mcpcat.track() first or provide a session ID string.",
      );
    }
  } else if (typeof serverOrSessionId === "string") {
    // Custom session ID provided - derive a deterministic session ID
    sessionId = deriveSessionIdFromMCPSession(serverOrSessionId, projectId);
  } else {
    throw new Error(
      "First parameter must be either an MCP server object or a session ID string",
    );
  }

  // Build the event object
  const event: UnredactedEvent = {
    // Core fields
    sessionId,
    projectId,

    // Fixed event type for custom events
    eventType: AGENTCAT_CUSTOM_EVENT_TYPE,

    // Timestamp
    timestamp: new Date(),

    // Event data from parameters
    resourceName: eventData?.resourceName,
    parameters: eventData?.parameters,
    response: eventData?.response,
    userIntent: eventData?.message,
    duration: eventData?.duration,
    isError: eventData?.isError,
    error: eventData?.error,
  };

  // Wire up customer-defined metadata
  if (eventData?.tags) {
    event.tags = validateTags(eventData.tags);
  }
  if (eventData?.properties && Object.keys(eventData.properties).length > 0) {
    event.properties = eventData.properties;
  }

  // If we have a tracked server, use the publishEvent function
  // Otherwise, add directly to the event queue
  if (lowLevelServer && getServerTrackingData(lowLevelServer)) {
    publishEventToQueue(lowLevelServer, event);
  } else {
    // For custom sessions, we need to import and use the event queue directly
    eventQueue.add(event);
  }

  writeToLog(
    `Published custom event for session ${sessionId} with type 'agentcat:custom'`,
  );
}

export type {
  MCPCatOptions,
  UserIdentity,
  RedactFunction,
  ExporterConfig,
  Exporter,
  CustomEventData,
} from "./types.js";

export type IdentifyFunction = MCPCatOptions["identify"];

export { track };
