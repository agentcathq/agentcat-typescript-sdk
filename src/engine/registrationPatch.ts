import { MCPServerLike } from "../types.js";
import { writeToLog } from "../modules/logging.js";
import { getLiteralValue, getObjectShape } from "../modules/mcp-sdk-compat.js";

/**
 * Patches setRequestHandler to re-arm the engine when tools/list or
 * tools/call get (re)registered after track().
 *
 * Arity- and type-safe by construction:
 * - v2 passes a method STRING first (2-arg spec form or 3-arg custom form);
 * - v1 passes a Zod request schema first (introspected for its method literal);
 * - ALL arguments are forwarded verbatim — a v2 3-arg custom registration
 *   must reach the SDK intact (dropping the third argument breaks the
 *   customer's server with "handler is required").
 */
export function patchSetRequestHandler(
  server: MCPServerLike,
  onToolHandlerRegistered: () => void,
): void {
  const original = server.setRequestHandler.bind(server);
  server.setRequestHandler = function (...args: any[]) {
    const first = args[0];
    let method: unknown;
    if (typeof first === "string") {
      method = first;
    } else {
      const shape = getObjectShape(first);
      method = shape?.method ? getLiteralValue(shape.method) : undefined;
    }
    const result = (original as any)(...args);
    if (method === "tools/call" || method === "tools/list") {
      try {
        onToolHandlerRegistered();
      } catch (error) {
        writeToLog(`Warning: engine re-arm failed - ${error}`);
      }
    }
    return result;
  } as any;
}
