// Import our minimal interface from types
import {
  AgentCatOptions,
  AgentCatData,
  MCPServerLike,
  CustomEventData,
  UnredactedEvent,
} from "./types.js";

// Import from modules
import { detectServer, describeSignals } from "./detect.js";
import { installEngine } from "./engine/index.js";
import { isCompatibleServerType } from "./modules/compatibility.js";
import { writeToLog } from "./modules/logging.js";
import {
  setServerTrackingData,
  getServerTrackingData,
} from "./modules/internal.js";
import { TelemetryManager } from "./modules/telemetry.js";
import {
  setTelemetryManager,
  getTelemetryManager,
  publishEvent as publishEventToQueue,
  eventQueue,
} from "./modules/eventQueue.js";
import { AGENTCAT_CUSTOM_EVENT_TYPE } from "./modules/constants.js";
import { validateTags } from "./modules/validation.js";
import { initDiagnostics } from "./modules/diagnostics.js";

/**
 * Integrates AgentCat analytics into an MCP server to track tool usage patterns and user interactions.
 *
 * @param server - The MCP server instance to track. Must be a compatible MCP server implementation.
 *   Both TypeScript SDK majors are supported with the same call — `@modelcontextprotocol/sdk` >=1.11 <2
 *   (v1 `Server`/`McpServer`) and `@modelcontextprotocol/server` >=2 <3 (v2 `McpServer`, including
 *   instances built inside `createMcpHandler`/`serveStdio` factories). The SDK major is auto-detected
 *   per server object.
 * @param projectId - Your AgentCat project ID obtained from agentcat.com when creating an account. Pass null for telemetry-only mode.
 * @param options - Optional configuration to customize tracking behavior.
 * @param options.enableReportMissing - Adds a "get_more_tools" tool that allows LLMs to automatically report missing functionality.
 * @param options.enableTracing - Enables tracking of tool calls and usage patterns.
 * @param options.enableToolCallContext - Injects a "context" parameter to existing tools to capture user intent. The context parameter is appended after the injected `session_id`/`agent_id` parameters.
 * @param options.customContextDescription - Custom description for the injected context parameter. Only applies when enableToolCallContext is true. Use this to provide domain-specific guidance to LLMs about what context they should provide.
 * @param options.enableAgentTracking - Injects an optional `agent_id` parameter so each agent (including every spawned subagent) is individually identifiable. Agent IDs are minted by the server on an agent's first call and echoed back on subsequent calls. Defaults to false (opt-in). The agent ID rides on events as the `agentcat_agent_id` tag.
 * @param options.resolveSessionId - Hook mode: supply your own session identifier per request (e.g. from your auth or workflow state) and AgentCat steps back — no `session_id` parameter is injected and no issuance text is prepended to results. The returned string is combined with your project ID into a deterministic KSUID, so the same identifier always maps to the same task. Return null to mint silently (avoid: the agent can never learn a silently minted ID). Receives the same `(request, extra)` arguments as `identify`.
 * @param options.identify - Async function to identify the actor behind a tool call. Runs on every tool call; the result is stamped directly onto that call's event.
 * @param options.redactSensitiveInformation - Function to redact sensitive data before sending to AgentCat.
 * @param options.redactEvent - Event-level redaction hook invoked with the full event (inspect `resourceName`, `eventType`, `parameters`, `response`, etc.) before it is published. Return a modified event, or null to drop the event entirely. May be sync or async. Runs before `redactSensitiveInformation`, so it sees raw, unredacted values; the string-level hook, sanitization, and truncation still run on its output. The system-managed fields `id`, `sessionId`, `projectId`, `eventType`, and `timestamp` cannot be changed (`id` is assigned after redaction and is empty at hook time). If the hook throws, the event is dropped and the error is logged to `~/agentcat.log`.
 * @param options.eventTags - Callback invoked on every auto-captured tool call to attach string key-value tags. Tags are intended to be indexed and queryable in the AgentCat dashboard — use them for structured metadata you'll want to filter or group by (e.g., trace IDs, environments, regions). Tags are validated client-side: keys must be ≤32 chars matching `[a-zA-Z0-9$_.:\- ]`, values must be strings ≤200 chars with no newlines, max 50 entries per event. Invalid entries are silently dropped with a warning logged to `~/agentcat.log`. If the callback throws or returns null, tags are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.eventProperties - Callback invoked on every auto-captured tool call to attach flexible JSON metadata (device info, feature flags, nested context). No constraints beyond standard JSON types. If the callback throws or returns null, properties are omitted. Receives the same `(request, extra)` arguments as `identify`.
 * @param options.apiBaseUrl - Custom API base URL for sending events. Falls back to the `AGENTCAT_API_URL` environment variable if not set (then legacy `MCPCAT_API_URL`), then to the default `https://api.agentcat.com`.
 * @param options.disableDiagnostics - Disables AgentCat's internal SDK diagnostics (anonymous error/telemetry reporting used to monitor SDK setup failures). Diagnostics are on by default, automatically disabled in test environments (`VITEST`, `JEST_WORKER_ID`, or `NODE_ENV=test`), and can also be disabled with the `DISABLE_DIAGNOSTICS` environment variable. Local `~/agentcat.log` logging is unaffected.
 * @param options.exporters - Configure telemetry exporters to send events to external systems. Available exporters:
 *   - `otlp`: OpenTelemetry Protocol exporter (see {@link ../modules/exporters/otlp.OTLPExporter})
 *   - `datadog`: Datadog APM exporter (see {@link ../modules/exporters/datadog.DatadogExporter})
 *   - `sentry`: Sentry Monitoring exporter (see {@link ../modules/exporters/sentry.SentryExporter})
 *   - `posthog`: PostHog analytics exporter (see {@link ../modules/exporters/posthog.PostHogExporter})
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
 * // MCP SDK v2 (@modelcontextprotocol/server) — same call, auto-detected
 * import { McpServer } from "@modelcontextprotocol/server";
 * import { z } from "zod";
 * import * as agentcat from "agentcat";
 *
 * const server = new McpServer(
 *   { name: "my-mcp-server", version: "1.0.0" },
 *   { capabilities: { tools: {} } },
 * );
 *
 * server.registerTool(
 *   "my_tool",
 *   { description: "Does something useful", inputSchema: z.object({ msg: z.string() }) },
 *   async (args) => ({ content: [{ type: "text", text: args.msg }] }),
 * );
 *
 * agentcat.track(server, "proj_abc123xyz");
 * ```
 *
 * @example
 * ```typescript
 * // MCP 2026-07-28 era (createMcpHandler / serveStdio): call track() inside
 * // the factory so every per-request instance is tracked.
 * import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
 * import * as agentcat from "agentcat";
 *
 * const handler = createMcpHandler(() => {
 *   const server = new McpServer({ name: "my-server", version: "1.0.0" }, { capabilities: { tools: {} } });
 *   // register tools...
 *   return agentcat.track(server, "proj_abc123xyz"); // track every per-request instance
 * });
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
 * // With event tags and properties. The `extra` shape is SDK-version-specific:
 * // on v2 it is the SDK's ServerContext ({ sessionId, mcpReq, http }) as shown
 * // here; on v1 it is the SDK's RequestHandlerExtra.
 * agentcat.track(mcpServer, "proj_abc123xyz", {
 *   eventTags: async (request, extra) => ({
 *     request_id: String(extra?.mcpReq?.id ?? ""),
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
    initDiagnostics({ projectId, disabled: options.disableDiagnostics });

    // Throws the support-matrix message on unknown shapes (caught below →
    // accurate warn + untracked return; never tells a too-new SDK to
    // "upgrade to v1.11+"). On success detection is non-null by construction.
    const validated = isCompatibleServerType(server);
    const detection = detectServer(server)!;
    const lowLevelServer = detection.lowLevel;

    // Resolve API base URL: option > AGENTCAT_API_URL > MCPCAT_API_URL (legacy) > default
    const apiBaseUrl =
      options.apiBaseUrl ||
      process.env.AGENTCAT_API_URL ||
      process.env.MCPCAT_API_URL;
    if (apiBaseUrl) eventQueue.configure(apiBaseUrl);

    // Setup-started beacon — now carries the detection fingerprint. This
    // line IS the fleet-level change-detection channel: writeToLog feeds the
    // diagnostics sink (setDiagnosticsSink), so signal drift across SDK
    // releases surfaces in the diagnostics pipeline without a separate API.
    writeToLog(
      `AgentCat setup started | project ${projectId || "(telemetry-only)"} | sdk v${detection.major}/${detection.flavor} | signals ${describeSignals(detection.signals)}`,
    );

    const existingData = getServerTrackingData(lowLevelServer);
    if (existingData) {
      writeToLog(
        "[SESSION DEBUG] track() - Server already being tracked, skipping initialization",
      );
      return validated;
    }

    // First-wins: per-request factories call track() on every request;
    // rebuilding exporters each time is waste.
    if (options.exporters && !getTelemetryManager()) {
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

    const agentcatData: AgentCatData = {
      projectId: projectId || "", // Use empty string for null projectId
      options: {
        enableReportMissing: options.enableReportMissing ?? true,
        enableTracing: options.enableTracing ?? true,
        enableToolCallContext: options.enableToolCallContext ?? true,
        customContextDescription: options.customContextDescription,
        enableAgentTracking: options.enableAgentTracking ?? false,
        resolveSessionId: options.resolveSessionId,
        identify: options.identify,
        redactSensitiveInformation: options.redactSensitiveInformation,
        redactEvent: options.redactEvent,
        eventTags: options.eventTags,
        eventProperties: options.eventProperties,
      },
    };

    setServerTrackingData(lowLevelServer, agentcatData);
    installEngine(detection);

    // Setup-completed beacon. Pairs with the start beacon: start + complete
    // means setup succeeded; start without complete (plus an error) localizes
    // the failure.
    const exporterCount = options.exporters
      ? Object.keys(options.exporters).length
      : 0;
    writeToLog(
      `AgentCat setup complete | project ${projectId || "(telemetry-only)"} | tracing=${agentcatData.options.enableTracing} context=${agentcatData.options.enableToolCallContext} reportMissing=${agentcatData.options.enableReportMissing} exporters=${exporterCount}`,
    );

    return validated;
  } catch (error) {
    writeToLog(`Warning: Failed to track server - ${error}`);
    return server;
  }
}

/**
 * Publishes a custom event to AgentCat with flexible session management.
 *
 * @param serverOrSessionId - Either a tracked MCP server instance or a session ID string.
 *   A session ID string is used verbatim as the event's session — it is never derived or hashed.
 * @param projectId - Your AgentCat project ID (required)
 * @param eventData - Optional event data to include with the custom event. Set `eventData.sessionId`
 *   to attribute the event to a task; it takes precedence over a session ID string passed as the
 *   first argument. When a tracked server is passed without `eventData.sessionId`, the event is
 *   published without a session (the server assigns one).
 *
 * @returns Promise that resolves when the event is queued for publishing
 *
 * @remarks
 * When a tracked server is passed, the `redactEvent` hook configured via `track()`
 * is applied to the custom event before it is published. Events published with a
 * bare session ID string bypass redaction, since no tracked configuration exists.
 *
 * @example
 * ```typescript
 * // With a tracked server, attributed to a task
 * await agentcat.publishCustomEvent(
 *   server,
 *   "proj_abc123xyz",
 *   {
 *     sessionId: "ses_2cOHEO0LYGADMzRvWTXXVbbgxgm",
 *     resourceName: "custom-action",
 *     parameters: { action: "user-feedback", rating: 5 },
 *     message: "User provided feedback"
 *   }
 * );
 * ```
 *
 * @example
 * ```typescript
 * // With a session ID string
 * await agentcat.publishCustomEvent(
 *   "ses_2cOHEO0LYGADMzRvWTXXVbbgxgm",
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
 * // With a tracked server and no session ID: published without a session
 * await agentcat.publishCustomEvent(
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
    lowLevelServer = serverOrSessionId.server
      ? serverOrSessionId.server
      : serverOrSessionId;
    const trackingData = getServerTrackingData(lowLevelServer as MCPServerLike);
    if (!trackingData) {
      throw new Error(
        "Server is not tracked. Please call agentcat.track() first or provide a session ID string.",
      );
    }
    if (eventData?.sessionId) {
      sessionId = eventData.sessionId;
    } else {
      // Handles are per-request now; a tracked server has no ambient session ID.
      sessionId = ""; // wire: null ("stateless mode - server assigns session")
      writeToLog(
        "publishCustomEvent: no sessionId provided; event will be published without a session. Pass eventData.sessionId to attribute it to a task.",
      );
    }
  } else if (typeof serverOrSessionId === "string") {
    // The string IS the session id — verbatim, no derivation.
    sessionId = eventData?.sessionId || serverOrSessionId;
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
    `Published custom event ${sessionId ? `for session ${sessionId}` : "without a session"} with type 'agentcat:custom'`,
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
