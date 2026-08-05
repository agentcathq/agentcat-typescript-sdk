import { writeToLog } from "./logging.js";

/**
 * Projects the request-handler `extra` into a JSON-publishable value for the
 * event's `parameters.extra`. The pipeline's walkers (redaction,
 * sanitization, truncation) traverse own enumerable keys only, so host
 * objects whose data lives behind prototype getters flatten to `{}`:
 *
 * - v2 (`@modelcontextprotocol/server`): `http.req` is a WHATWG Request —
 *   replaced with a plain `{ method, url, headers }` (headers verbatim).
 * - v1 (`@modelcontextprotocol/sdk`): `requestInfo.url` is a URL instance —
 *   replaced with its `.href` string. `requestInfo.headers` is already a
 *   plain object and passes through untouched.
 *
 * Duck-typed, never instanceof: workerd's Request is a different realm than
 * undici's. Shallow-copies only the levels it rewrites (extra, http,
 * requestInfo); everything else passes by reference, and when nothing needs
 * rewriting the original `extra` is returned unchanged. Never throws — a
 * projection failure must not cost the event.
 */
export function projectExtraForEvent(extra: unknown): unknown {
  if (extra === null || typeof extra !== "object") return extra;

  try {
    let out: Record<string, any> | null = null;

    // v2: http.req is a web Request. `headers.entries` doubles as the
    // duck-type probe and the iteration source; an already-projected plain
    // req has no such function, so re-projection is a no-op.
    const req = (extra as any).http?.req;
    if (
      req !== null &&
      typeof req === "object" &&
      req.headers !== null &&
      typeof req.headers === "object" &&
      typeof req.headers.entries === "function"
    ) {
      out = {
        ...(extra as any),
        http: {
          ...(extra as any).http,
          req: {
            ...(typeof req.method === "string" ? { method: req.method } : {}),
            ...(typeof req.url === "string" ? { url: req.url } : {}),
            headers: Object.fromEntries(req.headers.entries()),
          },
        },
      };
    }

    // v1: requestInfo.url is a URL instance (an already-string url passes
    // through untouched).
    const url = (extra as any).requestInfo?.url;
    if (
      url !== null &&
      typeof url === "object" &&
      typeof url.href === "string"
    ) {
      if (out === null) out = { ...(extra as Record<string, any>) };
      out.requestInfo = { ...(extra as any).requestInfo, url: url.href };
    }

    return out ?? extra;
  } catch (error) {
    writeToLog(
      `Warning: Failed to project request context into event parameters, publishing extra as-is - ${error}`,
    );
    return extra;
  }
}
