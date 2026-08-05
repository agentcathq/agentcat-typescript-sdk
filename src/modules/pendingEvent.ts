import { PendingEventFields, UnredactedEvent } from "../types.js";
import { sessionFromHookValue } from "./handles.js";
import { AGENTCAT_TAG_SESSION_SOURCE } from "./constants.js";
import { writeToLog } from "./logging.js";

/**
 * Budget for a deferred customer hook to settle once its event reaches the
 * background pipeline. Hooks are fired at request start, so by the time an
 * event is processed most have long settled; the budget only matters for a
 * hook that hangs — the event then publishes without that hook's data
 * instead of pinning a queue slot forever.
 */
export const PENDING_HOOK_TIMEOUT_MS = 30_000;

const TIMED_OUT = Symbol("agentcat.pending.timeout");

/**
 * Races a hook promise against the fixed budget. The inputs are constructed
 * non-rejecting (invokeSessionHook / the internal.ts resolvers), so the
 * catch here is belt-and-braces. The timer is cleared on settle so fast
 * hooks never hold the event loop open.
 */
async function settleWithTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), PENDING_HOOK_TIMEOUT_MS);
      }),
    ]);
    if (result === TIMED_OUT) {
      writeToLog(
        `Warning: ${label} hook did not settle within ${PENDING_HOOK_TIMEOUT_MS}ms; publishing event without it`,
      );
      return null;
    }
    return result as T;
  } catch (error) {
    writeToLog(`Warning: ${label} hook failed in background - ${error}`);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Applies deferred hook results to an event, in place. Runs as stage 0 of
 * the queue pipeline — before the redactEvent hook, so redaction sees the
 * resolved sessionId/identity/tags/properties, and before sanitization and
 * truncation, so customer-supplied values still go through both.
 *
 * The four hooks are awaited concurrently: worst case adds one budget to
 * the event's background latency, not four.
 */
export async function applyPendingEventFields(
  event: UnredactedEvent,
  pending: PendingEventFields,
): Promise<void> {
  const [hookValue, identity, customerTags, properties] = await Promise.all([
    pending.sessionHookValue
      ? settleWithTimeout(pending.sessionHookValue, "resolveSessionId")
      : null,
    pending.identity ? settleWithTimeout(pending.identity, "identify") : null,
    pending.tags ? settleWithTimeout(pending.tags, "eventTags") : null,
    pending.properties
      ? settleWithTimeout(pending.properties, "eventProperties")
      : null,
  ]);

  if (pending.sessionHookValue) {
    const { sessionId, sessionSource } = sessionFromHookValue(
      hookValue,
      event.projectId || undefined,
    );
    event.sessionId = sessionId;
    event.tags = {
      ...(event.tags ?? {}),
      [AGENTCAT_TAG_SESSION_SOURCE]: sessionSource,
    };
  }

  if (identity) {
    event.identifyActorGivenId = identity.userId;
    event.identifyActorName = identity.userName;
    event.identifyActorData = identity.userData || {};
  }

  // SDK tags stay last-writer: the on-path tags (MRTR, handle, protocol —
  // including the session-source finalized above) win name collisions.
  if (customerTags) {
    event.tags = { ...customerTags, ...(event.tags ?? {}) };
  }

  if (properties) {
    event.properties = properties;
  }
}
