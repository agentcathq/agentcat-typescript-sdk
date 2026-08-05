import { HighLevelMCPServerLike, MCPServerLike } from "../types.js";
import { writeToLog } from "../modules/logging.js";
import { stripInjectedArguments } from "../modules/handle-injection.js";
import { VersionAdapter, getInjectedParamsRegistry } from "./registry.js";

// Marks both originals and wrappers so re-sweeps and re-registrations of
// already-wrapped functions are no-ops.
const wrappedFns = new WeakSet<Function>();

/**
 * Wraps the tool function the SDK actually dispatches (adapter.tapKeys),
 * IN PLACE — never a copy: v2's update()/enable()/disable() closures mutate
 * the original object, and copies would diverge from what tools/list serves.
 *
 * The wrap adds two behaviors around the customer function:
 * - strips any AgentCat-injected args that survived SDK validation
 *   (defense-in-depth: callWrap already strips pre-validation; permissive
 *   validators like zod .loose() can still pass them through), and
 * - stashes thrown Errors on extra.__agentcat_error so callWrap can publish
 *   full stack traces after the SDK converts the throw to an isError result.
 */
export function wrapToolEntry(
  tool: any,
  toolName: string,
  server: MCPServerLike,
  adapter: VersionAdapter,
): void {
  if (!tool || typeof tool !== "object") return;
  for (const key of adapter.tapKeys) {
    const fn = tool[key];
    if (typeof fn !== "function") continue;
    if (wrappedFns.has(fn)) return; // already ours, or already wrapped
    const wrapped = async function (this: unknown, ...params: any[]) {
      // Preserve the CALL ARITY of the dispatch invocation: v2 always
      // invokes executor(args, ctx) with two positional arguments — even
      // for schema-less tools, where args is undefined but ctx must stay
      // in position 2. Only the v1 no-args callback convention (dispatch
      // calls cb(extra)) passes a single argument.
      const twoArg = params.length >= 2;
      let args: any;
      let extra: any;
      if (twoArg) {
        args = params[0];
        extra = params[1];
      } else {
        args = undefined;
        extra = params[0];
      }
      const registry = getInjectedParamsRegistry(server);
      const cleaned =
        args === undefined
          ? undefined
          : stripInjectedArguments(args, toolName, registry);
      try {
        return twoArg
          ? await fn.call(this, cleaned, extra)
          : await fn.call(this, extra);
      } catch (error) {
        if (error instanceof Error && extra && typeof extra === "object") {
          (extra as any).__agentcat_error = error;
        }
        throw error;
      }
    };
    wrappedFns.add(wrapped);
    wrappedFns.add(fn);
    tool[key] = wrapped;
    return; // first present key wins
  }
}

/** Idempotent sweep over every registered tool. Called from listWrap. */
export function rewrapAllTools(
  server: MCPServerLike,
  highLevel: HighLevelMCPServerLike,
  adapter: VersionAdapter,
): void {
  try {
    const tools = highLevel._registeredTools;
    if (!tools || typeof tools !== "object") return;
    for (const [name, tool] of Object.entries(tools)) {
      wrapToolEntry(tool, name, server, adapter);
    }
  } catch (error) {
    writeToLog(`Warning: inner-tap sweep failed - ${error}`);
  }
}

/**
 * Proxies _registeredTools so tools registered AFTER track() get the inner
 * tap immediately and the engine re-arms its map wraps (covers v2's lazy
 * setToolRequestHandlers on first registerTool).
 */
export function installRegistryProxy(
  server: MCPServerLike,
  highLevel: HighLevelMCPServerLike,
  adapter: VersionAdapter,
  onRegistration: () => void,
): void {
  try {
    const original = highLevel._registeredTools || {};
    highLevel._registeredTools = new Proxy(original, {
      set(target, property, value): boolean {
        try {
          if (
            typeof property === "string" &&
            value &&
            typeof value === "object"
          ) {
            wrapToolEntry(value, property, server, adapter);
          }
          const ok = Reflect.set(target, property, value);
          onRegistration();
          return ok;
        } catch (error) {
          writeToLog(
            `Warning: Error in registry proxy for tool ${String(property)} - ${error}`,
          );
          return Reflect.set(target, property, value);
        }
      },
    });
    writeToLog("Successfully set up listener for new tool registrations");
  } catch (error) {
    writeToLog(
      `Warning: Failed to setup listener for registered tools - ${error}`,
    );
  }
}
