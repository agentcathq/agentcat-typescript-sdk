import {
  Configuration,
  EventsApi,
  PublishEventRequest,
  PublishEventRequestEventTypeEnum,
} from "agentcat-api";
import {
  Event,
  UnredactedEvent,
  MCPServerLike,
  ServerClientInfoLike,
  UserIdentity,
} from "../types.js";
import { writeToLog } from "./logging.js";
import { getServerTrackingData } from "./internal.js";
import { buildSessionInfo } from "./session.js";
import { applyEventRedaction, redactEvent } from "./redaction.js";
import { sanitizeEvent } from "./sanitization.js";
import { truncateEvent } from "./truncation.js";
import KSUID from "../thirdparty/ksuid/index.js";
import { getMCPCompatibleErrorMessage } from "./compatibility.js";
import { TelemetryManager } from "./telemetry.js";
import { flushDiagnostics } from "./diagnostics.js";
import { registerBackgroundTask } from "./backgroundTasks.js";

interface QueuedEvent {
  event: UnredactedEvent;
  delivery: Promise<void>;
  settle: () => void;
}

class EventQueue {
  private queue: QueuedEvent[] = [];
  private processing = false;
  private maxRetries = 3;
  private maxQueueSize = 10000; // Prevent unbounded growth
  private concurrency = 5; // Max parallel requests
  private activeRequests = 0;
  private apiClient: EventsApi;
  private telemetryManager?: TelemetryManager;

  constructor() {
    const config = new Configuration({ basePath: "https://api.agentcat.com" });
    this.apiClient = new EventsApi(config);
  }

  configure(apiBaseUrl: string): void {
    const config = new Configuration({ basePath: apiBaseUrl });
    this.apiClient = new EventsApi(config);
  }

  setTelemetryManager(telemetryManager: TelemetryManager): void {
    this.telemetryManager = telemetryManager;
  }

  add(event: UnredactedEvent): void {
    let settleDelivery: () => void = () => {};
    const delivery = new Promise<void>((resolve) => {
      settleDelivery = resolve;
    });
    const queuedEvent: QueuedEvent = {
      event,
      delivery,
      settle: settleDelivery,
    };

    // Drop oldest events if queue is full (or implement your preferred strategy)
    if (this.queue.length >= this.maxQueueSize) {
      writeToLog("Event queue full, dropping oldest event");
      this.queue.shift()?.settle();
    }

    this.queue.push(queuedEvent);

    // Only AgentCat ingestion is protected. Telemetry-only events and custom
    // exporters retain their existing best-effort lifecycle.
    if (event.projectId) {
      registerBackgroundTask(delivery);
    }

    void this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) return;

    this.processing = true;

    while (this.queue.length > 0 && this.activeRequests < this.concurrency) {
      const queuedEvent = this.queue.shift();
      if (!queuedEvent) continue;

      this.activeRequests++;
      void this.processEvent(queuedEvent);
    }

    this.processing = false;
  }

  private async processEvent(queuedEvent: QueuedEvent): Promise<void> {
    const { event } = queuedEvent;

    try {
      if (event.eventRedactionFn) {
        const eventRedactionFn = event.eventRedactionFn;
        event.eventRedactionFn = undefined;
        try {
          if (!(await applyEventRedaction(event, eventRedactionFn))) {
            writeToLog("Event dropped by redactEvent hook");
            return;
          }
        } catch (error) {
          writeToLog(`Failed to redact event (event-level hook): ${error}`);
          return;
        }
      }

      if (event.redactionFn) {
        try {
          const redactedEvent = await redactEvent(event, event.redactionFn);
          event.redactionFn = undefined;
          Object.assign(event, redactedEvent);
        } catch (error) {
          writeToLog(`Failed to redact event: ${error}`);
          return;
        }
      }

      try {
        Object.assign(event, sanitizeEvent(event));
      } catch (error) {
        writeToLog(`Failed to sanitize event: ${error}`);
        return;
      }

      try {
        Object.assign(event, truncateEvent(event));
      } catch (error) {
        writeToLog(`Failed to truncate event: ${error}`);
        return;
      }

      event.id = event.id || (await KSUID.withPrefix("evt").random());
      await this.sendEvent(event as Event);
    } catch (error) {
      writeToLog(
        `Failed to deliver AgentCat event after retries: ${getMCPCompatibleErrorMessage(error)}`,
      );
    } finally {
      queuedEvent.settle();
      this.activeRequests--;
      void this.process();
    }
  }

  private toPublishEventRequest(event: Event): PublishEventRequest {
    return {
      // Core fields
      id: event.id,
      // Safe: sendEvent only publishes when event.projectId is truthy
      projectId: event.projectId!,
      sessionId: event.sessionId || null,
      timestamp: event.timestamp,
      duration: event.duration,

      // Event data
      eventType: event.eventType as PublishEventRequestEventTypeEnum,
      resourceName: event.resourceName,
      parameters: event.parameters,
      response: event.response,
      userIntent: event.userIntent,
      isError: event.isError,
      error: event.error,

      // Actor fields
      identifyActorGivenId: event.identifyActorGivenId,
      identifyActorName: event.identifyActorName,
      identifyData: event.identifyActorData,

      // Session info
      ipAddress: event.ipAddress,
      sdkLanguage: event.sdkLanguage,
      agentcatVersion: event.agentcatVersion,
      serverName: event.serverName,
      serverVersion: event.serverVersion,
      clientName: event.clientName,
      clientVersion: event.clientVersion,

      // Legacy fields
      actorId: event.actorId || event.identifyActorGivenId,
      eventId: event.eventId,

      // Customer-defined metadata
      tags: event.tags ?? undefined,
      properties: event.properties ?? undefined,
    };
  }

  private async sendEvent(event: Event, retries = 0): Promise<void> {
    // Export to telemetry if configured (fire-and-forget)
    if (this.telemetryManager) {
      this.telemetryManager.export(event).catch((error) => {
        writeToLog(
          `Telemetry export error: ${getMCPCompatibleErrorMessage(error)}`,
        );
      });
    }

    // Send to AgentCat API if projectId is provided
    if (event.projectId) {
      try {
        const publishRequest = this.toPublishEventRequest(event);
        await this.apiClient.publishEvent({
          publishEventRequest: publishRequest,
        });
        writeToLog(
          `Successfully sent event ${event.id} | ${event.eventType} | session ${event.sessionId} | ${event.projectId} | ${event.duration} ms | ${event.identifyActorGivenId || "anonymous"}`,
        );
      } catch (error) {
        writeToLog(
          `Failed to send event ${event.id}, retrying... [Error: ${getMCPCompatibleErrorMessage(error)}]`,
        );
        if (retries < this.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          await this.delay(Math.pow(2, retries) * 1000);
          return this.sendEvent(event, retries + 1);
        }
        throw error;
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Get queue stats for monitoring
  getStats() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      isProcessing: this.processing,
    };
  }

  // Graceful shutdown - wait for active requests
  async destroy(): Promise<void> {
    // Stop accepting new events
    this.add = () => {
      writeToLog("Queue is shutting down, event dropped");
    };

    // Wait for queue to drain (with timeout)
    const timeout = 5000; // 5 seconds
    const start = Date.now();

    while (
      (this.queue.length > 0 || this.activeRequests > 0) &&
      Date.now() - start < timeout
    ) {
      await this.delay(100);
    }

    if (this.queue.length > 0) {
      writeToLog(
        `Shutting down with ${this.queue.length} events still in queue`,
      );
    }
  }
}

export const eventQueue = new EventQueue();

/**
 * Signal-driven shutdown: drain the queue and diagnostics, then RESTORE the
 * signal's default behavior. Installing any SIGINT/SIGTERM listener disables
 * Node's default exit, so without the re-raise the first Ctrl+C / kill would
 * leave the customer's server running as an unkillable zombie until a second
 * signal — AgentCat must not change process lifecycle. The re-raise is
 * skipped when the customer has their own listener for the signal: then they
 * own termination, exactly as they did without AgentCat.
 *
 * Exported for tests; the deps parameter exists only as a test seam.
 */
export async function runSignalShutdown(
  signal: NodeJS.Signals,
  deps: {
    destroy: () => Promise<void>;
    flush: () => Promise<void>;
    listenerCount: (s: NodeJS.Signals) => number;
    reRaise: (s: NodeJS.Signals) => void;
  } = {
    destroy: () => eventQueue.destroy(),
    flush: () => flushDiagnostics(),
    listenerCount: (s) => process.listenerCount(s),
    reRaise: (s) => process.kill(process.pid, s),
  },
): Promise<void> {
  await Promise.allSettled([deps.destroy(), deps.flush()]);
  try {
    if (deps.listenerCount(signal) === 0) deps.reRaise(signal);
  } catch {
    // Re-raise is best effort; never throw from a signal handler.
  }
}

// Register graceful shutdown handlers if available (Node.js only)
// Edge environments (Cloudflare Workers, etc.) don't have process signals
try {
  if (typeof process !== "undefined" && typeof process.once === "function") {
    process.once("SIGINT", () => void runSignalShutdown("SIGINT"));
    process.once("SIGTERM", () => void runSignalShutdown("SIGTERM"));
    process.once("beforeExit", () => {
      // Natural exit path: flush only — no signal to restore.
      void eventQueue.destroy();
      void flushDiagnostics();
    });
  }
} catch {
  // process.once not available in this environment - graceful shutdown handlers not registered
}

let currentTelemetryManager: TelemetryManager | undefined;

export function setTelemetryManager(telemetryManager: TelemetryManager): void {
  currentTelemetryManager = telemetryManager;
  eventQueue.setTelemetryManager(telemetryManager);
}

export function getTelemetryManager(): TelemetryManager | undefined {
  return currentTelemetryManager;
}

export interface PublishEventContext {
  identity?: UserIdentity | null;
  clientInfo?: ServerClientInfoLike;
}

export function publishEvent(
  server: MCPServerLike,
  eventInput: UnredactedEvent,
  context?: PublishEventContext,
): void {
  const data = getServerTrackingData(server);
  if (!data) {
    writeToLog(
      "Warning: Server tracking data not found. Event will not be published.",
    );
    return;
  }

  if (!data.options.enableTracing) {
    return;
  }

  const sessionInfo = buildSessionInfo(
    server,
    context?.identity,
    context?.clientInfo ?? server.getClientVersion(),
  );

  // Calculate duration if not provided
  const duration =
    eventInput.duration ||
    (eventInput.timestamp
      ? new Date().getTime() - eventInput.timestamp.getTime()
      : undefined);

  // Build complete Event object with all fields explicit
  const fullEvent: UnredactedEvent = {
    // Core fields (id will be generated later in the queue)
    id: eventInput.id || "",
    sessionId: eventInput.sessionId || "",
    projectId: data.projectId,

    // Event metadata
    eventType: eventInput.eventType || "",
    timestamp: eventInput.timestamp || new Date(),
    duration: duration,

    // Session context from sessionInfo
    ipAddress: sessionInfo.ipAddress,
    sdkLanguage: sessionInfo.sdkLanguage,
    agentcatVersion: sessionInfo.agentcatVersion,
    serverName: sessionInfo.serverName,
    serverVersion: sessionInfo.serverVersion,
    clientName: sessionInfo.clientName,
    clientVersion: sessionInfo.clientVersion,

    // Actor information from sessionInfo
    identifyActorGivenId: sessionInfo.identifyActorGivenId,
    identifyActorName: sessionInfo.identifyActorName,
    identifyActorData: sessionInfo.identifyActorData,

    // Event-specific data from input
    resourceName: eventInput.resourceName,
    parameters: eventInput.parameters,
    response: eventInput.response,
    userIntent: eventInput.userIntent,
    isError: eventInput.isError,
    error: eventInput.error,

    // Preserve redaction functions
    redactionFn: eventInput.redactionFn,
    eventRedactionFn: eventInput.eventRedactionFn ?? data.options.redactEvent,

    // Customer-defined metadata
    tags: eventInput.tags,
    properties: eventInput.properties,
  };

  eventQueue.add(fullEvent);
}
