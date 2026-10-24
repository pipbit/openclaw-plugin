import type { PipbitAccountStateFile } from "../shared/contracts.ts";
import {
  CONNECTED_LINE,
  connectRefusedLine,
  connectedNoHandoverLine,
  gatewayQuietLine,
  greetingLine,
  notConnectedLine,
  waitingForConnectLine,
  waitingForHandoverLine,
} from "./messages.ts";

// The wait after setup saves the config: the Gateway picks up the new
// account, the channel opens its socket, Pip hands the person over and the
// agent greets them (the connect intro). Setup cannot see any of that
// directly; it reads the account's state file, which the channel rewrites
// whenever the link or the owner changes (see PipbitAccountStateFile in
// src/shared/contracts.ts).
//
// It never blocks the pairing itself: the config is already written. Three
// limits apply; the first two are measured from the start of the wait:
//
// - The quiet limit (60 s): no state for the new agent yet means the Gateway
//   is not running or has not picked up the config. It is that long because
//   on OpenClaw 2026.9.4 a change under `channels.pipbit` restarts the whole
//   Gateway (see setup-plugin.ts), and such a restart can first wait out
//   OpenClaw's 30 s gap between two restarts (installing the plugin on
//   2026.9.4 needs a restart of its own, often just before) and any work in
//   progress, then loads every plugin again before the channel writes its
//   first state. A shorter limit would call a Gateway that is on its way back
//   "not running".
// - The overall limit (two and a half minutes): as long as Pip may still
//   hand the person over, plus time for the agent's first reply. Pip waits
//   about two minutes from her approval for the agent to come online
//   (PIP_HANDOFF_WAIT_MS). Her approval comes before this wait starts, so
//   she hands over at the latest about two minutes into it (when the person
//   saved the config at once); the agent's greeting then needs its model's
//   first reply (about 11 s on the first bench, with the model thinking first).
//   Waiting longer shows nothing new: Pip has given up by then.
// - The limit once connected (50 s, measured from the moment the agent is
//   connected): Pip does not wait for anything more after that. She reads
//   the agent's presence every 2 s and hands over as soon as it is online,
//   once her own line has finished (at most 15 s) and the person is not in
//   the middle of talking; then the greeting needs its model's first reply.
//   If no greeting comes by then, no hand-off is coming (the Pipbit session
//   ended, the device went to sleep, Pip's two minutes had already run out,
//   or the person is busy talking), so the person gets the line telling them
//   what to say instead of a spinner that runs on for up to two minutes.

/** No state for the new agent by then: the Gateway is not running (or not back yet). */
export const DEFAULT_QUIET_MS = 60_000;
/**
 * How long Pip keeps trying to hand the person over after she approves the
 * pairing (the bridge's hand-off wait, raised after the first bench). She
 * hands over as soon as the agent comes online in that time.
 */
export const PIP_HANDOFF_WAIT_MS = 120_000;
/** Time for the agent's first reply (the greeting) once Pip hands over. */
export const GREETING_ALLOWANCE_MS = 30_000;
/** The whole wait. */
export const DEFAULT_TIMEOUT_MS = PIP_HANDOFF_WAIT_MS + GREETING_ALLOWANCE_MS;
/**
 * From "connected" to Pip's hand-over: her next presence read (every 2 s),
 * up to 15 s for her own line to finish (the bridge's
 * _PAIRING_HANDOFF_SPEECH_DRAIN_MAX_S), and a little slack for her quiet
 * check and the switch itself.
 */
export const HANDOVER_AFTER_CONNECT_MS = 20_000;
/** The wait once the agent is connected: the hand-over, then the greeting. */
export const DEFAULT_CONNECTED_MS = HANDOVER_AFTER_CONNECT_MS + GREETING_ALLOWANCE_MS;

/** Where the wait's progress goes: a spinner or progress panel, or plain lines. */
export interface WaitOutput {
  /** Start (or restart) the progress line. */
  start(label: string): void;
  /** Stop the progress line and leave `line` behind. */
  finish(line: string): void;
}

export interface ConnectWaitOptions {
  /** The new pairing's internal agent name; state for any other agent is ignored. */
  agentName: string;
  /** The spoken name, for the lines. */
  displayName: string;
  /** Epoch ms of the claim; state written before it belongs to an older pairing. */
  pairedAtMs: number;
  readState(): Promise<PipbitAccountStateFile | null>;
  output: WaitOutput;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Total wait (default DEFAULT_TIMEOUT_MS, 150 s). */
  timeoutMs?: number;
  /**
   * The wait for the greeting once the agent is connected (default
   * DEFAULT_CONNECTED_MS, 50 s), never past the total wait.
   */
  connectedMs?: number;
  /** Between two reads of the state file (default 1 s). */
  pollMs?: number;
  /**
   * Give up early when no state for the new agent has appeared by then
   * (default DEFAULT_QUIET_MS, 60 s): the Gateway is not running, or has not
   * picked up the config, and waiting longer tells the person nothing more.
   */
  quietMs?: number;
}

export type ConnectWaitOutcome = "greeted" | "connected" | "refused" | "not_connected" | "gateway_quiet";

function parseTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function readQuietly(read: () => Promise<PipbitAccountStateFile | null>): Promise<PipbitAccountStateFile | null> {
  try {
    return await read();
  } catch {
    // A half-written or unreadable file reads as "no news yet".
    return null;
  }
}

export async function waitForFirstConnect(options: ConnectWaitOptions): Promise<ConnectWaitOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 1_000;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const connectedMs = options.connectedMs ?? DEFAULT_CONNECTED_MS;
  const name = options.displayName;
  const startedAt = options.now();
  // The time left runs out at the total limit, or earlier once connected.
  let deadlineMs = timeoutMs;
  let connected = false;
  let sawState = false;
  const markConnected = () => {
    connected = true;
    deadlineMs = Math.min(timeoutMs, options.now() - startedAt + connectedMs);
    options.output.finish(CONNECTED_LINE);
    options.output.start(waitingForHandoverLine(name));
  };

  options.output.start(waitingForConnectLine(name));
  for (;;) {
    const state = await readQuietly(options.readState);
    const updatedAt = parseTime(state?.updatedAt);
    // Only this pairing's state counts: before the channel restarts, the file
    // can still describe the old agent (or an older run of this one).
    if (state && state.agentName === options.agentName && updatedAt !== null && updatedAt >= options.pairedAtMs) {
      sawState = true;
      if (state.link === "failed") {
        options.output.finish(connectRefusedLine(name, state.reason));
        return "refused";
      }
      if (!connected && state.link === "connected") {
        markConnected();
      }
      const introAt = parseTime(state.lastIntroAt);
      if (introAt !== null && introAt > options.pairedAtMs) {
        if (!connected) {
          // The intro can only come over a live socket; say so before the greeting.
          markConnected();
        }
        options.output.finish(greetingLine(name, state.lastGreeting));
        return "greeted";
      }
    }
    const elapsed = options.now() - startedAt;
    if (!sawState && elapsed >= quietMs) {
      options.output.finish(gatewayQuietLine(name));
      return "gateway_quiet";
    }
    if (elapsed >= deadlineMs) {
      break;
    }
    await options.sleep(Math.min(pollMs, Math.max(1, deadlineMs - elapsed)));
  }
  if (connected) {
    options.output.finish(connectedNoHandoverLine(name));
    return "connected";
  }
  if (!sawState) {
    // An overall limit shorter than the quiet one ran out first.
    options.output.finish(gatewayQuietLine(name));
    return "gateway_quiet";
  }
  options.output.finish(notConnectedLine(name));
  return "not_connected";
}
