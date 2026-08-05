import { existsSync, unlinkSync } from "fs";
import { beforeEach, afterEach } from "vitest";
import { Event } from "../types.js";

export const LOG_FILE = "agentcat.log";

/**
 * A valid 27-char session ID that still reads as its label in failures.
 * Real KSUIDs are opaque; test fixtures should not be.
 */
export function sid(label: string): string {
  const body = (label.replace(/[^0-9A-Za-z]/g, "") + "0".repeat(27)).slice(
    0,
    27,
  );
  return `ses_${body}`;
}

export function cleanupLogFile() {
  if (existsSync(LOG_FILE)) {
    unlinkSync(LOG_FILE);
  }
}

export const setupTestHooks = () => {
  beforeEach(() => {
    cleanupLogFile();
  });

  afterEach(() => {
    cleanupLogFile();
  });
};

// Event capture helper for testing
export class EventCapture {
  private capturedEvents: Event[] = [];
  private eq?: any;
  private originalEventQueueAdd?: (event: Event) => void;
  private originalSendEvent?: (event: Event, retries?: number) => Promise<void>;

  async start() {
    // The queue reference is kept on the instance so stop() never has to
    // re-import — a dynamic import in afterEach can stall on loaded CI
    // runners (vite-node module RPC) and blow the hook timeout.
    const eventQueueModule = await import("../modules/eventQueue.js");
    this.eq = eventQueueModule.eventQueue as any;
    const eq = this.eq;
    this.originalEventQueueAdd = eq.add.bind(eq);
    this.originalSendEvent = eq.sendEvent.bind(eq);

    // Capture at add() (synchronous) to keep this instance's events tied to
    // this instance, then defer to the real add() so process() runs the
    // redact/sanitize/truncate pipeline — those mutate the captured event in
    // place via Object.assign. sendEvent is stubbed so no real HTTP goes out.
    eq.add = (event: Event) => {
      this.capturedEvents.push(event);
      this.originalEventQueueAdd!(event);
    };
    eq.sendEvent = async (_event: Event) => {};
  }

  async stop() {
    if (this.eq && this.originalEventQueueAdd && this.originalSendEvent) {
      this.eq.add = this.originalEventQueueAdd;
      this.eq.sendEvent = this.originalSendEvent;
      this.originalEventQueueAdd = undefined;
      this.originalSendEvent = undefined;
      this.eq = undefined;
    }
  }

  getEvents(): Event[] {
    return [...this.capturedEvents];
  }

  /**
   * Waits until every event THIS capture has seen finishes the queue
   * pipeline. Events are captured at add() time and mutated in place
   * (deferred hook results land in stage 0), so assertions on
   * identity/tags/properties/hook-mode sessionId must flush first. The
   * completion marker is the event id, minted as the pipeline's final step
   * before send. Scoped per capture so hung-hook events left in flight by
   * other tests cannot stall this one.
   */
  async flush(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.capturedEvents.every((e: any) => e.id)) return;
      if (Date.now() > deadline) {
        throw new Error(
          "EventCapture.flush timed out waiting for captured events to finish processing",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  clear() {
    this.capturedEvents = [];
  }

  findEventByType(eventType: string): Event | undefined {
    return this.capturedEvents.find((e) => e.eventType === eventType);
  }

  findEventsByResourceName(resourceName: string): Event[] {
    return this.capturedEvents.filter((e) => e.resourceName === resourceName);
  }
}
