import { AsyncLocalStorage } from "node:async_hooks";

import type {
  ClientInfo,
  ConnectClientApi,
  ConnectClientOptions,
  LinkState,
  LinkStateName,
  Logger,
  PushMessageParams,
  PushResult,
  ReplyOptions,
  ReplyOutcome,
  TurnHandler,
  WebSocketFactory,
  WebSocketLike,
} from "../shared/contracts.ts";
import { SUBPROTOCOL, silentLogger } from "../shared/contracts.ts";
import {
  ConnectError,
  ConnectUnavailableError,
  InvalidRequestError,
  PipbitError,
} from "../shared/errors.ts";

import { classifyPushResult, frameResultFrom, type FrameResult } from "./classify.ts";
import {
  BACKOFF_BASE_S,
  BACKOFF_CAP_S,
  CANCEL_REASONS,
  CLOSE_GOING_AWAY,
  CLOSE_NORMAL,
  CLOSE_POLICY,
  CLOSE_SILENCE,
  CLOSE_SUPERSEDED,
  DEFAULT_ACK_DEADLINE_S,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_PING_INTERVAL_S,
  DEFAULT_PONG_DEADLINE_S,
  DEFAULT_RESULT_WAIT_S,
  FATAL_CLOSE_CODES,
  FATAL_HELLO_ERRORS,
  HANDSHAKE_TIMEOUT_MS,
  HELLO_ACK_TIMEOUT_MS,
  PUSH_READY_WAIT_MS,
  PUSH_RESULT_TIMEOUT_MS,
  RESULT_SEND_WAIT_MS,
  SUPERSEDED_HOLDOFF_S,
  SUPERSEDED_JITTER_S,
  TURN_DEDUP_WINDOW_MS,
  buildCancelAck,
  buildHello,
  buildMessageBody,
  buildPing,
  buildPong,
  buildReplyBody,
  buildSilenceBody,
  buildTurnAck,
  buildTurnResult,
  decodeFrame,
  defaultHelloClient,
  frameBytes,
  isPlainObject,
  positiveNumber,
  withEnvelope,
  type CancelOutcome,
  type Frame,
  type TurnResultBody,
} from "./frames.ts";
import { createWebSocketFactory } from "./socket.ts";
import { TimerSet, type TimerHandle } from "./timers.ts";
import { ConnectTurnRequest, normalizeHandlerResult, parseTurnPayload, type TurnControl } from "./turn.ts";

// The Pipbit Connect client: one WebSocket that the agent dials OUT to the
// platform (wss://api.pipbit.ai/v1/connect), kept open, reconnected when it
// drops, and used both ways: the platform sends spoken turns down it and the
// agent pushes replies and messages up it. It knows nothing about OpenClaw.
//
// It mirrors the Python SDK's ConnectClient (SDK/pipbit_sdk/pipbit/connect.py)
// in behaviour, because the conformance scenarios hold every client to the
// same outcomes, and adds what a Node client needs that the Python library
// got for free or lacks: an upgrade timeout, a hello.ack timeout, its own
// JSON ping and pong deadline, turns that race the hello.ack, and a local
// refusal of any frame over the platform's size limit.
//
// Everything runs on Node's single event loop. The one rule that keeps the
// platform happy is that a turn is acknowledged (turn.ack) from the socket
// reader before anything else happens to it, so no handler can delay it.

const WS_OPEN = 1;

const HANDLER_ERROR: TurnResultBody = { error: "handler_error", message: "The Pipbit agent handler failed." };
const CONFIGURATION_ERROR: TurnResultBody = {
  error: "configuration_error",
  message: "The Pipbit agent is not configured correctly.",
};

/** One socket, from the dial to its end. */
interface Session {
  readonly serial: number;
  readonly ws: WebSocketLike;
  /** The upgrade finished (the `open` event). */
  opened: boolean;
  /** A hello went out on this socket. */
  helloSent: boolean;
  /** hello.ack arrived: the link is ready. */
  acked: boolean;
  /** The client gave up on this socket; nothing it says matters any more. */
  abandoned: boolean;
  /** The socket's `close` event arrived. */
  ended: boolean;
  connectionId: string | null;
  /** The hello.error this socket earned, for its retry_after_s. */
  lastHelloError: Frame | null;
  handshakeTimer: TimerHandle | null;
  helloAckTimer: TimerHandle | null;
  pingTimer: TimerHandle | null;
  pongTimer: TimerHandle | null;
}

/** One turn from its turn.ack until nothing more will be sent for it. */
interface InFlightTurn {
  readonly requestId: string;
  readonly arrivedAtMs: number;
  readonly arrivedOn: string | null;
  readonly abort: AbortController;
  replyToken: string | null;
  /** A cancel frame withdrew it while it was open. */
  cancelled: boolean;
  /** Its verdict is final; a cancel now answers already_replied. */
  settled: boolean;
  handlerDone: boolean;
  /** reply() is sending, or has sent, the answer. */
  replying: boolean;
  replied: boolean;
  done: Promise<void> | null;
}

/** One push waiting for its `result` frame. */
interface Waiter {
  readonly session: Session;
  timer: TimerHandle | null;
  resolve(result: FrameResult): void;
  reject(error: Error): void;
}

interface ReadyWaiter {
  timer: TimerHandle | null;
  finish(ready: boolean): void;
}

interface ReadyWait {
  ms: number;
  /** false: wait only while a hello is outstanding on an open socket. true: wait whenever running. */
  whileRunning: boolean;
}

export class ConnectClient implements ConnectClientApi {
  readonly #agent: string;
  readonly #secret: string;
  readonly #connectUrl: string;
  readonly #handler: TurnHandler;
  readonly #clientInfo: ClientInfo;
  readonly #log: Logger;
  readonly #onStateChange: ((state: LinkState) => void) | undefined;
  readonly #onActivity: (() => void) | undefined;
  readonly #factory: WebSocketFactory;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #timers = new TimerSet();
  /** Knows which turn a piece of async code belongs to, so stop() never waits on its caller. */
  readonly #turnContext = new AsyncLocalStorage<InFlightTurn>();

  #running = false;
  #stateName: LinkStateName = "stopped";
  #reason: string | null = null;
  #revokedDetail: string | null = null;
  #connectionId: string | null = null;
  #dials = 0;
  #lastCloseCode: number | null = null;
  #nextDialAtMs: number | null = null;
  #fatalReason: string | null = null;
  #everConnected = false;
  /** Memory only; never written anywhere, never logged. */
  #sessionToken: string | null = null;
  #ackDeadlineS = DEFAULT_ACK_DEADLINE_S;
  #resultWaitS = DEFAULT_RESULT_WAIT_S;
  #pingIntervalS = DEFAULT_PING_INTERVAL_S;
  #pongDeadlineS = DEFAULT_PONG_DEADLINE_S;
  #maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  #backoffPrevS = BACKOFF_BASE_S;
  #session: Session | null = null;
  #sessionSerial = 0;
  #redialTimer: TimerHandle | null = null;
  /** request_id -> epoch ms of its first sighting. */
  readonly #seen = new Map<string, number>();
  readonly #inFlight = new Map<string, InFlightTurn>();
  readonly #handlerRuns = new Set<InFlightTurn>();
  readonly #waiters = new Map<string, Waiter>();
  readonly #readyWaiters = new Set<ReadyWaiter>();
  #frameSeq = 0;
  #lastEmitted = "";

  constructor(options: ConnectClientOptions) {
    const agent = typeof options.agent === "string" ? options.agent.trim() : "";
    const secret = typeof options.secret === "string" ? options.secret.trim() : "";
    if (!agent) {
      throw new PipbitError("The connect client needs the agent's name.", { reason: "configuration_error" });
    }
    if (!secret) {
      throw new PipbitError("The connect client needs the agent secret.", { reason: "configuration_error" });
    }
    if (typeof options.connectUrl !== "string" || !/^wss?:\/\//.test(options.connectUrl)) {
      throw new PipbitError("The connect URL must start with ws:// or wss://.", { reason: "configuration_error" });
    }
    if (typeof options.handler !== "function") {
      throw new PipbitError("The connect client needs a turn handler.", { reason: "configuration_error" });
    }
    this.#agent = agent;
    this.#secret = secret;
    this.#connectUrl = options.connectUrl;
    this.#handler = options.handler;
    const fallback = defaultHelloClient();
    this.#clientInfo = {
      name: options.client?.name || fallback.name,
      version: options.client?.version || fallback.version,
      runtime: options.client?.runtime || fallback.runtime,
    };
    this.#log = options.logger ?? silentLogger;
    this.#onStateChange = options.onStateChange;
    this.#onActivity = options.onActivity;
    this.#factory =
      options.webSocketFactory ?? createWebSocketFactory(`${this.#clientInfo.name}/${this.#clientInfo.version}`);
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#lastEmitted = JSON.stringify(this.state());
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  start(): void {
    if (this.#fatalReason !== null) {
      throw this.#unavailable();
    }
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#everConnected = false;
    this.#backoffPrevS = BACKOFF_BASE_S;
    this.#setState("connecting");
    this.#log.info(`connect: starting agent=${this.#agent}`);
    this.#dial();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.#running = false;
    this.#timers.clear(this.#redialTimer);
    this.#redialTimer = null;
    this.#nextDialAtMs = null;
    const session = this.#session;
    if (session !== null) {
      this.#abandon(session, CLOSE_NORMAL, "client stopping", null);
    }
    this.#finishReadyWaiters(false);
    this.#setState("stopped");
    this.#emitState();

    // A handler that calls stop() itself must not wait for its own turn.
    const caller = this.#turnContext.getStore();
    const running = [...this.#handlerRuns].filter((entry) => entry !== caller && entry.done !== null);
    if (running.length > 0) {
      let timer: TimerHandle | null = null;
      const timedOut = await Promise.race([
        Promise.allSettled(running.map((entry) => entry.done)).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = this.#timers.set(() => resolve(true), Math.max(0, timeoutMs));
        }),
      ]);
      this.#timers.clear(timer);
      if (timedOut) {
        const stuck = running.filter((entry) => !entry.handlerDone).map((entry) => entry.requestId);
        this.#log.warn(
          `connect: stop timed out with handlers still running agent=${this.#agent} request_ids=${stuck.join(",")}`,
        );
      }
    }
    // Nothing the client started may outlive stop(): hold-offs, pings,
    // readiness waits, push timeouts. (Unless start() was called again while
    // this stop waited: the new link's timers are live, not leftovers.)
    if (!this.#running) {
      this.#timers.clearAll();
    }
  }

  state(): LinkState {
    return {
      state: this.#stateName,
      reason: this.#reason,
      connectionId: this.#connectionId,
      detail: this.#reason === "revoked" ? this.#revokedDetail : null,
      dials: this.#dials,
      lastCloseCode: this.#lastCloseCode,
      nextDialAtMs: this.#nextDialAtMs,
    };
  }

  // ------------------------------------------------------------------
  // Pushes
  // ------------------------------------------------------------------

  async pushReply(replyToken: string, text: string, options: ReplyOptions = {}): Promise<PushResult> {
    const body = validateReply(replyToken, text, options);
    return this.#push("reply", body, true, { ms: PUSH_READY_WAIT_MS, whileRunning: false });
  }

  /**
   * Tell the platform a deferred turn gets no spoken reply, on purpose. It
   * rides a `reply` frame (`silent: true`, no text) on the turn's token, so
   * it waits for the link, is sized and answered like a reply, and the
   * platform's verdict on the token (cancelled, not pending, expired) is
   * read by the same rules. The token ends up silent for good: a reply after
   * it is refused as not pending.
   */
  async pushSilence(replyToken: string, options: ReplyOptions = {}): Promise<PushResult> {
    const body = validateSilence(replyToken, options);
    return this.#push("reply", body, true, { ms: PUSH_READY_WAIT_MS, whileRunning: false });
  }

  async pushMessage(params: PushMessageParams): Promise<PushResult> {
    const text = requireArgument(params?.text, "text");
    const subjectId = optionalArgument(params?.subjectId, "subject_id");
    const deviceId = optionalArgument(params?.deviceId, "device_id");
    const sessionId = optionalArgument(params?.sessionId, "session_id");
    if (subjectId === undefined && deviceId === undefined) {
      throw new InvalidRequestError("Provide either 'subject_id' or 'device_id' when pushing a message.");
    }
    const body = buildMessageBody({
      text,
      ...(subjectId !== undefined ? { subjectId } : {}),
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
    return this.#push("message", body, false, { ms: PUSH_READY_WAIT_MS, whileRunning: false });
  }

  async #push(type: "reply" | "message", body: Frame, replyDelivery: boolean, wait: ReadyWait): Promise<PushResult> {
    if (this.#fatalReason !== null) {
      throw this.#unavailable();
    }
    if (!this.#isReady()) {
      const mayWait = wait.whileRunning ? this.#running : this.#helloOutstanding();
      if (mayWait) {
        await this.#waitReady(wait.ms);
      }
      if (this.#fatalReason !== null) {
        throw this.#unavailable();
      }
    }
    const session = this.#session;
    if (session === null || !this.#isReady()) {
      throw this.#notConnected();
    }
    // The id is only spent on a frame that goes out.
    const id = `c-${this.#frameSeq + 1}`;
    const text = JSON.stringify(withEnvelope(type, id, body));
    const size = frameBytes(text);
    if (size > this.#maxFrameBytes) {
      throw new InvalidRequestError(
        `The ${type} frame is ${size} bytes, over the platform's limit of ${this.#maxFrameBytes}; nothing was sent.`,
        { reason: "frame_too_large" },
      );
    }
    this.#frameSeq += 1;
    const result = await new Promise<FrameResult>((resolve, reject) => {
      const waiter: Waiter = { session, timer: null, resolve, reject };
      this.#waiters.set(id, waiter);
      if (!this.#sendText(session, text)) {
        this.#waiters.delete(id);
        reject(this.#notConnected());
        return;
      }
      waiter.timer = this.#timers.set(() => {
        if (this.#waiters.get(id) === waiter) {
          this.#waiters.delete(id);
        }
        reject(
          new ConnectError(
            `The platform did not answer the ${type} frame within ${PUSH_RESULT_TIMEOUT_MS / 1000} s; ` +
              "the push may or may not have landed.",
            { reason: "ack_timeout" },
          ),
        );
      }, PUSH_RESULT_TIMEOUT_MS);
    });
    return classifyPushResult(result, replyDelivery);
  }

  // ------------------------------------------------------------------
  // Dialling and the socket's life
  // ------------------------------------------------------------------

  #dial(): void {
    this.#redialTimer = null;
    this.#nextDialAtMs = null;
    if (!this.#running) {
      return;
    }
    this.#setState(this.#everConnected ? "reconnecting" : "connecting");
    let ws: WebSocketLike;
    try {
      ws = this.#factory(this.#connectUrl, [SUBPROTOCOL], {
        handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        maxPayloadBytes: Math.max(DEFAULT_MAX_FRAME_BYTES, this.#maxFrameBytes),
      });
    } catch (error) {
      this.#log.warn(`connect: dial failed agent=${this.#agent} error=${describe(error)}`);
      this.#scheduleRedial(this.#nextBackoffS());
      return;
    }
    this.#sessionSerial += 1;
    const session: Session = {
      serial: this.#sessionSerial,
      ws,
      opened: false,
      helloSent: false,
      acked: false,
      abandoned: false,
      ended: false,
      connectionId: null,
      lastHelloError: null,
      handshakeTimer: null,
      helloAckTimer: null,
      pingTimer: null,
      pongTimer: null,
    };
    this.#session = session;
    ws.on("open", () => this.#onOpen(session));
    ws.on("message", (data: unknown, isBinary: boolean) => this.#onMessage(session, data, isBinary));
    ws.on("close", (code: number) => this.#onSocketClose(session, code));
    ws.on("error", (error: Error) => this.#onSocketError(session, error));
    session.handshakeTimer = this.#timers.set(() => this.#onHandshakeTimeout(session), HANDSHAKE_TIMEOUT_MS);
    this.#emitState();
  }

  #isCurrent(session: Session): boolean {
    return this.#session === session && !session.abandoned && !session.ended;
  }

  #isReady(): boolean {
    const session = this.#session;
    return this.#running && session !== null && session.acked && !session.abandoned && !session.ended;
  }

  #helloOutstanding(): boolean {
    const session = this.#session;
    return (
      this.#running &&
      session !== null &&
      session.opened &&
      session.helloSent &&
      !session.acked &&
      !session.abandoned &&
      !session.ended
    );
  }

  #onOpen(session: Session): void {
    if (!this.#isCurrent(session)) {
      return;
    }
    session.opened = true;
    this.#timers.clear(session.handshakeTimer);
    session.handshakeTimer = null;
    // Counted when the upgrade succeeds, before the hello: a socket refused
    // at hello still counts as a dial.
    this.#dials += 1;
    // A revoked frame's word belongs to the socket it arrived on.
    this.#revokedDetail = null;
    this.#log.info(`connect: socket open agent=${this.#agent} dial=${this.#dials}`);
    if (!this.#sendHello(session)) {
      this.#abandon(session, CLOSE_NORMAL, "", this.#nextBackoffS());
      return;
    }
    session.helloAckTimer = this.#timers.set(() => this.#onHelloAckTimeout(session), HELLO_ACK_TIMEOUT_MS);
    this.#emitState();
  }

  #sendHello(session: Session): boolean {
    const hello = buildHello({
      agent: this.#agent,
      client: this.#clientInfo,
      sessionToken: this.#sessionToken,
      secret: this.#secret,
      nowSeconds: Math.floor(this.#now() / 1000),
    });
    const sent = this.#sendFrameSafely(session, hello);
    if (sent) {
      session.helloSent = true;
    }
    return sent;
  }

  #onHandshakeTimeout(session: Session): void {
    session.handshakeTimer = null;
    if (!this.#isCurrent(session) || session.opened) {
      return;
    }
    this.#log.warn(`connect: upgrade timed out agent=${this.#agent} after_ms=${HANDSHAKE_TIMEOUT_MS}`);
    this.#abandon(session, CLOSE_NORMAL, "", this.#nextBackoffS());
  }

  #onHelloAckTimeout(session: Session): void {
    session.helloAckTimer = null;
    if (!this.#isCurrent(session) || session.acked) {
      return;
    }
    this.#log.warn(`connect: no hello.ack agent=${this.#agent} after_ms=${HELLO_ACK_TIMEOUT_MS}; redialling`);
    this.#abandon(session, CLOSE_NORMAL, "hello timeout", this.#nextBackoffS());
  }

  #onSocketError(session: Session, error: Error): void {
    if (!this.#isCurrent(session)) {
      return;
    }
    // The close event that follows decides what happens next.
    this.#log.warn(`connect: socket error agent=${this.#agent} error=${describe(error)}`);
  }

  #onSocketClose(session: Session, code: number): void {
    // A socket the client already gave up on must never move the state or
    // start a second hold-off.
    if (session.abandoned || session.ended || this.#session !== session) {
      return;
    }
    session.ended = true;
    const closeCode = typeof code === "number" ? code : null;
    this.#endSession(session, closeCode);
    this.#log.info(`connect: socket closed agent=${this.#agent} code=${closeCode ?? "none"}`);
    if (!this.#running) {
      this.#emitState();
      return;
    }
    const fatal = closeCode === null ? undefined : FATAL_CLOSE_CODES.get(closeCode);
    if (fatal !== undefined) {
      this.#fail(fatal);
      return;
    }
    let holdOffS: number;
    if (closeCode === CLOSE_SUPERSEDED) {
      this.#reason = "superseded";
      holdOffS = SUPERSEDED_HOLDOFF_S + this.#uniform(0, SUPERSEDED_JITTER_S);
    } else if (closeCode === CLOSE_POLICY) {
      holdOffS = this.#policyHoldOffS(session);
    } else if (closeCode === CLOSE_GOING_AWAY || closeCode === CLOSE_SILENCE) {
      holdOffS = this.#uniform(0, BACKOFF_BASE_S);
    } else {
      holdOffS = this.#nextBackoffS();
    }
    this.#scheduleRedial(holdOffS);
  }

  /** Give up on a socket the client decided is done, then optionally redial. */
  #abandon(session: Session, code: number, reason: string, holdOffS: number | null): void {
    if (session.abandoned || session.ended) {
      return;
    }
    session.abandoned = true;
    this.#endSession(session, session.opened ? code : null);
    try {
      if (session.opened && session.ws.readyState === WS_OPEN) {
        session.ws.close(code, reason);
      } else if (typeof session.ws.terminate === "function") {
        session.ws.terminate();
      } else {
        session.ws.close();
      }
    } catch {
      // Closing a socket that is already going away is fine.
    }
    if (holdOffS !== null) {
      this.#scheduleRedial(holdOffS);
    } else {
      this.#emitState();
    }
  }

  /** What every socket end shares: its timers, the connection id, the pushes waiting on it. */
  #endSession(session: Session, closeCode: number | null): void {
    for (const key of ["handshakeTimer", "helloAckTimer", "pingTimer", "pongTimer"] as const) {
      this.#timers.clear(session[key]);
      session[key] = null;
    }
    if (this.#session === session) {
      this.#session = null;
    }
    this.#connectionId = null;
    this.#lastCloseCode = closeCode;
    // A result can only come back on the socket its push went out on. The
    // push WAS sent, and the platform applies it even when it cannot answer,
    // so the outcome is unknown: link_lost, never not_connected.
    for (const [id, waiter] of this.#waiters) {
      if (waiter.session !== session) {
        continue;
      }
      this.#waiters.delete(id);
      this.#timers.clear(waiter.timer);
      waiter.reject(
        new ConnectError(
          "The connect link dropped after the frame went out and before the platform's answer arrived; " +
            "the push may or may not have landed, so do not blindly re-send it.",
          { reason: "link_lost" },
        ),
      );
    }
  }

  #scheduleRedial(holdOffS: number): void {
    if (!this.#running) {
      this.#emitState();
      return;
    }
    this.#timers.clear(this.#redialTimer);
    const ms = Math.max(0, Math.round(holdOffS * 1000));
    this.#nextDialAtMs = this.#now() + ms;
    this.#setState(this.#everConnected ? "reconnecting" : "connecting");
    this.#log.info(`connect: redialling agent=${this.#agent} in_s=${(ms / 1000).toFixed(1)}`);
    this.#redialTimer = this.#timers.set(() => this.#dial(), ms);
    this.#emitState();
  }

  #fail(reason: string): void {
    this.#sessionToken = null;
    this.#fatalReason = reason;
    this.#running = false;
    this.#timers.clear(this.#redialTimer);
    this.#redialTimer = null;
    this.#nextDialAtMs = null;
    this.#stateName = "failed";
    this.#reason = reason;
    this.#connectionId = null;
    const detail = reason === "revoked" && this.#revokedDetail ? ` detail=${this.#revokedDetail}` : "";
    this.#log.error(`connect: state=failed agent=${this.#agent} reason=${reason}${detail}`);
    const session = this.#session;
    if (session !== null) {
      this.#abandon(session, CLOSE_NORMAL, "", null);
    }
    this.#finishReadyWaiters(false);
    this.#emitState();
  }

  // ------------------------------------------------------------------
  // Frames in
  // ------------------------------------------------------------------

  #onMessage(session: Session, data: unknown, isBinary: boolean): void {
    if (!this.#isCurrent(session)) {
      return;
    }
    this.#activity();
    const frame = decodeFrame(data, isBinary);
    if (frame === null) {
      this.#log.warn(`connect: unreadable frame dropped agent=${this.#agent} binary=${isBinary}`);
      return;
    }
    try {
      this.#route(session, frame);
    } catch (error) {
      // Nothing may escape the reader: a bad frame costs itself, never the link.
      this.#log.error(
        `connect: frame handling failed agent=${this.#agent} type=${String(frame["type"])} error=${errorName(error)}`,
      );
    }
  }

  #route(session: Session, frame: Frame): void {
    const type = frame["type"] as string;
    if (!session.acked) {
      if (type === "hello.ack") {
        this.#onHelloAck(session, frame);
        return;
      }
      if (type === "hello.error") {
        this.#onHelloError(session, frame);
        return;
      }
    } else if (type === "hello.ack" || type === "hello.error") {
      this.#log.debug(`connect: ${type} after the handshake ignored agent=${this.#agent}`);
      return;
    }
    // Everything else is handled the same before and after the ack: the
    // broker binds the socket before it writes hello.ack, so a turn (or its
    // cancel) can race the ack, and it is acknowledged and run at once.
    switch (type) {
      case "turn":
        this.#onTurn(session, frame);
        return;
      case "cancel":
        this.#onCancel(session, frame);
        return;
      case "ping": {
        // Echo the ts unchanged. A ping without a usable ts cannot be
        // answered with a valid pong, so it is dropped.
        const ts = frame["ts"];
        if (typeof ts === "number" && Number.isInteger(ts) && ts >= 0) {
          this.#sendFrameSafely(session, buildPong(ts));
        } else {
          this.#log.warn(`connect: ping without an integer ts dropped agent=${this.#agent}`);
        }
        return;
      }
      case "pong":
        this.#timers.clear(session.pongTimer);
        session.pongTimer = null;
        return;
      case "result":
        this.#onResult(frame);
        return;
      case "error":
        this.#onErrorFrame(frame);
        return;
      case "close":
        this.#onCloseFrame(frame);
        return;
      case "revoked":
        this.#onRevoked(frame);
        return;
      default:
        this.#log.debug(`connect: ignoring frame agent=${this.#agent} type=${type}`);
    }
  }

  #onHelloAck(session: Session, frame: Frame): void {
    this.#timers.clear(session.helloAckTimer);
    session.helloAckTimer = null;
    const token = frame["session_token"];
    this.#sessionToken = typeof token === "string" && token ? token : null;
    this.#ackDeadlineS = positiveNumber(frame["ack_deadline_s"], DEFAULT_ACK_DEADLINE_S);
    this.#resultWaitS = positiveNumber(frame["result_wait_s"], DEFAULT_RESULT_WAIT_S);
    this.#pingIntervalS = positiveNumber(frame["ping_interval_s"], DEFAULT_PING_INTERVAL_S);
    this.#pongDeadlineS = positiveNumber(frame["pong_deadline_s"], DEFAULT_PONG_DEADLINE_S);
    const limits = frame["limits"];
    this.#maxFrameBytes = isPlainObject(limits)
      ? positiveNumber(limits["max_frame_bytes"], DEFAULT_MAX_FRAME_BYTES)
      : DEFAULT_MAX_FRAME_BYTES;
    const connectionId = frame["connection_id"];
    session.connectionId = typeof connectionId === "string" ? connectionId : null;
    session.acked = true;
    this.#connectionId = session.connectionId;
    this.#everConnected = true;
    this.#backoffPrevS = BACKOFF_BASE_S;
    this.#reason = null;
    this.#setState("connected");
    const capabilities = Array.isArray(frame["capabilities"])
      ? (frame["capabilities"] as unknown[]).filter((name): name is string => typeof name === "string" && !!name)
      : [];
    this.#log.info(
      `connect: state=connected agent=${this.#agent} connection_id=${session.connectionId ?? "-"} ` +
        `resumed=${String(frame["resumed"])} capabilities=${capabilities.join(",") || "-"} ` +
        `redelivered=${String(frame["redelivered"])} ack_deadline_s=${this.#ackDeadlineS} ` +
        `result_wait_s=${this.#resultWaitS}`,
    );
    this.#schedulePing(session);
    this.#finishReadyWaiters(true);
    this.#emitState();
  }

  #onHelloError(session: Session, frame: Frame): void {
    session.lastHelloError = frame;
    const error = typeof frame["error"] === "string" ? frame["error"] : "";
    this.#reason = error || null;
    const message = typeof frame["message"] === "string" ? frame["message"] : "";
    this.#log.warn(`connect: hello refused agent=${this.#agent} error=${error || "-"} message=${message}`);
    if (error === "resume_rejected") {
      // The session token died (rotated, expired, revoked): prove the
      // secret with a fresh hello on the same socket, as the protocol allows.
      this.#sessionToken = null;
      if (!this.#sendHello(session)) {
        this.#abandon(session, CLOSE_NORMAL, "", this.#nextBackoffS());
        return;
      }
      this.#emitState();
      return;
    }
    if (FATAL_HELLO_ERRORS.has(error)) {
      this.#fail(error);
      return;
    }
    // rate_limited, or a word this client does not know: hold off and retry.
    this.#abandon(session, CLOSE_NORMAL, "", this.#policyHoldOffS(session));
  }

  #onCloseFrame(frame: Frame): void {
    const word = typeof frame["reason"] === "string" ? frame["reason"] : "";
    this.#reason = word || null;
    if (word === "superseded") {
      this.#log.error(
        `connect: another instance of this agent is connected agent=${this.#agent}; ` +
          `this one holds off at least ${SUPERSEDED_HOLDOFF_S} s before retrying`,
      );
    } else {
      this.#log.info(`connect: close announced agent=${this.#agent} reason=${word || "-"}`);
    }
    this.#emitState();
  }

  #onRevoked(frame: Frame): void {
    // The close code that follows, not this word, decides what happens:
    // 4002 stops the client for good, 4003 retries after a hold-off.
    const word = frame["reason"];
    this.#revokedDetail = typeof word === "string" && word ? word : null;
    this.#reason = "revoked";
    this.#log.error(`connect: link revoked agent=${this.#agent} reason=${this.#revokedDetail ?? "-"}`);
    this.#emitState();
  }

  #onErrorFrame(frame: Frame): void {
    const code = typeof frame["code"] === "string" && frame["code"] ? frame["code"] : "invalid_frame";
    const ref = frame["ref"];
    this.#log.warn(
      `connect: error frame agent=${this.#agent} code=${code} ref_type=${String(frame["ref_type"] ?? "-")} ` +
        `ref=${typeof ref === "string" ? ref : "-"}`,
    );
    // An error that names an outstanding push is that push's answer: no
    // result will follow.
    const waiter = typeof ref === "string" ? this.#waiters.get(ref) : undefined;
    if (waiter === undefined || typeof ref !== "string") {
      return;
    }
    this.#waiters.delete(ref);
    this.#timers.clear(waiter.timer);
    const refType = typeof frame["ref_type"] === "string" && frame["ref_type"] ? frame["ref_type"] : "push";
    const message = typeof frame["message"] === "string" && frame["message"] ? frame["message"] : code;
    waiter.reject(new ConnectError(`The platform rejected the ${refType} frame: ${message}`, { reason: code }));
  }

  #onResult(frame: Frame): void {
    const ref = frame["ref"];
    const waiter = typeof ref === "string" ? this.#waiters.get(ref) : undefined;
    if (waiter === undefined || typeof ref !== "string") {
      this.#log.warn(
        `connect: result without a waiter dropped agent=${this.#agent} ref=${typeof ref === "string" ? ref : "-"} ` +
          `ok=${String(frame["ok"])} status_code=${String(frame["status_code"])}`,
      );
      return;
    }
    this.#waiters.delete(ref);
    this.#timers.clear(waiter.timer);
    let result: FrameResult;
    try {
      result = frameResultFrom(frame);
    } catch (error) {
      this.#log.warn(`connect: result frame without an integer status_code agent=${this.#agent} ref=${ref}`);
      waiter.reject(error instanceof Error ? error : new ConnectError(String(error), { reason: "invalid_frame" }));
      return;
    }
    waiter.resolve(result);
  }

  // ------------------------------------------------------------------
  // Keepalive: the broker never pings and closes 4008 after 40 s without a
  // text frame (WebSocket control pings do not count), so the client sends a
  // JSON ping every ping_interval_s and treats a pong later than
  // pong_deadline_s as a dead link.
  // ------------------------------------------------------------------

  #schedulePing(session: Session): void {
    this.#timers.clear(session.pingTimer);
    session.pingTimer = this.#timers.set(() => this.#sendPing(session), this.#pingIntervalS * 1000);
  }

  #sendPing(session: Session): void {
    session.pingTimer = null;
    if (!this.#isCurrent(session) || !session.acked) {
      return;
    }
    const sent = this.#sendFrameSafely(session, buildPing(this.#now()));
    if (sent && session.pongTimer === null) {
      session.pongTimer = this.#timers.set(() => this.#onPongOverdue(session), this.#pongDeadlineS * 1000);
    }
    this.#schedulePing(session);
  }

  #onPongOverdue(session: Session): void {
    session.pongTimer = null;
    if (!this.#isCurrent(session)) {
      return;
    }
    this.#log.warn(`connect: pong overdue agent=${this.#agent} deadline_s=${this.#pongDeadlineS}; redialling`);
    this.#abandon(session, CLOSE_NORMAL, "pong timeout", this.#nextBackoffS());
  }

  // ------------------------------------------------------------------
  // Turns
  // ------------------------------------------------------------------

  #onTurn(session: Session, frame: Frame): void {
    const requestId = frame["request_id"];
    if (typeof requestId !== "string" || !requestId) {
      this.#log.warn(`connect: turn without request_id dropped agent=${this.#agent}`);
      return;
    }
    // The ack goes out first, from the reader, before the dedupe and before
    // any handler: nothing a handler does can ever delay it.
    this.#sendFrameSafely(session, buildTurnAck(requestId));
    const redelivery = frame["redelivery"] === true;
    if (redelivery) {
      this.#log.info(`connect: redelivered turn agent=${this.#agent} request_id=${requestId}`);
    }
    if (!this.#firstSighting(requestId)) {
      this.#log.info(`connect: duplicate turn acked, not run again agent=${this.#agent} request_id=${requestId}`);
      return;
    }
    if (!this.#running) {
      this.#log.info(`connect: turn dropped, client stopping agent=${this.#agent} request_id=${requestId}`);
      return;
    }
    const entry: InFlightTurn = {
      requestId,
      arrivedAtMs: this.#now(),
      arrivedOn: session.connectionId,
      abort: new AbortController(),
      replyToken: null,
      cancelled: false,
      settled: false,
      handlerDone: false,
      replying: false,
      replied: false,
      done: null,
    };
    this.#inFlight.set(requestId, entry);
    this.#handlerRuns.add(entry);
    entry.done = this.#turnContext.run(entry, () => this.#runTurn(entry, frame["payload"], redelivery)).finally(() => {
      this.#handlerRuns.delete(entry);
    });
  }

  async #runTurn(entry: InFlightTurn, payload: unknown, redelivery: boolean): Promise<void> {
    // Start the handler only once the reader has finished with every frame
    // it is holding, so their acks go out first too.
    await Promise.resolve();
    let outcome: TurnResultBody;
    let stillWorking = false;
    try {
      const parsed = parseTurnPayload(payload);
      entry.replyToken = parsed.replyToken;
      const request = new ConnectTurnRequest(parsed, payload as Record<string, unknown>, redelivery, this.#controlFor(entry));
      const returned = await this.#handler(request);
      const normalized = normalizeHandlerResult(returned);
      if (normalized.kind === "text") {
        outcome = { text: normalized.text };
      } else if (normalized.kind === "deferred") {
        outcome = { status: "deferred" };
        stillWorking = normalized.stillWorking;
      } else {
        this.#log.warn(
          `connect: handler returned no usable answer agent=${this.#agent} request_id=${entry.requestId}`,
        );
        outcome = CONFIGURATION_ERROR;
      }
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        this.#log.warn(`connect: turn refused as invalid agent=${this.#agent} request_id=${entry.requestId}`);
        outcome = { error: "invalid_request", message: error.message || "Turn payload was invalid." };
      } else {
        // Only the error's class name: its message could quote the person.
        this.#log.warn(
          `connect: handler failed agent=${this.#agent} request_id=${entry.requestId} error=${errorName(error)}`,
        );
        outcome = HANDLER_ERROR;
      }
    }
    entry.handlerDone = true;
    try {
      await this.#finishTurn(entry, outcome, stillWorking);
    } catch (error) {
      this.#log.error(
        `connect: sending the turn's answer failed agent=${this.#agent} request_id=${entry.requestId} ` +
          `error=${errorName(error)}`,
      );
    }
  }

  async #finishTurn(entry: InFlightTurn, handlerOutcome: TurnResultBody, handlerStillWorking: boolean): Promise<void> {
    let outcome = handlerOutcome;
    let stillWorking = handlerStillWorking;
    if (entry.cancelled) {
      // The platform cancelled the reply token when it sent the cancel:
      // text would be refused, a deferred verdict would promise a reply it
      // will not take, and an error would be noise. Nothing is sent.
      this.#log.info(
        `connect: turn cancelled, answer dropped agent=${this.#agent} request_id=${entry.requestId} ` +
          `result=${resultKind(outcome)}`,
      );
      this.#forget(entry);
      return;
    }
    if (entry.replying || entry.replied) {
      // reply() already carries the answer; the verdict can only be deferred.
      if ("text" in outcome) {
        this.#log.warn(
          `connect: handler text after reply() dropped agent=${this.#agent} request_id=${entry.requestId}`,
        );
      }
      outcome = { status: "deferred" };
      stillWorking = true;
    }
    const deferredStillWorking = "status" in outcome && stillWorking;
    if (!deferredStillWorking) {
      entry.settled = true;
    }
    this.#forget(entry);

    if ("text" in outcome && this.#now() - entry.arrivedAtMs >= this.#resultWaitS * 1000) {
      await this.#sendLateText(entry, outcome.text);
      return;
    }
    // A result may only ride a socket whose hello was acknowledged (the
    // broker closes 4005 on anything earlier), so a handler that finishes
    // while the link is down or mid-handshake waits for it, bounded.
    const ready = await this.#waitReady(RESULT_SEND_WAIT_MS);
    const session = this.#session;
    if (!ready || session === null) {
      this.#log.warn(`connect: answer not sent, link not ready agent=${this.#agent} request_id=${entry.requestId}`);
      return;
    }
    if (entry.cancelled) {
      this.#log.info(`connect: turn cancelled, answer dropped agent=${this.#agent} request_id=${entry.requestId}`);
      return;
    }
    let sent: boolean;
    try {
      sent = this.#sendFrame(session, buildTurnResult(entry.requestId, outcome));
    } catch (error) {
      if (!(error instanceof InvalidRequestError)) {
        throw error;
      }
      this.#log.warn(
        `connect: answer over the frame limit, sent as a handler error agent=${this.#agent} ` +
          `request_id=${entry.requestId}`,
      );
      sent = this.#sendFrameSafely(session, buildTurnResult(entry.requestId, HANDLER_ERROR));
    }
    if (!sent) {
      this.#log.warn(`connect: answer not sent, link down agent=${this.#agent} request_id=${entry.requestId}`);
      return;
    }
    if (session.connectionId !== entry.arrivedOn) {
      this.#log.info(
        `connect: answer rides a successor connection agent=${this.#agent} request_id=${entry.requestId} ` +
          `arrived_on=${entry.arrivedOn ?? "-"} sent_on=${session.connectionId ?? "-"}`,
      );
    }
  }

  /**
   * A text answer after result_wait_s is no longer the inline answer: the
   * platform would treat a late turn.result as a push_reply and never say
   * how it went. A reply frame on the turn's token does the same thing and
   * comes back with a result, so the outcome can be logged.
   */
  async #sendLateText(entry: InFlightTurn, text: string): Promise<void> {
    if (entry.replyToken === null) {
      return;
    }
    try {
      const result = await this.#push("reply", buildReplyBody({ replyToken: entry.replyToken, text }), true, {
        ms: RESULT_SEND_WAIT_MS,
        whileRunning: true,
      });
      this.#log.info(
        `connect: late answer sent as a reply agent=${this.#agent} request_id=${entry.requestId} ` +
          `status_code=${result.statusCode}`,
      );
    } catch (error) {
      const fields = error instanceof PipbitError ? error : null;
      this.#log.warn(
        `connect: late answer not delivered agent=${this.#agent} request_id=${entry.requestId} ` +
          `error=${errorName(error)} reason=${fields?.reason ?? "-"} status_code=${fields?.statusCode ?? "-"}`,
      );
    }
  }

  #controlFor(entry: InFlightTurn): TurnControl {
    return {
      signal: entry.abort.signal,
      isCancelled: () => entry.cancelled,
      reply: (text, options) => this.#turnReply(entry, text, options),
      settle: () => {
        entry.settled = true;
        this.#forget(entry);
      },
    };
  }

  async #turnReply(entry: InFlightTurn, text: string, options: ReplyOptions | undefined): Promise<ReplyOutcome> {
    if (entry.cancelled) {
      return { sent: false, reason: "cancelled" };
    }
    if (entry.settled || entry.replying || entry.replyToken === null) {
      return { sent: false, reason: "already_settled" };
    }
    const body = validateReply(entry.replyToken, text, options ?? {});
    entry.replying = true;
    try {
      // The turn's own answer: waits for a ready link like a turn.result would.
      const result = await this.#push("reply", body, true, { ms: RESULT_SEND_WAIT_MS, whileRunning: true });
      entry.replied = true;
      entry.settled = true;
      this.#forget(entry);
      return { sent: true, result };
    } finally {
      entry.replying = false;
    }
  }

  /** Drop the turn's record once nothing more can happen to it. */
  #forget(entry: InFlightTurn): void {
    if (entry.handlerDone && (entry.settled || entry.cancelled) && this.#inFlight.get(entry.requestId) === entry) {
      this.#inFlight.delete(entry.requestId);
    }
  }

  #onCancel(session: Session, frame: Frame): void {
    const requestId = frame["request_id"];
    const reason = frame["reason"];
    if (typeof requestId !== "string" || !requestId || typeof reason !== "string" || !reason) {
      // A cancel that names no turn, or gives no reason, asked for nothing
      // properly: dropped, and nothing is acknowledged.
      this.#log.warn(`connect: cancel frame without request_id or reason dropped agent=${this.#agent}`);
      return;
    }
    if (!CANCEL_REASONS.has(reason)) {
      this.#log.info(`connect: cancel with an unlisted reason honoured agent=${this.#agent} reason=${reason}`);
    }
    const entry = this.#inFlight.get(requestId);
    let outcome: CancelOutcome;
    if (entry !== undefined && !entry.settled) {
      outcome = "cancelled";
      if (!entry.cancelled) {
        entry.cancelled = true;
        try {
          entry.abort.abort(new DOMException("The platform withdrew this turn.", "AbortError"));
        } catch (error) {
          this.#log.warn(`connect: an abort listener failed agent=${this.#agent} error=${errorName(error)}`);
        }
        this.#forget(entry);
      }
    } else if (entry !== undefined) {
      outcome = "already_replied";
    } else {
      outcome = this.#wasSeen(requestId) ? "already_replied" : "unknown";
    }
    this.#log.info(
      `connect: cancel agent=${this.#agent} request_id=${requestId} reason=${reason} outcome=${outcome}`,
    );
    this.#sendFrameSafely(session, buildCancelAck(requestId, outcome));
  }

  #firstSighting(requestId: string): boolean {
    const now = this.#now();
    const cutoff = now - TURN_DEDUP_WINDOW_MS;
    for (const [id, seenAt] of this.#seen) {
      if (seenAt < cutoff) {
        this.#seen.delete(id);
      }
    }
    if (this.#seen.has(requestId)) {
      return false;
    }
    this.#seen.set(requestId, now);
    return true;
  }

  #wasSeen(requestId: string): boolean {
    const seenAt = this.#seen.get(requestId);
    return seenAt !== undefined && seenAt >= this.#now() - TURN_DEDUP_WINDOW_MS;
  }

  // ------------------------------------------------------------------
  // Plumbing
  // ------------------------------------------------------------------

  /** Resolves true once the link is ready, false on timeout, stop or failure. */
  #waitReady(ms: number): Promise<boolean> {
    if (this.#isReady()) {
      return Promise.resolve(true);
    }
    if (!this.#running) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let finished = false;
      const waiter: ReadyWaiter = {
        timer: null,
        finish: (ready: boolean) => {
          if (finished) {
            return;
          }
          finished = true;
          this.#timers.clear(waiter.timer);
          this.#readyWaiters.delete(waiter);
          resolve(ready);
        },
      };
      waiter.timer = this.#timers.set(() => waiter.finish(false), ms);
      this.#readyWaiters.add(waiter);
    });
  }

  #finishReadyWaiters(ready: boolean): void {
    for (const waiter of [...this.#readyWaiters]) {
      waiter.finish(ready);
    }
  }

  /**
   * Serialise and send one frame. False when the socket cannot take it;
   * throws InvalidRequestError (nothing sent) when it is over the size limit.
   */
  #sendFrame(session: Session, frame: Frame): boolean {
    const text = JSON.stringify(frame);
    const size = frameBytes(text);
    if (size > this.#maxFrameBytes) {
      throw new InvalidRequestError(
        `The ${String(frame["type"])} frame is ${size} bytes, over the platform's limit of ${this.#maxFrameBytes}; ` +
          "nothing was sent.",
        { reason: "frame_too_large" },
      );
    }
    return this.#sendText(session, text);
  }

  #sendFrameSafely(session: Session, frame: Frame): boolean {
    try {
      return this.#sendFrame(session, frame);
    } catch (error) {
      this.#log.warn(
        `connect: frame not sent agent=${this.#agent} type=${String(frame["type"])} error=${errorName(error)}`,
      );
      return false;
    }
  }

  #sendText(session: Session, text: string): boolean {
    if (session.abandoned || session.ended || session.ws.readyState !== WS_OPEN) {
      return false;
    }
    try {
      session.ws.send(text, (error?: Error) => {
        if (error) {
          this.#log.debug(`connect: send failed agent=${this.#agent} error=${describe(error)}`);
        }
      });
    } catch (error) {
      this.#log.warn(`connect: send failed agent=${this.#agent} error=${describe(error)}`);
      return false;
    }
    this.#activity();
    return true;
  }

  #policyHoldOffS(session: Session): number {
    const retryAfter = session.lastHelloError?.["retry_after_s"];
    if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter + this.#uniform(0, BACKOFF_BASE_S);
    }
    return this.#nextBackoffS();
  }

  /**
   * Decorrelated jitter: each wait is drawn between the base and three times
   * the previous one, capped, so a fleet of agents never redials in step.
   * The previous wait resets to the base only on hello.ack.
   */
  #nextBackoffS(): number {
    const delay = Math.min(BACKOFF_CAP_S, this.#uniform(BACKOFF_BASE_S, this.#backoffPrevS * 3));
    this.#backoffPrevS = Math.max(BACKOFF_BASE_S, delay);
    return delay;
  }

  #uniform(low: number, high: number): number {
    return low + this.#random() * (high - low);
  }

  #setState(state: LinkStateName): void {
    if (this.#stateName === "failed") {
      return;
    }
    this.#stateName = state;
  }

  #emitState(): void {
    const snapshot = this.state();
    const key = JSON.stringify(snapshot);
    if (key === this.#lastEmitted) {
      return;
    }
    this.#lastEmitted = key;
    if (this.#onStateChange === undefined) {
      return;
    }
    try {
      this.#onStateChange(snapshot);
    } catch (error) {
      this.#log.warn(`connect: state listener failed agent=${this.#agent} error=${errorName(error)}`);
    }
  }

  #activity(): void {
    if (this.#onActivity === undefined) {
      return;
    }
    try {
      this.#onActivity();
    } catch (error) {
      this.#log.warn(`connect: activity listener failed agent=${this.#agent} error=${errorName(error)}`);
    }
  }

  #unavailable(): ConnectUnavailableError {
    const reason = this.#fatalReason ?? "not_connected";
    const detail = reason === "revoked" ? this.#revokedDetail : null;
    return new ConnectUnavailableError(
      `The platform refused the connect link for agent '${this.#agent}': ${reason}${detail ? ` (${detail})` : ""}.`,
      { reason, detail },
    );
  }

  #notConnected(): ConnectUnavailableError {
    return new ConnectUnavailableError(
      `The connect link is not up (state=${this.#stateName}); the push was not sent. ` +
        "Retry once the link is back, or give up.",
      { reason: "not_connected" },
    );
  }
}

function requireArgument(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidRequestError(`The '${field}' argument must be a non-empty string.`);
  }
  return value.trim();
}

function optionalArgument(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireArgument(value, field);
}

/** The reply frame's body, checked the way the SDK's push_reply checks it. */
function validateReply(replyToken: unknown, text: unknown, options: ReplyOptions): Frame {
  const token = requireArgument(replyToken, "reply_token");
  const words = requireArgument(text, "text");
  return buildReplyBody({ replyToken: token, text: words, ...validateHandback(options) });
}

/** The silent reply frame's body, checked the way the SDK's push_silence checks it. */
function validateSilence(replyToken: unknown, options: ReplyOptions): Frame {
  const token = requireArgument(replyToken, "reply_token");
  return buildSilenceBody({ replyToken: token, ...validateHandback(options) });
}

/**
 * The handback fields a reply or a silence may carry: `handback` only when
 * asked for, and a reason only beside it (the platform refuses a reason on
 * its own, so the client does too, before anything is sent).
 */
function validateHandback(options: ReplyOptions): { handback: boolean; handbackReason?: string } {
  const handback = options.handback === true;
  let handbackReason: string | undefined;
  if (options.handbackReason !== undefined && options.handbackReason !== null) {
    if (!handback) {
      throw new InvalidRequestError("The 'handback_reason' argument requires handback: true.");
    }
    handbackReason = requireArgument(options.handbackReason, "handback_reason");
  }
  return { handback, ...(handbackReason !== undefined ? { handbackReason } : {}) };
}

function resultKind(outcome: TurnResultBody): string {
  if ("text" in outcome) {
    return "text";
  }
  if ("status" in outcome) {
    return "deferred";
  }
  return outcome.error;
}

function errorName(error: unknown): string {
  if (error instanceof Error) {
    return error.name || "Error";
  }
  return typeof error;
}

/** A transport error's message: these come from ws and Node, never from a person. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
