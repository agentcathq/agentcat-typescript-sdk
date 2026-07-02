import { Event, Exporter } from "../../types.js";
import { writeToLog } from "../logging.js";
import { traceContext } from "./trace-context.js";
import { AGENTCAT_SOURCE } from "../constants.js";

export interface OTLPExporterConfig {
  type: "otlp";
  endpoint: string;
  headers?: Record<string, string>;
}

export class OTLPExporter implements Exporter {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(config: OTLPExporterConfig) {
    // Auto-append /v1/traces per OTLP spec if not already present
    const url = config.endpoint.replace(/\/+$/, "");
    this.endpoint = url.endsWith("/v1/traces") ? url : `${url}/v1/traces`;

    this.headers = {
      "Content-Type": "application/json", // Using JSON for now for easier debugging
      ...config.headers,
    };
  }

  async export(event: Event): Promise<void> {
    try {
      // Convert MCPCat event to OTLP trace format
      const span = this.convertToOTLPSpan(event);

      // Create OTLP JSON format
      const otlpRequest = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: event.serverName || "mcp-server" },
                },
                {
                  key: "service.version",
                  value: { stringValue: event.serverVersion || "unknown" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "agentcat",
                  version: event.agentcatVersion || "unknown",
                },
                spans: [span],
              },
            ],
          },
        ],
      };

      // Use JSON format for now
      const body = JSON.stringify(otlpRequest);

      // Use fetch to send the data
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body,
      });

      if (!response.ok) {
        throw new Error(
          `OTLP export failed: ${response.status} ${response.statusText}`,
        );
      }

      writeToLog(`Successfully exported event to OTLP: ${event.id}`);
    } catch (error) {
      throw new Error(`OTLP export error: ${error}`);
    }
  }

  private convertToOTLPSpan(event: Event): any {
    const startTimeNanos = event.timestamp
      ? BigInt(event.timestamp.getTime()) * BigInt(1_000_000)
      : BigInt(Date.now()) * BigInt(1_000_000);

    const endTimeNanos = event.duration
      ? startTimeNanos + BigInt(event.duration) * BigInt(1_000_000)
      : startTimeNanos;

    return {
      traceId: traceContext.getTraceId(event.sessionId),
      spanId: traceContext.getSpanId(event.id),
      name: event.eventType || "mcp.event",
      kind: 2, // SPAN_KIND_SERVER
      startTimeUnixNano: startTimeNanos.toString(),
      endTimeUnixNano: endTimeNanos.toString(),
      attributes: [
        {
          key: "source",
          value: { stringValue: AGENTCAT_SOURCE },
        },
        {
          key: "mcp.event_type",
          value: { stringValue: event.eventType || "" },
        },
        {
          key: "mcp.session_id",
          value: { stringValue: event.sessionId || "" },
        },
        {
          key: "mcp.project_id",
          value: { stringValue: event.projectId || "" },
        },
        {
          key: "mcp.resource_name",
          value: { stringValue: event.resourceName || "" },
        },
        {
          key: "mcp.user_intent",
          value: { stringValue: event.userIntent || "" },
        },
        {
          key: "mcp.actor_id",
          value: { stringValue: event.identifyActorGivenId || "" },
        },
        {
          key: "mcp.actor_name",
          value: { stringValue: event.identifyActorName || "" },
        },
        {
          key: "mcp.client_name",
          value: { stringValue: event.clientName || "" },
        },
        {
          key: "mcp.client_version",
          value: { stringValue: event.clientVersion || "" },
        },
        // Add customer-defined tags as individual attributes
        ...Object.entries(event.tags || {}).map(([key, value]) => ({
          key: `agentcat.tag.${key}`,
          value: { stringValue: value },
        })),
        // Add customer-defined properties as JSON
        ...(event.properties
          ? [
              {
                key: "agentcat.properties",
                value: { stringValue: JSON.stringify(event.properties) },
              },
            ]
          : []),
      ].filter((attr) => attr.value.stringValue), // Remove empty attributes
      status: {
        code: event.isError ? 2 : 1, // ERROR : OK
      },
    };
  }
}
