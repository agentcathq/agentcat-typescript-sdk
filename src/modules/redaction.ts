import {
  Event,
  RedactEventFunction,
  RedactFunction,
  UnredactedEvent,
} from "../types.js";

/**
 * Set of field names that should be protected from redaction.
 * These fields contain system-level identifiers and metadata that
 * need to be preserved for analytics tracking.
 */
const PROTECTED_FIELDS = new Set([
  "sessionId",
  "id",
  "projectId",
  "server",
  "identifyActorGivenId",
  "identifyActorName",
  "identifyData",
  "resourceName",
  "eventType",
  "actorId",
  "tags",
  "properties",
]);

/**
 * Recursively applies a redaction function to all string values in an object.
 * This ensures that sensitive information is removed from all string fields
 * before events are sent to the analytics service.
 *
 * @param obj - The object to redact strings from
 * @param redactFn - The redaction function to apply to each string
 * @param path - The current path in the object tree (used to check protected fields)
 * @param isProtected - Whether the current object/value is within a protected field
 * @param seen - Clones of objects already visited on this walk. Cycles in
 *   customer-supplied data (hook payloads, tool responses) must terminate:
 *   because each level suspends at an await, an unguarded cycle starves the
 *   event loop and dies in an uncatchable V8 heap-limit abort rather than a
 *   stack overflow. Same policy as normalize() in truncation.ts.
 * @returns A new object with all strings redacted
 */
async function redactStringsInObject(
  obj: any,
  redactFn: RedactFunction,
  path: string = "",
  isProtected: boolean = false,
  seen: WeakMap<object, any> = new WeakMap(),
): Promise<any> {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle strings
  if (typeof obj === "string") {
    // Don't redact if this field or any parent field is protected
    if (isProtected) {
      return obj;
    }
    return await redactFn(obj);
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    const existing = seen.get(obj);
    if (existing) return existing;
    const redactedArr: any[] = [];
    // Register the clone BEFORE descending so a back-edge resolves to it.
    seen.set(obj, redactedArr);
    for (let index = 0; index < obj.length; index++) {
      redactedArr[index] = await redactStringsInObject(
        obj[index],
        redactFn,
        `${path}[${index}]`,
        isProtected,
        seen,
      );
    }
    return redactedArr;
  }

  // Handle dates (don't redact)
  if (obj instanceof Date) {
    return obj;
  }

  // Handle objects
  if (typeof obj === "object") {
    const existing = seen.get(obj);
    if (existing) return existing;
    const redactedObj: any = {};
    // Register the clone BEFORE descending so a back-edge resolves to it.
    seen.set(obj, redactedObj);

    for (const [key, value] of Object.entries(obj)) {
      // Skip functions and undefined values
      if (typeof value === "function" || value === undefined) {
        continue;
      }

      // Build the path for nested fields
      const fieldPath = path ? `${path}.${key}` : key;
      // Check if this field is protected (only check at top level)
      const isFieldProtected =
        isProtected || (path === "" && PROTECTED_FIELDS.has(key));
      redactedObj[key] = await redactStringsInObject(
        value,
        redactFn,
        fieldPath,
        isFieldProtected,
        seen,
      );
    }

    return redactedObj;
  }

  // For all other types (numbers, booleans, etc.), return as-is
  return obj;
}

/**
 * Applies the customer's redaction function to all string fields in an Event object.
 * This is the main entry point for redacting sensitive information from events
 * before they are sent to the analytics service.
 *
 * @param event - The event to redact
 * @param redactFn - The customer's redaction function
 * @returns A new event object with all strings redacted
 */
export async function redactEvent(
  event: UnredactedEvent,
  redactFn: RedactFunction,
): Promise<Event> {
  return redactStringsInObject(event, redactFn, "", false) as Promise<Event>;
}

/**
 * Set of system-managed fields that are restored after the event-level
 * redaction hook runs. These are required for ingestion and session/project
 * attribution, so consumer changes to them are ignored.
 */
const RESTORED_FIELDS = [
  "id",
  "sessionId",
  "projectId",
  "eventType",
  "timestamp",
] as const;

/**
 * Applies the customer's event-level redaction hook to an event, in place.
 * The hook receives the full event (without internal function fields) and may
 * return a modified event, or null/undefined to drop the event entirely.
 *
 * The event object is rewritten rather than replaced: the queue pipeline and
 * its observers hold references to the same object across processing steps,
 * and clearing before assigning ensures fields the hook deleted stay deleted.
 * System-managed fields are restored from the original, and the string-level
 * `redactionFn` is preserved so it still runs afterwards.
 *
 * @param event - The event to run the hook on; mutated with the hook's result
 * @param eventRedactFn - The customer's event-level redaction hook
 * @returns True if the event was kept, false if the hook dropped it
 */
export async function applyEventRedaction(
  event: UnredactedEvent,
  eventRedactFn: RedactEventFunction,
): Promise<boolean> {
  const { redactionFn, eventRedactionFn: _e, ...hookInput } = event;
  const result = await eventRedactFn(hookInput as Event);

  if (result === null || result === undefined) {
    return false;
  }

  const redactedEvent: UnredactedEvent = { ...result, redactionFn };
  delete redactedEvent.eventRedactionFn;

  // System-managed fields are not consumer-settable
  for (const field of RESTORED_FIELDS) {
    if (event[field] === undefined) {
      delete redactedEvent[field];
    } else {
      (redactedEvent as any)[field] = event[field];
    }
  }

  for (const key of Object.keys(event)) {
    delete event[key as keyof UnredactedEvent];
  }
  Object.assign(event, redactedEvent);
  return true;
}
