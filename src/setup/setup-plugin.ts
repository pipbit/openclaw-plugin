import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  pipbitCapabilities,
  pipbitChannelMeta,
  pipbitConfigAdapter,
  pipbitConfigSchema,
  pipbitLifecycleAdapter,
  pipbitStatusAdapter,
} from "../channel/base.ts";
import { CHANNEL_ID } from "../shared/contracts.ts";
import { pipbitSetupWizard } from "./wizard.ts";

// The setup-only face of the channel. OpenClaw loads it (through
// setup-entry.ts) instead of the full plugin while the channel is disabled or
// not yet configured, and for status, channel lists and secret scans. It
// carries the channel's metadata, config, lifecycle and status adapters and
// the setup wizard; it has no gateway adapter and opens no socket. The
// lifecycle adapter is here because `openclaw channels remove --delete` falls
// back to this registration when the full plugin is not loaded (for example
// while the channel is switched off), and a removed account's state file
// must go with it then too.
//
// It deliberately declares no `reload` block. OpenClaw's default rule for a
// change under `channels.*` reloads the owning plugin, which is what turns
// this setup-only registration into the full plugin once the wizard has
// saved an account. When a registered channel declares
// `reload.configPrefixes`, OpenClaw's reload planner matches those first and
// plans only a channel restart for them (src/gateway/config-reload-plan.ts at
// 2026.9.6), which a setup-only registration cannot serve. OpenClaw 2026.9.4
// has no such default rule (it came in 2026.9.5): there the same change
// restarts the whole Gateway, by itself in OpenClaw's default "hybrid"
// reload mode, and the Gateway comes back with the full plugin.

export const pipbitSetupPlugin: ChannelPlugin = {
  id: CHANNEL_ID,
  meta: pipbitChannelMeta,
  capabilities: pipbitCapabilities,
  config: pipbitConfigAdapter,
  configSchema: pipbitConfigSchema,
  lifecycle: pipbitLifecycleAdapter,
  status: pipbitStatusAdapter,
  setupWizard: pipbitSetupWizard,
};
