// The whole spoken pairing, from a spoken name to the agent's credentials,
// with no screen of its own: whoever runs it (the setup wizard) supplies a
// PairingFlowUi that shows the platform's sentence and answers two
// questions. In order:
//
//   1. The spoken name becomes the agent name (names.ts). A name the
//      platform would refuse (reserved for Pip, too long, nothing usable
//      left) is sent back to the person through ui.askForAnotherName,
//      at most three times.
//   2. Start. A taken agent name (409 name_taken) is retried once with a
//      short random suffix (`clementine-7f3a`); the spoken name stays the
//      same and is always sent. A 400 is about the name (the only thing in
//      a well-formed body the platform can refuse), so its message goes to
//      ui.askForAnotherName too.
//   3. ui.showCode with the platform's sentence, then a poll every
//      `interval` seconds (the first one interval after the code appears).
//   4. The claim (200) ends the flow. A code that expires is replaced once
//      without asking (unless options.autoRemint is false); after that the
//      person is asked before each new one. A name registered by someone
//      else between the start and the claim (410 pairing_failed,
//      name_taken) gets one fresh suffix.
//   5. The platform registers the agent in the same step that answers the
//      claim poll, so that answer is the only copy of the secret. A 200 the
//      flow cannot read ends the flow with `claim_lost`, and so does every
//      410 pairing_claimed: the flow stops at the first 200 it reads, so a
//      pairing that is already claimed was claimed by an answer it never
//      got. Either way the agent is most likely on the person's Pipbit, and
//      nothing can connect as it.
//   6. A code that runs out while the last poll got no answer (or a 5xx)
//      gets one more poll, an interval later, before any new code: that
//      lost answer may have been the claim. If it was, the platform now
//      says pairing_claimed and step 5 applies. Without this poll the flow
//      would start a new code, find the name taken by the agent it just
//      lost, and add a second agent under a suffixed name.
//
// Every start counts against the platform's hourly budget per network
// address (10), so one flow makes at most six. Aborting options.signal, or
// any other way out of the flow while a code is still live, cancels that
// pairing on the platform so the code on screen stops working. Nothing here
// logs a code, the instructions sentence, or the secret.

import { setTimeout as delay } from "node:timers/promises";
import type { Logger, PairingClaim, PairingFlowOptions } from "../shared/contracts.ts";
import { PAIRING_AGENCY_NAME, silentLogger } from "../shared/contracts.ts";
import { PairingError } from "../shared/errors.ts";
import { cancelPairing, claimLostError, pollPairing, startPairing } from "./http.ts";
import type { PendingPairing } from "./http.ts";
import { checkDisplayName, withNameSuffix } from "./names.ts";
import type { NameProblem } from "./names.ts";

/** Starts one flow may spend of the platform's ten per hour per address. */
export const MAX_STARTS_PER_FLOW = 6;
/** How many times the person is asked for another spoken name. */
export const MAX_NAME_TRIES = 3;

export const RATE_LIMITED_MESSAGE = "Too many pairing attempts from this network; try again within the hour.";
const START_CAP_MESSAGE =
  `This setup already asked Pipbit for ${MAX_STARTS_PER_FLOW} pairing codes, and each one counts against an ` +
  "hourly limit per network; try again later.";
const EXPIRED_MESSAGE = "The pairing code expired before it was approved, and no new code was asked for.";
const ABORTED_MESSAGE = "The pairing was abandoned before it finished; its code no longer works.";

/**
 * Run a spoken pairing to the end. Resolves with the claim: the agent name,
 * the secret (shown by the platform exactly once; store it before anything
 * else) and the URLs. Rejects with PairingError (reason `reserved_name`,
 * `invalid_request`, `name_taken`, `rate_limited`, `expired`, `cancelled`,
 * `claim_lost`, `failed`, `not_found`, `platform_unreachable` or `aborted`;
 * never `claimed`, which becomes `claim_lost`), or with whatever a ui
 * callback threw.
 *
 * One exception to "aborting rejects": an abort that lands while a poll is
 * already in flight waits for that poll (at most its 10 s deadline), and if
 * the poll brings the claim, the claim is returned. The platform registered
 * the agent the moment it answered, and dropping the only copy of the secret
 * would leave a dead agent on the person's roster.
 */
export async function runPairingFlow(options: PairingFlowOptions): Promise<PairingClaim> {
  return new PairingFlowRun(options).run();
}

type WaitOutcome =
  | { kind: "claimed"; claim: PairingClaim }
  | { kind: "expired" }
  | { kind: "name_taken_at_claim"; error: PairingError };

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, signal ? { signal } : undefined);
}

function abortedError(): PairingError {
  return new PairingError("aborted", ABORTED_MESSAGE);
}

/** Poll answers that mean the platform has closed the pairing for good. */
const ENDING_REASONS: ReadonlySet<string> = new Set(["expired", "cancelled", "claimed", "claim_lost", "failed", "not_found"]);

/** A failure worth another poll: no answer at all, a 5xx, or a stray 429. */
function isTransient(error: PairingError): boolean {
  if (error.reason === "rate_limited") {
    return true;
  }
  return error.reason === "platform_unreachable" && (error.statusCode === null || error.statusCode >= 500);
}

class PairingFlowRun {
  readonly #options: PairingFlowOptions;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;
  readonly #signal: AbortSignal | undefined;

  #displayName = "";
  #baseAgentName = "";
  #agentName = "";
  #nameTries = 0;
  #starts = 0;
  #startSuffixUsed = false;
  #claimSuffixUsed = false;
  #autoRemintUsed = false;
  /** A started pairing that may still be live on the platform. */
  #live: PendingPairing | null = null;

  constructor(options: PairingFlowOptions) {
    this.#options = options;
    this.#log = options.logger ?? silentLogger;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#signal = options.signal;
  }

  async run(): Promise<PairingClaim> {
    try {
      this.#throwIfAborted();
      await this.#settleName(this.#options.displayName);
      let reminted = false;
      for (;;) {
        const pairing = await this.#start();
        await this.#ui(() => this.#options.ui.showCode(pairing.code, { reminted }));
        const outcome = await this.#waitForApproval(pairing);
        if (outcome.kind === "claimed") {
          this.#log.info(`Pipbit pairing ${pairing.code.pairingId} claimed; the agent name is ${outcome.claim.agentName}.`);
          return outcome.claim;
        }
        if (outcome.kind === "expired") {
          if (this.#autoRemintUsed || this.#options.autoRemint === false) {
            const again = await this.#ui(() => this.#options.ui.confirmNewCode());
            if (again !== true) {
              throw new PairingError("expired", EXPIRED_MESSAGE);
            }
          }
          this.#autoRemintUsed = true;
          reminted = true;
          continue;
        }
        // Someone registered the agent name between our start and the claim.
        if (this.#claimSuffixUsed) {
          throw outcome.error;
        }
        this.#claimSuffixUsed = true;
        this.#agentName = withNameSuffix(this.#baseAgentName, this.#random);
        this.#log.info(`The agent name was taken before the claim; starting again as ${this.#agentName}.`);
        reminted = false;
      }
    } catch (error) {
      await this.#cancelLive();
      if (this.#signal?.aborted) {
        throw abortedError();
      }
      throw error;
    }
  }

  // ---- names -------------------------------------------------------------

  /** Settle on a usable spoken name, asking the person as needed. */
  async #settleName(candidate: string): Promise<void> {
    let display = candidate;
    for (;;) {
      const check = checkDisplayName(display);
      if (check.ok) {
        this.#displayName = check.displayName;
        this.#baseAgentName = check.agentName;
        this.#agentName = check.agentName;
        this.#startSuffixUsed = false;
        return;
      }
      display = await this.#askForAnotherName(check.problem);
    }
  }

  async #askForAnotherName(problem: NameProblem): Promise<string> {
    if (this.#nameTries >= MAX_NAME_TRIES) {
      throw new PairingError(problem.reason, problem.message);
    }
    this.#nameTries += 1;
    const answer = await this.#ui(() => this.#options.ui.askForAnotherName(problem.message));
    if (typeof answer !== "string") {
      throw new PairingError(problem.reason, problem.message);
    }
    return answer;
  }

  // ---- start -------------------------------------------------------------

  async #start(): Promise<PendingPairing> {
    for (;;) {
      if (this.#starts >= MAX_STARTS_PER_FLOW) {
        throw new PairingError("rate_limited", START_CAP_MESSAGE);
      }
      this.#starts += 1;
      try {
        const pairing = await startPairing(
          {
            requestedName: this.#agentName,
            displayName: this.#displayName,
            client: this.#options.client,
            agencyName: this.#options.agencyName ?? PAIRING_AGENCY_NAME,
            description: this.#options.description,
          },
          {
            baseUrl: this.#options.baseUrl,
            fetchImpl: this.#options.fetchImpl,
            signal: this.#signal,
            now: this.#now,
          },
        );
        this.#live = pairing;
        this.#log.info(
          `Pipbit pairing ${pairing.code.pairingId} started for the agent name ${pairing.code.requestedName}; ` +
            `the code lasts ${pairing.code.expiresInS} s.`,
        );
        return pairing;
      } catch (error) {
        if (!(error instanceof PairingError)) {
          throw error;
        }
        if (error.reason === "name_taken" && !this.#startSuffixUsed) {
          this.#startSuffixUsed = true;
          this.#agentName = withNameSuffix(this.#baseAgentName, this.#random);
          this.#log.info(`The agent name ${this.#baseAgentName} is taken on Pipbit; trying ${this.#agentName}.`);
          continue;
        }
        if (error.reason === "invalid_request" && error.statusCode === 400) {
          // The platform's own words, shown to the person as they are.
          const answer = await this.#askForAnotherName({ reason: "invalid_request", message: error.message });
          await this.#settleName(answer);
          continue;
        }
        if (error.reason === "rate_limited") {
          throw new PairingError("rate_limited", RATE_LIMITED_MESSAGE, {
            code: error.code,
            statusCode: error.statusCode,
          });
        }
        throw error;
      }
    }
  }

  // ---- poll --------------------------------------------------------------

  async #waitForApproval(pairing: PendingPairing): Promise<WaitOutcome> {
    const code = pairing.code;
    const deadlineMs = code.startedAtMs + code.expiresInS * 1000;
    let intervalS = code.intervalS;
    // Whether a poll since the last pending answer got no answer from the
    // platform: that one may have been the claim, answered and then lost.
    let answerLost = false;
    // The one poll past the deadline (header step 6) has been sent.
    let lastLook = false;
    for (;;) {
      const leftMs = deadlineMs - this.#now();
      if (leftMs > 0) {
        this.#options.ui.onWaiting?.(Math.ceil(leftMs / 1000));
        await this.#pause(Math.min(intervalS * 1000, leftMs));
        if (this.#now() >= deadlineMs) {
          // The code ran out during the pause: the top of the loop decides.
          continue;
        }
      } else if (answerLost && !lastLook) {
        lastLook = true;
        this.#log.info(
          `The code of Pipbit pairing ${code.pairingId} ran out while a poll's answer was missing; ` +
            "asking the platform once more before any new code.",
        );
        await this.#pause(intervalS * 1000);
      } else {
        return this.#expired(pairing);
      }
      let outcome;
      try {
        // No abort signal on purpose: see runPairingFlow's note on a claim
        // in flight.
        outcome = await pollPairing(pairing, { fetchImpl: this.#options.fetchImpl });
      } catch (error) {
        if (!(error instanceof PairingError)) {
          throw error;
        }
        if (isTransient(error)) {
          const status = error.statusCode === null ? "no answer" : `status ${error.statusCode}`;
          const next = lastLook ? "the code has run out, so that was the last poll" : "polling again";
          this.#log.warn(`Pipbit pairing poll failed (${error.reason}, ${status}); ${next}.`);
          // A 429 turned the poll away before it reached the pairing; no
          // answer at all, or a 5xx, may hide a claim the platform made.
          if (error.reason === "platform_unreachable") {
            answerLost = true;
          }
          this.#throwIfAborted();
          continue;
        }
        if (ENDING_REASONS.has(error.reason)) {
          // The platform has closed this pairing; nothing to cancel.
          this.#live = null;
        }
        if (error.reason === "claimed") {
          // This flow returns at the first 200 it reads, so whatever claimed
          // the pairing, its answer (and the secret in it) never got here.
          throw claimLostError(
            this.#displayName,
            "The answer to the claim was lost on the way (the platform now says this pairing was already used)",
            { code: error.code, statusCode: error.statusCode },
          );
        }
        if (error.reason === "expired") {
          return this.#expired(pairing);
        }
        if (error.reason === "failed" && error.detail === "name_taken") {
          return { kind: "name_taken_at_claim", error };
        }
        throw error;
      }
      if (outcome.status === "claimed") {
        this.#live = null;
        return { kind: "claimed", claim: outcome.claim };
      }
      // Still pending, so no earlier poll claimed it.
      answerLost = false;
      intervalS = outcome.intervalS ?? code.intervalS;
      this.#throwIfAborted();
    }
  }

  #expired(pairing: PendingPairing): WaitOutcome {
    // The platform's clock started before ours, so by now it has expired
    // the pairing too; there is nothing left to cancel.
    if (this.#live === pairing) {
      this.#live = null;
    }
    this.#log.info(`Pipbit pairing ${pairing.code.pairingId} expired before it was approved.`);
    return { kind: "expired" };
  }

  // ---- plumbing ----------------------------------------------------------

  #throwIfAborted(): void {
    if (this.#signal?.aborted) {
      throw abortedError();
    }
  }

  async #pause(ms: number): Promise<void> {
    try {
      await this.#sleep(ms, this.#signal);
    } catch (error) {
      if (this.#signal?.aborted) {
        throw abortedError();
      }
      throw error;
    }
    this.#throwIfAborted();
  }

  /**
   * Run a ui callback, but stop waiting for it the moment the flow is
   * aborted (the callback's own promise is left to its owner).
   */
  async #ui<T>(callback: () => T | Promise<T>): Promise<T> {
    this.#throwIfAborted();
    const pending = Promise.resolve().then(callback);
    const signal = this.#signal;
    if (signal === undefined) {
      return pending;
    }
    const result = await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortedError());
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
    this.#throwIfAborted();
    return result;
  }

  /** Cancel the live pairing, if any, ignoring the answer. */
  async #cancelLive(): Promise<void> {
    const pairing = this.#live;
    if (pairing === null) {
      return;
    }
    this.#live = null;
    try {
      // A fresh deadline, never the flow's signal: it may be the very
      // abort that brought us here.
      await cancelPairing(pairing, { fetchImpl: this.#options.fetchImpl });
      this.#log.info(`Pipbit pairing ${pairing.code.pairingId} cancelled.`);
    } catch (error) {
      const reason = error instanceof PairingError ? error.reason : "error";
      this.#log.warn(`Could not cancel Pipbit pairing ${pairing.code.pairingId} (${reason}); its code expires on its own.`);
    }
  }
}
