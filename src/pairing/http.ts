// The three agent pairing routes the wizard calls (PROTOCOL.md section 16.7):
// start (POST /v1/connect/pairings), poll (POST .../<pairing_id>/token) and
// cancel (POST .../<pairing_id>/cancel). None takes a credential: a program
// that is pairing has none yet. The other two pairing routes (lookup and
// approve) are the bridge's, called when the person says the code to Pip.
//
// Answers are classified by the platform's error word first, then by the
// HTTP status, never by the message text (the spec's rule for this family).
// The start hands over two codes: the six-digit pairing code the person says
// (in PairingCode, for the screen) and the long device code this program
// presents on every poll and on cancel. The device code lives only in a
// private map inside this module, keyed by the PendingPairing object: it is
// never a field, never in an error message, never in a log line.

import type { ClientInfo, PairingClaim, PairingCode } from "../shared/contracts.ts";
import { HELLO_CLIENT_NAME, PLUGIN_VERSION } from "../shared/contracts.ts";
import { PairingError } from "../shared/errors.ts";
import type { PairingErrorReason } from "../shared/errors.ts";
import { isValidAgentName } from "./names.ts";
import { scrub, withRedactedView } from "./redact.ts";

/** Each pairing request gives up after this long (the SDK's deadline too). */
export const PAIRING_HTTP_TIMEOUT_MS = 10_000;
export const PAIRING_USER_AGENT = `${HELLO_CLIENT_NAME}/${PLUGIN_VERSION}`;
/** Used when a start answer lacks a usable `expires_in` / `interval`. */
export const DEFAULT_EXPIRES_IN_S = 600;
export const DEFAULT_INTERVAL_S = 5;

// The platform's caps on the optional start fields. A longer value would be
// a 400 that also costs one of the hourly starts, so it is caught here.
const CLIENT_FIELD_LIMITS = { name: 64, version: 32, runtime: 64 } as const;
const AGENCY_NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 2000;

/** Seams shared by every route. */
export interface PairingRequestOptions {
  fetchImpl?: typeof fetch;
  /** Per request; default PAIRING_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Aborting rejects the request with PairingError `aborted`. */
  signal?: AbortSignal;
}

export interface StartPairingOptions extends PairingRequestOptions {
  /** `https://api.pipbit.ai` in production; no `/v1`. */
  baseUrl: string;
  /** Epoch ms; the code's lifetime counts from when the start answered. */
  now?: () => number;
}

export interface StartPairingRequest {
  /** The agent name, already derived and checked (`home-brain`). */
  requestedName: string;
  /** The spoken name; always sent when given, so the platform never derives one. */
  displayName?: string;
  client?: ClientInfo;
  agencyName?: string;
  description?: string;
}

export type PollOutcome =
  | { status: "pending"; /** The 428 body's `interval`, when it carried one. */ intervalS: number | null }
  | { status: "claimed"; claim: PairingClaim };

export type CancelOutcome = "cancelled" | "not_pending" | "not_found";

/** A classified answer that was not a PairingError. */
export type PairingAnswer =
  | { kind: "ok"; status: number; body: Record<string, unknown> }
  | { kind: "pending"; intervalS: number | null };

// ---------------------------------------------------------------------------
// The started pairing
// ---------------------------------------------------------------------------

const deviceCodes = new WeakMap<PendingPairing, string>();

/**
 * A pairing the platform has started: the code to show, and what poll and
 * cancel need. Printing or serializing it shows only the pairing id and the
 * agent name (the id is not a secret; it names the pairing in URLs).
 */
export class PendingPairing {
  readonly code: PairingCode;
  /** The base URL the start went to, without a trailing slash. */
  readonly baseUrl: string;

  constructor(code: PairingCode, deviceCode: string, baseUrl: string) {
    this.code = code;
    this.baseUrl = baseUrl;
    deviceCodes.set(this, deviceCode);
    withRedactedView(this, "PendingPairing", () => ({
      pairingId: code.pairingId,
      requestedName: code.requestedName,
    }));
  }
}

function deviceCodeOf(pairing: PendingPairing): string {
  const deviceCode = deviceCodes.get(pairing);
  if (deviceCode === undefined) {
    throw new PairingError("invalid_request", "This pairing was not started by startPairing.");
  }
  return deviceCode;
}

// ---------------------------------------------------------------------------
// The three routes
// ---------------------------------------------------------------------------

/**
 * The start body exactly as it is sent: `requested_name`, then the optional
 * fields that have something in them (trimmed; an empty string is left out,
 * because the platform refuses one). Never `multi_user`: the platform's
 * default applies, and for a paired agent that is owner-only (since
 * 2026-10-01). Throws PairingError `invalid_request` (no status) for a
 * value the platform would refuse for its form, before anything is sent.
 */
export function buildStartBody(request: StartPairingRequest): Record<string, unknown> {
  const requestedName = String(request.requestedName ?? "").trim();
  if (!isValidAgentName(requestedName)) {
    throw new PairingError(
      "invalid_request",
      "The agent name must be 2 to 64 characters of lowercase letters, digits, underscores or hyphens, starting with a letter or digit.",
    );
  }
  const body: Record<string, unknown> = { requested_name: requestedName };
  const displayName = trimmed(request.displayName);
  if (displayName !== "") {
    body.display_name = displayName;
  }
  if (request.client !== undefined) {
    const client: Record<string, string> = {};
    for (const key of ["name", "version", "runtime"] as const) {
      const value = trimmed(request.client[key]);
      if (value === "") {
        continue;
      }
      if (value.length > CLIENT_FIELD_LIMITS[key]) {
        throw new PairingError(
          "invalid_request",
          `The client ${key} must be ${CLIENT_FIELD_LIMITS[key]} characters or fewer.`,
        );
      }
      client[key] = value;
    }
    if (Object.keys(client).length > 0) {
      body.client = client;
    }
  }
  const agencyName = trimmed(request.agencyName);
  if (agencyName !== "") {
    if (agencyName.length > AGENCY_NAME_MAX_LENGTH) {
      throw new PairingError(
        "invalid_request",
        `The agency name must be ${AGENCY_NAME_MAX_LENGTH} characters or fewer.`,
      );
    }
    body.agency_name = agencyName;
  }
  const description = trimmed(request.description);
  if (description !== "") {
    // Decoration only: a long one is cut rather than failing the pairing.
    body.description = description.slice(0, DESCRIPTION_MAX_LENGTH).trimEnd();
  }
  return body;
}

/**
 * Start a pairing. Resolves with the PendingPairing (its `code` is what the
 * person is shown). Rejects with PairingError: `invalid_request` (the
 * platform's 400, or a local refusal with no status), `name_taken` (409),
 * `rate_limited` (429), `not_found` (a platform older than pairing),
 * `platform_unreachable` or `aborted`.
 */
export async function startPairing(request: StartPairingRequest, options: StartPairingOptions): Promise<PendingPairing> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const body = buildStartBody(request);
  const answer = await postJson(`${baseUrl}/v1/connect/pairings`, body, options, "start a pairing", []);
  const startedAtMs = (options.now ?? Date.now)();
  const classified = classifyPairingAnswer(answer.status, answer.body);
  if (classified.kind !== "ok") {
    // Only the token route says "pending"; a start that does is broken.
    throw new PairingError("platform_unreachable", "The platform answered the pairing start as if it were a poll.", {
      statusCode: answer.status,
      code: "invalid_response",
    });
  }
  const fallbackDisplay = typeof body.display_name === "string" ? body.display_name : String(body.requested_name);
  return pendingFromStartBody(classified.body, {
    requestedName: String(body.requested_name),
    displayName: fallbackDisplay,
    startedAtMs,
    baseUrl,
    statusCode: answer.status,
  });
}

/**
 * One poll of the token route. Resolves `pending` while the person has not
 * approved yet (428), or `claimed` with the agent's name and secret (200,
 * shown by the platform exactly once). Rejects with PairingError: `expired`,
 * `cancelled`, `claimed` (someone already collected it) or `failed` (with
 * `detail` the platform's reason, today only `name_taken`), all 410;
 * `not_found` (404); `claim_lost` (a 2xx this program cannot read: on this
 * route a 2xx means the platform has already registered the agent, so the
 * secret in it is gone for good); `platform_unreachable`; or `aborted`.
 *
 * Pass no `signal` while a claim may be in flight unless dropping it is
 * really wanted: an aborted request can lose the one answer that carries the
 * secret, after the platform has already registered the agent.
 */
export async function pollPairing(pairing: PendingPairing, options: PairingRequestOptions = {}): Promise<PollOutcome> {
  const deviceCode = deviceCodeOf(pairing);
  const secrets = codeSecrets(pairing, deviceCode);
  const answer = await postJson(
    `${pairing.baseUrl}/v1/connect/pairings/${encodeURIComponent(pairing.code.pairingId)}/token`,
    { device_code: deviceCode },
    options,
    "poll the pairing",
    secrets,
  );
  if (answer.status >= 200 && answer.status < 300) {
    // The platform registers the agent in the same step that sends this
    // answer, so one this program cannot read is a lost claim.
    return { status: "claimed", claim: claimFromBody(answer.body, pairing, answer.status, secrets) };
  }
  const classified = classifyPairingAnswer(answer.status, answer.body, secrets);
  if (classified.kind === "pending") {
    return { status: "pending", intervalS: classified.intervalS };
  }
  // Only a 2xx classifies as "ok", and that was handled above.
  throw new PairingError("platform_unreachable", `The platform answered the poll with status ${answer.status}.`, {
    statusCode: answer.status,
  });
}

/**
 * Withdraw a pairing, so its code stops working. Resolves `cancelled` (200,
 * also when it already was), `not_pending` (409: it was claimed, expired or
 * failed already) or `not_found` (404). Rejects with PairingError
 * `platform_unreachable` or `aborted`, or as a poll would for anything else.
 */
export async function cancelPairing(pairing: PendingPairing, options: PairingRequestOptions = {}): Promise<CancelOutcome> {
  const deviceCode = deviceCodeOf(pairing);
  const secrets = codeSecrets(pairing, deviceCode);
  const answer = await postJson(
    `${pairing.baseUrl}/v1/connect/pairings/${encodeURIComponent(pairing.code.pairingId)}/cancel`,
    { device_code: deviceCode },
    options,
    "cancel the pairing",
    secrets,
  );
  try {
    classifyPairingAnswer(answer.status, answer.body, secrets);
    return "cancelled";
  } catch (error) {
    if (error instanceof PairingError) {
      if (error.code === "pairing_not_pending") {
        return "not_pending";
      }
      if (error.reason === "not_found") {
        return "not_found";
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The pairing routes' error words and what each becomes. */
const REASON_BY_WORD: Readonly<Record<string, PairingErrorReason>> = {
  invalid_request: "invalid_request",
  name_taken: "name_taken",
  rate_limited: "rate_limited",
  pairing_not_found: "not_found",
  pairing_expired: "expired",
  pairing_cancelled: "cancelled",
  pairing_claimed: "claimed",
  pairing_failed: "failed",
  // Approve or cancel on a pairing past pending. Deliberately NOT
  // name_taken, which the Python SDK reads any 409 as: that would send the
  // flow off on a suffix retry for a pairing that simply ended.
  pairing_not_pending: "invalid_request",
};

/** For a word this plugin does not know yet. */
const REASON_BY_STATUS: Readonly<Record<number, PairingErrorReason>> = {
  400: "invalid_request",
  404: "not_found",
  // An unknown 409 is not assumed to be name_taken (see above).
  409: "invalid_request",
  410: "failed",
  429: "rate_limited",
};

const DEFAULT_MESSAGES: Readonly<Record<PairingErrorReason, string>> = {
  invalid_request: "The platform refused the pairing request.",
  reserved_name: "That name is reserved for Pipbit's own assistant.",
  name_taken: "That agent name is already registered on Pipbit.",
  rate_limited: "Too many pairing requests; try again later.",
  not_found: "The platform does not know this pairing; it may have expired.",
  expired: "The pairing code expired before it was approved.",
  cancelled: "The pairing was cancelled.",
  claimed: "This pairing was already claimed; its secret is handed over once and cannot be shown again.",
  failed: "The pairing failed before the agent could be registered.",
  platform_unreachable: "The Pipbit platform could not be reached.",
  timeout: "The pairing was not approved in time.",
  aborted: "The pairing was abandoned.",
  claim_lost: "The answer that carried the agent's key was lost after the platform added the agent.",
};

/**
 * Turn a pairing route's answer into `ok` (a 2xx with a JSON object),
 * `pending` (the token route's 428), or a thrown PairingError. `body` is the
 * parsed JSON object, or null when the answer carried none. `secrets` are
 * scrubbed from any platform message before it becomes the error's message.
 */
export function classifyPairingAnswer(
  status: number,
  body: Record<string, unknown> | null,
  secrets: readonly string[] = [],
): PairingAnswer {
  const word = stringField(body, "error");
  const platformMessage = stringField(body, "message");
  const message = (reason: PairingErrorReason, fallback?: string): string =>
    scrub(platformMessage ?? fallback ?? DEFAULT_MESSAGES[reason], secrets);

  if (status >= 200 && status < 300) {
    if (body === null) {
      throw new PairingError("platform_unreachable", `The platform answered ${status} without a JSON body.`, {
        statusCode: status,
        code: "invalid_response",
      });
    }
    return { kind: "ok", status, body };
  }
  if (word === "pairing_pending" || status === 428) {
    return { kind: "pending", intervalS: positiveInt(body, "interval") };
  }
  if (status >= 500) {
    throw new PairingError(
      "platform_unreachable",
      scrub(platformMessage ?? `The Pipbit platform failed with status ${status}.`, secrets),
      { code: word, statusCode: status },
    );
  }
  if (status >= 400) {
    if (body === null) {
      if (status === 404) {
        throw new PairingError(
          "not_found",
          "The platform answered 404 without a JSON body: it has no pairing routes (it is older than pairing).",
          { statusCode: status },
        );
      }
      if (status === 429) {
        throw new PairingError("rate_limited", DEFAULT_MESSAGES.rate_limited, { statusCode: status });
      }
      throw new PairingError(
        "platform_unreachable",
        `The platform answered ${status} without a JSON body (something between here and Pipbit may have answered instead).`,
        { statusCode: status },
      );
    }
    const reason = (word !== null ? REASON_BY_WORD[word] : undefined) ?? REASON_BY_STATUS[status] ?? "invalid_request";
    let detail: string | null = null;
    if (reason === "failed") {
      detail = stringField(body, "reason") ?? (word !== null && word !== "pairing_failed" ? word : null);
    } else if (word === "pairing_not_pending") {
      detail = stringField(body, "status");
    }
    throw new PairingError(reason, message(reason), { code: word, statusCode: status, detail });
  }
  if (status >= 300 && status < 400) {
    throw new PairingError(
      "platform_unreachable",
      `The platform answered with a redirect (status ${status}); check the base URL (it must be the https address itself).`,
      { statusCode: status },
    );
  }
  throw new PairingError("platform_unreachable", `The platform answered with an unexpected status ${status}.`, {
    code: word,
    statusCode: status,
  });
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function invalidAnswer(what: string, statusCode: number): PairingError {
  return new PairingError("platform_unreachable", `The platform's answer has no usable '${what}'; the pairing cannot go on.`, {
    statusCode,
    code: "invalid_response",
  });
}

function requiredString(body: Record<string, unknown>, key: string, statusCode: number): string {
  const value = stringField(body, key);
  if (value === null) {
    throw invalidAnswer(key, statusCode);
  }
  return value;
}

/** `472915` shown as `472 915`; any other shape is shown as it came. */
export function groupUserCode(userCode: string): string {
  return /^[0-9]{6}$/.test(userCode) ? `${userCode.slice(0, 3)} ${userCode.slice(3)}` : userCode;
}

/** The platform's sentence, built here only when an answer lacks it. */
function instructionsFor(displayName: string, userCodeDisplay: string): string {
  return `On your Pipbit, say: "Pip, please add ${displayName} with code ${userCodeDisplay}."`;
}

function pendingFromStartBody(
  body: Record<string, unknown>,
  context: { requestedName: string; displayName: string; startedAtMs: number; baseUrl: string; statusCode: number },
): PendingPairing {
  const pairingId = requiredString(body, "pairing_id", context.statusCode);
  const userCode = requiredString(body, "user_code", context.statusCode);
  const deviceCode = requiredString(body, "device_code", context.statusCode);
  const userCodeDisplay = stringField(body, "user_code_display") ?? groupUserCode(userCode);
  const requestedName = stringField(body, "requested_name") ?? context.requestedName;
  const displayName = stringField(body, "display_name") ?? context.displayName;
  const code: PairingCode = {
    pairingId,
    userCode,
    userCodeDisplay,
    instructions: stringField(body, "instructions") ?? instructionsFor(displayName, userCodeDisplay),
    expiresInS: positiveInt(body, "expires_in") ?? DEFAULT_EXPIRES_IN_S,
    intervalS: positiveInt(body, "interval") ?? DEFAULT_INTERVAL_S,
    requestedName,
    displayName,
    startedAtMs: context.startedAtMs,
  };
  withRedactedView(code, "PairingCode", () => ({
    pairingId: code.pairingId,
    requestedName: code.requestedName,
    displayName: code.displayName,
    expiresInS: code.expiresInS,
    intervalS: code.intervalS,
    startedAtMs: code.startedAtMs,
  }));
  return new PendingPairing(code, deviceCode, context.baseUrl);
}

/**
 * The platform registered the agent, but the one answer that carried its
 * secret never arrived or could not be read. `problem` says which, in one
 * clause; the message names the spoken name, never a code or the secret.
 */
export function claimLostError(
  displayName: string,
  problem: string,
  fields: { code?: string | null; statusCode?: number | null } = {},
): PairingError {
  return new PairingError(
    "claim_lost",
    `${problem}, so the agent's key was lost. Pipbit most likely added ${displayName} anyway, and nothing can ` +
      `connect as it: say "remove ${displayName}" to your Pipbit before pairing again.`,
    fields,
  );
}

/**
 * The claim out of a 2xx token answer. Anything unusable throws `claim_lost`
 * (code `invalid_response`): the platform has registered the agent already,
 * so the secret this answer carried cannot be asked for again.
 */
function claimFromBody(
  body: Record<string, unknown> | null,
  pairing: PendingPairing,
  statusCode: number,
  secrets: readonly string[],
): PairingClaim {
  const lost = (problem: string): PairingError =>
    claimLostError(scrub(pairing.code.displayName, secrets), problem, { code: "invalid_response", statusCode });
  if (body === null) {
    throw lost(`The platform answered the claim (status ${statusCode}) without a JSON body`);
  }
  const field = (key: string): string => {
    const value = stringField(body, key);
    if (value === null) {
      throw lost(`The platform's claim answer has no usable '${key}'`);
    }
    return value;
  };
  const agentName = field("agent_name");
  const secret = field("secret");
  const baseUrl = field("base_url");
  // Used exactly as given: the platform names the socket's address.
  const connectUrl = field("connect_url");
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw lost("The platform's claim answer has no usable 'base_url'");
  }
  if (!/^wss?:\/\//i.test(connectUrl)) {
    throw lost("The platform's claim answer has no usable 'connect_url'");
  }
  const agent = body.agent;
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) {
    throw lost("The platform's claim answer has no usable 'agent'");
  }
  const claim: PairingClaim = {
    pairingId: stringField(body, "pairing_id") ?? pairing.code.pairingId,
    agentName,
    secret,
    baseUrl,
    connectUrl,
    agent: { ...(agent as Record<string, unknown>) },
  };
  // JSON.stringify(claim) and console.log(claim) leave the secret out;
  // read claim.secret to store it.
  withRedactedView(claim, "PairingClaim", () => ({
    pairingId: claim.pairingId,
    agentName: claim.agentName,
    baseUrl: claim.baseUrl,
    connectUrl: claim.connectUrl,
  }));
  return claim;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringField(body: Record<string, unknown> | null, key: string): string | null {
  if (body === null) {
    return null;
  }
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function positiveInt(body: Record<string, unknown> | null, key: string): number | null {
  if (body === null) {
    return null;
  }
  const value = body[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function codeSecrets(pairing: PendingPairing, deviceCode: string): string[] {
  return [deviceCode, pairing.code.userCode, pairing.code.userCodeDisplay];
}

function normalizeBaseUrl(baseUrl: string): string {
  const text = String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new PairingError("invalid_request", "The Pipbit base URL must be an http:// or https:// address.");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.host === "") {
    throw new PairingError("invalid_request", "The Pipbit base URL must be an http:// or https:// address.");
  }
  return text;
}

interface RawAnswer {
  status: number;
  /** The parsed JSON object, or null when the body was empty or not an object. */
  body: Record<string, unknown> | null;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== null && typeof cause === "object") {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === "string" && code !== "") {
        return code;
      }
      const name = (cause as { name?: unknown }).name;
      if (typeof name === "string" && name !== "") {
        return name;
      }
    }
    return error.name;
  }
  return "unknown error";
}

/**
 * One POST with a JSON body, the three headers, and the per-request
 * deadline. The request body (which may hold the device code) is never put
 * into an error; `secrets` are scrubbed from anything that is.
 */
async function postJson(
  url: string,
  payload: Record<string, unknown>,
  options: PairingRequestOptions,
  what: string,
  secrets: readonly string[],
): Promise<RawAnswer> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PAIRING_HTTP_TIMEOUT_MS;
  const outer = options.signal;
  if (outer?.aborted) {
    throw new PairingError("aborted", DEFAULT_MESSAGES.aborted);
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": PAIRING_USER_AGENT,
      },
      body: JSON.stringify(payload),
      // A redirect is answered, not followed: following one would carry the
      // device code to wherever it points.
      redirect: "manual",
      signal,
    });
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    if (text.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  } catch (error) {
    if (outer?.aborted) {
      throw new PairingError("aborted", DEFAULT_MESSAGES.aborted);
    }
    if (timeout.aborted) {
      const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`;
      throw new PairingError(
        "platform_unreachable",
        `The Pipbit platform did not answer within ${limit} when asked to ${what}.`,
      );
    }
    throw new PairingError(
      "platform_unreachable",
      scrub(`Could not reach the Pipbit platform to ${what} (${describeNetworkError(error)}).`, secrets),
    );
  }
}
