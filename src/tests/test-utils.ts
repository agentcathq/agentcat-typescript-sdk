import { existsSync, unlinkSync } from "fs";
import { beforeEach, afterEach } from "vitest";
import { Event } from "../types.js";

export const LOG_FILE = "agentcat.log";

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
  private originalEventQueueAdd?: (event: Event) => void;
  private originalSendEvent?: (event: Event, retries?: number) => Promise<void>;

  async start() {
    const eventQueueModule = await import("../modules/eventQueue.js");
    const eq = eventQueueModule.eventQueue as any;
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
    if (this.originalEventQueueAdd && this.originalSendEvent) {
      const eventQueueModule = await import("../modules/eventQueue.js");
      const eq = eventQueueModule.eventQueue as any;
      eq.add = this.originalEventQueueAdd;
      eq.sendEvent = this.originalSendEvent;
      this.originalEventQueueAdd = undefined;
      this.originalSendEvent = undefined;
    }
  }

  getEvents(): Event[] {
    return [...this.capturedEvents];
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
