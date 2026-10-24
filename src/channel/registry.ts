// Registries the channel shares with its two tools and the tool-call guard.
// OpenClaw calls a tool factory with the calling session's key, not with our
// turn, so the channel files each Pipbit turn it is running under that
// session key, and each running account under its id, and the factories and
// the guard look them up.
//
//   turns     session key -> the Pipbit turn being answered in that session
//             (at most one: turns are answered one at a time per session)
//   accounts  account id -> the running Connect client, the owner's subject
//             id and which OpenClaw agent answers for it
//
// Both maps live on the process (globalThis), not in this module. OpenClaw
// 2026.9.6 does not build a run's plugin tools from the plugin the Gateway
// loaded: it builds them from a tool-discovery copy of the package (a fresh
// copy under the state directory's tmp/plugin-captures, with a module graph
// of its own), so the channel that files a turn and the factory that looks
// it up are different instances of this file. A map declared here is empty
// in the factory's instance; only globalThis is shared between them. Before
// this was found (2026-10-18), pipbit_handback was never offered on a turn
// without the owner's verified voice, so every such turn ran on the
// no-tools retry since the first bench (2026-09-25), and pipbit_speak was
// never offered at all, because the copy knew no running account.
//
// Nothing here is persisted; the state file (state.ts) is the durable part.

import type { ConnectClientApi, LinkStateName, Logger, TurnRequest } from "../shared/contracts.ts";
import { getPipbitLogger } from "./runtime.ts";

/** One Pipbit turn while OpenClaw is running the agent for it. */
export interface InflightTurn {
  accountId: string;
  request: TurnRequest;
  /**
   * True only when the turn carried `speaker_verified: true`. Speaker
   * verification is a user-experience filter, never a security control.
   */
  verified: boolean;
  /**
   * True on the connect intro (the agent's greeting): the handback factory
   * offers nothing on it and requestHandback refuses it (see there).
   */
  isConnectIntro: boolean;
  /** Set by the handback tool: the reply goes out with `handback: true`. */
  handbackRequested: boolean;
  /**
   * The channel's logger, for the one line an ignored hand-back writes. The
   * tool runs in the other copy of this package (see above), whose own
   * plugin logger is never set.
   */
  logger?: Logger;
  /**
   * Set when OpenClaw reports a model call starting in this session (the
   * `model_call_started` hook). A run that failed without one never reached
   * the model: OpenClaw refused it beforehand (see inbound.ts).
   */
  modelCallStarted?: boolean;
}

/** One started account: what the speak tool needs to reach the owner. */
export interface RunningAccount {
  accountId: string;
  /** The agent's internal name on Pipbit (the state file is keyed to it). */
  agentName: string;
  /** `channels.pipbit.accounts.<id>.agentId`, normalized; null means the default agent. */
  agentId: string | null;
  /**
   * The OpenClaw agent that answers for this account: resolved through
   * OpenClaw's routing when the account starts, then the agent each Pipbit
   * turn was routed to. Null while unknown (routing could not tell).
   */
  routedAgentId: string | null;
  /** The paired owner's subject id, learned from turns (or the state file). */
  ownerSubjectId: string | null;
  client: ConnectClientApi | null;
  link: LinkStateName;
}

interface SharedRegistries {
  turns: Map<string, InflightTurn>;
  accounts: Map<string, RunningAccount>;
}

/**
 * The one key every copy of this plugin in the process agrees on. Bump the
 * suffix when the shape of what is stored changes, so an older copy loaded
 * beside a newer one (an in-place update) never reads the other's entries
 * (v2: a turn carries isConnectIntro and its logger, 2026-10-18).
 */
const SHARED_KEY: unique symbol = Symbol.for("pipbit.openclaw.registries.v2");

function sharedRegistries(): SharedRegistries {
  const host = globalThis as { [SHARED_KEY]?: SharedRegistries };
  return (host[SHARED_KEY] ??= { turns: new Map(), accounts: new Map() });
}

const { turns, accounts } = sharedRegistries();

/**
 * File a turn under its session key for the length of an agent run. Returns
 * a function that removes it again (only if it is still this turn).
 */
export function registerInflightTurn(sessionKey: string, turn: InflightTurn): () => void {
  turns.set(sessionKey, turn);
  return () => {
    if (turns.get(sessionKey) === turn) {
      turns.delete(sessionKey);
    }
  };
}

export function getInflightTurn(sessionKey: string | undefined | null): InflightTurn | undefined {
  if (!sessionKey) {
    return undefined;
  }
  return turns.get(sessionKey);
}

/**
 * Mark the session's in-flight turn for handback. Returns false when no turn
 * is in flight there (the run already ended, or it is not a Pipbit session),
 * and on the connect intro, where a hand-back is ignored: a greeting is
 * never the end of the conversation (DOC/engagement-kinds-kickoff.md). The
 * factory never offers the tool there; this is the belt behind it, logged.
 */
export function requestHandback(sessionKey: string | undefined | null): boolean {
  const turn = getInflightTurn(sessionKey);
  if (!turn) {
    return false;
  }
  if (turn.isConnectIntro) {
    (turn.logger ?? getPipbitLogger()).info("pipbit: hand-back on the connect intro ignored");
    return false;
  }
  turn.handbackRequested = true;
  return true;
}

/**
 * Note that a model call started in this session. Returns false when no
 * Pipbit turn is in flight there.
 */
export function markModelCallStarted(sessionKey: string | undefined | null): boolean {
  const turn = getInflightTurn(sessionKey);
  if (!turn) {
    return false;
  }
  turn.modelCallStarted = true;
  return true;
}

export function registerRunningAccount(account: RunningAccount): () => void {
  accounts.set(account.accountId, account);
  return () => {
    if (accounts.get(account.accountId) === account) {
      accounts.delete(account.accountId);
    }
  };
}

export function getRunningAccount(accountId: string): RunningAccount | undefined {
  return accounts.get(accountId);
}

export function listRunningAccounts(): RunningAccount[] {
  return [...accounts.values()];
}

/** Test seam: forget every turn and account (in every copy, since they are shared). */
export function resetRegistries(): void {
  turns.clear();
  accounts.clear();
}
