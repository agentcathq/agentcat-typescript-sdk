import { writeToLog } from "./logging.js";

const TAG_KEY_REGEX = /^[a-zA-Z0-9$_.:\- ]+$/;
const MAX_TAG_KEY_LENGTH = 32;
const MAX_TAG_VALUE_LENGTH = 200;
const MAX_TAG_ENTRIES = 50;

/**
 * Validates and filters a tags object against AgentCat tag constraints.
 * Invalid entries are logged as warnings and dropped.
 * Returns null if no valid entries remain.
 */
export function validateTags(
  tags: Record<string, string>,
): Record<string, string> | null {
  const entries = Object.entries(tags);

  if (entries.length === 0) {
    return null;
  }

  const valid: [string, string][] = [];

  for (const [key, value] of entries) {
    // Key validation
    if (typeof key !== "string" || !TAG_KEY_REGEX.test(key)) {
      writeToLog(
        `Dropping invalid tag: "${String(key)}" — key contains invalid characters or is empty`,
      );
      continue;
    }

    if (key.length > MAX_TAG_KEY_LENGTH) {
      writeToLog(
        `Dropping invalid tag: "${key}" — key exceeds max length of ${MAX_TAG_KEY_LENGTH}`,
      );
      continue;
    }

    // Value validation
    if (typeof value !== "string") {
      writeToLog(
        `Dropping invalid tag: "${key}" — non-string value (got ${typeof value})`,
      );
      continue;
    }

    if (value.length > MAX_TAG_VALUE_LENGTH) {
      writeToLog(
        `Dropping invalid tag: "${key}" — value exceeds max length of ${MAX_TAG_VALUE_LENGTH}`,
      );
      continue;
    }

    if (value.includes("\n")) {
      writeToLog(
        `Dropping invalid tag: "${key}" — value contains newline character`,
      );
      continue;
    }

    valid.push([key, value]);
  }

  if (valid.length === 0) {
    return null;
  }

  if (valid.length > MAX_TAG_ENTRIES) {
    const dropped = valid.length - MAX_TAG_ENTRIES;
    writeToLog(
      `Dropping ${dropped} tag(s) — exceeds maximum of ${MAX_TAG_ENTRIES} entries per event`,
    );
    valid.length = MAX_TAG_ENTRIES;
  }

  return Object.fromEntries(valid);
}
