import { createHmac, randomBytes } from "node:crypto";

import type { ClientInfo } from "../shared/contracts.ts";
import { HELLO_CLIENT_NAME, PLUGIN_VERSION } from "../shared/contracts.ts";

// The frames the client builds and the numbers it plays by. The wire
// contract is SDK/connect_spec/v1/PROTOCOL.md; every builder here produces
// exactly one frame shape from that bundle's schemas, and the tests check
// each one against its schema.

/** Protocol majors this client speaks, in preference order. */
export const PROTOCOL_VERSIONS: readonly number[] = [1];

/**
 * The optional frame families this client implements, offered in every
 * hello (a resume hello too: capabilities are agreed per socket). `cancel`
 * lets the platform withdraw a turn; `redelivery` lets the broker re-send,
 * once, a turn that was on the wire when a socket dropped before its ack.
 */
export const CLIENT_CAPABILITIES: readonly string[] = ["cancel", "redelivery"];

/** Why the platform withdraws a turn. Logged only: an unknown word is honoured. */
export const CANCEL_REASONS: ReadonlySet<string> = new Set([
  "return_to_pip",
  "switched_agent",
  "session_ended",
  "idle_timeout",
  "device_closed",
  "reply_timeout",
]);

/** hello.error words after which the client never dials again on its own. */
export const FATAL_HELLO_ERRORS: ReadonlySet<string> = new Set([
  "authentication_failed",
  "connect_not_enabled",
  "transport_mismatch",
  "agent_suspended",
  "protocol_unsupported",
]);

/**
 * WebSocket close codes that name a fatal refusal. 4003 (policy) is NOT
 * here: it is a hold-off and retry, and whether the refusal is final comes
 * from the hello.error word the next hello earns.
 */
export const FATAL_CLOSE_CODES: ReadonlyMap<number, string> = new Map([
  [4000, "authentication_failed"],
  [4002, "revoked"],
  [4004, "protocol_unsupported"],
]);

export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_SUPERSEDED = 4001;
export const CLOSE_POLICY = 4003;
export const CLOSE_SILENCE = 4008;

// Defaults that hello.ack overrides (PROTOCOL.md section 13).
export const DEFAULT_ACK_DEADLINE_S = 3;
export const DEFAULT_RESULT_WAIT_S = 6;
export const DEFAULT_PING_INTERVAL_S = 30;
export const DEFAULT_PONG_DEADLINE_S = 10;
export const DEFAULT_MAX_FRAME_BYTES = 262144;

/** Upgrade (HTTP to WebSocket) must finish within this, or the dial is abandoned. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/** After the hello goes out, hello.ack (or hello.error) must come within this. */
export const HELLO_ACK_TIMEOUT_MS = 10_000;
/** A finished handler waits this long for a ready link before its answer is dropped. */
export const RESULT_SEND_WAIT_MS = 15_000;
/** A push made while a hello is outstanding waits this long for the ack. */
export const PUSH_READY_WAIT_MS = 3_000;
/** How long a push waits for the platform's result frame. */
export const PUSH_RESULT_TIMEOUT_MS = 10_000;
/** A request_id is remembered this long from its first sighting (the reply-token TTL). */
export const TURN_DEDUP_WINDOW_MS = 900_000;

// Reconnect policy (PROTOCOL.md section 10). Seconds, like the spec.
export const BACKOFF_BASE_S = 1;
export const BACKOFF_CAP_S = 60;
export const SUPERSEDED_HOLDOFF_S = 30;
export const SUPERSEDED_JITTER_S = 10;

export type Frame = Record<string, unknown>;

/** The client block for hello: this plugin, this Node. */
export function defaultHelloClient(): ClientInfo {
  return { name: HELLO_CLIENT_NAME, version: PLUGIN_VERSION, runtime: `node/${process.versions.node}` };
}

/** 16 random bytes as base64url without padding: 22 characters. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * The hmac-v1 proof: lowercase hex HMAC-SHA256 keyed with the agent secret
 * over `timestamp + "." + nonce + "." + agent`. The secret itself never
 * leaves this function.
 */
export function signHello(secret: string, timestamp: string, nonce: string, agent: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${nonce}.${agent}`, "utf8").digest("hex");
}

export interface HelloInput {
  agent: string;
  client: ClientInfo;
  /** A session token from the last hello.ack: the resume form. */
  sessionToken?: string | null;
  /** Needed for the hmac-v1 form. */
  secret?: string;
  /** Unix seconds (the hmac-v1 form). */
  nowSeconds?: number;
  /** Test seam; a fresh random nonce otherwise. */
  nonce?: string;
}

/**
 * A hello frame. With a session token it resumes (`auth.method: "session"`);
 * otherwise it carries a fresh hmac-v1 proof. Both forms carry the client
 * block and the capabilities, which are agreed per socket.
 */
export function buildHello(input: HelloInput): Frame {
  const client: Record<string, string> = { name: input.client.name, version: input.client.version };
  if (typeof input.client.runtime === "string" && input.client.runtime) {
    client["runtime"] = input.client.runtime;
  }
  let auth: Record<string, string>;
  if (input.sessionToken) {
    auth = { method: "session", session_token: input.sessionToken };
  } else {
    if (typeof input.secret !== "string" || typeof input.nowSeconds !== "number") {
      throw new TypeError("An hmac-v1 hello needs the secret and the time.");
    }
    const timestamp = String(Math.floor(input.nowSeconds));
    const nonce = input.nonce ?? newNonce();
    auth = {
      method: "hmac-v1",
      timestamp,
      nonce,
      signature: signHello(input.secret, timestamp, nonce, input.agent),
    };
  }
  return {
    type: "hello",
    protocol_versions: [...PROTOCOL_VERSIONS],
    agent: input.agent,
    client,
    capabilities: [...CLIENT_CAPABILITIES],
    auth,
  };
}

export function buildTurnAck(requestId: string): Frame {
  return { type: "turn.ack", request_id: requestId };
}

/** The three shapes a turn.result may carry. */
export type TurnResultBody =
  | { text: string }
  | { status: "deferred" }
  | { error: "handler_error" | "invalid_request" | "configuration_error"; message: string };

export function buildTurnResult(requestId: string, result: TurnResultBody): Frame {
  return { type: "turn.result", request_id: requestId, result: { ...result } };
}

export type CancelOutcome = "cancelled" | "already_replied" | "unknown";

export function buildCancelAck(requestId: string, outcome: CancelOutcome): Frame {
  return { type: "cancel.ack", request_id: requestId, outcome };
}

export function buildPing(tsMs: number): Frame {
  return { type: "ping", ts: Math.max(0, Math.floor(tsMs)) };
}

/** A pong echoes the ping's `ts` unchanged. */
export function buildPong(ts: unknown): Frame {
  return { type: "pong", ts };
}

export interface ReplyFrameInput {
  replyToken: string;
  text: string;
  handback?: boolean;
  handbackReason?: string;
}

/** The body of a reply frame (the client adds type and id when it sends). */
export function buildReplyBody(input: ReplyFrameInput): Frame {
  const body: Frame = { reply_token: input.replyToken, text: input.text };
  if (input.handback === true) {
    body["handback"] = true;
    if (typeof input.handbackReason === "string") {
      body["handback_reason"] = input.handbackReason;
    }
  }
  return body;
}

export interface SilenceFrameInput {
  replyToken: string;
  handback?: boolean;
  handbackReason?: string;
}

/**
 * The body of a silent reply frame: a reply with `silent: true` and no
 * `text` at all. It tells the platform that a deferred turn gets no spoken
 * answer on purpose (the turn was not for this agent, or nothing should be
 * said), so the platform stops waiting for one instead of telling the person
 * the agent is still working and, later, that it never answered. It is not
 * a way to hide an answer the agent failed to produce. The text key is left
 * out rather than sent empty: a silence has no words to send, and the
 * platform reads an absent text and an empty one the same way.
 */
export function buildSilenceBody(input: SilenceFrameInput): Frame {
  const body: Frame = { reply_token: input.replyToken, silent: true };
  if (input.handback === true) {
    body["handback"] = true;
    if (typeof input.handbackReason === "string") {
      body["handback_reason"] = input.handbackReason;
    }
  }
  return body;
}

export interface MessageFrameInput {
  text: string;
  subjectId?: string;
  deviceId?: string;
  sessionId?: string;
}

/** The body of a message frame (the client adds type and id when it sends). */
export function buildMessageBody(input: MessageFrameInput): Frame {
  const body: Frame = { text: input.text };
  if (input.subjectId !== undefined) {
    body["subject_id"] = input.subjectId;
  }
  if (input.deviceId !== undefined) {
    body["device_id"] = input.deviceId;
  }
  if (input.sessionId !== undefined) {
    body["session_id"] = input.sessionId;
  }
  return body;
}

/** The envelope a push rides in: `type` and `id` always win over the body. */
export function withEnvelope(type: string, id: string, body: Frame): Frame {
  return { ...body, type, id };
}

/** Bytes a frame takes on the wire as UTF-8 JSON text. */
export function frameBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Turn whatever the socket handed over into a frame object, or null when it
 * is not one: binary data, text that is not JSON, JSON that is not an
 * object, or an object with no string `type`. Never throws.
 */
export function decodeFrame(data: unknown, isBinary: boolean): Frame | null {
  if (isBinary) {
    return null;
  }
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (Buffer.isBuffer(data)) {
    text = data.toString("utf8");
  } else if (data instanceof ArrayBuffer) {
    text = Buffer.from(data).toString("utf8");
  } else if (Array.isArray(data) && data.every((part) => Buffer.isBuffer(part))) {
    text = Buffer.concat(data as Buffer[]).toString("utf8");
  } else {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const frame = parsed as Frame;
  return typeof frame["type"] === "string" ? frame : null;
}

/** A positive finite number from a hello.ack field, else the default. */
export function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
