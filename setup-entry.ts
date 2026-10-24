import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { pipbitSetupPlugin } from "./src/setup/setup-plugin.ts";

// The setup-only entry (package.json `openclaw.setupEntry`): what OpenClaw
// loads while the Pipbit channel is disabled or not yet paired, and for
// status and channel lists. It carries the setup wizard and opens no socket.
export default defineSetupPluginEntry(pipbitSetupPlugin);
