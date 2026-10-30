import { HookSessionFinalizer, MCPServerLike } from "../types.js";
import { loadNodeModule } from "./runtime-versions.js";
import { writeToLog } from "./logging.js";

/**
 * The session of one traced tool call, exactly as its tool-call event
 * publishes it. A custom event published inside the call's handler, on the
 * same server and without its own sessionId, joins this session.
 */
export interface ToolCallScope {
  /** The low-level server whose tools/call handler AgentCat wrapped. */
  server: MCPServerLike;
  /** The call's session ID: empty for an invalid or foreign session_id, and in hook mode. */
  sessionId: string;
  /** Hook mode: the call's shared session finalization. */
  hookSession?: HookSessionFinalizer;
}

/** The slice of node:async_hooks AsyncLocalStorage this module uses. */
export interface ScopeStorage {
  run<R>(store: ToolCallScope, fn: () => R): R;
  getStore(): ToolCallScope | undefined;
}

// undefined: not loaded yet. null: AsyncLocalStorage is unavailable in this
// runtime, so no call is ever scoped and custom events keep the no-session path.
let storage: ScopeStorage | null | undefined;

function loadStorage(): ScopeStorage | null {
  if (storage !== undefined) return storage;
  storage = null;
  try {
    const asyncHooks =
      loadNodeModule<typeof import("node:async_hooks")>("node:async_hooks");
    if (typeof asyncHooks?.AsyncLocalStorage === "function") {
      storage = new asyncHooks.AsyncLocalStorage<ToolCallScope>();
    }
  } catch (error) {
    writeToLog(`Warning: AsyncLocalStorage failed to load - ${error}`);
  }
  if (!storage) {
    writeToLog(
      "AsyncLocalStorage is unavailable in this runtime; custom events published inside a tool call do not join its session unless eventData.sessionId is set",
    );
  }
  return storage;
}

/**
 * Runs the customer's tool handler with the call's session in async context:
 * the handler and every async task it starts, also after the call returns,
 * can read it with getEnclosingToolCall. When the scope cannot be entered,
 * the handler still runs exactly once, unscoped. The handler's own errors
 * pass through untouched.
 *
 * @param scope - The session of this tool call
 * @param fn - Invokes the customer's handler
 * @returns Whatever fn returns
 */
export function runInToolCallScope<R>(scope: ToolCallScope, fn: () => R): R {
  const als = loadStorage();
  if (!als) return fn();
  let entered = false;
  try {
    return als.run(scope, () => {
      entered = true;
      return fn();
    });
  } catch (error) {
    if (entered) throw error;
    writeToLog(
      `Warning: AgentCat could not scope tool call to its session; custom events inside it publish without a session - ${error}`,
    );
    return fn();
  }
}

/**
 * The innermost traced tool call this code runs inside, when that call
 * belongs to `server`. Undefined outside any traced call, inside another
 * server's call, and when the lookup fails (logged).
 *
 * @param server - The low-level server a custom event is published with
 * @returns The enclosing call's scope, or undefined
 */
export function getEnclosingToolCall(
  server: MCPServerLike,
): ToolCallScope | undefined {
  // Not loaded means no tool call has entered a scope yet.
  if (!storage) return undefined;
  try {
    const scope = storage.getStore();
    return scope && scope.server === server ? scope : undefined;
  } catch (error) {
    writeToLog(
      `Warning: AgentCat could not read the enclosing tool call; publishing without a session - ${error}`,
    );
    return undefined;
  }
}

/**
 * Test seam: replaces the scope storage. Pass null for a runtime without
 * AsyncLocalStorage, undefined to load it lazily again.
 */
export function _setScopeStorageForTest(
  replacement: ScopeStorage | null | undefined,
): void {
  storage = replacement;
}
