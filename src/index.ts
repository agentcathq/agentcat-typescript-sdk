// Import our minimal interface from types
import {
  AgentCatOptions,
  AgentCatData,
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
import { setupAgentCatTools } from "./modules/tools.js";
import { setupToolCallTracing } from "./modules/tracing.js";
import { getSessionInfo } from "./modules/session.js";
import { deriveTaskId } from "./modules/handles.js";
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
 * Integrates AgentCat analytics into an MCP server to track tool usage patterns and user interactions.
 *
 * @param server - The MCP server instance to track. Must be a compatible MCP server implementation.
 * @param projectId - Your AgentCat project ID obtained from agentcat.com when creating an account. Pass null for telemetry-only mode.
 * @param options - Optional configuration to customize tracking behavior.
 * @param options.enableReportMissing - Adds a "get_more_tools" tool that allows LLMs to automatically report missing functionality.
 * @param options.enableTracing - Enables tracking of tool calls and usage patterns. Also gates handle injection: when false, `task_id`/`agent_id` are not added to tool schemas.
 * @param options.enableAgentTracking - Injects an optional `agent_id` handle alongside `task_id` so subagents can be told apart within a single task. Each agent omits `agent_id` on its first call and is issued its own, while one `task_id` is shared by every agent working the same goal. Defaults to true. Set false to drop `agent_id` from tool schemas, from the `agentcat_agent_id` / `agentcat_agent_id_source` event tags, and from the mint-back instructions entirely; `task_id` is unaffected.
 * @param options.enableToolCallContext - Injects a "context" parameter to existing tools to capture user intent.
 * @param options.resolveTaskId - Callback returning your own correlation identifier for a request (a workflow id, a ticket id). The returned string is trimmed and combined with your project ID into a deterministic KSUID, so the same identifier always maps to the same Task ID across processes and restarts. Takes precedence over an agent-supplied `task_id`. Return null or an empty string — or throw — to fall back to the agent-supplied value, then to a freshly minted one. Runs on every tool call and receives the same `(request, extra)` arguments as `identify`. Note that the returned value is always derived, even if it already looks like a `ses_`-prefixed handle.
 * @param options.customContextDescription - Custom description for the injected context parameter. Only applies when enableToolCallContext is true. Use this to provide domain-specific guidance to LLMs about what context they should provide.
 * @param options.identify - Async function returning the actor behind a request. Runs on every tool call and the result is stamped on that call's event only — nothing is cached or merged between calls, so return the complete `userData` object each time.
 * @param options.redactSensitiveInformation - Function to redact sensitive data before sending to AgentCat.
 * @param options.redactEvent - Event-level redaction hook invoked with the full event (inspect `resourceName`, `eventType`, `parameters`, `response`, etc.) before it is published. Return a modified event, or null to drop the event entirely. May be sync or async. Runs before `redactSensitiveInformation`, so it sees raw, unredacted values; the string-level hook, sanitization, and truncation still run on its output. The system-managed fields `id`, `sessionId` (the Task ID), `projectId`, `eventType`, and `timestamp` cannot be changed (`id` is assigned after redaction and is empty at hook time). If the hook throws, the event is dropped and the error is logged to `~/agentcat.log`.
 * @param options.eventTags - Callback invoked on every auto-captured event (tool calls) to attach string key-value tags. Tags are intended to be indexed and queryable in the AgentCat dashboard — use them for structured metadata you'll want to filter or group by (e.g., trace IDs, environments, regions). Tags are validated client-side: keys must be ≤32 chars matching `[a-zA-Z0-9$_.:\- ]`, values must be strings ≤200 chars with no newlines, max 50 entries per event. Invalid entries are silently dropped with a warning logged to `~/agentcat.log`. If the callback throws or returns null, tags are omitted. Receives the same `(request, extra)` arguments as `identify`. AgentCat adds its own `agentcat_`-prefixed tags (`agentcat_task_id_source`, `agentcat_agent_id`, `agentcat_agent_id_source`) after your tags are validated, so they neither collide with your keys nor consume your 50-tag budget.
 * @param options.eventProperties - Callback invoked on every auto-captured event to attach flexible JSON metadata (device info, feature flags, nested context). No constraints beyond standard JSON types. If the callback throws or returns null, properties are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.apiBaseUrl - Custom API base URL for sending events. Falls back to the `AGENTCAT_API_URL` environment variable if not set (then legacy `MCPCAT_API_URL`), then to the default `https://api.agentcat.com`.
 * @param options.disableDiagnostics - Disables AgentCat's internal SDK diagnostics (anonymous error/telemetry reporting used to monitor SDK setup failures). Diagnostics are on by default, automatically disabled in test environments (`VITEST`, `JEST_WORKER_ID`, or `NODE_ENV=test`), and can also be disabled with the `DISABLE_DIAGNOSTICS` environment variable. Local `~/agentcat.log` logging is unaffected.
 * @param options.exporters - Configure telemetry exporters to send events to external systems. Available exporters:
 *   - `otlp`: OpenTelemetry Protocol exporter (see {@link ../modules/exporters/otlp.OTLPExporter})
 *   - `datadog`: Datadog APM exporter (see {@link ../modules/exporters/datadog.DatadogExporter})
 *   - `sentry`: Sentry Monitoring exporter (see {@link ../modules/exporters/sentry.SentryExporter})
 *
 * @returns The tracked server instance.
 *
 * @remarks
 * Analytics data and debug information are logged to `~/agentcat.log` since console logs interfere
 * with STDIO-based MCP servers.
 *
 * Do not call `track()` multiple times on the same server instance as this will cause unexpected behavior.
 *
 * @example
 * ```typescript
 * import * as agentcat from "agentcat";
 *
 * const mcpServer = new Server({ name: "my-mcp-server", version: "1.0.0" });
 *
 * // Track the server with AgentCat
 * agentcat.track(mcpServer, "proj_abc123xyz");
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
 * agentcat.track(mcpServer, "proj_abc123xyz", {
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
 * // Task and agent handles
 * //
 * // By default every tool gains optional `task_id` and `agent_id` parameters.
 * // An agent omits them on its first call, the server mints them and appends an
 * // "[MCP INSTRUCTIONS]:" block to the result, and the agent echoes them back on
 * // every later call. AgentCat strips both before your handler runs.
 * agentcat.track(mcpServer, "proj_abc123xyz", {
 *   enableAgentTracking: false, // task_id only, no per-agent handle
 * });
 *
 * // Or correlate by your own identifier instead of the agent-supplied handle
 * agentcat.track(mcpServer, "proj_abc123xyz", {
 *   resolveTaskId: (request, extra) => {
 *     const header = extra?.headers?.["x-workflow-id"];
 *     return typeof header === "string" ? header : null;
 *   },
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With custom context description
 * agentcat.track(mcpServer, "proj_abc123xyz", {
 *   enableToolCallContext: true,
 *   customContextDescription: "Explain why you're calling this tool and what business objective it helps achieve"
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With sensitive data redaction
 * agentcat.track(mcpServer, "proj_abc123xyz", {
 *   redactSensitiveInformation: async (text) => {
 *     return text.replace(/api_key_\w+/g, "[REDACTED]");
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With event-level redaction
 * agentcat.track(mcpServer, "proj_abc123xyz", {
 *   redactEvent: (event) => {
 *     // Drop events from tools that handle secrets entirely
 *     if (event.resourceName === "get_credentials") {
 *       return null;
 *     }
 *     // Strip response payloads from a specific tool
 *     if (event.resourceName === "export_report") {
 *       return { ...event, response: undefined };
 *     }
 *     return event;
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With event tags and properties
 * agentcat.track(mcpServer, "proj_abc123xyz", {
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
 * // Telemetry-only mode (no AgentCat account required)
 * agentcat.track(mcpServer, null, {
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
 * // Dual mode - send to both AgentCat and telemetry exporters
 * agentcat.track(mcpServer, "proj_abc123xyz", {
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
  options: AgentCatOptions = {},
): any {
  try {
    initDiagnostics({
      projectId,
      disabled: options.disableDiagnostics,
    });

    const validatedServer = isCompatibleServerType(server);

    // Resolve API base URL: option > AGENTCAT_API_URL > MCPCAT_API_URL (legacy) > default
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
      `AgentCat setup started | project ${projectId || "(telemetry-only)"} | server ${isHighLevel ? "high-level" : "low-level"}`,
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
    const agentcatData: AgentCatData = {
      projectId: projectId || "", // Use empty string for null projectId
      sessionInfo,
      options: {
        enableReportMissing: options.enableReportMissing ?? true,
        enableTracing: options.enableTracing ?? true,
        enableAgentTracking: options.enableAgentTracking ?? true,
        enableToolCallContext: options.enableToolCallContext ?? true,
        resolveTaskId: options.resolveTaskId,
        customContextDescription: options.customContextDescription,
        identify: options.identify,
        redactSensitiveInformation: options.redactSensitiveInformation,
        redactEvent: options.redactEvent,
        eventTags: options.eventTags,
        eventProperties: options.eventProperties,
      },
      handleCollisionTools: new Set<string>(),
    };

    setServerTrackingData(lowLevelServer, agentcatData);
    if (isHighLevel) {
      const highLevelServer = validatedServer as HighLevelMCPServerLike;
      setupTracking(highLevelServer);
    } else {
      // Unconditional: this is the ONLY thing that wraps tools/list on the
      // low-level path, and that wrap owns handle injection and collision
      // recording as well as get_more_tools. Gating it on enableReportMissing
      // silently disabled handles for anyone who turned that option off. The
      // get_more_tools descriptor itself stays gated, inside.
      try {
        setupAgentCatTools(lowLevelServer);
      } catch (error) {
        writeToLog(`Warning: Failed to setup tools/list wrapping - ${error}`);
      }

      if (agentcatData.options.enableTracing) {
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
      `AgentCat setup complete | project ${projectId || "(telemetry-only)"} | tracing=${agentcatData.options.enableTracing} context=${agentcatData.options.enableToolCallContext} reportMissing=${agentcatData.options.enableReportMissing} exporters=${exporterCount}`,
    );

    return validatedServer;
  } catch (error) {
    writeToLog(`Warning: Failed to track server - ${error}`);
    return server;
  }
}

/** Prefix `newTaskId` mints Task IDs with. */
const TASK_ID_PREFIX = "ses_";

/**
 * A Task ID supplied by a customer, normalised. A value that already looks like
 * a handle this SDK minted (`ses_…`) is used verbatim — that is the intended
 * case, a handle the agent read off a tool call and handed back. Anything else
 * is a customer identifier and gets the same deterministic derivation
 * `resolveHandles` applies to the `resolveTaskId` hook, so custom events
 * correlate with the tool calls made under that same identifier.
 */
function resolveCustomTaskId(id: string, projectId: string): string {
  return id.startsWith(TASK_ID_PREFIX) ? id : deriveTaskId(id, projectId);
}

/**
 * Publishes a custom event to AgentCat.
 *
 * @param serverOrTaskId - Either a tracked MCP server instance or a Task ID string
 * @param projectId - Your AgentCat project ID (required)
 * @param eventData - Optional event data to include with the custom event
 *
 * @returns Promise that resolves when the event is queued for publishing
 *
 * @remarks
 * Handles are resolved per request, so a tracked server carries no ambient Task
 * ID. To correlate a custom event with a task, pass the Task ID — either as the
 * first argument or as `eventData.taskId`, which takes precedence. A value that
 * already looks like a handle this SDK minted (`ses_…`) is used verbatim;
 * anything else is derived exactly as the `resolveTaskId` hook is, so an id a
 * customer already uses for both lines up automatically. Without either, the
 * event is published with no session ID and a warning is logged.
 *
 * Custom events carry no actor unless one is supplied via `eventData.actor`:
 * there is no request to run `identify` against, and identity is never carried
 * between requests.
 *
 * When a tracked server is passed, the `redactEvent` hook configured via `track()`
 * is applied to the custom event before it is published. Events published with a
 * bare Task ID string bypass redaction, since no tracked configuration exists.
 *
 * @example
 * ```typescript
 * // With a tracked server and the Task ID the agent handed back
 * await agentcat.publishCustomEvent(
 *   server,
 *   "proj_abc123xyz",
 *   {
 *     taskId: "ses_2Zx...",
 *     resourceName: "custom-action",
 *     parameters: { action: "user-feedback", rating: 5 },
 *     message: "User provided feedback",
 *     actor: { userId: "user-123", userName: "Ada" }
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // With your own workflow identifier, which correlates with the tool calls
 * // made under the same identifier via `resolveTaskId`
 * await agentcat.publishCustomEvent(
 *   "workflow-12345",
 *   "proj_abc123xyz",
 *   {
 *     isError: true,
 *     error: { message: "Custom error occurred", code: "ERR_001" }
 *   }
 * );
 * ```
 */
export async function publishCustomEvent(
  serverOrTaskId: any | string,
  projectId: string,
  eventData?: CustomEventData,
): Promise<void> {
  // Validate required parameters
  if (!projectId) {
    throw new Error("projectId is required for publishCustomEvent");
  }

  // An explicit taskId always wins, in either call form.
  let sessionId: string | undefined = eventData?.taskId
    ? resolveCustomTaskId(eventData.taskId, projectId)
    : undefined;

  // Determine if the first parameter is a tracked server or a Task ID string
  const isServer =
    typeof serverOrTaskId === "object" && serverOrTaskId !== null;
  let lowLevelServer: MCPServerLike | null = null;

  if (isServer) {
    // Try to get tracking data for the server
    lowLevelServer = serverOrTaskId.server
      ? serverOrTaskId.server
      : serverOrTaskId;

    if (!getServerTrackingData(lowLevelServer as MCPServerLike)) {
      // Server is not tracked - treat it as an error
      throw new Error(
        "Server is not tracked. Please call agentcat.track() first or provide a task ID string.",
      );
    }

    if (!sessionId) {
      // A tracked server carries no ambient session: handles are per request
      // and a custom event has no request to read them from. Publish without a
      // Task ID rather than inventing one that correlates with nothing.
      writeToLog(
        "Warning: publishCustomEvent called with a tracked server and no taskId. Handles are per-request, so the event will be published without a session ID.",
      );
    }
  } else if (typeof serverOrTaskId === "string") {
    sessionId = sessionId || resolveCustomTaskId(serverOrTaskId, projectId);
  } else {
    throw new Error(
      "First parameter must be either an MCP server object or a task ID string",
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

    // Actor, supplied per call — never inherited from another request
    identifyActorGivenId: eventData?.actor?.userId,
    identifyActorName: eventData?.actor?.userName,
    identifyActorData: eventData?.actor?.userData,

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
    `Published custom event for session ${sessionId ?? "(none)"} with type 'agentcat:custom'`,
  );
}

export type {
  AgentCatOptions,
  AgentCatData,
  UserIdentity,
  RedactFunction,
  RedactEventFunction,
  ExporterConfig,
  Exporter,
  CustomEventData,
} from "./types.js";

export { AgentCatIDPrefixes } from "./types.js";

export type IdentifyFunction = AgentCatOptions["identify"];

export { track };
