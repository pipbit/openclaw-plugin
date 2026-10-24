// The per-account state file: `<OpenClaw state dir>/pipbit/<accountId>.json`.
//
// The channel writes it whenever the link or the owner changes, and deletes
// it when the account is removed from the config; the setup wizard reads it
// after saving the config (to show "Connected" and the agent's greeting),
// the status line reads a refusal from it when the Gateway's live status is
// not at hand (a CLI run in another process), and the speak tool's owner
// survives a Gateway restart through it. It never holds a secret, a token,
// a code or anything the person said: only link words, times, the owner's
// pseudonymous subject id and the agent's own greeting.
//
// Writes are atomic (a temporary file, then a rename), so a reader never
// sees half a file.

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  accountStateFilePath,
  type LinkStateName,
  type PipbitAccountStateFile,
} from "../shared/contracts.ts";

const LINK_WORDS: ReadonlySet<string> = new Set(["connecting", "connected", "reconnecting", "stopped", "failed"]);

/** OpenClaw's state directory (`~/.openclaw` unless OPENCLAW_STATE_DIR says otherwise). */
export function resolvePipbitStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateDir(env);
}

/** A fresh state record for an account that has never written one. */
export function emptyAccountState(accountId: string, agentName: string, now: Date = new Date()): PipbitAccountStateFile {
  return {
    version: 1,
    accountId,
    agentName,
    link: "stopped",
    reason: null,
    detail: null,
    updatedAt: now.toISOString(),
    ownerSubjectId: null,
    lastIntroAt: null,
    lastGreeting: null,
  };
}

/**
 * Read an account's state file. Returns null when there is none, or when it
 * is unreadable or not a version 1 record (a corrupt file is treated as
 * absent, never as an error).
 */
export async function readAccountState(stateDir: string, accountId: string): Promise<PipbitAccountStateFile | null> {
  let raw: string;
  try {
    raw = await readFile(accountStateFilePath(stateDir, accountId), "utf8");
  } catch {
    return null;
  }
  try {
    return parseAccountState(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Validate a parsed state file; null when it is not a version 1 record. */
export function parseAccountState(value: unknown): PipbitAccountStateFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return null;
  }
  if (typeof record.accountId !== "string" || typeof record.agentName !== "string") {
    return null;
  }
  if (typeof record.link !== "string" || !LINK_WORDS.has(record.link)) {
    return null;
  }
  if (typeof record.updatedAt !== "string") {
    return null;
  }
  return {
    version: 1,
    accountId: record.accountId,
    agentName: record.agentName,
    link: record.link as LinkStateName,
    reason: stringOrNull(record.reason),
    detail: stringOrNull(record.detail),
    updatedAt: record.updatedAt,
    ownerSubjectId: stringOrNull(record.ownerSubjectId),
    lastIntroAt: stringOrNull(record.lastIntroAt),
    lastGreeting: stringOrNull(record.lastGreeting),
  };
}

/**
 * Write an account's state file atomically: the JSON goes to a temporary
 * file beside the target, which is then renamed over it. The directory is
 * created (owner-only) when missing.
 */
export async function writeAccountState(stateDir: string, state: PipbitAccountStateFile): Promise<void> {
  const target = accountStateFilePath(stateDir, state.accountId);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  try {
    await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Delete an account's state file (the account was removed from the config).
 * A file that is already gone is fine.
 */
export async function removeAccountState(stateDir: string, accountId: string): Promise<void> {
  await rm(accountStateFilePath(stateDir, accountId), { force: true });
}

/**
 * Holds one account's state in memory and writes every change to disk, one
 * write at a time and in order, so a late write never overwrites a newer
 * one. A failed write is reported to `onError` and never thrown: the state
 * file is a convenience for other processes, not something the link waits on.
 */
export class AccountStateWriter {
  readonly stateDir: string;
  #state: PipbitAccountStateFile;
  #chain: Promise<void> = Promise.resolve();
  readonly #onError: (error: unknown) => void;
  readonly #now: () => Date;

  constructor(options: {
    stateDir: string;
    initial: PipbitAccountStateFile;
    onError?: (error: unknown) => void;
    now?: () => Date;
  }) {
    this.stateDir = options.stateDir;
    this.#state = { ...options.initial };
    this.#onError = options.onError ?? (() => {});
    this.#now = options.now ?? (() => new Date());
  }

  /** A copy of the state as last updated (possibly not yet on disk). */
  current(): PipbitAccountStateFile {
    return { ...this.#state };
  }

  /** Merge a change, stamp `updatedAt` and queue the write. */
  update(patch: Partial<Omit<PipbitAccountStateFile, "version" | "accountId" | "updatedAt">>): Promise<void> {
    this.#state = { ...this.#state, ...patch, version: 1, updatedAt: this.#now().toISOString() };
    const snapshot = { ...this.#state };
    this.#chain = this.#chain
      .then(() => writeAccountState(this.stateDir, snapshot))
      .catch((error: unknown) => {
        this.#onError(error);
      });
    return this.#chain;
  }

  /** Resolves once every queued write has finished. */
  flush(): Promise<void> {
    return this.#chain;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
