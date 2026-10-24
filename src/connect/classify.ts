import type { PushResult } from "../shared/contracts.ts";
import {
  AuthenticationError,
  ConnectError,
  InvalidRequestError,
  PlatformServerError,
  SessionGoneError,
} from "../shared/errors.ts";

import type { Frame } from "./frames.ts";

// What a `result` frame means for the push that asked for it. The rules are
// the Python SDK's classify_api_result (SDK/pipbit_sdk/pipbit/client.py), so
// a platform verdict raises the same error class whichever client pushed:
// the conformance scenarios name the class they expect.

/** A result frame reduced to the HTTP status and body the route would have answered with. */
export interface FrameResult {
  statusCode: number;
  body: Record<string, unknown> | null;
}

function isStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Reduce a `result` frame to a FrameResult. A success keeps its `data` (and
 * reads as a 200 when the status is missing); a failure keeps only the
 * string `error`, `reason` and `message` fields. A failure with no integer
 * status cannot be classified and is a ConnectError `invalid_frame`.
 */
export function frameResultFrom(frame: Frame): FrameResult {
  const statusCode = frame["status_code"];
  if (frame["ok"] === true) {
    const data = frame["data"];
    return {
      statusCode: isStatus(statusCode) ? statusCode : 200,
      body: data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null,
    };
  }
  if (!isStatus(statusCode)) {
    throw new ConnectError("The platform's answer was not a valid result frame.", { reason: "invalid_frame" });
  }
  const body: Record<string, unknown> = {};
  for (const key of ["error", "reason", "message"]) {
    if (typeof frame[key] === "string") {
      body[key] = frame[key];
    }
  }
  return { statusCode, body };
}

function stringField(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(body: Record<string, unknown> | null): string | null {
  for (const key of ["message", "error", "detail"]) {
    const value = stringField(body, key);
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * The verdict on a push: the PushResult on a 2xx, else the typed error.
 * `replyDelivery` says the push was a reply, the only kind where the
 * reply-token reasons mean anything.
 *
 * - 401 or 403: AuthenticationError.
 * - A reply refused with `reply_token_cancelled` or `reply_token_not_pending`:
 *   InvalidRequestError (never SessionGoneError: a withdrawn or already
 *   answered turn must not be re-spoken through a message).
 * - `no_active_agent_session`, or a reply refused as unknown (404
 *   `not_found`), expired (`reply_token_expired`, or an older platform's
 *   "Reply token has expired" 400): SessionGoneError.
 * - Any other 4xx, a 429 `rate_limited` included: InvalidRequestError.
 * - 5xx, the broker's 503 `platform_unavailable` included: PlatformServerError.
 * - 1xx or 3xx: InvalidRequestError (not a verdict these rules know).
 */
export function classifyPushResult(result: FrameResult, replyDelivery: boolean): PushResult {
  const status = result.statusCode;
  const body = result.body;
  const code = stringField(body, "error");
  const reason = stringField(body, "reason");
  const detail = errorMessage(body);
  if (status === 401 || status === 403) {
    throw new AuthenticationError(
      detail ? `Pipbit API authentication failed: ${detail}` : "Pipbit API authentication failed.",
      { code, statusCode: status },
    );
  }
  if (status >= 400 && status < 500) {
    const message = detail
      ? `Pipbit API rejected the request: ${detail}`
      : `Pipbit API rejected the request with status code ${status}.`;
    const fields = { code, statusCode: status, reason };
    if (replyDelivery && (reason === "reply_token_cancelled" || reason === "reply_token_not_pending")) {
      throw new InvalidRequestError(message, fields);
    }
    const sessionGone =
      code === "no_active_agent_session" ||
      (replyDelivery &&
        ((status === 404 && code === "not_found") ||
          reason === "reply_token_expired" ||
          (status === 400 && (detail ?? "").startsWith("Reply token has expired"))));
    if (sessionGone) {
      throw new SessionGoneError(message, fields);
    }
    throw new InvalidRequestError(message, fields);
  }
  if (status >= 500) {
    throw new PlatformServerError(`Pipbit API request failed with status code ${status}.`, { code, statusCode: status });
  }
  if (status < 200 || status >= 300) {
    throw new InvalidRequestError(
      `Pipbit API answered with an unexpected status code ${status}${detail ? `: ${detail}` : "."}`,
      { code, statusCode: status, reason },
    );
  }
  return { statusCode: status, data: body };
}
