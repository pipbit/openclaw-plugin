// The OpenClaw runtime object, as handed to the plugin by `setRuntime` when
// the Gateway registers the channel. The channel reads routing and dispatch
// helpers from it. It is NOT set in "tool-discovery" registration mode, so
// nothing may assume it exists before a channel account starts.

import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { silentLogger, type Logger } from "../shared/contracts.ts";

let current: PluginRuntime | null = null;
let pluginLogger: Logger = silentLogger;

export function setPipbitRuntime(runtime: PluginRuntime): void {
  current = runtime;
}

export function tryGetPipbitRuntime(): PluginRuntime | null {
  return current;
}

export function getPipbitRuntime(): PluginRuntime {
  if (!current) {
    throw new Error("The Pipbit channel runtime is not ready yet (the Gateway has not registered the channel).");
  }
  return current;
}

export function clearPipbitRuntime(): void {
  current = null;
}

/** The plugin-wide logger (the Gateway's plugin logger once registered). */
export function setPipbitLogger(logger: Logger): void {
  pluginLogger = logger;
}

export function getPipbitLogger(): Logger {
  return pluginLogger;
}
