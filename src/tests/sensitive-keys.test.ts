import { describe, it, expect } from "vitest";
import {
  isSensitiveKey,
  maskSensitiveKeys,
} from "../modules/sensitive-keys.js";
import vectors from "./fixtures/sensitive-keys-vectors.json";

// The vectors come from the shared reference implementation; every SDK passes the same file.
describe("sensitive keys vectors", () => {
  it("classifies every key case", () => {
    for (const c of vectors.keys) {
      expect(isSensitiveKey(c.key), c.key).toBe(c.sensitive);
    }
  });

  it("masks every tree case without changing the input", () => {
    for (const c of vectors.trees) {
      const before = structuredClone(c.input);
      expect(maskSensitiveKeys(c.input), c.name).toEqual(c.expected);
      expect(c.input, c.name).toEqual(before);
    }
  });

  it("masks a cycle and a subtree deeper than the walk limit", () => {
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    expect(maskSensitiveKeys(cyclic)).toEqual({ a: 1, self: "[redacted]" });
    let deep: any = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    let masked: any = maskSensitiveKeys(deep);
    for (let i = 0; i < 10; i++) masked = masked.d;
    expect(masked).toBe("[redacted]");
  });
});
