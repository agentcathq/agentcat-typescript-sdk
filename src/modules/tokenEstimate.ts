/**
 * Token estimates for tool-call events.
 *
 * One divisor, pinned byte-for-byte across the TypeScript, Python, and Go
 * SDKs: ceil(utf8Bytes / 3.5). Measured on production MCP responses, the
 * inner text runs 3.71 bytes per token on OpenAI tokenizers and about 3.15
 * on Claude's; 3.5 splits the difference. The input side counts the raw
 * arguments the model emitted; the output side counts the content-block text
 * the harness feeds back. Nothing else counts. See
 * docs/superpowers/specs/2026-09-19-sdk-token-estimates-design.md.
 */

export const TOKEN_ESTIMATE_BYTES_PER_TOKEN = 3.5;

/** The server's MAX_TOKEN_COUNT: the columns are int32. */
const MAX_TOKEN_COUNT = 2_147_483_647;

/** UTF-8 byte length without allocating an encoded copy. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair encodes one 4-byte code point.
        bytes += 4;
        i++;
      } else {
        // A lone surrogate encodes as U+FFFD, three bytes.
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** ceil(bytes / 3.5), 0 for nothing, clamped to the server's int32 column. */
export function estimateTokens(bytes: number): number {
  if (!(bytes > 0)) return 0;
  return Math.min(
    Math.ceil(bytes / TOKEN_ESTIMATE_BYTES_PER_TOKEN),
    MAX_TOKEN_COUNT,
  );
}

/**
 * UTF-8 length of the compact JSON. JSON.stringify already uses compact
 * separators and escapes neither non-ASCII nor <, >, & — the same bytes the
 * Python (ensure_ascii=False) and Go (SetEscapeHTML(false)) SDKs count.
 */
function compactJsonBytes(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? utf8ByteLength(json) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tokens the model spent emitting the call: the raw arguments object,
 * injected parameters included. undefined when there are no arguments.
 *
 * Never throws: this runs inside the customer's request, and a failure to
 * estimate must cost at most this field, never the tool's response.
 */
export function estimateInputTokens(args: unknown): number | undefined {
  try {
    if (args === undefined || args === null) return undefined;
    const bytes = compactJsonBytes(args);
    return bytes === undefined ? undefined : estimateTokens(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Tokens the model reads back: the text of the content blocks. Falls back to
 * the whole response when it carries no content list; undefined when there
 * is no response at all.
 *
 * Never throws, for the same reason as estimateInputTokens.
 */
export function estimateOutputTokens(response: unknown): number | undefined {
  try {
    if (response === undefined || response === null) return undefined;
    const content = (response as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      const bytes = compactJsonBytes(response);
      return bytes === undefined ? undefined : estimateTokens(bytes);
    }
    let bytes = 0;
    for (const block of content) {
      bytes += contentBlockBytes(block);
    }
    return estimateTokens(bytes);
  } catch {
    return undefined;
  }
}

function contentBlockBytes(block: unknown): number {
  if (!block || typeof block !== "object") return 0;
  const b = block as {
    type?: unknown;
    text?: unknown;
    resource?: { text?: unknown } | null;
  };
  if (b.type === "text" && typeof b.text === "string") {
    return utf8ByteLength(b.text);
  }
  if (
    b.type === "resource" &&
    b.resource &&
    typeof b.resource === "object" &&
    typeof b.resource.text === "string"
  ) {
    return utf8ByteLength(b.resource.text);
  }
  return 0;
}
