import { Event, UnredactedEvent } from "../types.js";

const BASE64_PATTERN = /^[A-Za-z0-9+/\n\r]+=*$/;
const SIZE_GATE = 10240; // 10KB - skip strings shorter than this

/**
 * Sanitizes an event by redacting non-text content blocks from responses
 * and large base64-encoded strings from parameters.
 *
 * This is a synchronous operation that returns a new object without mutating the original.
 * It should run after customer redaction in the event pipeline.
 */
export function sanitizeEvent<T extends Event | UnredactedEvent>(event: T): T {
  const result = { ...event };

  if (result.response != null) {
    result.response = sanitizeResponse(result.response);
  }

  if (result.parameters != null) {
    result.parameters = sanitizeParameters(result.parameters);
  }

  return result;
}

/**
 * Sanitizes response content blocks by replacing non-text content types
 * with informative redaction messages.
 */
function sanitizeResponse(response: any): any {
  if (response == null || typeof response !== "object") {
    return response;
  }

  const result = { ...response };

  if (Array.isArray(result.content)) {
    result.content = result.content.map(sanitizeContentBlock);
  }

  if (
    result.structuredContent != null &&
    typeof result.structuredContent === "object"
  ) {
    result.structuredContent = sanitizeParameters(result.structuredContent);
  }

  return result;
}

/**
 * Sanitizes a single content block based on its type discriminator.
 */
function sanitizeContentBlock(block: any): any {
  if (block == null || typeof block !== "object") {
    return block;
  }

  switch (block.type) {
    case "text":
      return block;

    case "image":
      return {
        type: "text",
        text: "[image content redacted - not supported by AgentCat]",
      };

    case "audio":
      return {
        type: "text",
        text: "[audio content redacted - not supported by AgentCat]",
      };

    case "resource":
      return sanitizeResourceBlock(block);

    case "resource_link":
      return block;

    default:
      return {
        type: "text",
        text: `[unsupported content type "${block.type}" redacted - not supported by AgentCat]`,
      };
  }
}

/**
 * Sanitizes an embedded resource content block.
 * BlobResourceContents (has `blob` field) are redacted.
 * TextResourceContents (has `text` field) pass through.
 */
function sanitizeResourceBlock(block: any): any {
  if (block.resource && block.resource.blob !== undefined) {
    return {
      type: "text",
      text: "[binary resource content redacted - not supported by AgentCat]",
    };
  }
  return block;
}

/**
 * Recursively scans parameters for large base64-encoded strings and replaces them.
 * Uses a size gate (10KB) to avoid regex testing on small strings.
 */
function sanitizeParameters(obj: any): any {
  if (obj == null) {
    return obj;
  }

  if (typeof obj === "string") {
    if (obj.length >= SIZE_GATE && BASE64_PATTERN.test(obj)) {
      return "[binary data redacted - not supported by AgentCat]";
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeParameters);
  }

  if (obj instanceof Date) {
    return obj;
  }

  if (typeof obj === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeParameters(value);
    }
    return result;
  }

  return obj;
}
