import { getMCPCompatibleErrorMessage } from "./compatibility.js";
import { writeToLog } from "./logging.js";

export type BackgroundTaskRegistrar = (task: Promise<void>) => void;

let backgroundTaskRegistrar: BackgroundTaskRegistrar | undefined;

/**
 * Installs the runtime-specific background task registrar.
 *
 * This is intentionally internal. Runtime entrypoints configure it so public
 * AgentCat APIs stay environment-agnostic.
 */
export function setBackgroundTaskRegistrar(
  registrar: BackgroundTaskRegistrar | undefined,
): void {
  backgroundTaskRegistrar = registrar;
}

/**
 * Extends the current runtime invocation for a task when the active runtime
 * supports it. Registration failures are fail-open so analytics can never
 * break the customer's request.
 */
export function registerBackgroundTask(task: Promise<void>): void {
  if (!backgroundTaskRegistrar) return;

  try {
    backgroundTaskRegistrar(task);
  } catch (error) {
    writeToLog(
      `Failed to register AgentCat event delivery as a background task: ${getMCPCompatibleErrorMessage(error)}`,
    );
  }
}
