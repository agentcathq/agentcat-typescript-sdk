import { CallToolResult } from "@modelcontextprotocol/sdk/types";

export interface AgentCatOptions {
  enableReportMissing?: boolean;
  enableTracing?: boolean;
  /**
   * Injects an `agent_id` handle alongside `task_id` so subagents can be told
   * apart within a single task. Defaults to true. Set false to drop agent_id
   * from tool schemas entirely.
   */
  enableAgentTracking?: boolean;
  enableToolCallContext?: boolean;
  /**
   * Takes precedence over an agent-supplied `task_id`. Return a stable
   * identifier for the goal (a workflow id, a ticket id) and AgentCat derives a
   * deterministic Task ID from it. Return null — or throw — to fall back to the
   * agent-supplied-or-minted chain. May be sync or async.
   */
  resolveTaskId?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra,
  ) => string | null | Promise<string | null>;
  customContextDescription?: string;
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

export type ToolCallback =
  | ((
      args: any,
      extra: CompatibleRequestHandlerExtra,
    ) => CallToolResult | Promise<CallToolResult>)
  | ((
      extra: CompatibleRequestHandlerExtra,
    ) => CallToolResult | Promise<CallToolResult>);

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
  Session = "ses",
  Event = "evt",
  Agent = "agt",
}

export interface Event {
  // Core identification
  id: string;
  /**
   * The Task ID this event belongs to. Undefined when no handle was available —
   * a custom event published against a tracked server without a `taskId`, for
   * instance. Handles are per request, so there is nothing ambient to fall back
   * on and an invented ID would be worse than none.
   */
  sessionId?: string;
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

export interface UnredactedEvent extends Partial<Event> {
  redactionFn?: RedactFunction; // Optional redaction function for sensitive data
  eventRedactionFn?: RedactEventFunction; // Optional whole-event redaction hook
}

// Use our own minimal interface for what we actually need
export interface CompatibleRequestHandlerExtra {
  sessionId?: string;
  headers?: Record<string, string | string[]>;
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
}

export interface AgentCatData {
  projectId: string; // Project ID for AgentCat
  sessionInfo: SessionInfo;
  options: AgentCatOptions;
  /**
   * Names of tools that declare their own task_id/agent_id parameter. Server
   * configuration, identical for every caller and bounded by tool count — not
   * per-request state. The low-level tools/call path reads this to avoid
   * stripping a customer's own parameter.
   */
  handleCollisionTools: Set<string>;
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
  /**
   * The Task ID to attribute this event to. Takes precedence over the first
   * argument of `publishCustomEvent`. A value that already looks like a handle
   * this SDK minted (`ses_…`) is used verbatim; anything else is treated as a
   * customer identifier and derived exactly as the `resolveTaskId` hook does,
   * so it correlates with the tool calls made under that same identifier.
   */
  taskId?: string;
  /**
   * The actor this event belongs to. Must be supplied per call: custom events
   * have no request to run `identify` against, and identity is never carried
   * between requests.
   */
  actor?: UserIdentity;
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
