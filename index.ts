// The OpenClaw entry for @pipbit/pipbit: registers the Pipbit channel, hands
// it OpenClaw's runtime, and (in full mode) registers its two agent tools and
// the tool-call guard. Everything else lives under src/.

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { pipbitPlugin } from "./src/channel/plugin.ts";
import { registerPipbitFull } from "./src/channel/register.ts";
import { setPipbitRuntime } from "./src/channel/runtime.ts";
import { CHANNEL_ID } from "./src/shared/contracts.ts";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "Pipbit",
  description: "Pipbit Connect for OpenClaw: your OpenClaw agent becomes one of your Pipbit's voice agents.",
  plugin: pipbitPlugin,
  setRuntime: setPipbitRuntime,
  registerFull: registerPipbitFull,
});
