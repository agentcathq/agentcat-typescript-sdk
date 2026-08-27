export interface AgentCatOptions {
  enableReportMissing?: boolean;
  enableTracing?: boolean;
  enableToolCallContext?: boolean;
  customContextDescription?: string;
  /**
   * Default false. Set true to inject a required agent_id parameter into every
   * tool. Agents self-generate the value (model|harness|nonce, e.g.
   * "opus-4.80-1m|claude-code|k3n9x"); it is echoed back in mcp_session
   * and stamped on events as tags. Omission never rejects a call server-side —
   * the event is simply published without agent identity. The intended
   * enforcement is client-side: a strict schema-validating MCP client will
   * refuse to send a call that omits a required agent_id in the first place.
   */
  enableAgentTracking?: boolean;
  /**
   * Hook mode: you manage task state. When configured, AgentCat injects no
   * session_id parameter and prepends no issuance text; the returned value is
   * combined with the project ID into a deterministic ses_ KSUID. Nullish
   * returns and throws mint silently — a configured hook should answer every
   * request.
   */
  resolveSessionId?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra,
  ) => string | null | Promise<string | null>;
  identify?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra,
  ) => Promise<UserIdentity | null>;
  redactSensitiveInformation?: RedactFunction;
  redactEvent?: RedactEventFunction;
  exporters?: Record<string, ExporterConfig>;
  apiBaseUrl?: string;
  disableDiagnostics?: boolean;
  eventTags?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra,
  ) => Record<string, string> | null | Promise<Record<string, string> | null>;
  eventProperties?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra,
  ) => Record<string, any> | null | Promise<Record<string, any> | null>;
}

export interface CompatibleToolResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

export type ToolCallback =
  | ((
      args: any,
      extra: CompatibleRequestHandlerExtra,
    ) => CompatibleToolResult | Promise<CompatibleToolResult>)
  | ((
      extra: CompatibleRequestHandlerExtra,
    ) => CompatibleToolResult | Promise<CompatibleToolResult>);

// RegisteredTool type that supports both MCP SDK 1.23- (callback) and 1.24+ (handler)
export type RegisteredTool = {
  description?: string;
  inputSchema?: any;
  update?: (...args: any[]) => any;
} & (
  | { callback: ToolCallback; handler?: never }
  | { handler: ToolCallback; callback?: never }
);

export type RedactFunction = (text: string) => Promise<string>;

export type RedactEventFunction = (
  event: Event,
) => Event | null | Promise<Event | null>;

export interface ExporterConfig {
  type: string;
  [key: string]: any;
}

export interface Exporter {
  export(event: Event): Promise<void>;
}

export enum AgentCatIDPrefixes {
  Session = "ses", // Session IDs deliberately keep this prefix
  Event = "evt",
  Agent = "agt",
}

export interface Event {
  // Core identification
  id: string;
  sessionId: string;
  projectId?: string; // Optional for telemetry-only mode

  // Event metadata
  eventType: string; // Changed from enum to string for flexibility
  timestamp: Date;
  duration?: number;

  // Session context (from SessionInfo)
  ipAddress?: string;
  sdkLanguage?: string;
  agentcatVersion?: string;
  serverName?: string;
  serverVersion?: string;
  clientName?: string;
  clientVersion?: string;

  // Actor/identity information
  identifyActorGivenId?: string;
  identifyActorName?: string;
  identifyActorData?: object;

  // Event-specific data
  resourceName?: string; // Tool/resource name
  parameters?: any;
  response?: any;
  userIntent?: string;

  // Error tracking
  isError?: boolean;
  error?: ErrorData;

  // Customer-defined metadata
  tags?: Record<string, string> | null;
  properties?: Record<string, any> | null;

  // Legacy fields for AgentCat API compatibility
  actorId?: string; // Maps to identifyActorGivenId in some contexts
  eventId?: string; // Custom event ID
  identifyData?: object; // Legacy name for identifyActorData
}

/**
 * Promises for customer-hook results, fired at request start and resolved in
 * the background event pipeline — customer hooks never hold up the tool call.
 * Every promise here is constructed non-rejecting (hook failures resolve to
 * null). Never serialized: detached at the top of processEvent before any
 * pipeline stage or the wire payload can see it.
 */
export interface PendingEventFields {
  /** Raw resolveSessionId hook value (pre-derivation). */
  sessionHookValue?: Promise<string | null>;
  identity?: Promise<UserIdentity | null>;
  tags?: Promise<Record<string, string> | null>;
  properties?: Promise<Record<string, any> | null>;
}

export interface UnredactedEvent extends Partial<Event> {
  redactionFn?: RedactFunction; // Optional redaction function for sensitive data
  eventRedactionFn?: RedactEventFunction; // Optional whole-event redaction hook
  pending?: PendingEventFields; // Deferred hook results, applied in the queue
}

/**
 * Duck type over the second argument the MCP SDK passes to request handlers,
 * covering both supported majors:
 * - v1 (`@modelcontextprotocol/sdk`): the SDK's `RequestHandlerExtra` —
 *   e.g. `sessionId`, `authInfo`, `requestId`.
 * - v2 (`@modelcontextprotocol/server`): the SDK's `ServerContext` —
 *   `{ sessionId, mcpReq, http }`; note `http?.req?.headers` is a Web
 *   `Headers` object (use `.get("x-header")`, not bracket access).
 *
 * Only `sessionId` is common to both; everything else is reached through the
 * index signature and is SDK-version-specific.
 */
export interface CompatibleRequestHandlerExtra {
  /**
   * The MCP transport session, assigned by the SDK and reset on reconnect.
   * NOT AgentCat's `session_id` handle, which outlives the transport — that
   * one is the agent-echoed tool parameter stored in `Event.sessionId`.
   */
  sessionId?: string;
  [key: string]: any;
}

export interface ServerClientInfoLike {
  name?: string;
  version?: string;
}

export interface HighLevelMCPServerLike {
  _registeredTools: { [name: string]: RegisteredTool };
  server: MCPServerLike;
  // Tool registration methods - simplified signatures without Zod dependency
  tool?(name: string, cb: ToolCallback): void;
  tool?(name: string, description: string, cb: ToolCallback): void;
  tool?(name: string, paramsSchema: any, cb: ToolCallback): void;
  tool?(
    name: string,
    description: string,
    paramsSchema: any,
    cb: ToolCallback,
  ): void;
  registerTool?(
    name: string,
    config: {
      description?: string;
      inputSchema?: any;
    },
    handler: ToolCallback,
  ): void;
}

export interface MCPServerLike {
  setRequestHandler(
    schema: any,
    handler: (
      request: any,
      extra?: CompatibleRequestHandlerExtra,
    ) => Promise<any>,
  ): void;
  _requestHandlers: Map<
    string,
    (request: any, extra?: CompatibleRequestHandlerExtra) => Promise<any>
  >;
  _serverInfo?: ServerClientInfoLike;
  getClientVersion(): ServerClientInfoLike | undefined;
}

export interface UserIdentity {
  userId: string; // Unique identifier for the user
  userName?: string; // Optional user name
  userData?: Record<string, any>; // Additional user data
}

export interface SessionInfo {
  ipAddress?: string;
  sdkLanguage?: string;
  agentcatVersion?: string;
  serverName?: string;
  serverVersion?: string;
  clientName?: string;
  clientVersion?: string;
  identifyActorGivenId?: string; // Actor identity stamped on every event
  identifyActorName?: string; // Actor identity stamped on every event
  identifyActorData?: object;
}

export interface AgentCatData {
  projectId: string; // Project ID for AgentCat ("" in telemetry-only mode)
  options: AgentCatOptions;
}

// Error tracking types
export interface StackFrame {
  filename: string;
  function: string; // Function name or "<anonymous>"
  lineno?: number;
  colno?: number;
  in_app: boolean;
  abs_path?: string;
  context_line?: string; // The line of code where the error occurred
}

export interface ChainedErrorData {
  message: string;
  type?: string;
  stack?: string;
  frames?: StackFrame[];
}

export interface ErrorData {
  message: string;
  type?: string; // Error class name (e.g., "TypeError", "Error")
  stack?: string; // Full stack trace string
  frames?: StackFrame[]; // Parsed stack frames
  chained_errors?: ChainedErrorData[];
  platform?: string; // Platform identifier (e.g., "javascript", "node")
}

// Custom event types for publishCustomEvent function
export interface CustomEventData {
  /** Session ID to attribute this event to. Takes precedence over a session-id string argument. */
  sessionId?: string;
  resourceName?: string;
  parameters?: any;
  response?: any;
  message?: string;
  duration?: number;
  isError?: boolean;
  error?: any;
  tags?: Record<string, string>;
  properties?: Record<string, any>;
}
