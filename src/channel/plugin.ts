// The full Pipbit channel plugin: the setup-safe pieces from base.ts plus
// the running parts (the gateway that holds the Connect link, the security
// note for OpenClaw's audit, and the prompt hints for spoken replies).
//
// There is deliberately NO outbound adapter. OpenClaw's shared `message`
// tool, cron announcements and sub-agent announcements all send through a
// channel's outbound adapter with a destination the model or the job chose;
// without one, a send to Pipbit fails with "Outbound not configured for
// channel: pipbit" (a permanent error for cron and announce delivery). The
// only way for the agent to speak unprompted is the pipbit_speak tool, which
// always targets the paired owner.

import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { CHANNEL_ID, HANDBACK_TOOL_NAME } from "../shared/contracts.ts";
import { ConnectClient } from "../connect/index.ts";
import { pipbitSetupWizard } from "../setup/wizard.ts";
import {
  pipbitCapabilities,
  pipbitChannelMeta,
  pipbitConfigAdapter,
  pipbitConfigSchema,
  pipbitLifecycleAdapter,
  pipbitStatusAdapter,
  type ResolvedPipbitAccount,
} from "./base.ts";
import { createPipbitGatewayAdapter } from "./gateway.ts";
import { PIPBIT_DM_SCOPE } from "./inbound.ts";

/**
 * What the model is told on every Pipbit turn. OpenClaw sends these hints
 * with each inbound turn whatever the prompt mode, while the Pipbit skill is
 * left out of every turn without a verified voice: an ordinary one is
 * limited to pipbit_handback, and the connect intro runs with no tools at
 * all and learns its rule from the intro text (CONNECT_INTRO_UNVERIFIED_NOTE
 * in inbound.ts). So what such a turn must know lives here, in the intro
 * text and in the handback tool's description.
 */
export const pipbitAgentPrompt: NonNullable<ChannelPlugin["agentPrompt"]> = {
  inboundFormattingHints: () => ({
    text_markup: "plain_speech",
    rules: [
      "Replies are spoken aloud by a small voice device (a Pipbit); nothing is shown on a screen.",
      "Answer in one to three short sentences unless the person asks for more; when there is a lot to say, give the gist and offer more.",
      "Use plain words only: no markdown, lists, headings, links, code, tables or emoji.",
      "Say numbers, times and names the way a person would say them aloud.",
      "Everyone near this Pipbit shares one conversation with you: its owner and anyone else in the room.",
      `On a turn where ${HANDBACK_TOOL_NAME} is your only tool, the voice was not recognised as the owner's: answer by voice what you can, and do not promise to do things for them.`,
    ],
  }),
};

export const pipbitPlugin: ChannelPlugin<ResolvedPipbitAccount> = {
  id: CHANNEL_ID,
  meta: { ...pipbitChannelMeta },
  capabilities: pipbitCapabilities,
  reload: {
    configPrefixes: [`channels.${CHANNEL_ID}`],
    // Read live by the speak tool on every run: no restart needed.
    noopPrefixes: [`channels.${CHANNEL_ID}.proactiveSpeech`],
  },
  setupWizard: pipbitSetupWizard,
  config: pipbitConfigAdapter,
  lifecycle: pipbitLifecycleAdapter,
  configSchema: pipbitConfigSchema,
  status: pipbitStatusAdapter,
  gateway: createPipbitGatewayAdapter({
    createClient: (options) => new ConnectClient(options),
  }),
  security: {
    dmRouting: {
      // Every Pipbit subject gets its own session; the channel builds the key
      // itself (inbound.ts), and this tells OpenClaw's audit the same.
      resolveDmScope: () => PIPBIT_DM_SCOPE,
    },
  },
  agentPrompt: pipbitAgentPrompt,
};
