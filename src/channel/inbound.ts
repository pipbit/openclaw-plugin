// From a Pipbit turn to an OpenClaw agent run and back.
//
// Every turn is answered the same way: the Connect client acknowledges it,
// this handler returns a deferred verdict at once ("the answer will follow"),
// OpenClaw runs the agent, and the agent's final words go back as a `reply`
// frame on the turn's reply token. (Handback can only ride a reply frame,
// never an inline answer, which is why even quick answers take this path.)
//
// Sessions: one OpenClaw session per Pipbit subject id. A subject id is one
// pseudonym per Pipbit OWNER per agent, shared by every voice on the device,
// so a guest's words land in the owner's session with an unverified speaker
// flag; that is why the tool gate is decided per turn, not per session.
// The session is never the agent's main session: the key is built here with
// the per-account-channel-peer scope and no cross-channel identity links, and
// a turn whose key would still be the main one is refused.
//
// Turns in one session are answered one at a time, in order, so OpenClaw's
// steer and follow-up queue never folds two Pipbit turns into one run and
// every reply token gets its own answer.
//
// Tools: a turn whose speaker was verified (speaker_verified === true) gets
// the agent's normal tools; every other turn, including one with no verdict
// at all, gets only the handback tool. The connect intro is the exception:
// it never offers the handback (a greeting is not the end of the
// conversation), so a verified intro keeps the agent's other tools and an
// unverified one runs with no tools at all. Speaker verification is a
// user-experience filter, never a security control.
//
// Engagement: the bridge says why the agent was engaged (`engagement`: named
// or router), and the turn body carries the matching one-line note on the
// intro and on the first ordinary turn of each agent session, so the agent
// knows whether to hold the floor (DOC/engagement-kinds-kickoff.md).
//
// What is spoken: only the agent's own final words. OpenClaw's failure
// copy (payloads marked isError) and its no-visible-reply stand-in notice are
// written for an operator reading a chat, so they are never read aloud; the
// turn is settled without an answer and the Gateway log keeps the reason.
//
// Logs carry request ids and outcomes only: never an utterance, a reply
// token, a subject id or anything the agent said. An error's message is
// logged (trimmed) because it is what makes a failure readable, but an error
// from the agent run can quote what the model was sent, so each whole quote
// of the turn's words, the agent's words, the subject id and the session key
// is cut out of it first. A partial quote is not caught.

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import * as replyPayloadSdk from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  CHANNEL_ID,
  HANDBACK_TOOL_NAME,
  silentLogger,
  type ConnectClientApi,
  type EngagementKind,
  type HandlerResult,
  type Logger,
  type ReplyOutcome,
  type TurnHandler,
  type TurnRequest,
} from "../shared/contracts.ts";
import { ConnectUnavailableError, PlatformServerError, SessionGoneError } from "../shared/errors.ts";
import { isAgentSelectionRequired } from "./config-checks.ts";
import { registerInflightTurn, type InflightTurn } from "./registry.ts";
import { sanitizeForSpeech } from "./speech.ts";

/** The session scope every Pipbit turn uses (OpenClaw's audit is told the same). */
export const PIPBIT_DM_SCOPE = "per-account-channel-peer" as const;

/** What the agent is told on the connect intro, in place of the marker. */
export const CONNECT_INTRO_INSTRUCTION =
  "(Pipbit: the person was just handed to you on their Pipbit voice device. Greet them in one short spoken sentence, in your own voice.)";

/**
 * Added to the intro when this turn gives the agent no tools (no verified
 * voice, which is how Pip's own hand-off usually arrives; an intro never
 * offers the handback). OpenClaw shows no skills on such a run, so the intro
 * carries the part of the Pipbit skill that matters there.
 */
export const CONNECT_INTRO_UNVERIFIED_NOTE =
  "(You have no tools on this turn: answer by voice what you can, and do not promise to do things for them.)";

/**
 * What a known engagement kind tells the agent about holding the floor, in
 * the words of DOC/engagement-kinds-kickoff.md. Carried on the intro and on
 * the first ordinary turn of each agent session; an older bridge sends no
 * kind, and the body then carries no note.
 */
export const ENGAGEMENT_NOTES: Readonly<Record<EngagementKind, string>> = {
  named: "The person asked for you by name. Stay with them until they end the conversation or ask for Pip; do not hand back after answering.",
  router:
    "This request was sent to you without your name. Answer it and stay available for a correction; do not hand back yourself, the floor returns to Pip on its own.",
};

/** The note for a turn's engagement kind; empty when the turn carried none. */
export function engagementNote(kind: EngagementKind | null): string {
  return kind ? ENGAGEMENT_NOTES[kind] : "";
}

/**
 * The runtime tool list of the one retry an unverified turn gets when
 * OpenClaw refused its run with only pipbit_handback (tools are switched off
 * too). It keeps the retry on OpenClaw's short prompt, the one every
 * unverified turn gets, which leaves out the owner line ("Authorized
 * Senders"), the memory section and the skills.
 *
 * Why one blank entry, in OpenClaw 2026.9.4 and 2026.9.6: the prompt is the
 * short one whenever the runtime tool list is non-empty and has no wildcard
 * (toolPolicyRestrictsTools), and a run is refused when its runtime tool
 * list leaves no tool to call, even with tools switched off (that list is
 * enforced when tools are disabled). So a real tool name with tools off is
 * refused, and an empty list or no list gets the full prompt. The refusal
 * check drops blank entries before it looks (normalizeStringEntries) while
 * the prompt check counts them, so this list gets the short prompt, no tools
 * and no refusal. openclaw-dispatch.test.ts checks this against the real
 * runner. If a later OpenClaw closes that gap, the retry is either refused
 * (the turn ends unanswered, logged) or runs with the full prompt; it never
 * has a tool.
 */
export const NO_TOOLS_RETRY_TOOLS_ALLOW: readonly string[] = [" "];

/** How long an answered request id is remembered, to drop a redelivered copy. */
const ANSWERED_MEMORY_MS = 15 * 60_000;

/** How long a reply that did not reach Pipbit is sent again for (well inside the 900 s token life). */
export const RESEND_WINDOW_MS = 120_000;
const RESEND_FIRST_DELAY_MS = 2_000;
const RESEND_MAX_DELAY_MS = 15_000;
const RESEND_POLL_MS = 1_000;

type ChannelRuntime = PluginRuntime["channel"];
type TerminalClassifier = (payload: ReplyPayload) => boolean;

/**
 * Which final payloads are the answer itself (not reasoning, commentary, a
 * status notice or a speech supplement). OpenClaw 2026.9.6 exports this
 * classifier as isReplyPayloadTerminalContent; 2026.9.4 and 2026.9.5 do
 * not, and a named import of a missing export fails the whole module when
 * it loads, so the SDK module is read as a namespace and the same rules are
 * applied here when the host lacks them. (9.6 also counts a status notice
 * that answers a command; spoken words never run commands on this channel.)
 */
export function selectTerminalClassifier(sdk: Readonly<Record<string, unknown>>): TerminalClassifier {
  const host = sdk["isReplyPayloadTerminalContent"];
  if (typeof host === "function") {
    return host as TerminalClassifier;
  }
  const readSupplement = sdk["getReplyPayloadTtsSupplement"];
  return (payload) => {
    const fields = payload as ReplyPayload & Record<string, unknown>;
    if (fields.isReasoning === true || fields.isCommentary === true) {
      return false;
    }
    if (fields.isCompactionNotice || fields.isFallbackNotice || fields.isStatusNotice) {
      return false;
    }
    const supplement =
      typeof readSupplement === "function"
        ? (readSupplement(payload) as { visibleTextAlreadyDelivered?: boolean } | undefined)
        : undefined;
    return (
      !supplement ||
      (supplement.visibleTextAlreadyDelivered !== true && typeof fields.text === "string" && fields.text.trim() !== "")
    );
  };
}

export const isTerminalReply: TerminalClassifier = selectTerminalClassifier(
  replyPayloadSdk as unknown as Readonly<Record<string, unknown>>,
);

export interface PipbitRoute {
  agentId: string;
  sessionKey: string;
  mainSessionKey: string;
  /** True when the key would land in the agent's main session (refused). */
  isMain: boolean;
}

/**
 * Route a subject to its own session. An account that names its OpenClaw
 * agent goes straight to that agent: OpenClaw's own routing is not asked,
 * because with several agents, no default and no binding it refuses to pick
 * one (AgentSelectionRequiredError) even though the account says who answers.
 * Otherwise OpenClaw's routing picks the agent. Either way the key is built
 * with the per-account-channel-peer scope and without identity links.
 */
export function resolvePipbitRoute(params: {
  routing: ChannelRuntime["routing"];
  cfg: OpenClawConfig;
  accountId: string;
  subjectId: string;
  agentId: string | null;
}): PipbitRoute {
  const { routing, cfg, accountId } = params;
  const peer = { kind: "direct" as const, id: params.subjectId };
  const routed =
    params.agentId === null
      ? routing.resolveAgentRoute({
          cfg,
          channel: CHANNEL_ID,
          accountId,
          peer,
          dmScope: PIPBIT_DM_SCOPE,
        })
      : null;
  const mainKey = (cfg as { session?: { mainKey?: string } }).session?.mainKey;
  const requestedAgentId = params.agentId ?? routed?.agentId ?? "";
  const sessionKey = routing.buildAgentSessionKey({
    agentId: requestedAgentId,
    ...(mainKey ? { mainKey } : {}),
    channel: CHANNEL_ID,
    accountId,
    peer,
    dmScope: PIPBIT_DM_SCOPE,
  });
  const agentId = agentIdFromSessionKey(sessionKey) ?? requestedAgentId;
  const mainSessionKey = routing.buildAgentSessionKey({
    agentId,
    ...(mainKey ? { mainKey } : {}),
    channel: CHANNEL_ID,
    accountId,
    dmScope: "main",
  });
  const isMain = sessionKey === mainSessionKey || (routed !== null && sessionKey === routed.mainSessionKey);
  return { agentId, sessionKey, mainSessionKey, isMain };
}

/** `agent:<id>:...` -> `<id>` (OpenClaw's normalized agent id). */
export function agentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : null;
}

export interface TurnBodyOptions {
  /**
   * The first ordinary turn the agent sees in this agent session (after the
   * intro, or in its place when none came): the body carries the engagement
   * note, as the intro does.
   */
  firstOrdinaryTurn?: boolean;
}

/** The words the agent sees for a turn. The intro marker is never among them. */
export function buildTurnBody(request: TurnRequest, options: TurnBodyOptions = {}): string {
  const note = engagementNote(request.engagement);
  if (request.isConnectIntro()) {
    const asked = request.handoffContext?.trim();
    const parts = [CONNECT_INTRO_INSTRUCTION];
    if (asked) {
      parts.push(`(When they asked for you they said: "${asked}". Answer that right after your greeting.)`);
    }
    if (note) {
      parts.push(`(Pipbit: ${note})`);
    }
    if (request.speakerVerified !== true) {
      parts.push(CONNECT_INTRO_UNVERIFIED_NOTE);
    }
    return parts.join("\n");
  }
  if (note && options.firstOrdinaryTurn) {
    return `${request.text}\n(Pipbit: ${note})`;
  }
  return request.text;
}

export interface TurnHandlerOptions {
  accountId: string;
  /** `channels.pipbit...agentId`; null lets OpenClaw's routing pick the agent. */
  agentId: string | null;
  /** OpenClaw's channel helpers, read at each turn. */
  channelRuntime: () => ChannelRuntime;
  /** The Gateway config, read at each turn. */
  config: () => OpenClawConfig;
  /** The running client: its link state for resends, and the message fallback when a reply token expired. */
  client: () => ConnectClientApi | null;
  logger?: Logger;
  /** Every turn that carries a subject id: the paired owner's id. */
  onOwner?: (subjectId: string) => void;
  /** Which OpenClaw agent a turn was routed to. */
  onRouted?: (agentId: string) => void;
  /** The agent's spoken greeting, after a connect intro was answered. */
  onGreeting?: (greeting: string) => void;
  onInbound?: () => void;
  onOutbound?: () => void;
  now?: () => number;
  /** Waits between reply resends; stops early when the signal aborts. Test seam. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How long a reply that did not reach Pipbit is sent again for (ms). */
  resendWindowMs?: number;
}

export interface PipbitTurnHandler {
  handle: TurnHandler;
  /** Resolves once every queued and running turn has finished. */
  idle(): Promise<void>;
  /**
   * Abort every queued and running agent run (the account is stopping, so
   * no answer could go out anyway). Each turn then settles without a reply.
   */
  abortAll(): void;
}

interface PendingTurn {
  /** The request to answer (a redelivered copy replaces the original). */
  current: TurnRequest;
  /** Earlier copies of the same request; settled when the run ends. */
  superseded: TurnRequest[];
  abort: AbortController;
}

/** What one agent run left behind. */
interface AttemptOutcome {
  /** OpenClaw admitted the turn and ran it. */
  admitted: boolean;
  /** The agent's own final words, in order (never OpenClaw's failure copy or stand-in notice). */
  finals: string[];
  /** The run ended in failure (OpenClaw's verdict, or a failure payload in place of an answer). */
  failed: boolean;
}

export function createTurnHandler(options: TurnHandlerOptions): PipbitTurnHandler {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? abortableSleep;
  const resendWindowMs = options.resendWindowMs ?? RESEND_WINDOW_MS;
  const chains = new Map<string, Promise<void>>();
  const pending = new Map<string, PendingTurn>();
  const answered = new Map<string, number>();
  // Session key -> the agent session (Pipbit's id for the conversation with
  // this agent) whose first ordinary turn already carried the engagement
  // note. One entry per owner, replaced when a new agent session begins.
  const noted = new Map<string, string>();

  const rememberAnswered = (requestId: string): void => {
    const time = now();
    answered.set(requestId, time + ANSWERED_MEMORY_MS);
    if (answered.size > 256) {
      for (const [id, expires] of answered) {
        if (expires <= time) {
          answered.delete(id);
        }
      }
    }
  };
  const wasAnswered = (requestId: string): boolean => {
    const expires = answered.get(requestId);
    return expires !== undefined && expires > now();
  };

  const enqueue = (sessionKey: string, hide: () => ReadonlyArray<string | null | undefined>, work: () => Promise<void>): void => {
    const previous = chains.get(sessionKey) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      logger.error(`pipbit: a turn failed unexpectedly: ${errorSummary(error, hide())}`);
    });
    chains.set(sessionKey, next);
    void next.then(() => {
      if (chains.get(sessionKey) === next) {
        chains.delete(sessionKey);
      }
    });
  };

  const handle: TurnHandler = (request: TurnRequest): HandlerResult => {
    if (request.isEnvironmentEvent()) {
      // Background device events are not for the agent: answered silently.
      return request.defer();
    }
    const subjectId = request.subjectId?.trim() ?? "";
    if (!subjectId) {
      logger.warn("pipbit: a turn arrived without a subject id; left unanswered");
      return request.defer();
    }
    if (!request.isConnectIntro() && request.text.trim() === "") {
      return request.defer();
    }
    options.onInbound?.();
    options.onOwner?.(subjectId);

    const running = pending.get(request.requestId);
    if (running) {
      // The broker re-sent a turn we are still answering (after a lost
      // socket): answer the newest copy, settle the older one at the end.
      running.superseded.push(running.current);
      running.current = request;
      watchCancel(running, request);
      logger.info(`pipbit: turn ${request.requestId} was delivered again; answering the newest copy`);
      return request.defer({ stillWorking: true });
    }
    if (wasAnswered(request.requestId)) {
      logger.info(`pipbit: turn ${request.requestId} was already answered; ignoring the repeat`);
      return request.defer();
    }

    let route: PipbitRoute;
    try {
      route = resolvePipbitRoute({
        routing: options.channelRuntime().routing,
        cfg: options.config(),
        accountId: options.accountId,
        subjectId,
        agentId: options.agentId,
      });
    } catch (error) {
      if (isAgentSelectionRequired(error)) {
        logger.error(
          `pipbit: turn ${request.requestId} could not be routed: OpenClaw has several agents and none is set to answer on Pipbit; set this account's agentId (the Pipbit status names the config line)`,
        );
      } else {
        logger.error(`pipbit: turn ${request.requestId} could not be routed: ${errorSummary(error, [subjectId, subjectId.toLowerCase()])}`);
      }
      return request.defer();
    }
    if (route.isMain) {
      logger.error(
        `pipbit: turn ${request.requestId} would have landed in the agent's main session; refused (check session and binding config)`,
      );
      return request.defer();
    }
    options.onRouted?.(route.agentId);

    const entry: PendingTurn = { current: request, superseded: [], abort: new AbortController() };
    watchCancel(entry, request);
    pending.set(request.requestId, entry);
    const hideForQueue = (): Array<string | null> => [
      entry.current.text,
      entry.current.handoffContext,
      subjectId,
      subjectId.toLowerCase(),
      route.sessionKey,
    ];
    enqueue(route.sessionKey, hideForQueue, async () => {
      try {
        await runTurn(entry, route, subjectId);
      } finally {
        pending.delete(request.requestId);
      }
    });
    return request.defer({ stillWorking: true });
  };

  const runTurn = async (entry: PendingTurn, route: PipbitRoute, subjectId: string): Promise<void> => {
    const requestId = entry.current.requestId;
    if (entry.current.isCancelled() || entry.abort.signal.aborted) {
      settleAll(entry);
      logger.info(`pipbit: turn ${requestId} was cancelled before it started`);
      return;
    }

    const request = entry.current;
    const verified = request.speakerVerified === true;
    const intro = request.isConnectIntro();
    const inflight: InflightTurn = {
      accountId: options.accountId,
      request,
      verified,
      isConnectIntro: intro,
      handbackRequested: false,
      logger,
    };
    // Everything the agent said in this turn, for scrubbing error messages.
    const spoken: string[] = [];
    // The first ordinary turn of an agent session carries the engagement
    // note once, after the intro or in its place (a quiet resume has none).
    // It counts as carried only once OpenClaw has run the turn (below): a
    // run it did not admit never reached the model, so the next turn of
    // the session carries the note instead.
    const sessionTag = request.agentSessionId ?? "";
    const firstOrdinaryTurn = !intro && noted.get(route.sessionKey) !== sessionTag;
    const body = buildTurnBody(request, { firstOrdinaryTurn });
    const target = `${CHANNEL_ID}:${subjectId}`;
    const timestamp = now();

    // What an error message must never carry into a log line.
    const hidden = (): Array<string | null> => [
      request.text,
      request.handoffContext,
      body,
      subjectId,
      subjectId.toLowerCase(),
      route.sessionKey,
      ...spoken,
    ];

    // "gated": only pipbit_handback. "open": the agent's normal tools (on an
    // intro the handback factory leaves pipbit_handback out, registry.ts).
    // "no-tools": no tools and the same short prompt a gated run gets (see
    // NO_TOOLS_RETRY_TOOLS_ALLOW): the retry after OpenClaw refused a gated
    // run, and every unverified intro from the start, since an intro offers
    // no handback and a gated run with nothing to offer is refused anyway.
    const attempt = async (params: { tools: "gated" | "open" | "no-tools"; messageId: string }): Promise<AttemptOutcome> => {
      const toolsAllow =
        params.tools === "gated" ? [HANDBACK_TOOL_NAME] : params.tools === "no-tools" ? [...NO_TOOLS_RETRY_TOOLS_ALLOW] : null;
      const finals: string[] = [];
      let failurePayloads = 0;
      let terminalOutcome: unknown;
      const cfg = options.config();
      const channel = options.channelRuntime();
      const ctxPayload = channel.inbound.buildContext({
        channel: CHANNEL_ID,
        accountId: options.accountId,
        messageId: params.messageId,
        messageIdFull: params.messageId,
        timestamp,
        from: target,
        sender: { id: subjectId },
        conversation: { kind: "direct", id: subjectId, label: "Pipbit" },
        route: {
          agentId: route.agentId,
          dmScope: PIPBIT_DM_SCOPE,
          accountId: options.accountId,
          routeSessionKey: route.sessionKey,
          dispatchSessionKey: route.sessionKey,
        },
        reply: { to: target, originatingTo: target },
        message: {
          inboundEventKind: "user_request",
          body,
          rawBody: body,
          bodyForAgent: body,
          commandBody: body,
          sourceModality: "voice",
        },
        access: { commands: { authorized: false } },
        // Spoken words never run slash commands.
        extra: { CommandAuthorized: false, CommandInterpretationSuppressed: true },
      });

      // No replyPipeline: it would put OpenClaw's messages.responsePrefix
      // (for example "[Marvin]") in front of every spoken answer.
      const result = await channel.inbound.dispatch({
        cfg,
        channel: CHANNEL_ID,
        accountId: options.accountId,
        route: { agentId: route.agentId, dmScope: PIPBIT_DM_SCOPE, sessionKey: route.sessionKey },
        ctxPayload,
        ...(toolsAllow ? { toolsAllow } : {}),
        replyOptions: {
          abortSignal: entry.abort.signal,
          disableBlockStreaming: true,
          suppressToolProgressMessages: true,
          sourceReplyDeliveryMode: "automatic",
          ...(params.tools === "no-tools" ? { disableTools: true } : {}),
          onAgentRunTerminalOutcome: (outcome: unknown) => {
            terminalOutcome = outcome;
          },
        },
        delivery: {
          deliver: async (payload: ReplyPayload, info) => {
            if (info.kind !== "final" || !isTerminalReply(payload)) {
              return;
            }
            if (payload.isError === true) {
              // OpenClaw's failure copy ("Something went wrong ... use /new"):
              // written for an operator, never read aloud.
              failurePayloads += 1;
              return;
            }
            const text = typeof payload.text === "string" ? payload.text.trim() : "";
            if (text && !finals.includes(text)) {
              finals.push(text);
              spoken.push(text);
            }
          },
          durable: false,
          onError: (error, info) => {
            logger.warn(`pipbit: turn ${requestId} delivery step "${info.kind}" failed: ${errorSummary(error, hidden())}`);
          },
        },
        record: {
          onRecordError: (error) => {
            logger.warn(`pipbit: turn ${requestId} could not be recorded in the session: ${errorSummary(error, hidden())}`);
          },
        },
        messageId: params.messageId,
      });
      const admitted = result.admission.kind === "dispatch" && result.dispatched;
      const dispatchResult = (result as { dispatchResult?: Record<PropertyKey, unknown> }).dispatchResult;
      if (!admitted) {
        logger.info(`pipbit: turn ${requestId} was not run by OpenClaw (${result.admission.kind})`);
      } else if (typeof dispatchResult?.["deferredToActiveRun"] === "string") {
        // Another run already held this session (not a Pipbit turn: those
        // are one at a time), and OpenClaw folded this turn into it.
        logger.warn(
          `pipbit: turn ${requestId} was folded into a run already in progress (${String(dispatchResult["deferredToActiveRun"])}); no answer of its own`,
        );
      }
      if (dispatchResult?.["noVisibleReplyFallbackDelivered"] === true) {
        // The agent gave no answer and OpenClaw sent its stand-in notice
        // ("OpenClaw couldn't produce or deliver a reply ... Reference: <run id>"):
        // that notice is the only final here, and it is not spoken.
        finals.length = 0;
        logger.warn(`pipbit: turn ${requestId}: the agent gave no answer; OpenClaw's stand-in notice is not spoken`);
      }
      if (failurePayloads > 0) {
        logger.warn(
          `pipbit: turn ${requestId}: OpenClaw reported a failure instead of an answer; it is not spoken (the Gateway log has the reason)`,
        );
      }
      const failed =
        terminalOutcome === "failed" || dispatchResult?.[AGENT_RUN_TERMINAL_OUTCOME] === "failed" || failurePayloads > 0;
      return { admitted, finals, failed };
    };

    const unregister = registerInflightTurn(route.sessionKey, inflight);
    const firstTools = verified ? "open" : intro ? "no-tools" : "gated";
    let outcome: AttemptOutcome;
    try {
      outcome = await attempt({ tools: firstTools, messageId: requestId });
      if (
        firstTools === "gated" &&
        outcome.admitted &&
        outcome.failed &&
        outcome.finals.length === 0 &&
        inflight.modelCallStarted !== true &&
        !entry.abort.signal.aborted &&
        !entry.current.isCancelled()
      ) {
        // OpenClaw refused the run before the model was called. With only
        // pipbit_handback allowed, that is its "No callable tools remain
        // after resolving explicit tool allowlist (... runtime toolsAllow:
        // pipbit_handback)" check: the run had no pipbit_handback tool to
        // offer, because the tool policy (tools.allow, an agent's
        // tools.allow, the sandbox tool list) removed it, the model has no
        // tool support, or the tool's factory offered nothing. Ask once more
        // with tools switched off and the same short prompt, so the person
        // still hears an answer and the run sees no more than a gated one
        // would. The new message id keeps OpenClaw's inbound de-duplication
        // from dropping it.
        logger.warn(
          `pipbit: turn ${requestId}: OpenClaw offered no ${HANDBACK_TOOL_NAME} tool for this run (a tool policy, a sandbox tool list, or a model without tool support can cause it; the Pipbit status lists the config causes); asking once more without tools`,
        );
        outcome = await attempt({ tools: "no-tools", messageId: `${requestId}:no-tools` });
      }
    } catch (error) {
      unregister();
      settleAll(entry);
      if (entry.abort.signal.aborted || entry.current.isCancelled()) {
        logger.info(`pipbit: turn ${requestId} was cancelled; nothing sent`);
      } else {
        logger.error(`pipbit: turn ${requestId} failed in the agent run: ${errorSummary(error, hidden())}`);
      }
      return;
    }
    unregister();
    if (firstOrdinaryTurn && outcome.admitted) {
      noted.set(route.sessionKey, sessionTag);
    }

    const answer = entry.current;
    for (const older of entry.superseded) {
      safeSettle(older);
    }
    if (answer.isCancelled() || entry.abort.signal.aborted) {
      safeSettle(answer);
      logger.info(`pipbit: turn ${requestId} was cancelled; nothing sent`);
      return;
    }
    const text = sanitizeForSpeech(outcome.finals.join("\n\n"));
    // A hand-back never rides the greeting (requestHandback already refuses
    // it on an intro; this is the belt on the reply path).
    const handback = inflight.handbackRequested && !inflight.isConnectIntro;
    if (!text) {
      safeSettle(answer);
      if (handback) {
        logger.warn(
          `pipbit: turn ${requestId} asked to hand back to Pip but ended with nothing to say; a handback rides a spoken reply, so none was sent and the person stays with this agent`,
        );
      } else if (outcome.admitted) {
        logger.info(`pipbit: turn ${requestId} ended with nothing to say`);
      }
      return;
    }
    await sendAnswer(answer, text, handback, subjectId, entry.abort.signal);
  };

  const delivered = (request: TurnRequest, text: string): void => {
    rememberAnswered(request.requestId);
    options.onOutbound?.();
    if (request.isConnectIntro()) {
      options.onGreeting?.(text);
    }
  };

  /**
   * Wait before sending a reply again: at least `delayMs`, then until the
   * link reads connected. False when the turn was cancelled, the account is
   * stopping, or the deadline passed.
   */
  const waitToResend = async (delayMs: number, deadline: number, signal: AbortSignal): Promise<boolean> => {
    let wait = delayMs;
    for (;;) {
      const left = deadline - now();
      if (left <= 0 || signal.aborted) {
        return false;
      }
      await sleep(Math.min(wait, left), signal);
      if (signal.aborted || now() >= deadline) {
        return false;
      }
      if (options.client()?.state().state === "connected") {
        return true;
      }
      wait = RESEND_POLL_MS;
    }
  };

  const sendAnswer = async (
    request: TurnRequest,
    text: string,
    handback: boolean,
    subjectId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const requestId = request.requestId;
    const hide = [text, request.text, request.handoffContext, subjectId, subjectId.toLowerCase()];
    const deadline = now() + resendWindowMs;
    let delayMs = RESEND_FIRST_DELAY_MS;
    let resends = 0;
    for (;;) {
      let outcome: ReplyOutcome | null = null;
      let failure: unknown;
      try {
        outcome = await request.reply(text, handback ? { handback: true } : undefined);
      } catch (error) {
        failure = error;
      }
      if (outcome) {
        if (outcome.sent) {
          delivered(request, text);
          const again = resends > 0 ? ` (sent again ${resends} time${resends === 1 ? "" : "s"})` : "";
          logger.info(`pipbit: turn ${requestId} answered${handback ? " and handed back to Pip" : ""}${again}`);
        } else {
          logger.info(`pipbit: turn ${requestId} not answered (${outcome.reason})`);
        }
        return;
      }
      if (isSessionGone(failure)) {
        safeSettle(request);
        break;
      }
      if (!isResendable(failure)) {
        safeSettle(request);
        logger.warn(`pipbit: turn ${requestId} reply was refused: ${errorSummary(failure, hide)}`);
        return;
      }
      // Nothing landed (the link was down, or Pipbit's platform answered 503
      // platform_unavailable): the same reply is safe to send again while
      // the reply token lives. A link_lost or ack_timeout is never resent:
      // that reply may already be on its way to being spoken.
      if (resends === 0) {
        logger.info(`pipbit: turn ${requestId} reply did not reach Pipbit (${notLandedReason(failure)}); sending it again once the link is ready`);
      }
      const ready = await waitToResend(delayMs, deadline, signal);
      if (!ready) {
        safeSettle(request);
        if (signal.aborted || request.isCancelled()) {
          logger.info(`pipbit: turn ${requestId} was cancelled before its reply could be sent again; nothing sent`);
        } else {
          logger.warn(
            `pipbit: turn ${requestId} reply could not reach Pipbit within ${Math.round(resendWindowMs / 1000)} s; the answer was dropped`,
          );
        }
        return;
      }
      resends += 1;
      delayMs = Math.min(delayMs * 2, RESEND_MAX_DELAY_MS);
    }
    // The reply token expired during a long run: say it as a message instead.
    const client = options.client();
    if (!client) {
      logger.warn(`pipbit: turn ${requestId} reply token expired and the link is down; the answer was dropped`);
      return;
    }
    try {
      await client.pushMessage({ text, subjectId });
      delivered(request, text);
      logger.info(`pipbit: turn ${requestId} reply token had expired; sent the answer as a message`);
    } catch (error) {
      logger.warn(`pipbit: turn ${requestId} fallback message failed: ${errorSummary(error, hide)}`);
    }
  };

  return {
    handle,
    idle: async () => {
      while (chains.size > 0) {
        await Promise.all([...chains.values()]);
      }
    },
    abortAll: () => {
      for (const entry of pending.values()) {
        entry.abort.abort();
      }
    },
  };
}

/** OpenClaw's marker on a dispatch result for how the agent run ended. */
const AGENT_RUN_TERMINAL_OUTCOME = Symbol.for("openclaw.agentRunTerminalOutcome");

function settleAll(entry: PendingTurn): void {
  safeSettle(entry.current);
  for (const older of entry.superseded) {
    safeSettle(older);
  }
}

function safeSettle(request: TurnRequest): void {
  try {
    request.settle();
  } catch {
    // Settling twice, or after the link stopped, is harmless.
  }
}

/**
 * A cancel of the copy being answered aborts the agent run. A cancel of a
 * copy that a redelivery already replaced does not.
 */
function watchCancel(entry: PendingTurn, request: TurnRequest): void {
  const onAbort = (): void => {
    if (entry.current === request) {
      entry.abort.abort();
    }
  };
  if (request.signal.aborted) {
    onAbort();
    return;
  }
  request.signal.addEventListener("abort", onAbort, { once: true });
}

function isSessionGone(error: unknown): boolean {
  return (
    error instanceof SessionGoneError ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "SessionGoneError")
  );
}

/**
 * A reply that provably did not land: the link was not up, so nothing was
 * sent (ConnectUnavailableError `not_connected`), or Pipbit's platform was
 * unavailable and the push had no effect (PlatformServerError 503). Anything
 * else is not sent again.
 */
function isResendable(error: unknown): boolean {
  const fields = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    reason?: unknown;
    statusCode?: unknown;
  };
  if (error instanceof ConnectUnavailableError || fields.name === "ConnectUnavailableError") {
    return fields.reason === "not_connected";
  }
  if (error instanceof PlatformServerError || fields.name === "PlatformServerError") {
    return fields.statusCode === 503;
  }
  return false;
}

function notLandedReason(error: unknown): string {
  const fields = (typeof error === "object" && error !== null ? error : {}) as { statusCode?: unknown };
  return fields.statusCode === 503 ? "Pipbit's platform was unavailable" : "the link was down";
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Error class and message, trimmed; never a stack. Every text in `hide`
 * (four characters or longer) is replaced with "[redacted]" wherever it
 * appears whole, longest first, before the message is trimmed, so a hidden
 * text that straddles the 200-character cut is removed rather than left in
 * part. Only whole quotes are caught: a message that quotes part of a hidden
 * text (a provider echoing a fragment of what the person said) still
 * carries that part.
 */
export function errorSummary(error: unknown, hide: readonly (string | null | undefined)[] = []): string {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    return "unknown error";
  }
  const texts = hide
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter((text) => text.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const text of texts) {
    message = message.split(text).join("[redacted]");
  }
  const trimmed = message.length > 200 ? `${message.slice(0, 200)}...` : message;
  return error instanceof Error ? `${error.name}: ${trimmed}` : trimmed;
}
