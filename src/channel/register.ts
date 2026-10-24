// What the plugin entry registers beyond the channel itself: the two tools,
// the tool-call guard, and a watch on model calls. OpenClaw runs this in its
// "full" registration mode and again in "tool-discovery" mode; in the latter
// the runtime object is not set, so nothing here touches it, and the hooks
// (they act on real agent runs) are only registered in full mode.

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { HANDBACK_TOOL_NAME, SPEAK_TOOL_NAME } from "../shared/contracts.ts";
import { markModelCallStarted } from "./registry.ts";
import { setPipbitLogger } from "./runtime.ts";
import { createHandbackToolFactory, createSpeakToolFactory, createToolCallGuard } from "./tools.ts";

export function registerPipbitFull(api: OpenClawPluginApi): void {
  api.registerTool(createHandbackToolFactory(), { name: HANDBACK_TOOL_NAME });
  // Two gates, both needed. "optional" is a real OpenClaw gate: an optional
  // plugin tool reaches the model only when the tool policy selects it (the
  // manifest's toolMetadata profiles, the `full` profile's wildcard, or
  // tools.allow / tools.alsoAllow naming it). The plugin's own switch,
  // channels.pipbit.proactiveSpeech, is checked by the factory on every run,
  // because the `full` profile would otherwise hand the tool to every agent.
  api.registerTool(createSpeakToolFactory({ fallbackConfig: () => api.config }), {
    name: SPEAK_TOOL_NAME,
    optional: true,
  });
  if (api.registrationMode === "tool-discovery") {
    return;
  }
  const logger = api.logger;
  setPipbitLogger({
    debug: (message) => logger.debug?.(message),
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  });
  api.on("before_tool_call", createToolCallGuard());
  // Tells a run that failed before any model call (OpenClaw refused it) from
  // one the model itself failed; only the first is asked again without tools
  // (inbound.ts). The event carries no words, only ids and model names.
  api.on("model_call_started", (event, ctx) => {
    markModelCallStarted(ctx.sessionKey ?? event.sessionKey);
  });
}
