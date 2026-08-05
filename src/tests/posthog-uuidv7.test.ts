import { describe, it, expect } from "vitest";
import { validate as uuidValidate, version as uuidVersion } from "uuid";
import { toUUIDv7 } from "../modules/exporters/posthog.js";
import KSUID from "../thirdparty/ksuid/index.js";

describe("toUUIDv7", () => {
  // Generate a real KSUID with ses_ prefix for realistic test data
  const realSessionId = KSUID.withPrefix("ses").randomSync();

  it("should produce a valid UUIDv7", () => {
    const result = toUUIDv7(realSessionId);
    expect(uuidValidate(result)).toBe(true);
    expect(uuidVersion(result)).toBe(7);
  });

  it("should be deterministic — same input always produces same output", () => {
    const a = toUUIDv7(realSessionId);
    const b = toUUIDv7(realSessionId);
    const c = toUUIDv7(realSessionId);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("should produce different UUIDs for different session IDs", () => {
    const sessionA = KSUID.withPrefix("ses").randomSync();
    const sessionB = KSUID.withPrefix("ses").randomSync();
    expect(toUUIDv7(sessionA)).not.toBe(toUUIDv7(sessionB));
  });

  it("should embed the KSUID timestamp in the UUIDv7", () => {
    // Create a KSUID at a known time
    const knownTime = new Date("2025-06-15T12:00:00Z").getTime();
    const ksuid = KSUID.fromParts(knownTime, Buffer.alloc(16, 0xab));
    const sessionId = `ses_${ksuid.string}`;

    const result = toUUIDv7(sessionId);

    // Extract timestamp from UUIDv7 (first 48 bits = first 12 hex chars)
    const hex = result.replace(/-/g, "");
    const extractedMs = parseInt(hex.substring(0, 12), 16);

    // KSUID has second-level precision, so the extracted timestamp should
    // be within 1 second of the known time
    expect(Math.abs(extractedMs - knownTime)).toBeLessThan(1000);
  });

  it("should set version bits to 7 (0111)", () => {
    const result = toUUIDv7(realSessionId);
    // Version is the 13th hex character (index 14 in the formatted string, index 12 in raw hex)
    const hex = result.replace(/-/g, "");
    const versionNibble = parseInt(hex[12], 16);
    expect(versionNibble).toBe(7);
  });

  it("should set variant bits to 10xx", () => {
    const result = toUUIDv7(realSessionId);
    // Variant is the 17th hex character (index 16 in raw hex)
    const hex = result.replace(/-/g, "");
    const variantNibble = parseInt(hex[16], 16);
    // Must be 8, 9, a, or b (binary 10xx)
    expect(variantNibble).toBeGreaterThanOrEqual(8);
    expect(variantNibble).toBeLessThanOrEqual(0xb);
  });

  it("should handle evt_ prefix", () => {
    const eventId = KSUID.withPrefix("evt").randomSync();
    const result = toUUIDv7(eventId);
    expect(uuidValidate(result)).toBe(true);
    expect(uuidVersion(result)).toBe(7);
  });

  it("should handle invalid KSUID gracefully with fallback timestamp", () => {
    const result = toUUIDv7("ses_invalid_ksuid_string");
    // Should still produce a valid UUIDv7 (hash-derived fallback timestamp)
    expect(uuidValidate(result)).toBe(true);
    expect(uuidVersion(result)).toBe(7);
  });

  it("should be deterministic for non-KSUID input (fallback path)", async () => {
    const first = toUUIDv7("my-customer-task-id");
    // Cross a millisecond boundary to prove the fallback ignores wall time.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = toUUIDv7("my-customer-task-id");
    expect(first).toBe(second);
  });

  it("should produce different UUIDs for different non-KSUID inputs", () => {
    expect(toUUIDv7("task-a")).not.toBe(toUUIDv7("task-b"));
  });

  it("should be deterministic for empty-string input", async () => {
    const first = toUUIDv7("");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(toUUIDv7("")).toBe(first);
    expect(uuidValidate(first)).toBe(true);
    expect(uuidVersion(first)).toBe(7);
  });

  it("should produce timestamps that are before or equal to current time", () => {
    const now = Date.now();
    const result = toUUIDv7(realSessionId);

    const hex = result.replace(/-/g, "");
    const extractedMs = parseInt(hex.substring(0, 12), 16);

    // KSUID creation time should be at or before now
    expect(extractedMs).toBeLessThanOrEqual(now);
  });
});
