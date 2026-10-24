import { PairingError } from "../shared/errors.ts";
import type { PipbitAccountStateFile } from "../shared/contracts.ts";

// Every sentence the setup wizard shows, in one place. The wizard runs in a
// terminal (`openclaw channels add pipbit`, `openclaw onboard`) and in the
// Control UI (Channels, then Set up); the lines are plain sentences that read
// the same in both. None of them ever carries the agent secret, the device
// code or the bare six-digit code: the code only ever appears inside the
// platform's own `instructions` sentence, which the wizard shows verbatim.

export const CODE_TITLE = "Add this agent to your Pipbit";
export const NEW_CODE_TITLE = "Here is a new code";
export const NEW_CODE_LEAD = "The last code expired before your Pipbit heard it, so here is a new one.";
export const NEW_CODE_QUESTION = "The code expired before your Pipbit heard it. Get a new code?";
export const ANOTHER_NAME_PLACEHOLDER = "Another name (leave empty to stop)";
export const CONNECTED_LINE = "Connected to Pipbit.";

/** The one plain line under the code: the proof turn needs nothing more from the person. */
export function handoverLine(name: string): string {
  return `Once it is added, Pip will hand you over to ${name} by herself.`;
}

/**
 * "9 minutes left", "1 minute left", "less than a minute left": whole
 * minutes, so the line changes about once a minute rather than on every
 * poll (a remote client re-renders, and a screen reader re-announces, each
 * change).
 */
export function timeLeft(secondsLeft: number): string {
  if (secondsLeft < 60) {
    return "less than a minute left";
  }
  const minutes = Math.round(secondsLeft / 60);
  return minutes === 1 ? "1 minute left" : `${minutes} minutes left`;
}

export function waitingLine(secondsLeft: number): string {
  return `Waiting for you to say it to your Pipbit (${timeLeft(secondsLeft)})`;
}

/**
 * Shown the moment the claim arrives. OpenClaw saves the config only when
 * its whole setup flow is done, and it may still ask a question or two of
 * its own (who administers from chat, which agent answers), while Pip waits
 * about two minutes for the agent to come online before she gives up on the
 * hand-off. So the line asks the person to finish setup now: in a terminal
 * by pressing Enter through the rest, on a remote client (the Control UI) by
 * clicking through to Finish. In the Control UI, Done saves the settings
 * but the Gateway starts the channel only when the setup dialog closes at
 * its last screen, Finish (the 2026-09-25 bench: saved at Done 56 s after
 * the approval, connected at Finish 78 s after it).
 */
export function addedLine(name: string, remote = false): string {
  const how = remote ? "click through to Finish" : "press Enter through the rest";
  return `Added to your Pipbit as ${name}. Finish setup now (${how}): Pip is waiting to hand you over.`;
}

/**
 * The end of every question asked before a new pairing replaces a saved one.
 * Pairing again while the old agent is still on the Pipbit leaves two agents
 * with the same spoken name there, and "remove <name>" afterwards cannot
 * tell them apart, so the question asks for the removal first.
 */
function removeFirstQuestion(name: string): string {
  return `To pair it again, first say "remove ${name}" to your Pipbit, then answer yes. Pair it again now?`;
}

/** Asked before a new pairing replaces a saved one that still works. */
export function replaceQuestion(name: string): string {
  return `${name} is already paired with your Pipbit. ${removeFirstQuestion(name)}`;
}

/**
 * Shown when setup keeps the saved pairing but finds the Pipbit skill
 * switched off in OpenClaw's config (OpenClaw's `doctor --fix` did that to
 * installs paired with an earlier copy of the plugin), and switches it on.
 */
export function skillBackOnLine(name: string): string {
  return `The Pipbit skill (how ${name} speaks through your Pipbit) was switched off in OpenClaw's settings, so setup switched it back on. The pairing is unchanged.`;
}

/**
 * Setup started from OpenClaw's own chat ("connect pipbit"). That chat only
 * shows a setup's text once the setup asks a question, and a pairing waits
 * without asking anything, so the sentence would arrive after its code had
 * expired. The wizard stops at once with this line instead.
 */
export const CHAT_SETUP_LINE =
  'Pipbit pairing cannot run in the OpenClaw chat. Use the Control UI (Channels, then Pipbit, then Set up) or run "openclaw channels add pipbit" in a terminal.';

// ---------------------------------------------------------------------------
// When the saved pairing was refused
//
// The account's state file says Pipbit refused the saved pairing for good
// (link "failed"). What setup does depends on why; the choice is made in
// wizard.ts (refusalHandling), and these are its lines.
// ---------------------------------------------------------------------------

type Refusal = Pick<PipbitAccountStateFile, "reason" | "detail">;

/** The refusal word and, for a `revoked` refusal, the word that says why. */
export function refusalWords(state: Refusal): { reason: string; detail: string } {
  return { reason: (state.reason ?? "").trim(), detail: (state.detail ?? "").trim() };
}

/**
 * The one line shown when the agent is gone from the person's Pipbit (the
 * person said "remove <name>", the agent was deleted, or Pipbit Connect was
 * switched off for it), before setup pairs it again without asking.
 */
export function refusedLine(name: string, state: Refusal): string {
  const { reason, detail } = refusalWords(state);
  if (reason === "revoked" && detail === "deleted") {
    return `${name} no longer exists on Pipbit, so this pairs it again with a new code.`;
  }
  if (reason === "connect_not_enabled") {
    return `Pipbit Connect was switched off for ${name}, so this pairs it again with a new code.`;
  }
  return `Your Pipbit removed ${name}, so this pairs it again with a new code.`;
}

/**
 * The one line that ends setup when pairing again would not help: Pipbit
 * suspended the agent or expects it to connect another way (both need
 * Pipbit's support), or this plugin is too old for Pipbit.
 */
export function refusedStopLine(name: string, state: Refusal): string {
  const { reason } = refusalWords(state);
  if (reason === "protocol_unsupported") {
    return (
      `Pipbit no longer accepts this version of the Pipbit plugin, so setting ${name} up again does not help. ` +
      'Update the plugin with "openclaw plugins update pipbit".'
    );
  }
  if (reason === "transport_mismatch") {
    return (
      `Pipbit expects ${name} to connect a different way, so setting it up again does not help. ` +
      "Contact hello@pipworks.ai; once it is sorted out, restart the OpenClaw Gateway so it connects again."
    );
  }
  return (
    `Pipbit has suspended ${name}, so setting it up again does not help. ` +
    "Contact hello@pipworks.ai; once it is sorted out, restart the OpenClaw Gateway so it connects again."
  );
}

/**
 * Asked when Pipbit refused the saved pairing but the agent may still be on
 * the person's Pipbit (its credentials were refused or replaced, or the
 * refusal does not say). It asks for "remove <name>" first, like
 * replaceQuestion, and defaults to No.
 */
export function refusedQuestion(name: string, state: Refusal): string {
  const { reason, detail } = refusalWords(state);
  let lead: string;
  if (reason === "authentication_failed") {
    lead =
      `Pipbit did not accept ${name}'s credentials, but ${name} is probably still on your Pipbit. ` +
      "If this computer's clock is more than a minute off, fixing the clock is enough.";
  } else if (reason === "revoked" && detail === "secret_rotated") {
    lead = `${name}'s Pipbit credentials were replaced, but ${name} is still on your Pipbit.`;
  } else {
    // The refusal word itself (revoked, unpublished, something newer) is a
    // protocol word, not something to show the person.
    lead = `Pipbit stopped accepting ${name}, but ${name} may still be on your Pipbit.`;
  }
  return `${lead} ${removeFirstQuestion(name)}`;
}

// ---------------------------------------------------------------------------
// After the config is saved
// ---------------------------------------------------------------------------

export function waitingForConnectLine(name: string): string {
  return `Waiting for ${name} to connect to Pipbit`;
}

export function waitingForHandoverLine(name: string): string {
  return `Waiting for Pip to hand you over to ${name}`;
}

const GREETING_LIMIT = 280;

export function greetingLine(name: string, greeting: string | null): string {
  const words = (greeting ?? "").replace(/\s+/g, " ").trim();
  if (!words) {
    return `Pip handed you over to ${name}.`;
  }
  const shown = words.length > GREETING_LIMIT ? `${words.slice(0, GREETING_LIMIT - 3).trimEnd()}...` : words;
  return `${name} said: "${shown}"`;
}

export function connectedNoHandoverLine(name: string): string {
  return `${name} is connected. If Pip did not hand you over, say "connect me to ${name}" on your Pipbit.`;
}

export function notConnectedLine(name: string): string {
  return `${name} is not connected yet. Once it is, say "connect me to ${name}" on your Pipbit.`;
}

export function gatewayQuietLine(name: string): string {
  return (
    `${name} is saved and connects while the OpenClaw Gateway is running. ` +
    `Then say "connect me to ${name}" on your Pipbit.`
  );
}

export function connectRefusedLine(name: string, _reason: string | null): string {
  // The refusal word is a protocol word; the status command explains it in
  // plain words, with what to do.
  return `Pipbit refused ${name}'s connection. Run "openclaw channels status" to see why and what to do.`;
}

// ---------------------------------------------------------------------------
// When the pairing does not finish
// ---------------------------------------------------------------------------

export const ABORTED_LINE = "Setup stopped, and the code was withdrawn.";
export const NO_NAME_LINE = "No other name was given, so nothing was added.";
export const STOPPED_WORD = "Stopped.";

const SECRETISH = /pb_(?:live_sk|pc|cs)_[A-Za-z0-9_-]+/g;

/** Belt and braces: an error message never shows a credential-shaped token. */
export function redact(text: string): string {
  return text.replace(SECRETISH, "[hidden]");
}

/**
 * One plain line for a pairing that did not finish. `baseUrl` is named when
 * the platform could not be reached, so a mistyped custom address is visible;
 * `name` is the spoken name the pairing used.
 */
export function pairingFailureLine(error: unknown, baseUrl: string, name: string): string {
  if (error instanceof PairingError) {
    switch (error.reason) {
      case "claim_lost":
        return (
          `${name} was probably added to your Pipbit, but its key was lost on the way. ` +
          `Say "remove ${name}" to your Pipbit, then run setup again.`
        );
      case "rate_limited":
        return "Pipbit has had too many pairing requests from this network in the last hour. Try again later.";
      case "expired":
        return "The code expired before your Pipbit heard it, so nothing was added. Run setup again when you are ready.";
      case "platform_unreachable":
        return `Could not reach Pipbit at ${baseUrl}. Check this computer's internet connection and try again.`;
      case "timeout":
        return "Pipbit did not answer in time, so nothing was added. Try again in a moment.";
      case "aborted":
        return ABORTED_LINE;
      case "reserved_name":
        return redact(`${error.message} Nothing was added.`);
      case "name_taken":
        return "Pipbit already has an agent with that name. Give this OpenClaw agent another name and run setup again.";
      case "cancelled":
        return "The pairing was cancelled before it finished. Run setup again for a new code.";
      case "claimed":
        return "That pairing was already used. Run setup again for a new code.";
      case "failed":
        return "The name was taken on Pipbit at the last moment, so nothing was added. Run setup again.";
      case "not_found":
        return "Pipbit did not recognise the pairing. Run setup again; if this keeps happening, the service may not support pairing yet.";
      case "invalid_request":
        return redact(`Pipbit refused the pairing request: ${error.message}`);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return redact(`Setup stopped: ${message}`);
}
