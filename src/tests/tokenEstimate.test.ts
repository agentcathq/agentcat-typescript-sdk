import { describe, it, expect } from "vitest";
import {
  TOKEN_ESTIMATE_BYTES_PER_TOKEN,
  utf8ByteLength,
  estimateTokens,
  estimateInputTokens,
  estimateOutputTokens,
} from "../modules/tokenEstimate.js";

// Shared vectors: pinned byte-for-byte against the Python and Go SDKs. See
// docs/superpowers/specs/2026-09-19-sdk-token-estimates-design.md.

describe("estimateTokens", () => {
  it("pins the divisor", () => {
    expect(TOKEN_ESTIMATE_BYTES_PER_TOKEN).toBe(3.5);
  });

  it.each([
    [0, 0],
    [1, 1],
    [7, 2],
    [13, 4],
    [4096, 1171],
    [7516192765, 2147483647],
  ])("bytes %i -> %i tokens", (bytes, tokens) => {
    expect(estimateTokens(bytes)).toBe(tokens);
  });
});

describe("utf8ByteLength", () => {
  it.each([
    ["", 0],
    ["hello", 5],
    ["café", 5],
    ["你好", 6],
    ["😀", 4],
    ["\ud83d", 3], // lone high surrogate encodes as U+FFFD
  ])("%j -> %i bytes", (text, bytes) => {
    expect(utf8ByteLength(text)).toBe(bytes);
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
  });
});

describe("estimateInputTokens (raw arguments)", () => {
  it.each([
    [{ q: "hello" }, 4],
    [{}, 1],
    [{ name: "café" }, 5],
    [{ html: "<a>&</a>" }, 6],
    [{ t: "你好" }, 4],
    [{ ids: [1, 2, 3], opts: { deep: true, n: null } }, 13],
  ])("%j -> %i", (args, tokens) => {
    expect(estimateInputTokens(args)).toBe(tokens);
  });

  it("omits the field for absent arguments", () => {
    expect(estimateInputTokens(undefined)).toBeUndefined();
    expect(estimateInputTokens(null)).toBeUndefined();
  });

  it("omits the field when the arguments cannot be serialized", () => {
    const circular: any = {};
    circular.self = circular;
    expect(estimateInputTokens(circular)).toBeUndefined();
  });

  it("never throws: a toJSON that throws yields an omitted field", () => {
    const hostile = {
      toJSON() {
        throw new Error("boom");
      },
    };
    expect(() => estimateInputTokens(hostile)).not.toThrow();
    expect(estimateInputTokens(hostile)).toBeUndefined();
  });
});

describe("estimateOutputTokens (content blocks)", () => {
  const text = (t: string) => ({ type: "text", text: t });

  it.each([
    [{ content: [text("hello world")] }, 4],
    [{ content: [text("abcd"), text("e")] }, 2],
    [{ content: [text("")] }, 0],
    [{ content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] }, 0],
    [
      {
        content: [
          {
            type: "resource",
            resource: { uri: "file:///a", text: "resource body" },
          },
        ],
      },
      4,
    ],
    [
      {
        content: [
          { type: "resource", resource: { uri: "file:///a", blob: "QUJD" } },
        ],
      },
      0,
    ],
    [
      { content: [text("hi")], structuredContent: { big: "y".repeat(1000) } },
      1,
    ],
    [{ content: [text("x".repeat(4096))] }, 1171],
    [{ content: [text("hi")], isError: true }, 1],
    [{ content: [], structuredContent: { result: "ok" } }, 5],
    [{ content: [] }, 0],
    [{ content: [], structuredContent: null }, 0],
    [
      {
        content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
        structuredContent: { result: "ok" },
      },
      0,
    ],
  ])("%j -> %i", (response, tokens) => {
    expect(estimateOutputTokens(response)).toBe(tokens);
  });

  it("falls back to the whole response when there is no content list", () => {
    expect(estimateOutputTokens({ result: "ok" })).toBe(5);
  });

  it("omits the field for an absent response", () => {
    expect(estimateOutputTokens(undefined)).toBeUndefined();
    expect(estimateOutputTokens(null)).toBeUndefined();
  });

  it("ignores blocks whose text is not a string", () => {
    expect(
      estimateOutputTokens({
        content: [{ type: "text", text: 42 }, null, "str"],
      }),
    ).toBe(0);
  });

  it("never throws: a content getter that throws yields an omitted field", () => {
    const hostile = {
      get content(): unknown {
        throw new Error("boom");
      },
    };
    expect(() => estimateOutputTokens(hostile)).not.toThrow();
    expect(estimateOutputTokens(hostile)).toBeUndefined();
  });
});
