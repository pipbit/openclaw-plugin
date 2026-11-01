// The status line: what the link state means in plain words, and how it maps
// onto OpenClaw's account status fields. Pure and setup-safe (no socket, no
// runtime), so the setup wizard and the CLI status commands can use it.
//
// Three words matter to the person:
//
//   Connected        OpenClaw lifecycle "ready"
//   Reconnecting     lifecycle "recovering" (the client is backing off or
//                    redialling; nothing for the person to do)
//   Needs attention  lifecycle "blocked" with terminalDisconnect, so OpenClaw
//                    never restarts it; the message says what to do (most
//                    often Set up again; see remedyForMessage)
//
// plus "Connecting" (the first dial), "Not set up" and "Not running".
//
// Where the plain words show: the Needs attention message is the account's
// lastError, which OpenClaw prints in `openclaw channels status` and the
// Control UI. The Reconnecting reason is kept in stateReason, which
// OpenClaw's status commands drop for a running account, so the Gateway
// log carries it instead (gateway.ts logs one line per new drop).
//
// Every patch also carries the status word (statusState). From OpenClaw
// 2026.10 a plain status read (no probe, the default for `openclaw channels
// status` and the Control UI) no longer calls the status adapter's
// buildAccountSnapshot: it shows the account as the Gateway's setStatus
// calls left it, so whatever the adapter adds has to be published here too
// (gateway.ts publishes the rest). On 2026.9 the adapter still runs and
// overwrites these with the same values.

import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { LinkState, LinkStateName, PipbitAccountStateFile } from "../shared/contracts.ts";

export type PipbitStatusLabel =
  | "Connected"
  | "Connecting"
  | "Reconnecting"
  | "Needs attention"
  | "Not set up"
  | "Not running"
  | "Disabled";

export type PipbitIssueKind = "config" | "auth" | "permissions" | "runtime";

/** How to get back to a working link after most refusals. */
export const SET_UP_AGAIN_FIX =
  "Run Set up for Pipbit again (Control UI: Channels, then Pipbit; or `openclaw channels add --channel pipbit` in a terminal).";

export const MESSAGES = {
  notSetUp: "Pipbit is not set up for this agent yet. Run Set up to add it.",
  removed: "Removed from your Pipbit. Run Set up again to add it back.",
  authenticationFailed:
    "Pipbit did not accept this agent's credentials (or this machine's clock is more than a minute off). Run Set up again.",
  connectNotEnabled:
    "Pipbit Connect is switched off for this agent (it may have been removed from your Pipbit). Run Set up again to add it back.",
  transportMismatch: "Pipbit expects this agent to connect a different way, so it cannot connect. Contact hello@pipworks.ai.",
  suspended: "Pipbit has suspended this agent, so it cannot connect. Contact hello@pipworks.ai.",
  deleted: "This agent no longer exists on Pipbit. Run Set up again to add it back.",
  stoppedAccepting: "Pipbit stopped accepting this agent, though it may still be on your Pipbit. Run Set up again.",
  secretRotated: "This agent's Pipbit credentials were replaced. Run Set up again.",
  protocolUnsupported: "This version of the Pipbit plugin is too old for Pipbit. Update the plugin.",
  secretUnreadable:
    "The Pipbit secret in the config could not be read (an environment variable or secret reference that is not set). Fix the secret or run Set up again.",
} as const;

const ISSUE_KIND_BY_MESSAGE: ReadonlyMap<string, PipbitIssueKind> = new Map<string, PipbitIssueKind>([
  [MESSAGES.notSetUp, "config"],
  [MESSAGES.removed, "auth"],
  [MESSAGES.authenticationFailed, "auth"],
  [MESSAGES.connectNotEnabled, "auth"],
  [MESSAGES.transportMismatch, "config"],
  [MESSAGES.suspended, "permissions"],
  [MESSAGES.deleted, "auth"],
  [MESSAGES.stoppedAccepting, "auth"],
  [MESSAGES.secretRotated, "auth"],
  [MESSAGES.protocolUnsupported, "runtime"],
  [MESSAGES.secretUnreadable, "config"],
]);

/**
 * Plain words for a fatal refusal: the `hello.error` word or the close
 * reason, the `revoked` frame's word, and the close code.
 *
 * These must agree with what setup does about the same refusal
 * (refusalHandling in src/setup/wizard.ts): a message says the agent is
 * gone from the person's Pipbit only where setup pairs again without asking
 * (removed by voice, deleted, Pipbit Connect switched off), and tells the
 * person not to set up again exactly where setup stops (suspended, a
 * transport mismatch, a plugin too old). An unpublished agent keeps its
 * place on the person's Pipbit (the platform ends its sessions but keeps
 * its bindings), so it is not "gone".
 */
export function describeRefusal(reason: string | null, detail: string | null, closeCode: number | null): string {
  const word = (reason ?? "").trim();
  const extra = (detail ?? "").trim();
  if (word === "revoked" || closeCode === 4002) {
    switch (extra || word) {
      case "suspended":
      case "agent_suspended":
        return MESSAGES.suspended;
      case "deleted":
        return MESSAGES.deleted;
      case "secret_rotated":
        return MESSAGES.secretRotated;
      case "grant_revoked":
        return MESSAGES.removed;
      default:
        if (word === "agent_suspended") {
          return MESSAGES.suspended;
        }
        // unpublished, policy, no word, or a word this plugin does not know.
        return MESSAGES.stoppedAccepting;
    }
  }
  switch (word) {
    case "authentication_failed":
      return MESSAGES.authenticationFailed;
    case "connect_not_enabled":
      return MESSAGES.connectNotEnabled;
    case "transport_mismatch":
      return MESSAGES.transportMismatch;
    case "agent_suspended":
      return MESSAGES.suspended;
    case "protocol_unsupported":
      return MESSAGES.protocolUnsupported;
    default:
      break;
  }
  if (closeCode === 4000) {
    return MESSAGES.authenticationFailed;
  }
  if (closeCode === 4004) {
    return MESSAGES.protocolUnsupported;
  }
  return word
    ? `Pipbit refused the connection (${word}). Run Set up again.`
    : "Pipbit refused the connection. Run Set up again.";
}

/** Plain words for why the link is reconnecting (no action needed). */
export function describeReconnect(state: Pick<LinkState, "reason" | "lastCloseCode">): string {
  const word = (state.reason ?? "").trim();
  if (word === "superseded" || state.lastCloseCode === 4001) {
    return "another copy of this agent connected; waiting 30 s";
  }
  if (word === "rate_limited") {
    return "Pipbit asked it to slow down; retrying shortly";
  }
  if (state.lastCloseCode === 4008 || word === "idle_timeout") {
    return "the connection went quiet; reconnecting";
  }
  if (word === "shutdown" || state.lastCloseCode === 1001) {
    return "Pipbit's connection service restarted; reconnecting";
  }
  if (state.lastCloseCode === 4003) {
    return "Pipbit turned the connection away for now; retrying";
  }
  return "the connection dropped; retrying";
}

/** Which kind of status issue a Needs attention message is. */
export function issueKindForMessage(message: string): PipbitIssueKind {
  return ISSUE_KIND_BY_MESSAGE.get(message) ?? "runtime";
}

/** What the person does about a Needs attention message. */
export interface PipbitRemedy {
  /**
   * One line that stands on its own (OpenClaw 2026.9.4 lists no issue of its
   * own for a terminal disconnect) but never repeats the message word for
   * word (2026.9.6 lists the message itself, with a generic fix).
   */
  message: string;
  fix: string;
}

const SET_UP_AGAIN_REMEDY: PipbitRemedy = {
  message: "Pipbit stopped accepting this agent's connection; pairing it with your Pipbit again reconnects it.",
  fix: SET_UP_AGAIN_FIX,
};

const REMEDY_BY_MESSAGE: ReadonlyMap<string, PipbitRemedy> = new Map<string, PipbitRemedy>([
  [
    MESSAGES.suspended,
    {
      message: "Pipbit has suspended this agent; setting it up again does not help.",
      fix: "Contact hello@pipworks.ai; once it is sorted out, restart the Gateway so it connects again.",
    },
  ],
  [
    MESSAGES.transportMismatch,
    {
      message: "Pipbit expects this agent to connect another way; setting it up again does not help.",
      fix: "Contact hello@pipworks.ai; once it is sorted out, restart the Gateway so it connects again.",
    },
  ],
  [
    MESSAGES.protocolUnsupported,
    {
      message: "Pipbit no longer accepts this version of the plugin; setting it up again does not help.",
      fix: "Update the plugin (`openclaw plugins update pipbit`), then restart the Gateway.",
    },
  ],
  [
    MESSAGES.secretUnreadable,
    {
      message: "The Pipbit secret setting could not be read; the agent itself is still paired.",
      fix: "Fix the secret reference: set the environment variable or SecretRef that the Pipbit secret setting names, or run Set up for Pipbit again.",
    },
  ],
]);

/**
 * The fix for a Needs attention message, chosen from the message: a
 * suspension or a transport mismatch goes to Pipbit's support (setup stops
 * for both, see refusalHandling), a too-old plugin gets an update, an
 * unreadable secret gets its reference fixed, and every other refusal gets
 * Set up again.
 */
export function remedyForMessage(message: string): PipbitRemedy {
  return REMEDY_BY_MESSAGE.get(message) ?? SET_UP_AGAIN_REMEDY;
}

export interface LinkStatusContext {
  accountId: string;
  now: number;
  /** The previous link state this account reported, if any. */
  previous: LinkState | null;
  /** Redials since the link was last connected. */
  reconnectAttempts: number;
}

/**
 * The account status patch for one link state. `connected` also clears a
 * previous terminal verdict (OpenClaw only accepts that from an explicit
 * `terminalDisconnect: undefined` beside lifecycle "ready").
 */
export function statusPatchForLinkState(state: LinkState, context: LinkStatusContext): ChannelAccountSnapshot {
  const { accountId, now } = context;
  switch (state.state) {
    case "connecting": {
      const patch: ChannelAccountSnapshot = {
        accountId,
        running: true,
        connected: false,
        lifecycle: "starting",
        stateReason: "Connecting",
        statusState: "Connecting",
      };
      if (isNewRedial(state, context.previous)) {
        // A first dial failed and another is scheduled: see "reconnecting".
        patch.lastDisconnect = disconnectRecord(state, now);
      }
      return patch;
    }
    case "connected":
      return {
        accountId,
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: now,
        lastTransportActivityAt: now,
        lastError: null,
        reconnectAttempts: 0,
        stateReason: "Connected",
        statusState: "Connected",
        terminalDisconnect: undefined,
      };
    case "reconnecting": {
      const patch: ChannelAccountSnapshot = {
        accountId,
        running: true,
        connected: false,
        lifecycle: "recovering",
        reconnectAttempts: context.reconnectAttempts,
        lastError: null,
        stateReason: `Reconnecting: ${describeReconnect(state)}`,
        statusState: "Reconnecting",
      };
      // Stamped on every new drop and on every newly scheduled redial.
      // OpenClaw's health check allows a disconnected account 120 s from
      // lastDisconnect.at; a dial that never gets through (DNS, refused, a
      // proxy error) changes nothing else, and every hold-off is under
      // 120 s, so this keeps the account in its reconnect grace for as long
      // as the client really is redialling.
      if (isNewDisconnect(state, context.previous) || isNewRedial(state, context.previous)) {
        patch.lastDisconnect = disconnectRecord(state, now);
      }
      return patch;
    }
    case "failed":
      return {
        accountId,
        running: false,
        connected: false,
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastDisconnect: disconnectRecord(state, now),
        lastError: describeRefusal(state.reason, state.detail, state.lastCloseCode),
        stateReason: "Needs attention",
        statusState: "Needs attention",
      };
    case "stopped":
    default:
      return {
        accountId,
        running: false,
        connected: false,
        lifecycle: "stopped",
        stateReason: "Stopped",
        statusState: "Not running",
      };
  }
}

/** The status for an account that cannot start: blocked, never restarted. */
export function blockedStatusPatch(accountId: string, message: string): ChannelAccountSnapshot {
  return {
    accountId,
    running: false,
    connected: false,
    lifecycle: "blocked",
    terminalDisconnect: true,
    lastError: message,
    stateReason: "Needs attention",
    statusState: "Needs attention",
  };
}

/** A drop the account has not reported yet (a new socket ended, or a new reason). */
export function isNewDisconnect(state: LinkState, previous: LinkState | null): boolean {
  if (!previous || previous.state !== "reconnecting") {
    return true;
  }
  return previous.dials !== state.dials || previous.lastCloseCode !== state.lastCloseCode || previous.reason !== state.reason;
}

/** A redial the client has just scheduled (a new hold-off time). */
function isNewRedial(state: LinkState, previous: LinkState | null): boolean {
  return state.nextDialAtMs !== null && state.nextDialAtMs !== (previous?.nextDialAtMs ?? null);
}

function disconnectRecord(state: LinkState, now: number): NonNullable<Exclude<ChannelAccountSnapshot["lastDisconnect"], string>> {
  const record: { at: number; status?: number; error?: string } = { at: now };
  if (typeof state.lastCloseCode === "number") {
    record.status = state.lastCloseCode;
  }
  if (state.reason) {
    record.error = state.reason;
  }
  return record;
}

/**
 * The status word from OpenClaw's live account snapshot, or null when the
 * snapshot carries no live facts (a CLI process that has no Gateway state).
 */
export function labelFromSnapshot(snapshot: Partial<ChannelAccountSnapshot> | undefined): PipbitStatusLabel | null {
  if (!snapshot) {
    return null;
  }
  if (snapshot.enabled === false) {
    return "Disabled";
  }
  if (snapshot.configured === false) {
    return "Not set up";
  }
  if (snapshot.lifecycle === "blocked" || snapshot.terminalDisconnect === true) {
    return "Needs attention";
  }
  if (snapshot.lifecycle === "ready" || snapshot.connected === true) {
    return "Connected";
  }
  if (snapshot.lifecycle === "recovering") {
    return "Reconnecting";
  }
  if (snapshot.lifecycle === "starting") {
    return "Connecting";
  }
  if (snapshot.lifecycle === "stopped" || snapshot.running === false) {
    return "Not running";
  }
  return null;
}

/** The status word from the state file the Gateway last wrote. */
export function labelFromLink(link: LinkStateName | null | undefined): PipbitStatusLabel {
  switch (link) {
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "connecting":
      return "Connecting";
    case "failed":
      return "Needs attention";
    default:
      return "Not running";
  }
}

/**
 * The plain words behind a state file's `failed` link, else null. Only a
 * refusal is read from the file: any other link word may be stale (a
 * Gateway that crashed never wrote "stopped").
 */
export function refusalFromStateFile(file: PipbitAccountStateFile | null): string | null {
  if (!file || file.link !== "failed") {
    return null;
  }
  return describeRefusal(file.reason, file.detail, null);
}
