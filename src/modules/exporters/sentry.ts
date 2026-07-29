import { Event, Exporter } from "../../types.js";
import { writeToLog } from "../logging.js";
import { traceContext } from "./trace-context.js";
import { AGENTCAT_SOURCE } from "../constants.js";

export interface SentryExporterConfig {
  type: "sentry";
  dsn: string;
  environment?: string;
  release?: string;
  enableTracing?: boolean; // Default: false (logs/errors only)
}

interface ParsedDSN {
  protocol: string;
  publicKey: string;
  host: string;
  port?: string;
  path: string;
  projectId: string;
}

interface SentryTransaction {
  type: "transaction";
  event_id: string;
  timestamp: number;
  start_timestamp: number;
  transaction: string;
  contexts: {
    trace: {
      trace_id: string;
      span_id: string;
      op: string;
      status?: "ok" | "internal_error";
    };
    [key: string]: any;
  };
  spans?: Array<{
    span_id: string;
    trace_id: string;
    parent_span_id?: string;
    op: string;
    description?: string;
    start_timestamp: number;
    timestamp: number;
    status?: "ok" | "internal_error";
  }>;
  tags?: Record<string, string>;
  extra?: Record<string, any>;
}

interface SentryErrorEvent {
  type: "event";
  event_id: string;
  timestamp: number;
  level: "error" | "fatal" | "warning";
  exception: {
    values: Array<{
      type: string;
      value: string;
      mechanism?: {
        type: string;
        handled: boolean;
      };
    }>;
  };
  contexts?: {
    trace?: {
      trace_id: string;
      span_id: string;
      parent_span_id?: string;
      op?: string;
    };
    [key: string]: any;
  };
  tags?: Record<string, string>;
  extra?: Record<string, any>;
  transaction?: string;
}

interface SentryLog {
  timestamp: number;
  trace_id: string;
  event_id: string;
  level: "info" | "error";
  body: string;
  attributes?: Record<
    string,
    { value: any; type: "string" | "boolean" | "integer" | "double" }
  >;
}

export class SentryExporter implements Exporter {
  private endpoint: string;
  private authHeader: string;
  private config: SentryExporterConfig;
  private parsedDSN: ParsedDSN;

  constructor(config: SentryExporterConfig) {
    this.config = config;
    this.parsedDSN = this.parseDSN(config.dsn);

    // Build envelope endpoint
    this.endpoint = `${this.parsedDSN.protocol}://${this.parsedDSN.host}${
      this.parsedDSN.port ? `:${this.parsedDSN.port}` : ""
    }${this.parsedDSN.path}/api/${this.parsedDSN.projectId}/envelope/`;

    // Build auth header
    this.authHeader = `Sentry sentry_version=7, sentry_client=agentcat/1.0.0, sentry_key=${this.parsedDSN.publicKey}`;

    writeToLog(`SentryExporter: Initialized with endpoint ${this.endpoint}`);
  }

  private parseDSN(dsn: string): ParsedDSN {
    // DSN format: protocol://publicKey@host[:port]/path/projectId
    const regex = /^(https?):\/\/([a-f0-9]+)@([\w.-]+)(:\d+)?(\/.*)?\/(\d+)$/;
    const match = dsn.match(regex);

    if (!match) {
      throw new Error(`Invalid Sentry DSN: ${dsn}`);
    }

    return {
      protocol: match[1],
      publicKey: match[2],
      host: match[3],
      port: match[4]?.substring(1), // Remove leading ':'
      path: match[5] || "",
      projectId: match[6],
    };
  }

  async export(event: Event): Promise<void> {
    try {
      // ALWAYS send log
      const log = this.eventToLog(event);
      const logEnvelope = this.createLogEnvelope(log);

      writeToLog(`SentryExporter: Sending log for event ${event.id} to Sentry`);

      const logResponse = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "X-Sentry-Auth": this.authHeader,
          "Content-Type": "application/x-sentry-envelope",
        },
        body: logEnvelope,
      });

      if (!logResponse.ok) {
        const errorBody = await logResponse.text();
        writeToLog(
          `Sentry log export failed - Status: ${logResponse.status}, Body: ${errorBody}`,
        );
      } else {
        writeToLog(`Sentry log export success - Event: ${event.id}`);
      }

      // OPTIONALLY send transaction for performance monitoring
      if (this.config.enableTracing) {
        const transaction = this.eventToTransaction(event);
        const transactionEnvelope = this.createTransactionEnvelope(transaction);

        writeToLog(
          `SentryExporter: Sending transaction ${transaction.event_id} to Sentry`,
        );

        const transactionResponse = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "X-Sentry-Auth": this.authHeader,
            "Content-Type": "application/x-sentry-envelope",
          },
          body: transactionEnvelope,
        });

        if (!transactionResponse.ok) {
          const errorBody = await transactionResponse.text();
          writeToLog(
            `Sentry transaction export failed - Status: ${transactionResponse.status}, Body: ${errorBody}`,
          );
        } else {
          writeToLog(`Sentry transaction export success - Event: ${event.id}`);
        }
      }

      // ALWAYS send error event for Issue creation if this is an error
      if (event.isError) {
        // Use transaction if available for better context, otherwise create minimal error event
        const errorEvent = this.config.enableTracing
          ? this.eventToErrorEvent(event, this.eventToTransaction(event))
          : this.eventToErrorEvent(event);
        const errorEnvelope = this.createErrorEnvelope(errorEvent);

        writeToLog(
          `SentryExporter: Sending error event ${errorEvent.event_id} to Sentry for Issue creation`,
        );

        const errorResponse = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "X-Sentry-Auth": this.authHeader,
            "Content-Type": "application/x-sentry-envelope",
          },
          body: errorEnvelope,
        });

        if (!errorResponse.ok) {
          const errorBody = await errorResponse.text();
          writeToLog(
            `Sentry error export failed - Status: ${errorResponse.status}, Body: ${errorBody}`,
          );
        } else {
          writeToLog(`Sentry error export success - Event: ${event.id}`);
        }
      }
    } catch (error) {
      writeToLog(`Sentry export error: ${error}`);
    }
  }

  /**
   * The trace every envelope for one event joins. `getTraceId` returns fresh
   * random bytes for a falsy input, and `export()` derives a trace id up to
   * three times per event (log, transaction, error) — so a session-less event
   * would scatter across three unrelated traces. Falling back to the event id
   * makes it deterministically its own single-event trace instead.
   */
  private traceIdFor(event: Event): string {
    return traceContext.getTraceId(event.sessionId || event.id);
  }

  private eventToLog(event: Event): SentryLog {
    const timestamp = event.timestamp
      ? new Date(event.timestamp).getTime() / 1000
      : Date.now() / 1000;

    const traceId = this.traceIdFor(event);

    // Generate deterministic event_id for Sentry
    const eventId =
      traceContext.getSpanId(event.id) + traceContext.getSpanId(event.id);

    // Build message
    const message = event.resourceName
      ? `MCP ${event.eventType || "event"}: ${event.resourceName}`
      : `MCP ${event.eventType || "event"}`;

    return {
      timestamp,
      trace_id: traceId,
      event_id: eventId,
      level: event.isError ? "error" : "info",
      body: message,
      attributes: this.buildLogAttributes(event),
    };
  }

  private buildLogAttributes(
    event: Event,
  ): Record<
    string,
    { value: any; type: "string" | "boolean" | "integer" | "double" }
  > {
    const attributes: Record<
      string,
      { value: any; type: "string" | "boolean" | "integer" | "double" }
    > = {};

    if (event.eventType) {
      attributes.eventType = { value: event.eventType, type: "string" };
    }
    if (event.resourceName) {
      attributes.resourceName = { value: event.resourceName, type: "string" };
    }
    if (event.serverName) {
      attributes.serverName = { value: event.serverName, type: "string" };
    }
    if (event.clientName) {
      attributes.clientName = { value: event.clientName, type: "string" };
    }
    if (event.sessionId) {
      attributes.sessionId = { value: event.sessionId, type: "string" };
    }
    if (event.projectId) {
      attributes.projectId = { value: event.projectId, type: "string" };
    }
    if (event.duration !== undefined) {
      attributes.duration_ms = { value: event.duration, type: "double" };
    }
    if (event.identifyActorGivenId) {
      attributes.actorId = {
        value: event.identifyActorGivenId,
        type: "string",
      };
    }
    if (event.identifyActorName) {
      attributes.actorName = { value: event.identifyActorName, type: "string" };
    }
    if (event.userIntent) {
      attributes.userIntent = { value: event.userIntent, type: "string" };
    }
    if (event.serverVersion) {
      attributes.serverVersion = { value: event.serverVersion, type: "string" };
    }
    if (event.clientVersion) {
      attributes.clientVersion = { value: event.clientVersion, type: "string" };
    }
    if (event.isError !== undefined) {
      attributes.isError = { value: event.isError, type: "boolean" };
    }

    return attributes;
  }

  private createLogEnvelope(log: SentryLog): string {
    // Envelope header
    const envelopeHeader = {
      event_id: log.event_id,
      sent_at: new Date().toISOString(),
    };

    // Item header with ALL MANDATORY fields
    const itemHeader = {
      type: "log",
      item_count: 1, // MANDATORY - must match number of logs
      content_type: "application/vnd.sentry.items.log+json", // MANDATORY - exact string
    };

    // Payload with CORRECT key
    const payload = {
      items: [log], // Changed from 'logs' to 'items'
    };

    // Build envelope with TRAILING NEWLINE
    return (
      [
        JSON.stringify(envelopeHeader),
        JSON.stringify(itemHeader),
        JSON.stringify(payload),
      ].join("\n") + "\n"
    ); // Added required trailing newline
  }

  private eventToTransaction(event: Event): SentryTransaction {
    // Calculate timestamps
    const endTimestamp = event.timestamp
      ? new Date(event.timestamp).getTime() / 1000
      : Date.now() / 1000;

    const startTimestamp = event.duration
      ? endTimestamp - event.duration / 1000
      : endTimestamp;

    const traceId = this.traceIdFor(event);
    const spanId = traceContext.getSpanId(event.id);

    // Build transaction name
    const transactionName = event.resourceName
      ? `${event.eventType || "mcp"} - ${event.resourceName}`
      : event.eventType || "mcp.event";

    const transaction: SentryTransaction = {
      type: "transaction",
      event_id: traceContext.getSpanId(event.id) + traceContext.getSpanId(),
      timestamp: endTimestamp,
      start_timestamp: startTimestamp,
      transaction: transactionName,
      contexts: this.buildContexts(event, {
        trace_id: traceId,
        span_id: spanId,
        op: event.eventType || "mcp.event",
        status: event.isError ? "internal_error" : "ok",
      }) as SentryTransaction["contexts"],
      tags: this.buildTags(event),
      extra: this.buildExtra(event),
    };

    return transaction;
  }

  private buildTags(event: Event): Record<string, string> {
    const tags: Record<string, string> = {
      source: AGENTCAT_SOURCE,
    };

    if (this.config.environment) tags.environment = this.config.environment;
    if (this.config.release) tags.release = this.config.release;
    if (event.eventType) tags.event_type = event.eventType;
    if (event.resourceName) tags.resource = event.resourceName;
    if (event.serverName) tags.server_name = event.serverName;
    if (event.clientName) tags.client_name = event.clientName;
    if (event.identifyActorGivenId) tags.actor_id = event.identifyActorGivenId;

    // Add customer-defined tags (namespaced to avoid collisions with Sentry reserved fields)
    if (event.tags) {
      for (const [key, value] of Object.entries(event.tags)) {
        tags[`agentcat.${key}`] = value;
      }
    }

    return tags;
  }

  private buildExtra(event: Event): Record<string, any> {
    const extra: Record<string, any> = {};

    if (event.sessionId) extra.session_id = event.sessionId;
    if (event.projectId) extra.project_id = event.projectId;
    if (event.userIntent) extra.user_intent = event.userIntent;
    if (event.identifyActorName) extra.actor_name = event.identifyActorName;
    if (event.serverVersion) extra.server_version = event.serverVersion;
    if (event.clientVersion) extra.client_version = event.clientVersion;
    if (event.duration !== undefined) extra.duration_ms = event.duration;
    if (event.error) extra.error = event.error;

    return extra;
  }

  private buildContexts(
    event: Event,
    traceCtx: Record<string, any>,
  ): Record<string, any> {
    const contexts: Record<string, any> = {
      trace: traceCtx,
    };

    // Add customer-defined properties as a custom context
    if (event.properties) {
      contexts.agentcat = event.properties;
    }

    return contexts;
  }

  private eventToErrorEvent(
    event: Event,
    transaction?: SentryTransaction,
  ): SentryErrorEvent {
    // Extract error message
    let errorMessage = "Unknown error";
    let errorType = "ToolCallError";

    if (event.error) {
      if (typeof event.error === "string") {
        errorMessage = event.error;
      } else if (typeof event.error === "object" && event.error !== null) {
        if ("message" in event.error) {
          errorMessage = String(event.error.message);
        } else {
          errorMessage = JSON.stringify(event.error);
        }
        if ("type" in event.error) {
          errorType = String(event.error.type);
        }
      }
    }

    // Use same trace context as the transaction for correlation (if available)
    const traceId = transaction
      ? transaction.contexts.trace.trace_id
      : this.traceIdFor(event);
    const spanId = traceContext.getSpanId(event.id);

    const timestamp = transaction
      ? transaction.timestamp
      : event.timestamp
        ? new Date(event.timestamp).getTime() / 1000
        : Date.now() / 1000;

    const errorEvent: SentryErrorEvent = {
      type: "event",
      event_id: traceContext.getSpanId(event.id) + traceContext.getSpanId(),
      timestamp,
      level: "error",
      exception: {
        values: [
          {
            type: errorType,
            value: errorMessage,
            mechanism: {
              type: "mcp_tool_call",
              handled: false,
            },
          },
        ],
      },
      contexts: {
        ...this.buildContexts(event, {
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: transaction?.contexts.trace.span_id,
          op: transaction?.contexts.trace.op || event.eventType || "mcp.event",
        }),
        mcp: {
          resource_name: event.resourceName,
          session_id: event.sessionId,
          event_type: event.eventType,
          user_intent: event.userIntent,
        },
      },
      tags: this.buildTags(event),
      extra: this.buildExtra(event),
      transaction:
        transaction?.transaction ||
        (event.resourceName
          ? `${event.eventType || "mcp"} - ${event.resourceName}`
          : event.eventType || "mcp.event"), // Generate transaction name if not available
    };

    return errorEvent;
  }

  private createTransactionEnvelope(transaction: SentryTransaction): string {
    // Envelope header
    const envelopeHeader = {
      event_id: transaction.event_id,
      sent_at: new Date().toISOString(),
    };

    // Item header for transaction
    const itemHeader = {
      type: "transaction",
    };

    // Build envelope (newline-separated JSON)
    return [
      JSON.stringify(envelopeHeader),
      JSON.stringify(itemHeader),
      JSON.stringify(transaction),
    ].join("\n");
  }

  private createErrorEnvelope(errorEvent: SentryErrorEvent): string {
    // Envelope header
    const envelopeHeader = {
      event_id: errorEvent.event_id,
      sent_at: new Date().toISOString(),
    };

    // Item header for error event
    const itemHeader = {
      type: "event",
      content_type: "application/json",
    };

    // Build envelope (newline-separated JSON)
    return [
      JSON.stringify(envelopeHeader),
      JSON.stringify(itemHeader),
      JSON.stringify(errorEvent),
    ].join("\n");
  }
}
