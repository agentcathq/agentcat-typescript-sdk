// Masks the values of sensitive keys (credential headers, tokens, secrets) in an event field.
// A port of the shared reference implementation; src/tests/fixtures/sensitive-keys-vectors.json
// holds its test vectors.
import { MAX_DEPTH } from "./truncation.js";

export const MASK = "[redacted]";

// A key matches a name when its canonical form equals the name or ends with "-" + name.
// prettier-ignore
const EXACT = [
  "accesskey", "cb-access-sign", "cf-access-client-id", "dpop", "fastly-key",
  "jenkins-crumb", "paypal-transmission-sig", "plaid-verification",
  "sec-websocket-protocol", "x-airtable-content-mac", "x-amzn-ava-user-context",
  "x-amzn-oidc-data", "x-firebase-appcheck", "x-forge-oauth-system",
  "x-forge-oauth-user", "x-honeycomb-team", "x-insert-key", "x-jfrog-art-api",
  "x-nf-sign", "x-registry-config", "x-requestdigest", "x-sfdc-session",
  "x-trello-webhook", "x-vault-mfa", "x-vercel-protection-bypass", "x-wp-nonce",
];
// A key matches when its canonical form contains the word.
// prettier-ignore
const CONTAINS = [
  "authorization", "secret", "password", "passwd", "passphrase", "cookie", "signature",
  "credential", "jwt", "assertion", "bearer", "csrf", "xsrf", "hmac", "saml",
  "api-key", "apikey", "access-key", "private-key", "privatekey", "subscription-key",
  "encryption-key", "signing-key", "shared-key", "sharedkey", "master-key",
  "account-key", "app-key", "appkey", "application-key", "functions-key", "sas-key",
  "license-key", "consumer-key", "client-key", "customer-key",
];
// A key matches when one hyphen-separated part of its canonical form equals the word.
const SEGMENT = ["auth", "token", "otp"];
// A key matches when its canonical form ends with the word.
const SUFFIX = ["token"];

// The pair rule: a map that names a key in one entry and holds its value in another.
const PAIR_NAME_KEYS = ["name", "key", "header"];
const PAIR_VALUE_KEYS = ["value", "values"];
// The children of a map stored under this exact key are JSON Schema property names.
const SCHEMA_PROPERTIES_KEY = "properties";

function camelSplit(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (i > 0 && "A" <= ch && ch <= "Z") {
      const prev = text[i - 1];
      const nxt = i + 1 < text.length ? text[i + 1] : "";
      if (("a" <= prev && prev <= "z") || ("0" <= prev && prev <= "9")) {
        out += "-";
      } else if ("A" <= prev && prev <= "Z" && "a" <= nxt && nxt <= "z") {
        out += "-";
      }
    }
    out += ch;
  }
  return out;
}

function canonicalParts(text: string): string[] {
  let out = "";
  for (const ch of text) {
    if ("A" <= ch && ch <= "Z") {
      out += String.fromCharCode(ch.charCodeAt(0) + 32);
    } else if (("a" <= ch && ch <= "z") || ("0" <= ch && ch <= "9")) {
      out += ch;
    } else {
      out += "-";
    }
  }
  const parts = out.split("-").filter((p) => p !== "");
  while (
    parts.length > 0 &&
    [...parts[parts.length - 1]].every((c) => "0" <= c && c <= "9")
  ) {
    parts.pop();
  }
  return parts;
}

function partsMatch(parts: string[]): boolean {
  if (parts.length === 0) return false;
  const joined = parts.join("-");
  for (const name of EXACT) {
    if (joined === name || joined.endsWith("-" + name)) return true;
  }
  for (const word of CONTAINS) {
    if (joined.includes(word)) return true;
  }
  for (const part of parts) {
    if (SEGMENT.includes(part)) return true;
  }
  for (const word of SUFFIX) {
    if (joined.endsWith(word)) return true;
  }
  return false;
}

export function isSensitiveKey(key: string): boolean {
  return (
    partsMatch(canonicalParts(key)) ||
    partsMatch(canonicalParts(camelSplit(key)))
  );
}

function canonical(key: string): string {
  return canonicalParts(key).join("-");
}

function isMap(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function maskValue(
  value: unknown,
  underProperties: boolean,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined || typeof value === "boolean") {
    return value;
  }
  if (isMap(value) && underProperties) {
    return maskSensitiveKeys(value, false, depth, seen);
  }
  return MASK;
}

/**
 * A masked copy of `value`. `underProperties` is true when `value` is the map stored under the
 * key "properties". Like normalize() in truncation.ts, a cycle or a subtree deeper than
 * MAX_DEPTH stops the walk; that subtree becomes MASK.
 */
export function maskSensitiveKeys(
  value: unknown,
  underProperties = false,
  depth = MAX_DEPTH,
  seen = new WeakSet<object>(),
): unknown {
  if (!Array.isArray(value) && !isMap(value)) return value;
  if (seen.has(value) || depth <= 0) return MASK;
  seen.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => maskSensitiveKeys(item, false, depth - 1, seen));
  } else {
    const masked: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        masked[key] = maskValue(child, underProperties, depth - 1, seen);
      } else {
        masked[key] = maskSensitiveKeys(
          child,
          key === SCHEMA_PROPERTIES_KEY,
          depth - 1,
          seen,
        );
      }
    }
    let namesASensitiveKey = false;
    for (const [key, child] of Object.entries(value)) {
      if (PAIR_NAME_KEYS.includes(canonical(key))) {
        if (typeof child === "string" && isSensitiveKey(child)) {
          namesASensitiveKey = true;
        }
      }
    }
    if (namesASensitiveKey) {
      for (const [key, child] of Object.entries(value)) {
        if (PAIR_VALUE_KEYS.includes(canonical(key))) {
          masked[key] = maskValue(child, false, depth - 1, seen);
        }
      }
    }
    out = masked;
  }
  seen.delete(value);
  return out;
}
