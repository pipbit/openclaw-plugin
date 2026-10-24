// The plugin's two agent tools, and the guard that keeps every other tool
// away from an unverified Pipbit turn.
//
// pipbit_handback  Ends the agent's part of the conversation: the reply to
//                  the current Pipbit turn goes out with `handback: true`, and
//                  Pip (the Pipbit's own assistant) speaks next. No parameters.
//                  Offered only inside a Pipbit turn, and never on the connect
//                  intro: a greeting is not the end of the conversation
//                  (DOC/engagement-kinds-kickoff.md).
//
// pipbit_speak     Says something on the owner's Pipbit unprompted (a
//                  reminder the agent promised). It has NO destination
//                  parameter: the message always goes to the paired owner's
//                  subject id, so a prompt cannot point it at anyone else.
//                  Off unless `channels.pipbit.proactiveSpeech` is true
//                  (OpenClaw's "optional" tool flag alone is not enough: the
//                  manifest lists the tool under every tool profile, and the
//                  "full" profile's wildcard selects optional tools too).
//                  Who may have it once it is on:
//                    - a run answering a Pipbit turn: only when that turn's
//                      speaker was verified. OpenClaw marks a Pipbit turn as
//                      not from its owner (a Pipbit subject id is not on its
//                      owner list, and if someone put it there it would
//                      cover every voice on the device alike), so its owner
//                      flag says nothing here; the Pipbit verdict decides,
//                      as it does for every other tool.
//                    - any other run: not when OpenClaw marks it as driven by
//                      someone who is not the owner (for example a group
//                      member on another channel). Scheduled runs leave
//                      that flag unset; for a chat OpenClaw sets it true
//                      only when commands.ownerAllowFrom lists the sender
//                      (or for an admin Control UI client) and false for
//                      everyone else, so without that list no chat run gets
//                      the tool.
//
// The guard reads the turn's speaker verdict (`speaker_verified`): only a
// verified speaker's turn may use tools other than pipbit_handback. Speaker
// verification is a user-experience filter, never a security control.
//
// OpenClaw builds a tool from its factory for each agent run, handing over
// the run's context (session key, channel, agent); the factories return null
// to leave a tool out of a run. They read only the in-process registries,
// never the runtime object, so they are safe in "tool-discovery" mode.

import type { AnyAgentTool, OpenClawConfig, OpenClawPluginToolContext, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/core";
import { CHANNEL_ID, HANDBACK_TOOL_NAME, SPEAK_TOOL_NAME } from "../shared/contracts.ts";
import { isProactiveSpeechEnabled, resolveDefaultPipbitAccountId } from "./base.ts";
import { getInflightTurn, getRunningAccount, listRunningAccounts, requestHandback, type RunningAccount } from "./registry.ts";
import { sanitizeForSpeech } from "./speech.ts";

/** Longest unprompted message, in characters (before speech cleanup). */
export const SPEAK_MAX_CHARS = 600;

// The handback rides the spoken reply of the same turn, so an empty reply
// hands nothing back: both texts ask for one short line in the agent's own
// words (the answer still owed, or a brief acknowledgement), never nothing,
// and leave goodbyes to Pip. They are also the only guidance an ordinary
// turn without a verified voice gets about the handback, since OpenClaw
// shows no skills on a run limited to this one tool (an unverified connect
// intro runs with no tools at all and learns its rule from the intro body,
// CONNECT_INTRO_UNVERIFIED_NOTE in inbound.ts). The description also says
// when the tool is for and when it is not: the first time it reached an
// OpenClaw agent (2026-10-18) the agent handed back on every turn, greeting
// included. Not being able to help stays a reason, so that Pip can route
// the request elsewhere; having finished one is not.
export const HANDBACK_DESCRIPTION =
  "Hand the conversation back to Pip, the Pipbit's own assistant, once your reply on this turn has been spoken. Use it only when the person says they are done with you, asks for Pip by name, or wants something you cannot help with, so Pip can route it. It is not for a greeting, and not for having finished what they asked: they may have a follow-up or a correction for you, and Pip takes the floor back on her own when they move on. Still reply on this turn with one short line in your own words: what they still need, or a brief acknowledgement. Never leave that reply empty, because the handback travels with it. Skip any goodbye speech: Pip speaks next.";

export const HANDBACK_RESULT_TEXT =
  "Handback set. Now reply with one short line in your own words, what they still need or a brief acknowledgement; it is the last thing they hear from you before Pip takes over. Do not leave it empty, and skip any goodbye speech.";

export const SPEAK_DESCRIPTION =
  "Say something out loud on your owner's Pipbit voice device without being asked, for example a reminder you promised. It always goes to the person who added you to their Pipbit and cannot reach anyone else. Keep it to one or two short spoken sentences, with no formatting. Pipbit limits how often an agent may speak unprompted.";

const HANDBACK_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const SPEAK_PARAMETERS = {
  type: "object",
  properties: {
    text: {
      type: "string",
      minLength: 1,
      maxLength: SPEAK_MAX_CHARS,
      description: "What to say, as plain spoken words.",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

type ToolParameters = AnyAgentTool["parameters"];

/** The config the tool should read: the freshest the context offers. */
function configOf(ctx: OpenClawPluginToolContext, fallback?: () => OpenClawConfig | undefined): OpenClawConfig | undefined {
  return ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config ?? fallback?.();
}

// ---------------------------------------------------------------------------
// pipbit_handback
// ---------------------------------------------------------------------------

export function createHandbackToolFactory(): OpenClawPluginToolFactory {
  return (ctx) => {
    if (ctx.messageChannel !== CHANNEL_ID) {
      return null;
    }
    const sessionKey = ctx.sessionKey;
    const turn = sessionKey ? getInflightTurn(sessionKey) : undefined;
    // Never on the connect intro: a greeting is not the end of the
    // conversation, and a model offered the tool there took the hint.
    if (!sessionKey || !turn || turn.isConnectIntro) {
      return null;
    }
    const tool: AnyAgentTool = {
      name: HANDBACK_TOOL_NAME,
      label: "Hand back to Pip",
      description: HANDBACK_DESCRIPTION,
      parameters: HANDBACK_PARAMETERS as unknown as ToolParameters,
      catalogMode: "direct-only",
      async execute() {
        if (!requestHandback(sessionKey)) {
          throw new Error(
            getInflightTurn(sessionKey)?.isConnectIntro
              ? "This turn is your connect greeting, where a hand-back is ignored: greet them and stay."
              : "There is no Pipbit turn in progress here, so there is nothing to hand back.",
          );
        }
        return {
          content: [{ type: "text", text: HANDBACK_RESULT_TEXT }],
          details: { handback: true },
        };
      },
    };
    return tool;
  };
}

// ---------------------------------------------------------------------------
// pipbit_speak
// ---------------------------------------------------------------------------

export interface SpeakToolOptions {
  /** The config to read when the run context carries none (the plugin api's). */
  fallbackConfig?: () => OpenClawConfig | undefined;
}

/**
 * The running account the speak tool talks through, for this run: the one
 * serving the current Pipbit turn; else the one whose OpenClaw agent is the
 * calling agent; else the default account, but only to a caller that is its
 * agent. The serving agent is the account's agentId, else the agent
 * OpenClaw's routing picked when the account started (or the last turn was
 * routed to); while it is unknown, no named agent gets the default account.
 * It must be connected and know its owner.
 */
export function pickSpeakAccount(
  ctx: Pick<OpenClawPluginToolContext, "agentId" | "agentAccountId" | "messageChannel">,
  cfg: OpenClawConfig | undefined,
): RunningAccount | null {
  const usable = listRunningAccounts().filter(isUsable);
  if (usable.length === 0) {
    return null;
  }
  if (ctx.messageChannel === CHANNEL_ID && ctx.agentAccountId) {
    const own = usable.find((account) => account.accountId === ctx.agentAccountId);
    if (own) {
      return own;
    }
  }
  const agentId = normalize(ctx.agentId);
  if (agentId) {
    const matching = usable.find((account) => (account.agentId ?? account.routedAgentId) === agentId);
    if (matching) {
      return matching;
    }
  }
  const defaultId = resolveDefaultPipbitAccountId(cfg);
  const fallback = usable.find((account) => account.accountId === defaultId);
  if (!fallback) {
    return null;
  }
  const owner = fallback.agentId ?? fallback.routedAgentId;
  if (agentId && owner !== agentId) {
    return null;
  }
  return fallback;
}

export function createSpeakToolFactory(options: SpeakToolOptions = {}): OpenClawPluginToolFactory {
  return (ctx) => {
    if (!mayOfferSpeak(ctx)) {
      return null;
    }
    const cfg = configOf(ctx, options.fallbackConfig);
    if (!isProactiveSpeechEnabled(cfg)) {
      return null;
    }
    const chosen = pickSpeakAccount(ctx, cfg);
    if (!chosen) {
      return null;
    }
    const accountId = chosen.accountId;
    const tool: AnyAgentTool = {
      name: SPEAK_TOOL_NAME,
      label: "Speak on Pipbit",
      description: SPEAK_DESCRIPTION,
      parameters: SPEAK_PARAMETERS as unknown as ToolParameters,
      async execute(_toolCallId, rawParams, signal) {
        const raw = readText(rawParams);
        const text = sanitizeForSpeech(raw, { maxChars: SPEAK_MAX_CHARS });
        if (!text) {
          throw new Error("Nothing to say: the text was empty once formatting was removed. Nothing was sent.");
        }
        if (signal?.aborted) {
          throw new Error("Cancelled before anything was sent.");
        }
        const account = getRunningAccount(accountId);
        if (!account || !isUsable(account) || !account.client || !account.ownerSubjectId) {
          throw new Error("Pipbit is not connected right now, so nothing was sent.");
        }
        let delivered: boolean;
        try {
          const result = await account.client.pushMessage({ text, subjectId: account.ownerSubjectId });
          delivered = isDeliveredLive(result.data);
        } catch (error) {
          throw new Error(describeSpeakFailure(error));
        }
        return {
          content: [
            {
              type: "text",
              text: delivered
                ? "Said on your owner's Pipbit just now."
                : "Pipbit accepted it but could not say it right away; it is queued on Pipbit.",
            },
          ],
          details: { status: delivered ? "delivered" : "queued" },
        };
      },
    };
    return tool;
  };
}

/**
 * Whether this run's speaker may have pipbit_speak at all (the switch and
 * the account are checked after). A run answering a Pipbit turn: only when
 * the turn's speaker was verified, whatever OpenClaw's owner flag says (it
 * reads false on a Pipbit turn); an unverified turn is also held to
 * pipbit_handback by its tool list and the tool-call guard. Any other run:
 * not when OpenClaw marks its sender as someone other than the owner.
 */
function mayOfferSpeak(ctx: Pick<OpenClawPluginToolContext, "messageChannel" | "sessionKey" | "senderIsOwner">): boolean {
  const pipbitTurn = ctx.messageChannel === CHANNEL_ID ? getInflightTurn(ctx.sessionKey) : undefined;
  if (pipbitTurn) {
    return pipbitTurn.verified;
  }
  return ctx.senderIsOwner !== false;
}

/** The platform's `live_delivery.delivered` flag from a message result. */
export function isDeliveredLive(data: Record<string, unknown> | null): boolean {
  const live = data?.live_delivery;
  return typeof live === "object" && live !== null && (live as { delivered?: unknown }).delivered === true;
}

/** Plain words for why a message was not sent (never the text itself). */
export function describeSpeakFailure(error: unknown): string {
  const fields = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
    reason?: unknown;
  };
  const name = typeof fields.name === "string" ? fields.name : "";
  if (fields.code === "rate_limited" || fields.statusCode === 429) {
    return "Pipbit is limiting how often this agent may speak unprompted. Nothing was sent; try again in a minute.";
  }
  if (name === "ConnectUnavailableError") {
    return "Pipbit is not connected right now, so nothing was sent.";
  }
  if (name === "ConnectError") {
    return "The connection dropped before Pipbit answered, so it is not known whether it was said. Do not repeat it straight away.";
  }
  if (fields.code === "not_found" || fields.statusCode === 404 || name === "SessionGoneError") {
    return "Pipbit no longer knows this agent's owner (it may have been removed from their Pipbit). Nothing was sent.";
  }
  if (name === "PlatformServerError") {
    return "Pipbit had a problem and nothing was sent. Try again later.";
  }
  return "Pipbit did not accept the message, so nothing was sent.";
}

function isUsable(account: RunningAccount): boolean {
  return account.link === "connected" && account.client !== null && account.ownerSubjectId !== null;
}

function readText(params: unknown): string {
  if (typeof params === "object" && params !== null) {
    const text = (params as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

function normalize(agentId: string | undefined): string | null {
  const trimmed = typeof agentId === "string" ? agentId.trim().toLowerCase() : "";
  return trimmed === "" ? null : trimmed;
}

// ---------------------------------------------------------------------------
// The tool-call guard (defence in depth beside the per-turn tool list)
// ---------------------------------------------------------------------------

// Only an ordinary unverified turn can reach this: an unverified connect
// intro runs with tools switched off, so no call gets this far there.
export const UNVERIFIED_BLOCK_REASON =
  "This Pipbit speaker was not recognised as the owner, so only pipbit_handback is available on this turn.";

/**
 * A `before_tool_call` handler: while the calling session is answering a
 * Pipbit turn whose speaker was not verified, every tool except the
 * handback tool is blocked. Other sessions are untouched.
 */
export function createToolCallGuard(): (
  event: { toolName: string },
  ctx: { sessionKey?: string },
) => { block: true; blockReason: string } | undefined {
  return (event, ctx) => {
    const turn = getInflightTurn(ctx.sessionKey);
    if (!turn || turn.verified) {
      return undefined;
    }
    if (event.toolName === HANDBACK_TOOL_NAME) {
      return undefined;
    }
    return { block: true, blockReason: UNVERIFIED_BLOCK_REASON };
  };
}
