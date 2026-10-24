import type {
  ConversationItem,
  DeferredResult,
  EngagementKind,
  ReplyOptions,
  ReplyOutcome,
  TurnRequest,
} from "../shared/contracts.ts";
import { CONNECT_INTRO_UTTERANCE, ENVIRONMENT_EVENT_UTTERANCE } from "../shared/contracts.ts";
import { InvalidRequestError } from "../shared/errors.ts";

import { isPlainObject } from "./frames.ts";

// One turn, from the `turn` frame's payload to the object a handler sees,
// and from whatever the handler returned to a turn.result body. The parse is
// type-strict like the Python SDK's Request.from_payload (models.py): a field
// that is present with the wrong type fails the whole turn with
// invalid_request instead of being guessed at (the advisory `engagement`
// word is the one exception, see optionalEngagement).

/** The turn's data, parsed and checked. */
export interface ParsedTurn {
  requestId: string;
  replyToken: string;
  text: string;
  sessionId: string | null;
  subjectId: string | null;
  agentSessionId: string | null;
  deviceId: string | null;
  handoffContext: string | null;
  managerName: string | null;
  conversation: ConversationItem[];
  deviceShadow: Record<string, unknown> | null;
  environmentEvent: Record<string, unknown> | null;
  multiUser: boolean;
  speakerVerified: boolean | null;
  speakerBasis: string | null;
  engagement: EngagementKind | null;
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidRequestError(`The '${field}' field must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidRequestError(`The '${field}' field must be a non-empty string when provided.`);
  }
  return value.trim();
}

function optionalBoolean(payload: Record<string, unknown>, field: string): boolean | null {
  const value = payload[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new InvalidRequestError(`The '${field}' field must be a boolean when provided.`);
  }
  return value;
}

/**
 * The one lenient field: `engagement` is guidance, not data the agent acts
 * on blindly, and a newer bridge may add a word, so anything but the two
 * known words (a wrong type included) reads null instead of failing the turn.
 */
function optionalEngagement(payload: Record<string, unknown>): EngagementKind | null {
  const value = payload["engagement"];
  return value === "named" || value === "router" ? value : null;
}

function optionalObject(payload: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = payload[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    throw new InvalidRequestError(`The '${field}' field must be an object or null.`);
  }
  return { ...value };
}

/**
 * Parse a turn payload (PROTOCOL.md section 7). Throws InvalidRequestError
 * when a required field is missing or empty, or an optional one is present
 * with the wrong type. `speaker_verified` must be a real JSON boolean; its
 * vocabulary (`speaker_basis`) is never checked. Speaker verification is a
 * user-experience filter, never a security control.
 */
export function parseTurnPayload(payload: unknown): ParsedTurn {
  if (!isPlainObject(payload)) {
    throw new InvalidRequestError("Turn payload must be a JSON object.");
  }
  const requestId = requireString(payload, "request_id");
  const replyToken = requireString(payload, "reply_token");
  const sessionId = optionalString(payload, "session_id");
  const text = requireString(payload, "utterance");
  const subjectId = optionalString(payload, "subject_id");
  const agentSessionId = optionalString(payload, "agent_session_id");
  const deviceId = optionalString(payload, "device_id");
  const handoffContext = optionalString(payload, "handoff_context");
  const managerName = optionalString(payload, "manager_name");
  const speakerVerified = optionalBoolean(payload, "speaker_verified");
  const speakerBasis = optionalString(payload, "speaker_basis");

  let rawConversation = payload["conversation"];
  if (rawConversation === undefined || rawConversation === null) {
    rawConversation = [];
  }
  if (!Array.isArray(rawConversation)) {
    throw new InvalidRequestError("The 'conversation' field must be a list.");
  }
  const conversation: ConversationItem[] = rawConversation.map((item: unknown, index: number) => {
    if (!isPlainObject(item)) {
      throw new InvalidRequestError(`The 'conversation' item at index ${index} must be an object.`);
    }
    // The item's keys are the bridge's; role and text are always strings
    // here so a consumer never has to check them again.
    return {
      ...item,
      role: typeof item["role"] === "string" ? item["role"] : "",
      text: typeof item["text"] === "string" ? item["text"] : "",
    };
  });

  return {
    requestId,
    replyToken,
    text,
    sessionId,
    subjectId,
    agentSessionId,
    deviceId,
    handoffContext,
    managerName,
    conversation,
    deviceShadow: optionalObject(payload, "device_shadow"),
    environmentEvent: optionalObject(payload, "environment_event"),
    // The wire keeps the old name: family_mode, true only when sent as true.
    multiUser: payload["family_mode"] === true,
    speakerVerified,
    speakerBasis,
    engagement: optionalEngagement(payload),
  };
}

/** What a handler's return value comes to on the wire. */
export type NormalizedOutcome =
  | { kind: "text"; text: string }
  | { kind: "deferred"; stillWorking: boolean }
  | { kind: "configuration_error" };

/**
 * The SDK's normalize_handler_result (dispatch.py), plus the plugin's
 * `stillWorking` flag: a non-empty string or `{text}` is the answer
 * (trimmed; any other key, handback included, is dropped because an inline
 * answer cannot carry it); `defer()` or `{status: "deferred"}` defers;
 * anything else (an empty or blank string, null, a number) is the agent's
 * configuration error.
 */
export function normalizeHandlerResult(value: unknown): NormalizedOutcome {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? { kind: "text", text } : { kind: "configuration_error" };
  }
  if (isPlainObject(value)) {
    if (value["kind"] === "deferred") {
      return { kind: "deferred", stillWorking: value["stillWorking"] === true };
    }
    const text = value["text"];
    if (typeof text === "string" && text.trim()) {
      return { kind: "text", text: text.trim() };
    }
    if (value["status"] === "deferred") {
      return { kind: "deferred", stillWorking: false };
    }
  }
  return { kind: "configuration_error" };
}

/** What the client lends a turn object: its cancel state and its two ways to finish. */
export interface TurnControl {
  readonly signal: AbortSignal;
  isCancelled(): boolean;
  reply(text: string, options?: ReplyOptions): Promise<ReplyOutcome>;
  settle(): void;
}

/** The TurnRequest a handler receives (src/shared/contracts.ts). */
export class ConnectTurnRequest implements TurnRequest {
  readonly requestId: string;
  readonly replyToken: string;
  readonly text: string;
  readonly sessionId: string | null;
  readonly subjectId: string | null;
  readonly agentSessionId: string | null;
  readonly deviceId: string | null;
  readonly handoffContext: string | null;
  readonly managerName: string | null;
  readonly conversation: readonly ConversationItem[];
  readonly deviceShadow: Readonly<Record<string, unknown>> | null;
  readonly environmentEvent: Readonly<Record<string, unknown>> | null;
  readonly multiUser: boolean;
  readonly speakerVerified: boolean | null;
  readonly speakerBasis: string | null;
  readonly engagement: EngagementKind | null;
  readonly redelivery: boolean;
  readonly signal: AbortSignal;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly #control: TurnControl;

  constructor(parsed: ParsedTurn, payload: Record<string, unknown>, redelivery: boolean, control: TurnControl) {
    this.requestId = parsed.requestId;
    this.replyToken = parsed.replyToken;
    this.text = parsed.text;
    this.sessionId = parsed.sessionId;
    this.subjectId = parsed.subjectId;
    this.agentSessionId = parsed.agentSessionId;
    this.deviceId = parsed.deviceId;
    this.handoffContext = parsed.handoffContext;
    this.managerName = parsed.managerName;
    this.conversation = parsed.conversation;
    this.deviceShadow = parsed.deviceShadow;
    this.environmentEvent = parsed.environmentEvent;
    this.multiUser = parsed.multiUser;
    this.speakerVerified = parsed.speakerVerified;
    this.speakerBasis = parsed.speakerBasis;
    this.engagement = parsed.engagement;
    this.redelivery = redelivery;
    this.signal = control.signal;
    this.payload = payload;
    this.#control = control;
  }

  isConnectIntro(): boolean {
    return this.text === CONNECT_INTRO_UTTERANCE;
  }

  isEnvironmentEvent(): boolean {
    return this.text === ENVIRONMENT_EVENT_UTTERANCE;
  }

  isCancelled(): boolean {
    return this.#control.isCancelled();
  }

  defer(options?: { stillWorking?: boolean }): DeferredResult {
    return Object.freeze({ kind: "deferred" as const, stillWorking: options?.stillWorking === true });
  }

  reply(text: string, options?: ReplyOptions): Promise<ReplyOutcome> {
    return this.#control.reply(text, options);
  }

  settle(): void {
    this.#control.settle();
  }

  /**
   * Never show the reply token or the utterance in a log line by accident:
   * serialising or inspecting a turn shows only its id. The full data is on
   * the fields (and `payload`) for code that means to read it.
   */
  toJSON(): Record<string, unknown> {
    return { requestId: this.requestId, redelivery: this.redelivery };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `TurnRequest { requestId: ${JSON.stringify(this.requestId)}, redelivery: ${this.redelivery} }`;
  }
}
