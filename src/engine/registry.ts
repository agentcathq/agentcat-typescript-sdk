import { HighLevelMCPServerLike } from "../types.js";

/** toolName -> names AgentCat actually injected into that tool's schema. */
export type InjectedParamsRegistry = Map<string, Set<string>>;

const registries = new WeakMap<object, InjectedParamsRegistry>();

export function setInjectedParamsRegistry(
  server: object,
  registry: InjectedParamsRegistry,
): void {
  registries.set(server, registry);
}

export function getInjectedParamsRegistry(
  server: object,
): InjectedParamsRegistry | undefined {
  return registries.get(server);
}

/** toolName set: tools whose declared outputSchema received _mcp_instructions. */
export type OutputInjectionRegistry = Set<string>;

const outputRegistries = new WeakMap<object, OutputInjectionRegistry>();

export function setOutputInjectionRegistry(
  server: object,
  registry: OutputInjectionRegistry,
): void {
  outputRegistries.set(server, registry);
}

export function getOutputInjectionRegistry(
  server: object,
): OutputInjectionRegistry | undefined {
  return outputRegistries.get(server);
}

// ── Engine state ────────────────────────────────────────────────────────────

export interface VersionAdapter {
  major: 1 | 2;
  /** Tool-registry property that dispatch actually invokes; first present wins. */
  tapKeys: readonly string[];
}

export type AnyHandler = (request: any, extra?: any) => Promise<any>;

export interface EngineState {
  adapter: VersionAdapter;
  highLevel?: HighLevelMCPServerLike;
  /** Stored original handlers — each wrapper closes over the one it wrapped. */
  originalList?: AnyHandler;
  originalCall?: AnyHandler;
  /** Our current wrappers, for idempotent re-arm checks. */
  listWrapper?: AnyHandler;
  callWrapper?: AnyHandler;
}

const engineStates = new WeakMap<object, EngineState>();

export function initEngineState(server: object, state: EngineState): void {
  engineStates.set(server, state);
}

export function getEngineState(server: object): EngineState | undefined {
  return engineStates.get(server);
}
