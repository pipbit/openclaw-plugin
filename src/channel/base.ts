// The setup-safe half of the Pipbit channel: metadata, capabilities, the
// config schema, account resolution and the status adapter. OpenClaw loads
// this through the setup-only entry (when the channel is not configured yet,
// and for `status` / `channels list`), so nothing here opens a socket or
// needs the runtime object. The running half is gateway.ts and inbound.ts.
//
// Config lives at `channels.pipbit`. One paired Pipbit agent is one account:
// the top-level fields are the default account, `accounts.<id>` holds more.
//
//   channels: {
//     pipbit: {
//       agentName: "home-brain",        // the agent's internal name on Pipbit
//       displayName: "Home Brain",      // the spoken name recorded at pairing
//       secret: "${PIPBIT_SECRET}",     // issued at pairing, saved by setup; never shown or logged
//       agentId: "main",                // which OpenClaw agent answers (optional)
//       proactiveSpeech: false,         // the pipbit_speak tool (off by default)
//     },
//   }

import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelMeta,
  ChannelStatusAdapter,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_BASE_URL,
  DEFAULT_CONNECT_URL,
  type PipbitAccountConfig,
  type PipbitAccountStateFile,
  type PipbitChannelConfig,
  type SecretInput,
} from "../shared/contracts.ts";
import {
  agentSelectionIssue,
  findHandbackBlockers,
  isAgentSelectionRequired,
  type PipbitConfigIssue,
} from "./config-checks.ts";
import { readAccountState, removeAccountState, resolvePipbitStateDir } from "./state.ts";
import {
  issueKindForMessage,
  labelFromSnapshot,
  refusalFromStateFile,
  remedyForMessage,
  SET_UP_AGAIN_FIX,
  type PipbitStatusLabel,
} from "./status.ts";

export {
  AccountStateWriter,
  emptyAccountState,
  parseAccountState,
  readAccountState,
  removeAccountState,
  resolvePipbitStateDir,
  writeAccountState,
} from "./state.ts";
export {
  describeReconnect,
  describeRefusal,
  labelFromLink,
  labelFromSnapshot,
  MESSAGES as PIPBIT_STATUS_MESSAGES,
  remedyForMessage,
  SET_UP_AGAIN_FIX,
  type PipbitStatusLabel,
} from "./status.ts";
export type { PipbitConfigIssue } from "./config-checks.ts";

// ---------------------------------------------------------------------------
// Metadata and capabilities (must agree with package.json `openclaw.channel`)
// ---------------------------------------------------------------------------

export const pipbitChannelMeta = {
  id: CHANNEL_ID,
  label: "Pipbit",
  selectionLabel: "Pipbit (voice device)",
  detailLabel: "Pipbit Connect",
  docsPath: "https://github.com/pipbit/openclaw-plugin#readme",
  docsLabel: "pipbit",
  blurb: "Talk to this agent by voice on your Pipbit. You add it by saying a six-digit code to your Pipbit.",
  systemImage: "waveform",
  markdownCapable: false,
} as const satisfies ChannelMeta;

/** Direct, spoken, one reply per turn: every rich chat feature is off. */
export const pipbitCapabilities: ChannelCapabilities = {
  chatTypes: ["direct"],
  polls: false,
  reactions: false,
  edit: false,
  unsend: false,
  reply: false,
  effects: false,
  groupManagement: false,
  threads: false,
  media: false,
  nativeCommands: false,
  blockStreaming: false,
};

// ---------------------------------------------------------------------------
// Config schema (the setup lane copies this object into openclaw.plugin.json
// `channelConfigs.pipbit.schema`; a test checks the two stay equal)
// ---------------------------------------------------------------------------

const secretInputSchema = {
  description:
    "The agent secret, issued by Pipbit at pairing and saved here by setup; never shown or logged. A plain string, a ${ENV_VAR} reference, or a SecretRef object.",
  anyOf: [
    { type: "string", minLength: 1 },
    {
      type: "object",
      additionalProperties: false,
      required: ["source", "id"],
      properties: {
        source: { type: "string", minLength: 1 },
        provider: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
    },
  ],
} as const;

const healthMonitorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
  },
} as const;

const accountProperties = {
  name: { type: "string", description: "OpenClaw's own label for this account." },
  enabled: { type: "boolean" },
  agentName: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    description: "The agent's internal name on Pipbit, as the pairing claim returned it.",
  },
  displayName: {
    type: "string",
    minLength: 1,
    maxLength: 128,
    description:
      "The spoken name Pip knows this agent by, recorded at pairing. Changing it here does not rename the agent on the Pipbit.",
  },
  secret: secretInputSchema,
  baseUrl: { type: "string", pattern: "^https?://", description: "Pipbit's HTTPS API base." },
  connectUrl: { type: "string", pattern: "^wss?://", description: "Pipbit Connect's WebSocket address." },
  agentId: { type: "string", minLength: 1, description: "Which OpenClaw agent answers; the default agent when unset." },
  pairedAt: { type: "string", description: "When the pairing was claimed (ISO time)." },
  healthMonitor: healthMonitorSchema,
  responsePrefix: {
    type: "string",
    description: "Accepted so OpenClaw's reply prefix setting validates here; spoken replies never carry a prefix.",
  },
} as const;

export const pipbitConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ...accountProperties,
    accounts: {
      type: "object",
      description: "More paired Pipbit agents, keyed by account id.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: accountProperties,
      },
    },
    defaultAccount: { type: "string", minLength: 1 },
    proactiveSpeech: {
      type: "boolean",
      description: "Let the agent speak on the owner's Pipbit unprompted (the pipbit_speak tool). Off unless true.",
    },
  },
} as const;

const SECRET_HELP =
  "Issued by Pipbit at pairing and saved here by setup; it is never shown or logged. Keep it private.";
const DISPLAY_NAME_HELP =
  "The name Pip knows this agent by, recorded at pairing. Changing it here does not rename the agent on your Pipbit.";
const RESPONSE_PREFIX_HELP = "Pipbit replies are spoken, so they never carry OpenClaw's reply prefix.";

/**
 * The ChannelConfigSchema wrapper OpenClaw takes on the channel plugin.
 *
 * `advanced: true` puts a field under the Control UI's "Advanced settings"
 * disclosure on the channel's page (closed unless the person opened it).
 * OpenClaw makes every `channels.*.secret` field a common one by default,
 * so without the flag the agent secret sat next to the Enabled switch as an
 * empty "JSON value" box (a string-or-SecretRef field has no simpler
 * control, and the paired secret lives under `accounts`), inviting someone
 * to type over or clear it. Setup writes the secret; nobody needs to edit it
 * by hand. `sensitive: true` keeps a stored value hidden wherever it shows.
 */
export const pipbitConfigSchema: NonNullable<ChannelPlugin["configSchema"]> = {
  schema: pipbitConfigJsonSchema as unknown as NonNullable<ChannelPlugin["configSchema"]>["schema"],
  uiHints: {
    secret: { label: "Agent secret", sensitive: true, advanced: true, help: SECRET_HELP },
    agentName: { label: "Agent name on Pipbit", advanced: true },
    displayName: { label: "Spoken name (recorded at pairing)", advanced: true, help: DISPLAY_NAME_HELP },
    baseUrl: { label: "Pipbit API address", advanced: true },
    connectUrl: { label: "Pipbit Connect address", advanced: true },
    agentId: { label: "OpenClaw agent", advanced: true },
    responsePrefix: { label: "Reply prefix (not used)", advanced: true, help: RESPONSE_PREFIX_HELP },
    proactiveSpeech: {
      label: "Speak unprompted",
      help: "Lets the agent say things on your Pipbit without being asked (reminders). Off by default.",
    },
    "accounts.*.secret": { label: "Agent secret", sensitive: true, advanced: true, help: SECRET_HELP },
    "accounts.*.agentName": { label: "Agent name on Pipbit", advanced: true },
    "accounts.*.displayName": { label: "Spoken name (recorded at pairing)", advanced: true, help: DISPLAY_NAME_HELP },
    "accounts.*.baseUrl": { label: "Pipbit API address", advanced: true },
    "accounts.*.connectUrl": { label: "Pipbit Connect address", advanced: true },
    "accounts.*.agentId": { label: "OpenClaw agent", advanced: true },
    "accounts.*.responsePrefix": { label: "Reply prefix (not used)", advanced: true, help: RESPONSE_PREFIX_HELP },
  },
};

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export type PipbitSecretSource = "config" | "env" | "ref" | "none";

export interface ResolvedPipbitAccount {
  accountId: string;
  enabled: boolean;
  /** True when the account has both an agent name and a secret. */
  configured: boolean;
  agentName: string | null;
  displayName: string | null;
  /**
   * The secret exactly as configured (not resolved). Non-enumerable, so a
   * spread or JSON.stringify of the account never carries it.
   */
  readonly secret: SecretInput | null;
  /** Where the secret comes from, for status output (never the value). */
  secretSource: PipbitSecretSource;
  baseUrl: string;
  connectUrl: string;
  /** Which OpenClaw agent answers; null means OpenClaw's routing decides. */
  agentId: string | null;
  pairedAt: string | null;
}

/** `channels.pipbit`, or an empty section. */
export function readPipbitSection(cfg: OpenClawConfig | null | undefined): PipbitChannelConfig {
  const channels = (cfg as { channels?: Record<string, unknown> } | null | undefined)?.channels;
  const section = channels?.[CHANNEL_ID];
  return isRecord(section) ? (section as PipbitChannelConfig) : {};
}

function readAccountsMap(section: PipbitChannelConfig): Record<string, PipbitAccountConfig> {
  const accounts = section.accounts;
  if (!isRecord(accounts)) {
    return {};
  }
  const out: Record<string, PipbitAccountConfig> = {};
  for (const [key, value] of Object.entries(accounts)) {
    const id = key.trim();
    if (id && isRecord(value)) {
      out[id] = value as PipbitAccountConfig;
    }
  }
  return out;
}

/** True when the top-level fields describe an account (the implicit default). */
function hasTopLevelAccount(section: PipbitChannelConfig): boolean {
  return nonEmptyString(section.agentName) !== null || hasSecretInput(section.secret);
}

/** Every account id: the implicit default first, then `accounts`; never empty. */
export function listPipbitAccountIds(cfg: OpenClawConfig | null | undefined): string[] {
  const section = readPipbitSection(cfg);
  const ids: string[] = [];
  if (hasTopLevelAccount(section)) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }
  for (const id of Object.keys(readAccountsMap(section))) {
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

/** `defaultAccount` when it names a listed account, else "default", else the first. */
export function resolveDefaultPipbitAccountId(cfg: OpenClawConfig | null | undefined): string {
  const ids = listPipbitAccountIds(cfg);
  const preferred = nonEmptyString(readPipbitSection(cfg).defaultAccount);
  if (preferred && ids.includes(preferred)) {
    return preferred;
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Resolve one account from the config. The default account merges the
 * top-level fields with `accounts.default`; a named account uses its own
 * fields and inherits only the two Pipbit addresses. The secret is carried
 * as configured and never resolved here.
 */
export function resolvePipbitAccount(cfg: OpenClawConfig | null | undefined, accountId?: string | null): ResolvedPipbitAccount {
  const section = readPipbitSection(cfg);
  const id = nonEmptyString(accountId) ?? resolveDefaultPipbitAccountId(cfg);
  const accounts = readAccountsMap(section);
  const own = accounts[id] ?? {};
  const merged: PipbitAccountConfig =
    id === DEFAULT_ACCOUNT_ID
      ? { ...pickAccountFields(section), ...own }
      : { baseUrl: section.baseUrl, connectUrl: section.connectUrl, ...own };

  const agentName = nonEmptyString(merged.agentName);
  const secret = normalizeSecretInput(merged.secret);
  const account: Omit<ResolvedPipbitAccount, "secret"> = {
    accountId: id,
    enabled: section.enabled !== false && merged.enabled !== false,
    configured: agentName !== null && secret !== null,
    agentName,
    displayName: nonEmptyString(merged.displayName),
    secretSource: secretSourceOf(secret),
    baseUrl: nonEmptyString(merged.baseUrl) ?? DEFAULT_BASE_URL,
    connectUrl: nonEmptyString(merged.connectUrl) ?? DEFAULT_CONNECT_URL,
    agentId: nonEmptyString(merged.agentId),
    pairedAt: nonEmptyString(merged.pairedAt),
  };
  Object.defineProperty(account, "secret", { value: secret, enumerable: false, writable: false });
  return account as ResolvedPipbitAccount;
}

function pickAccountFields(section: PipbitChannelConfig): PipbitAccountConfig {
  const { accounts: _accounts, defaultAccount: _defaultAccount, proactiveSpeech: _proactive, ...fields } = section;
  return fields;
}

/**
 * The implicit default account's own settings at the channel root (removed
 * with that account). Channel-wide settings stay while any account is left:
 * the root's `enabled` switches the whole channel, its baseUrl / connectUrl
 * are inherited by named accounts, and OpenClaw reads the root's
 * healthMonitor and responsePrefix for every account that sets none of its
 * own.
 */
const ROOT_ACCOUNT_KEYS = ["agentName", "displayName", "secret", "pairedAt", "agentId", "name"] as const;

/**
 * `config.deleteAccount`: the config without one account. The default
 * account also loses its settings at the channel root; `defaultAccount` is
 * dropped when it named the account, and `channels.pipbit` itself goes once
 * no account is left. Nothing else changes (an unknown account id returns
 * an equal config, which OpenClaw reports as nothing to remove).
 */
export function deletePipbitAccount(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  if (!isRecord(channels) || !isRecord(channels[CHANNEL_ID])) {
    return cfg;
  }
  const id = nonEmptyString(accountId) ?? DEFAULT_ACCOUNT_ID;
  const section: Record<string, unknown> = { ...(channels[CHANNEL_ID] as Record<string, unknown>) };
  const accounts: Record<string, unknown> = isRecord(section.accounts) ? { ...section.accounts } : {};
  for (const key of Object.keys(accounts)) {
    if (key.trim() === id) {
      delete accounts[key];
    }
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    for (const key of ROOT_ACCOUNT_KEYS) {
      delete section[key];
    }
  }
  if (section.defaultAccount === id) {
    delete section.defaultAccount;
  }
  if (Object.keys(accounts).length > 0) {
    section.accounts = accounts;
  } else {
    delete section.accounts;
  }
  const nextChannels: Record<string, unknown> = { ...channels };
  const anyAccountLeft = hasTopLevelAccount(section as PipbitChannelConfig) || Object.keys(accounts).length > 0;
  if (anyAccountLeft) {
    nextChannels[CHANNEL_ID] = section;
  } else {
    delete nextChannels[CHANNEL_ID];
  }
  const next = { ...cfg } as Record<string, unknown>;
  if (Object.keys(nextChannels).length > 0) {
    next.channels = nextChannels;
  } else {
    delete next.channels;
  }
  return next as OpenClawConfig;
}

/**
 * `config.setAccountEnabled`: writes `accounts.<id>.enabled`, the account's
 * own switch (the channel root's `enabled` switches every account, so it is
 * not touched). For the implicit default account this adds
 * `accounts.default: { enabled }`, which the root settings still fill in.
 */
export function setPipbitAccountEnabled(cfg: OpenClawConfig, accountId: string, enabled: boolean): OpenClawConfig {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const section: Record<string, unknown> = isRecord(channels?.[CHANNEL_ID]) ? { ...(channels[CHANNEL_ID] as Record<string, unknown>) } : {};
  const id = nonEmptyString(accountId) ?? DEFAULT_ACCOUNT_ID;
  const accounts: Record<string, unknown> = isRecord(section.accounts) ? { ...section.accounts } : {};
  const existing = isRecord(accounts[id]) ? accounts[id] : {};
  accounts[id] = { ...existing, enabled };
  return {
    ...cfg,
    channels: { ...(isRecord(channels) ? channels : {}), [CHANNEL_ID]: { ...section, accounts } },
  } as OpenClawConfig;
}

/** A string (trimmed, non-empty) or a SecretRef-shaped object; else null. */
function normalizeSecretInput(value: unknown): SecretInput | null {
  if (typeof value === "string") {
    return value.trim() === "" ? null : value.trim();
  }
  if (isRecord(value) && typeof value.id === "string" && value.id.trim() !== "" && typeof value.source === "string") {
    const ref: { source: string; provider?: string; id: string } = { source: value.source, id: value.id.trim() };
    if (typeof value.provider === "string" && value.provider.trim() !== "") {
      ref.provider = value.provider.trim();
    }
    return ref;
  }
  return null;
}

function hasSecretInput(value: unknown): boolean {
  return normalizeSecretInput(value) !== null;
}

function secretSourceOf(secret: SecretInput | null): PipbitSecretSource {
  if (secret === null) {
    return "none";
  }
  if (typeof secret !== "string") {
    return "ref";
  }
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$|^\$[A-Z_][A-Z0-9_]*$/.test(secret) ? "env" : "config";
}

/** Whether `channels.pipbit.proactiveSpeech` is exactly true. */
export function isProactiveSpeechEnabled(cfg: OpenClawConfig | null | undefined): boolean {
  return readPipbitSection(cfg).proactiveSpeech === true;
}

/** The account's own config facts for its status: name, URL, where the secret comes from. */
export function describePipbitAccount(account: ResolvedPipbitAccount): ChannelAccountSnapshot {
  const snapshot: ChannelAccountSnapshot = {
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    baseUrl: account.baseUrl,
    secretSource: account.secretSource,
  };
  const name = account.displayName ?? account.agentName;
  if (name) {
    snapshot.name = name;
  }
  return snapshot;
}

// No `inspectAccount`: when a plugin has one, OpenClaw's CLI status commands
// build the account from it and never call the status adapter below, so the
// refusal the Gateway last wrote to the state file would never be shown
// while the Gateway is down. resolveAccount is already status-safe (the
// secret is carried unread and non-enumerable).
export const pipbitConfigAdapter: ChannelPlugin<ResolvedPipbitAccount>["config"] = {
  listAccountIds: (cfg) => listPipbitAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolvePipbitAccount(cfg, accountId),
  defaultAccountId: (cfg) => resolveDefaultPipbitAccountId(cfg),
  deleteAccount: ({ cfg, accountId }) => deletePipbitAccount(cfg, accountId),
  setAccountEnabled: ({ cfg, accountId, enabled }) => setPipbitAccountEnabled(cfg, accountId, enabled),
  isEnabled: (account) => account.enabled,
  isConfigured: (account) => account.configured,
  unconfiguredReason: () => "not set up (run Set up for Pipbit)",
  describeAccount: (account) => describePipbitAccount(account),
  hasConfiguredState: ({ cfg }) => listPipbitAccountIds(cfg).some((id) => resolvePipbitAccount(cfg, id).configured),
};

export interface PipbitLifecycleOptions {
  /** Where the state files live; OpenClaw's state dir by default. */
  stateDir?: () => string;
}

/**
 * `lifecycle.onAccountRemoved`: an account removed from the config (for
 * example `openclaw channels remove --channel pipbit --delete`) takes its
 * state file with it (the owner's subject id and the agent's last greeting).
 * A failure to delete never blocks the removal.
 */
export function createPipbitLifecycleAdapter(
  options: PipbitLifecycleOptions = {},
): NonNullable<ChannelPlugin<ResolvedPipbitAccount>["lifecycle"]> {
  const stateDir = options.stateDir ?? (() => resolvePipbitStateDir());
  return {
    onAccountRemoved: async ({ accountId }) => {
      try {
        await removeAccountState(stateDir(), accountId);
      } catch {
        // The file is a convenience; the config change goes ahead.
      }
    },
  };
}

export const pipbitLifecycleAdapter = createPipbitLifecycleAdapter();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface PipbitStatusAdapterOptions {
  /** Where the state files live; OpenClaw's state dir by default. */
  stateDir?: () => string;
}

/** Where config issues ride on an account snapshot, for collectStatusIssues. */
export const PIPBIT_CONFIG_ISSUES_KEY = "pipbitConfigIssues";

type RoutingModule = {
  resolveAgentRoute: (input: { cfg: OpenClawConfig; channel: string; accountId?: string | null }) => { agentId: string };
};
let routingModule: Promise<RoutingModule | null> | null = null;

function loadRouting(): Promise<RoutingModule | null> {
  routingModule ??= import("openclaw/plugin-sdk/routing").then(
    (module) => module as unknown as RoutingModule,
    () => null,
  );
  return routingModule;
}

/**
 * What in the Gateway config keeps this account from working as it should
 * (see config-checks.ts): OpenClaw cannot tell which agent answers, or its
 * tool policy removes pipbit_handback.
 */
export async function collectPipbitConfigIssues(
  cfg: OpenClawConfig | null | undefined,
  account: ResolvedPipbitAccount,
): Promise<PipbitConfigIssue[]> {
  if (!cfg || !account.enabled || !account.configured) {
    return [];
  }
  const issues: PipbitConfigIssue[] = [];
  let agentId = nonEmptyString(account.agentId)?.toLowerCase() ?? null;
  if (agentId === null) {
    const routing = await loadRouting();
    try {
      agentId = nonEmptyString(routing?.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: account.accountId }).agentId)?.toLowerCase() ?? null;
    } catch (error) {
      if (isAgentSelectionRequired(error)) {
        issues.push(agentSelectionIssue(cfg, account.accountId));
      }
    }
  }
  issues.push(...findHandbackBlockers(cfg, agentId));
  return issues;
}

/**
 * The status adapter. Live facts come from OpenClaw's account snapshot
 * (the Gateway process). When a snapshot carries none (a CLI process while
 * the Gateway is down), a refusal the Gateway last wrote to the state file
 * still reads Needs attention; any other link word there may be stale, so
 * the account then reads Not running.
 */
export function createPipbitStatusAdapter(
  options: PipbitStatusAdapterOptions = {},
): ChannelStatusAdapter<ResolvedPipbitAccount> {
  const stateDir = options.stateDir ?? (() => resolvePipbitStateDir());

  const stateFileFor = async (account: ResolvedPipbitAccount): Promise<PipbitAccountStateFile | null> => {
    if (!account.configured || !account.agentName) {
      return null;
    }
    try {
      const file = await readAccountState(stateDir(), account.accountId);
      return file && file.agentName === account.agentName ? file : null;
    } catch {
      return null;
    }
  };

  const labelFor = async (
    account: ResolvedPipbitAccount,
    snapshot: Partial<ChannelAccountSnapshot> | undefined,
  ): Promise<{ label: PipbitStatusLabel; detail: string | null }> => {
    if (!account.enabled) {
      return { label: "Disabled", detail: null };
    }
    if (!account.configured) {
      return { label: "Not set up", detail: null };
    }
    const live = labelFromSnapshot(snapshot);
    if (live && live !== "Not running") {
      return { label: live, detail: snapshot?.lastError ?? snapshot?.stateReason ?? null };
    }
    const refusal = refusalFromStateFile(await stateFileFor(account));
    if (refusal) {
      return { label: "Needs attention", detail: refusal };
    }
    return { label: live ?? "Not running", detail: snapshot?.lastError ?? null };
  };

  return {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastError: null,
    },
    buildAccountSnapshot: async ({ account, cfg, runtime }) => {
      const { label, detail } = await labelFor(account, runtime);
      const snapshot: ChannelAccountSnapshot = {
        ...(runtime ?? {}),
        ...describePipbitAccount(account),
        statusState: label,
      };
      if (!runtime?.lastError && label === "Needs attention" && detail) {
        snapshot.lastError = detail;
      }
      // Always from this config: the runtime spread above may carry the
      // Gateway's last published list (gateway.ts), which can be older.
      const configIssues = await collectPipbitConfigIssues(cfg, account);
      if (configIssues.length > 0) {
        (snapshot as Record<string, unknown>)[PIPBIT_CONFIG_ISSUES_KEY] = configIssues;
      } else {
        delete (snapshot as Record<string, unknown>)[PIPBIT_CONFIG_ISSUES_KEY];
      }
      return snapshot;
    },
    buildChannelSummary: async ({ account, snapshot }) => {
      const { label, detail } = await labelFor(account, snapshot);
      return {
        ok: label === "Connected",
        label,
        statusState: label,
        configured: account.configured,
        // OpenClaw's Control UI reads these two from this summary, not from
        // the account: its channel row says Running only when one of them is
        // true, and Configured otherwise (ui/src/pages/channels/view.ts at
        // 2026.9.6). Without them a connected account read Configured.
        running: snapshot?.running === true,
        connected: snapshot?.connected === true,
        ...(detail ? { detail } : {}),
      };
    },
    collectStatusIssues: (accounts) => collectPipbitStatusIssues(accounts),
  };
}

/**
 * The issues for each account that needs the person: blocked (with the fix
 * its message calls for), not set up, or held back by the Gateway config.
 *
 * For a blocked, configured account OpenClaw already lists its own issue
 * carrying the same lastError (with the fix "resolve the reported channel
 * error, then restart the channel"), so this one does not repeat the
 * message: it says what to do instead.
 */
export function collectPipbitStatusIssues(accounts: readonly ChannelAccountSnapshot[]): ChannelStatusIssue[] {
  const issues: ChannelStatusIssue[] = [];
  for (const snapshot of accounts) {
    if (snapshot.enabled === false) {
      continue;
    }
    const blocked = snapshot.lifecycle === "blocked" || snapshot.terminalDisconnect === true;
    const message = typeof snapshot.lastError === "string" && snapshot.lastError.trim() !== "" ? snapshot.lastError : null;
    if (blocked || (snapshot.statusState === "Needs attention" && message)) {
      const text = message ?? "The Pipbit link stopped and needs attention.";
      const remedy = remedyForMessage(text);
      issues.push({
        channel: CHANNEL_ID,
        accountId: snapshot.accountId,
        kind: issueKindForMessage(text),
        // OpenClaw's own issue does not cover an unconfigured account.
        message: snapshot.configured === false ? text : remedy.message,
        fix: remedy.fix,
      });
    } else if (snapshot.configured === false && snapshot.running === true) {
      issues.push({
        channel: CHANNEL_ID,
        accountId: snapshot.accountId,
        kind: "config",
        message: "Pipbit is not set up for this agent yet.",
        fix: SET_UP_AGAIN_FIX,
      });
    }
    for (const issue of readConfigIssues(snapshot)) {
      issues.push({ channel: CHANNEL_ID, accountId: snapshot.accountId, kind: "config", message: issue.message, fix: issue.fix });
    }
  }
  return issues;
}

function readConfigIssues(snapshot: ChannelAccountSnapshot): PipbitConfigIssue[] {
  const raw = (snapshot as Record<string, unknown>)[PIPBIT_CONFIG_ISSUES_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is PipbitConfigIssue =>
      isRecord(entry) && typeof entry.message === "string" && typeof entry.fix === "string",
  );
}

export const pipbitStatusAdapter = createPipbitStatusAdapter();

// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
