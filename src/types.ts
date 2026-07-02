import { CallToolResult } from "@modelcontextprotocol/sdk/types";

export interface MCPCatOptions {
  enableReportMissing?: boolean;
  enableTracing?: boolean;
  enableToolCallContext?: boolean;
  customContextDescription?: string;
  identify?: (
    request: any,
    extra?: CompatibleRequestHandlerExtra,
  ) => Promise<UserIdentity | null>;
  redactSensitiveInformation?: RedactFunction;
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

export interface ExporterConfig {
  type: string;
  [key: string]: any;
}

export interface Exporter {
  export(event: Event): Promise<void>;
}

export enum MCPCatIDPrefixes {
  Session = "ses",
  Event = "evt",
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

  // Legacy fields for MCPCat API compatibility
  actorId?: string; // Maps to identifyActorGivenId in some contexts
  eventId?: string; // Custom event ID
  identifyData?: object; // Legacy name for identifyActorData
}

export interface UnredactedEvent extends Partial<Event> {
  redactionFn?: RedactFunction; // Optional redaction function for sensitive data
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
  identifyActorGivenId?: string; // Actor ID for mcpcat:identify events
  identifyActorName?: string; // Actor name for mcpcat:identify events
  identifyActorData?: object;
}

export interface MCPCatData {
  projectId: string; // Project ID for MCPCat
  sessionId: string; // Unique identifier for the session (KSUID with ses prefix)
  lastActivity: Date; // Last activity timestamp
  identifiedSessions: Map<string, UserIdentity>;
  sessionInfo: SessionInfo;
  options: MCPCatOptions;
  lastMcpSessionId?: string; // Track the last MCP sessionId we saw
  sessionSource: "mcp" | "mcpcat"; // Track whether session ID came from MCP protocol or MCPCat generation
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
