import { join } from "node:path";

// The contracts between the plugin's four parts. Each part implements or
// consumes these types and never reaches into another part's files:
//
//   src/connect  the Pipbit Connect client: the WebSocket, the frames, the
//                reconnect rules. Knows nothing about OpenClaw.
//   src/pairing  the agent pairing routes and the name rules. Knows nothing
//                about OpenClaw either.
//   src/channel  the OpenClaw channel: runs the client inside the Gateway,
//                turns Pipbit turns into agent runs, owns the two tools and
//                the status line.
//   src/setup    the OpenClaw setup wizard: drives a pairing and writes the
//                account into the Gateway config.
//
// The wire contract itself is SDK/connect_spec/v1/PROTOCOL.md; this file
// only fixes the TypeScript shapes the parts hand each other.

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** OpenClaw plugin id, channel id and config key (`channels.pipbit`). */
export const CHANNEL_ID = "pipbit";
export const PLUGIN_VERSION = "0.1.1";

/** The two agent tools the plugin registers (listed in openclaw.plugin.json). */
export const HANDBACK_TOOL_NAME = "pipbit_handback";
export const SPEAK_TOOL_NAME = "pipbit_speak";

/** Name the platform shows for the client software in hello (metrics only). */
export const HELLO_CLIENT_NAME = "pipbit-openclaw";
/**
 * Name sent as `client.name` when starting a pairing. Pip says it aloud
 * ("Clementine from OpenClaw"), so it must read naturally.
 */
export const PAIRING_CLIENT_NAME = "OpenClaw";
/** `agency_name` for a paired agent; spoken in Pip's hand-off announcement. */
export const PAIRING_AGENCY_NAME = "OpenClaw";
/** Spoken name used when the OpenClaw agent has no configured name. */
export const FALLBACK_DISPLAY_NAME = "OpenClaw";

export const DEFAULT_BASE_URL = "https://api.pipbit.ai";
export const DEFAULT_CONNECT_URL = "wss://api.pipbit.ai/v1/connect";
export const SUBPROTOCOL = "pipbit.connect.v1";

/** Turn utterances that are markers, never words to show a model. */
export const CONNECT_INTRO_UTTERANCE = "__pipbit_agent_connected__";
export const ENVIRONMENT_EVENT_UTTERANCE = "__pipbit_environment_event__";

// ---------------------------------------------------------------------------
// Logging (every part takes one; nothing is ever logged that carries the
// agent secret, a session token, a pairing code, a device code, a reply
// token or an utterance)
// ---------------------------------------------------------------------------

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

// ---------------------------------------------------------------------------
// src/connect: the client
// ---------------------------------------------------------------------------

/**
 * The client's own view of its link, the same five words the conformance
 * adapter reports (SDK/connect_spec/v1/schemas/adapter.json link_state):
 * connecting (no hello.ack yet since start), connected, reconnecting (the
 * link dropped after at least one hello.ack; backing off or redialling),
 * stopped (never started, or stopped), failed (a fatal refusal; the client
 * never dials again).
 */
export type LinkStateName = "connecting" | "connected" | "reconnecting" | "stopped" | "failed";

export interface LinkState {
  state: LinkStateName;
  /** The last hello.error word or close reason the link saw, else null. */
  reason: string | null;
  /** The broker's id for the current socket while connected, else null. */
  connectionId: string | null;
  /** The `revoked` frame's word while `reason` is `revoked`, else null. */
  detail: string | null;
  /** Sockets this client object has opened (counted when the upgrade succeeds). */
  dials: number;
  /** The WebSocket close code of the last socket that ended, else null. */
  lastCloseCode: number | null;
  /** Epoch ms of the next dial while backing off, else null. */
  nextDialAtMs: number | null;
}

/** The client software block sent in hello and in the pairing start. */
export interface ClientInfo {
  name: string;
  version: string;
  runtime?: string;
}

/** One conversation item as the platform sends it. */
export interface ConversationItem {
  role: string;
  text: string;
}

/**
 * Why the agent was engaged, as the bridge reports it in the turn's optional
 * `engagement` field (spec 1.8.0): "named" when the person asked for the
 * agent by name or Pip connected it at their request, "router" when Pip sent
 * an un-named request to it. The agent's hand-back rule follows it
 * (DOC/engagement-kinds-kickoff.md).
 */
export type EngagementKind = "named" | "router";

/** What `handler` may return for a turn. */
export type HandlerResult = string | DeferredResult | { text: string } | null | undefined;

/** Returned by `TurnRequest.defer()`. */
export interface DeferredResult {
  readonly kind: "deferred";
  /**
   * false (the default, the SDK's `defer()`): the turn is settled the moment
   * the deferred verdict goes out; a later cancel answers `already_replied`.
   * true: the caller is still working and will call `reply()` or `settle()`;
   * until then a cancel answers `cancelled` and aborts `signal`.
   */
  readonly stillWorking: boolean;
}

export interface ReplyOptions {
  /** Hand the conversation back to Pip after this reply is spoken. */
  handback?: boolean;
  /** Only beside `handback: true`; today only `needs_wifi` means anything. */
  handbackReason?: string;
}

/** The platform's answer to a `reply` or `message` frame that succeeded. */
export interface PushResult {
  statusCode: number;
  /** The platform route's JSON body (the `result` frame's `data`). */
  data: Record<string, unknown> | null;
}

export type ReplyOutcome =
  | { sent: true; result: PushResult }
  | { sent: false; reason: "cancelled" | "already_settled" };

/**
 * One turn, parsed from the `turn` frame's payload (PROTOCOL.md section 7).
 * The client acknowledges the frame before the handler ever sees this.
 */
export interface TurnRequest {
  readonly requestId: string;
  readonly replyToken: string;
  /** The utterance, trimmed. A marker for intros and environment events. */
  readonly text: string;
  readonly sessionId: string | null;
  /** One pseudonym per Pipbit owner per agent; every voice on the device shares it. */
  readonly subjectId: string | null;
  readonly agentSessionId: string | null;
  readonly deviceId: string | null;
  /** What the person said beyond the agent's name when they asked for it. */
  readonly handoffContext: string | null;
  readonly managerName: string | null;
  readonly conversation: readonly ConversationItem[];
  readonly deviceShadow: Readonly<Record<string, unknown>> | null;
  readonly environmentEvent: Readonly<Record<string, unknown>> | null;
  /** The wire field `family_mode`, true only when sent as true. */
  readonly multiUser: boolean;
  /**
   * The speaker verdict: true, false, or null when the turn carried none.
   * Speaker verification is a user-experience filter, never a security control.
   */
  readonly speakerVerified: boolean | null;
  readonly speakerBasis: string | null;
  /** The engagement kind, or null when the turn carried none (an older bridge). */
  readonly engagement: EngagementKind | null;
  /** The broker re-sent this turn after a lost socket. */
  readonly redelivery: boolean;
  /** Aborts when a `cancel` frame withdraws this turn while it is still open. */
  readonly signal: AbortSignal;
  /** The raw payload, as received. */
  readonly payload: Readonly<Record<string, unknown>>;

  isConnectIntro(): boolean;
  isEnvironmentEvent(): boolean;
  isCancelled(): boolean;
  /** Tell the platform the answer will follow separately (see DeferredResult). */
  defer(options?: { stillWorking?: boolean }): DeferredResult;
  /**
   * Send the answer to a deferred turn as a `reply` frame on this turn's
   * token, then settle the turn. Sends nothing once the turn was cancelled or
   * already settled. Rejects with the shared errors on a platform refusal.
   */
  reply(text: string, options?: ReplyOptions): Promise<ReplyOutcome>;
  /** Finish a still-working deferred turn without an answer. */
  settle(): void;
}

export type TurnHandler = (request: TurnRequest) => HandlerResult | Promise<HandlerResult>;

export interface PushMessageParams {
  text: string;
  subjectId?: string;
  deviceId?: string;
  sessionId?: string;
  /**
   * Since connect spec 1.10.0, each sent only when given: how the message
   * reaches the person ("speak" or "announce"), the word the manager
   * assistant introduces it with, and the sender's own id for the
   * platform's 24-hour duplicate check. The channel itself sends none.
   */
  delivery?: string;
  hint?: string;
  clientMessageId?: string;
}

/** Minimal WebSocket surface the client needs; `ws` provides it. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "unexpected-response", listener: (request: unknown, response: { statusCode?: number }) => void): this;
}

export type WebSocketFactory = (url: string, protocols: string[], options: { handshakeTimeoutMs: number; maxPayloadBytes: number }) => WebSocketLike;

export interface ConnectClientOptions {
  /** The agent's registered (internal) name. */
  agent: string;
  /** The agent secret; used only inside the hello proof, never sent. */
  secret: string;
  /** `wss://api.pipbit.ai/v1/connect` in production. */
  connectUrl: string;
  handler: TurnHandler;
  client: ClientInfo;
  logger?: Logger;
  /** Called on every link state change, with a copy of the state. */
  onStateChange?: (state: LinkState) => void;
  /** Called on every frame received or sent (keeps OpenClaw's health monitor fed). */
  onActivity?: () => void;
  /** Test seams. */
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
  random?: () => number;
}

/** The client's public face, implemented by src/connect/client.ts. */
export interface ConnectClientApi {
  /** Start dialling at once; does not wait for the hello.ack. */
  start(): void;
  /** Close with 1000 and wait up to timeoutMs for running handlers. */
  stop(timeoutMs?: number): Promise<void>;
  state(): LinkState;
  /** A `reply` frame outside a turn object (the conformance harness uses it). */
  pushReply(replyToken: string, text: string, options?: ReplyOptions): Promise<PushResult>;
  /** A `reply` frame with `silent: true` and no text: the turn gets no spoken reply, on purpose. */
  pushSilence(replyToken: string, options?: ReplyOptions): Promise<PushResult>;
  /** A `message` frame. At least one of subjectId or deviceId is required. */
  pushMessage(params: PushMessageParams): Promise<PushResult>;
}

// ---------------------------------------------------------------------------
// src/pairing: the pairing flow
// ---------------------------------------------------------------------------

/** The code the person says, as the start route returned it (no device code). */
export interface PairingCode {
  pairingId: string;
  /** Six digits, `472915`. Never shown on its own and never logged. */
  userCode: string;
  /** `472 915`. */
  userCodeDisplay: string;
  /** The platform's sentence, shown verbatim: On your Pipbit, say: "Pip, please add ...". */
  instructions: string;
  expiresInS: number;
  intervalS: number;
  requestedName: string;
  displayName: string;
  /** Epoch ms when the start answered (the lifetime counts from here). */
  startedAtMs: number;
}

/** The claim: shown by the platform exactly once. `secret` is never logged. */
export interface PairingClaim {
  pairingId: string;
  agentName: string;
  secret: string;
  baseUrl: string;
  connectUrl: string;
  /** The platform's public agent record. */
  agent: Record<string, unknown>;
}

/** What the flow needs from whoever shows it to the person (the wizard). */
export interface PairingFlowUi {
  /** Show the sentence. `reminted` is true when this code replaced an expired one. */
  showCode(code: PairingCode, info: { reminted: boolean }): Promise<void>;
  /**
   * Asked when a code expired: after the one automatic new code was used, or
   * at every expiry when the flow runs with `autoRemint: false`.
   */
  confirmNewCode(): Promise<boolean>;
  /**
   * The spoken name was refused (reserved for Pipbit's own assistant, or not
   * usable). Show `message` in one line and return another spoken name, or
   * null to give up.
   */
  askForAnotherName(message: string): Promise<string | null>;
  /** Progress while waiting for the person; seconds left on the current code. */
  onWaiting?(secondsLeft: number): void;
}

export interface PairingFlowOptions {
  /** What the person will say to their Pipbit ("Home Brain"). */
  displayName: string;
  baseUrl: string;
  client: ClientInfo;
  agencyName?: string;
  description?: string;
  ui: PairingFlowUi;
  /**
   * Replace the first expired code without asking (the default, true). The
   * wizard passes false on a remote prompter (the Control UI), where a
   * cancelled session is invisible to the flow: every new code is then asked
   * for through `ui.confirmNewCode`, which throws once the session is gone.
   */
  autoRemint?: boolean;
  /** Aborting cancels the pending pairing on the platform (device code). */
  signal?: AbortSignal;
  logger?: Logger;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Between src/channel and src/setup: the Gateway config and the state file
// ---------------------------------------------------------------------------

/** A SecretInput: a plain string, `${ENV}`, or an OpenClaw SecretRef object. */
export type SecretInput = string | { source: string; provider?: string; id: string };

/** One paired Pipbit agent: `channels.pipbit.accounts.<accountId>`. */
export interface PipbitAccountConfig {
  enabled?: boolean;
  /** The agent's internal name on Pipbit (`home-brain`). */
  agentName?: string;
  /** The spoken name (`Home Brain`). */
  displayName?: string;
  secret?: SecretInput;
  baseUrl?: string;
  connectUrl?: string;
  /** Which OpenClaw agent answers; the default agent when unset. */
  agentId?: string;
  /** ISO time of the pairing claim. */
  pairedAt?: string;
}

/** `channels.pipbit`. */
export interface PipbitChannelConfig extends PipbitAccountConfig {
  accounts?: Record<string, PipbitAccountConfig>;
  defaultAccount?: string;
  /** The proactive-speech tool; off unless set to true. */
  proactiveSpeech?: boolean;
}

export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Written by the channel to `<OpenClaw state dir>/pipbit/<accountId>.json`
 * whenever the link or the owner changes, read by the setup wizard after it
 * saves the config (to show "Connected" and the greeting) and by the speak
 * tool (the owner's subject id). Never holds a secret, a token or a code.
 */
export interface PipbitAccountStateFile {
  version: 1;
  accountId: string;
  agentName: string;
  link: LinkStateName;
  reason: string | null;
  detail: string | null;
  updatedAt: string;
  /** The subject id of the paired owner, learned from the first turn. */
  ownerSubjectId: string | null;
  lastIntroAt: string | null;
  /** The agent's words on its last connect intro (what Pip handed over to). */
  lastGreeting: string | null;
}

export function accountStateFilePath(stateDir: string, accountId: string): string {
  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(stateDir, "pipbit", `${safe}.json`);
}
