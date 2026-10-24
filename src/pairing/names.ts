// The agent's two names, and the rules that turn one into the other.
//
// The spoken name (the platform's `display_name`, "Home Brain") is what the
// person says to their Pipbit and what Pip says back. The agent name (the
// platform's `requested_name`, later `agent_name`, "home-brain") is the
// internal name the platform files the agent under: 2 to 64 characters of
// lowercase letters, digits, underscores and hyphens, starting with a letter
// or a digit, unique across every Pipbit agent. The wizard never asks for the
// agent name; it is derived from the spoken one here.
//
// The derivation is the Python SDK's rule (SDK/pipbit_sdk/pipbit/pairing.py,
// agent_name_from_display), so a paired agent's internal name looks the same
// whichever tool paired it, plus three repairs the SDK leaves to the
// platform's 400: accents are folded to plain letters ("Zoë" becomes "zoe",
// not "zo"), a leading underscore or hyphen is dropped (the grammar wants a
// letter or digit first), and the result is capped at 59 characters so a
// five-character suffix ("-7f3a") still fits inside 64 when the name is taken.
//
// The reserved-name check mirrors the platform's _validate_reserved_name
// (HOST/pipbit_platform_service/pipbit_platform_service/service.py) exactly,
// so a name the platform would refuse is caught before it costs a pairing
// start (the platform allows ten an hour per network address).

/** The platform's agent-name grammar (envelope.json#/$defs/agent_name). */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
export const AGENT_NAME_MAX_LENGTH = 64;
/** "-" plus four hex digits: what a taken name gets on the retry. */
export const NAME_SUFFIX_LENGTH = 5;
/** A derived name leaves room for the suffix. */
export const DERIVED_NAME_MAX_LENGTH = AGENT_NAME_MAX_LENGTH - NAME_SUFFIX_LENGTH;
/** The platform's cap on `display_name`. */
export const DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Names no third-party agent may take, as an agent name or a spoken name:
 * Pipbit's own assistant answers to them. The platform's default list; an
 * operator can replace it there (PIPBIT_PLATFORM_CONNECT_RESERVED_NAMES), in
 * which case the platform's 400 still catches what this copy misses.
 */
export const RESERVED_AGENT_NAMES: readonly string[] = Object.freeze([
  "pip",
  "pipbit",
  "pip-bit",
  "pipworks",
  "pippa",
]);

/**
 * The agent name for a spoken name: `Home Brain` becomes `home-brain`,
 * `Zoë` becomes `zoe`, `Café Bot` becomes `cafe-bot`. Returns "" when
 * nothing usable is left (`???`, a name written only in a non-Latin script).
 * The result can still be one character long, which the grammar refuses;
 * check it with isValidAgentName.
 */
export function agentNameFromDisplay(display: string): string {
  let name = String(display ?? "")
    .trim()
    // Fold accents: NFKD splits "ë" into "e" plus a combining mark (and
    // turns full-width and ligature letters into plain ones); the marks go.
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
  // The SDK's rule: every run of other characters becomes one hyphen,
  // repeated hyphens collapse, hyphens at the ends go.
  name = name.replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  // The grammar wants a letter or digit first.
  name = name.replace(/^[-_]+/, "");
  if (name.length > DERIVED_NAME_MAX_LENGTH) {
    // Cut, and never leave the cut ending on a separator.
    name = name.slice(0, DERIVED_NAME_MAX_LENGTH).replace(/[-_]+$/, "");
  }
  return name;
}

/** True when the platform's agent-name grammar accepts `name` as it is. */
export function isValidAgentName(name: string): boolean {
  return typeof name === "string" && AGENT_NAME_PATTERN.test(name);
}

/**
 * How a spoken name comes out of a speech recognizer: lowercase with every
 * character outside a-z and 0-9 dropped ("P.I.P" and "Pip-Bit" become
 * "pip" and "pipbit"). The platform's _asr_normalize.
 */
function asrNormalize(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * True when `value` is, or sounds like, one of the built-in assistant's
 * names, by the platform's own three tests: the lowercased value is on the
 * list; it normalizes to "pip"; or it normalizes to what a list entry
 * normalizes to. So "Pip", "P.I.P", "Pip-Bit", "pip_works" and "Pippa" are
 * reserved, while "peppa", "pipa" and "pip2" are not. Applies to agent names
 * and spoken names alike.
 */
export function isReservedName(value: string, reserved: readonly string[] = RESERVED_AGENT_NAMES): boolean {
  const text = String(value ?? "");
  const lowered = text.trim().toLowerCase();
  const list = reserved.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== "");
  if (list.includes(lowered)) {
    return true;
  }
  const normalized = asrNormalize(text);
  if (normalized === "pip") {
    return true;
  }
  return list.some((entry) => asrNormalize(entry) === normalized);
}

/**
 * A fresh agent name for when `base` is taken: `clementine` becomes
 * `clementine-7f3a` (four lowercase hex digits from `random`, which returns
 * a number in [0, 1) as Math.random does). The base is cut so the whole
 * stays within 64 characters and never ends on a separator before the
 * hyphen. The spoken name does not change; only the internal one does.
 */
export function withNameSuffix(base: string, random: () => number = Math.random): string {
  let draw = Number(random());
  if (!Number.isFinite(draw) || draw < 0) {
    draw = 0;
  }
  if (draw >= 1) {
    draw = 1 - Number.EPSILON;
  }
  const hex = Math.floor(draw * 0x10000)
    .toString(16)
    .padStart(4, "0");
  const stem = String(base ?? "")
    .slice(0, AGENT_NAME_MAX_LENGTH - NAME_SUFFIX_LENGTH)
    .replace(/[-_]+$/, "");
  return stem === "" ? hex : `${stem}-${hex}`;
}

/** Why a spoken name cannot be used. */
export interface NameProblem {
  reason: "reserved_name" | "invalid_request";
  /** One line, for the person; names the spoken name, never a code. */
  message: string;
}

export type NameCheck =
  | { ok: true; displayName: string; agentName: string }
  | { ok: false; problem: NameProblem };

/** A spoken name as it will be sent: whitespace runs become one space. */
export function tidyDisplayName(display: string): string {
  return String(display ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function quoted(display: string): string {
  const shown = display.length > 40 ? `${display.slice(0, 40)}...` : display;
  return `"${shown}"`;
}

/**
 * Everything the platform would refuse about a spoken name, checked before
 * a pairing start is spent on it: empty, longer than 80 characters,
 * reserved (the spoken name or the agent name derived from it), or no
 * usable agent name derivable from it. On success, the tidied spoken name
 * and its agent name.
 */
export function checkDisplayName(display: string): NameCheck {
  const displayName = tidyDisplayName(display);
  if (displayName === "") {
    return {
      ok: false,
      problem: { reason: "invalid_request", message: "The agent needs a name that people can say to their Pipbit." },
    };
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      problem: {
        reason: "invalid_request",
        message: `${quoted(displayName)} is too long to say (at most ${DISPLAY_NAME_MAX_LENGTH} characters); choose a shorter name.`,
      },
    };
  }
  const agentName = agentNameFromDisplay(displayName);
  if (isReservedName(displayName) || (agentName !== "" && isReservedName(agentName))) {
    return {
      ok: false,
      problem: {
        reason: "reserved_name",
        message: `${quoted(displayName)} is reserved for Pipbit's own assistant; choose another name.`,
      },
    };
  }
  if (!isValidAgentName(agentName)) {
    return {
      ok: false,
      problem: {
        reason: "invalid_request",
        message: `${quoted(displayName)} needs at least two plain letters or digits to become an agent name; choose another name.`,
      },
    };
  }
  return { ok: true, displayName, agentName };
}
