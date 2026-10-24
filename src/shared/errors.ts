// Error classes shared by every part of the plugin. The class names match
// the Python SDK's exceptions on purpose: the conformance harness reports an
// error by its class name (SDK/connect_spec/v1/schemas/adapter.json), so a
// scenario's expected error means the same thing whichever client answered.

export interface PipbitErrorFields {
  code?: string | null;
  statusCode?: number | null;
  reason?: string | null;
  detail?: string | null;
}

/** Base class: every error the plugin raises on purpose. */
export class PipbitError extends Error {
  override name = "PipbitError";
  /** The platform's error word (`invalid_request`, `rate_limited`, ...). */
  readonly code: string | null;
  /** The HTTP status the platform answered with, when there was one. */
  readonly statusCode: number | null;
  /** The additive machine word (`reply_token_expired`, `revoked`, ...). */
  readonly reason: string | null;
  /** Extra word, for example the `revoked` frame's reason. */
  readonly detail: string | null;

  constructor(message: string, fields: PipbitErrorFields = {}) {
    super(message);
    this.code = fields.code ?? null;
    this.statusCode = fields.statusCode ?? null;
    this.reason = fields.reason ?? null;
    this.detail = fields.detail ?? null;
  }
}

/** 401 or 403 from the platform. */
export class AuthenticationError extends PipbitError {
  override name = "AuthenticationError";
}

/** Any other 4xx: the request itself was refused. */
export class InvalidRequestError extends PipbitError {
  override name = "InvalidRequestError";
}

/** The reply token or agent session is gone: fall back to a message. */
export class SessionGoneError extends InvalidRequestError {
  override name = "SessionGoneError";
}

/** 5xx, or the broker's `platform_unavailable`: the push had no effect. */
export class PlatformServerError extends PipbitError {
  override name = "PlatformServerError";
}

/**
 * The link failed while a push was in flight, or the push timed out.
 * `reason` is `link_lost`, `ack_timeout`, `invalid_frame` or the code of an
 * `error` frame that named the push.
 */
export class ConnectError extends PipbitError {
  override name = "ConnectError";
}

/**
 * Nothing was sent: the link is not up (`reason` `not_connected`), or the
 * client has stopped for good (`reason` is the refusal word, with `detail`
 * the `revoked` frame's word when there was one).
 */
export class ConnectUnavailableError extends ConnectError {
  override name = "ConnectUnavailableError";
}

/** Why a pairing step failed. */
export type PairingErrorReason =
  | "invalid_request"
  | "reserved_name"
  | "name_taken"
  | "rate_limited"
  | "not_found"
  | "expired"
  | "cancelled"
  | "claimed"
  | "failed"
  | "platform_unreachable"
  | "timeout"
  | "aborted"
  /**
   * The platform most likely registered the agent but its answer (the only
   * copy of the secret) never arrived or could not be read: the pairing
   * flow got a `410 pairing_claimed` (it stops at the first 200 it reads, so
   * any claim it did not read was lost; see src/pairing/flow.ts, header
   * steps 5 and 6), or a 200 failed validation. The agent is on the
   * person's Pipbit and nothing can connect as it; they should say
   * "remove <name>" there before pairing again. The flow never rejects with
   * plain `claimed`; only pollPairing on its own reports that.
   */
  | "claim_lost";

/** A pairing route refused, or the flow could not finish. */
export class PairingError extends PipbitError {
  override name = "PairingError";
  declare readonly reason: PairingErrorReason;

  constructor(reason: PairingErrorReason, message: string, fields: Omit<PipbitErrorFields, "reason"> = {}) {
    super(message, { ...fields, reason });
  }
}
