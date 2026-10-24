import { join, resolve } from "node:path";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  FALLBACK_DISPLAY_NAME,
  type PairingClaim,
  type PipbitAccountConfig,
  type PipbitChannelConfig,
} from "../shared/contracts.ts";

// Reading and writing the parts of the Gateway config the setup wizard
// touches: the spoken name (from the OpenClaw agent roster and the agent's
// workspace) and `channels.pipbit`. Everything here is a pure function of
// its inputs (the one file it may need is read through a function the caller
// passes), so the wizard's tests need no OpenClaw at all.
//
// The config arrives typed as OpenClaw's own config type; these helpers read
// it as plain data (`unknown`) on purpose. The agent roster has two shapes
// (see below) and the channel section is ours, so walking the raw object is
// both simpler and sturdier than leaning on OpenClaw's generated types.

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** `channels.pipbit` as plain data, or an empty object when absent. */
export function readPipbitSection(cfg: unknown): PipbitChannelConfig {
  const channels = isRecord(cfg) ? cfg["channels"] : undefined;
  const section = isRecord(channels) ? channels[CHANNEL_ID] : undefined;
  return isRecord(section) ? (section as PipbitChannelConfig) : {};
}

/**
 * One account's fields, by the channel's own rule (resolvePipbitAccount in
 * src/channel/base.ts): the default account is the channel's top-level
 * fields with `accounts.default` laid over them; a named account is
 * `accounts.<id>`. Null when neither holds anything.
 */
export function readPipbitAccount(cfg: unknown, accountId: string = DEFAULT_ACCOUNT_ID): PipbitAccountConfig | null {
  const section = readPipbitSection(cfg);
  const accounts = isRecord(section.accounts) ? section.accounts : {};
  const own = isRecord(accounts[accountId]) ? (accounts[accountId] as PipbitAccountConfig) : null;
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return own;
  }
  const { accounts: _accounts, defaultAccount: _default, proactiveSpeech: _speech, ...top } = section;
  const merged: PipbitAccountConfig = { ...top, ...own };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** A secret counts as present when it is a non-empty string or a SecretRef object. */
export function hasSecret(account: PipbitAccountConfig | null): boolean {
  const secret = account?.secret;
  if (typeof secret === "string") {
    return secret.trim().length > 0;
  }
  return isRecord(secret) && typeof secret["id"] === "string" && secret["id"].length > 0;
}

/** True when the account holds a finished pairing: an agent name and a secret. */
export function isAccountPaired(account: PipbitAccountConfig | null): boolean {
  return trimmed(account?.agentName) !== null && hasSecret(account);
}

/** The spoken name a paired account was saved with, for status lines. */
export function accountSpokenName(account: PipbitAccountConfig | null): string | null {
  return trimmed(account?.displayName) ?? trimmed(account?.agentName);
}

// ---------------------------------------------------------------------------
// The spoken name
// ---------------------------------------------------------------------------

type AgentEntry = Json & { id: string };

/**
 * The configured OpenClaw agents, in either of the two shapes OpenClaw
 * accepts: `agents.entries` (keyed by agent id, the newer shape, and the one
 * OpenClaw prefers when both exist) or `agents.list` (an array whose items
 * carry `id`). Mirrors OpenClaw's own roster reader
 * (src/agents/agent-roster.ts at 2026.9.6).
 */
function listAgentEntries(cfg: unknown): AgentEntry[] {
  const agents = isRecord(cfg) ? cfg["agents"] : undefined;
  if (!isRecord(agents)) {
    return [];
  }
  const entries = agents["entries"];
  if (entries !== undefined) {
    if (!isRecord(entries)) {
      return [];
    }
    return Object.entries(entries)
      .filter((pair): pair is [string, Json] => isRecord(pair[1]))
      .map(([id, entry]) => ({ ...entry, id }));
  }
  const list = agents["list"];
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter(
    (entry): entry is AgentEntry => isRecord(entry) && typeof entry["id"] === "string",
  );
}

/** True when the config names a roster at all (`agents.entries` or `agents.list`). */
function hasAgentRoster(cfg: unknown): boolean {
  const agents = isRecord(cfg) ? cfg["agents"] : undefined;
  return isRecord(agents) && (agents["entries"] !== undefined || agents["list"] !== undefined);
}

/** OpenClaw's id of the agent a config with no roster at all has. */
const IMPLICIT_AGENT_ID = "main";

/**
 * OpenClaw's canonical agent id (normalizeAgentId in its
 * normalization-core/agent-id.ts): lower case, anything outside
 * `[a-z0-9_-]` turned into dashes, at most 64 characters, "main" when
 * nothing usable is left.
 */
export function normalizeAgentId(id: string | null | undefined): string {
  const text = (id ?? "").trim();
  const lower = text.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(text)) {
    return lower;
  }
  const cleaned = lower
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return cleaned || IMPLICIT_AGENT_ID;
}

function findAgentEntry(cfg: unknown, agentId: string): AgentEntry | null {
  const id = normalizeAgentId(agentId);
  return listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === id) ?? null;
}

/**
 * The agent that owns the default workspace, by OpenClaw's own rule
 * (tryResolveLegacyDataOwner in src/agents/agent-roster.ts at 2026.9.6):
 * exactly one entry marked `default: true` (ignored when `agents.ownership`
 * is "explicit"), else the only agent, else "main" when there is no roster
 * at all, else none.
 */
export function resolveDefaultWorkspaceOwner(cfg: unknown): string | null {
  const agents = isRecord(cfg) ? cfg["agents"] : undefined;
  const entries = listAgentEntries(cfg);
  if (!(isRecord(agents) && agents["ownership"] === "explicit")) {
    const marked = entries.filter((entry) => entry["default"] === true);
    if (marked.length === 1 && marked[0]) {
      return normalizeAgentId(marked[0].id);
    }
  }
  if (entries.length === 1 && entries[0]) {
    return normalizeAgentId(entries[0].id);
  }
  return entries.length === 0 && !hasAgentRoster(cfg) ? IMPLICIT_AGENT_ID : null;
}

/** Where OpenClaw keeps its files, as far as finding an agent's workspace goes. */
export interface OpenClawPaths {
  /** OpenClaw's state directory (`~/.openclaw`, or OPENCLAW_STATE_DIR). */
  stateDir: string;
  /** The home directory a leading `~` stands for (OPENCLAW_HOME, else the user's). */
  homeDir: string;
  /**
   * The default agent's workspace when `agents.defaults.workspace` is unset
   * (`~/.openclaw/workspace`, OPENCLAW_WORKSPACE_DIR, or `workspace` in the
   * state directory).
   */
  defaultWorkspaceDir: string;
}

/** A configured path with a leading `~` expanded, made absolute (OpenClaw's resolveUserPath). */
function resolveUserPath(input: string, homeDir: string): string {
  const text = input.trim();
  if (/^~(?=$|[\\/])/.test(text)) {
    return resolve(text.replace(/^~/, () => homeDir));
  }
  return resolve(text);
}

/**
 * The agent's workspace directory, by OpenClaw's own rule
 * (resolveAgentWorkspaceDir in src/agents/agent-scope-config.ts at
 * 2026.9.6): the agent's own `workspace`; for the agent that owns the
 * default workspace, `agents.defaults.workspace` or else OpenClaw's default
 * workspace; for any other agent, `<agents.defaults.workspace>/<id>` or else
 * `<state dir>/workspace-<id>`.
 */
export function resolveAgentWorkspaceDir(cfg: unknown, agentId: string, paths: OpenClawPaths): string {
  const id = normalizeAgentId(agentId);
  const entry = findAgentEntry(cfg, id);
  const own = trimmed(entry?.["workspace"]);
  if (own) {
    return resolveUserPath(own, paths.homeDir);
  }
  const agents = isRecord(cfg) ? cfg["agents"] : undefined;
  const defaults = isRecord(agents) ? agents["defaults"] : undefined;
  const fallback = isRecord(defaults) ? trimmed(defaults["workspace"]) : null;
  if (id === resolveDefaultWorkspaceOwner(cfg)) {
    return fallback ? resolveUserPath(fallback, paths.homeDir) : paths.defaultWorkspaceDir;
  }
  if (fallback) {
    return join(resolveUserPath(fallback, paths.homeDir), id);
  }
  return join(paths.stateDir, `workspace-${id}`);
}

/** The agent whose workspace is `workspaceDir` (how OpenClaw names the setup owner), or null. */
export function findAgentByWorkspace(cfg: unknown, workspaceDir: string, paths: OpenClawPaths): string | null {
  const wanted = resolve(workspaceDir);
  const ids = listAgentEntries(cfg).map((entry) => normalizeAgentId(entry.id));
  if (ids.length === 0 && !hasAgentRoster(cfg)) {
    ids.push(IMPLICIT_AGENT_ID);
  }
  return ids.find((id) => resolveAgentWorkspaceDir(cfg, id, paths) === wanted) ?? null;
}

/** The file in an agent's workspace that holds its name. */
export const IDENTITY_FILENAME = "IDENTITY.md";

/** Template text OpenClaw's own IDENTITY.md parser skips (src/agents/identity-file.ts). */
const IDENTITY_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "not set yet",
  "pick something you like",
  "ai? robot? familiar? ghost in the machine? something weirder?",
  "how do you come across? sharp? warm? chaotic? calm?",
  "your signature - pick one that feels right",
  "workspace-relative path, http(s) url, or data uri",
]);

const MARKDOWN_EDGES = /^[*_`\s]+|[*_`\s]+$/g;

function isIdentityPlaceholder(value: string): boolean {
  let text = value.trim().replace(MARKDOWN_EDGES, "").trim();
  if (text.startsWith("(") && text.endsWith(")")) {
    text = text.slice(1, -1).trim();
  }
  // En and em dashes count as a plain dash.
  text = text.replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  return IDENTITY_PLACEHOLDERS.has(text);
}

/**
 * The Name in an agent's IDENTITY.md, read the way OpenClaw reads it
 * (parseIdentityMarkdown in src/agents/identity-file.ts at 2026.9.6): each
 * `Label: value` line, a leading `- ` and markdown emphasis ignored, the
 * template's placeholder text skipped, the last Name line winning. Null when
 * there is none.
 */
export function parseIdentityName(markdown: string): string | null {
  let name: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^\s*-\s*/, "");
    const colon = cleaned.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const label = cleaned.slice(0, colon).replace(/[*_`]/g, "").trim().toLowerCase();
    const value = cleaned.slice(colon + 1).replace(MARKDOWN_EDGES, "").trim();
    if (label === "name" && value && !isIdentityPlaceholder(value)) {
      name = value;
    }
  }
  return name;
}

/** OpenClaw shows at most 50 UTF-16 units of a name (assistant-identity.ts), never half a pair. */
function identityName(value: unknown): string | null {
  const text = trimmed(value);
  if (!text || text.length <= 50) {
    return text;
  }
  const cut = text.slice(0, 50);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** What resolveSpokenName needs besides the config. */
export interface SpokenNameSources {
  /** The account's `agentId` (which OpenClaw agent answers), when one is set. */
  agentId?: string | null;
  /**
   * The agent OpenClaw routes Pipbit turns to (its resolveAgentRoute for
   * channel pipbit, account default), or null when routing cannot decide.
   */
  routedAgentId?: string | null;
  /** The workspace of the agent setup was started for (OpenClaw's setup owner), when known. */
  ownerWorkspaceDir?: string | null;
  paths: OpenClawPaths;
  /** The text of `<workspaceDir>/IDENTITY.md`, or null when there is none or it cannot be read. */
  readIdentityFile(workspaceDir: string): string | null;
}

/**
 * The name the person will say to their Pipbit: the name of the OpenClaw
 * agent that answers Pipbit turns, in OpenClaw's own order
 * (resolveAssistantIdentity in src/gateway/assistant-identity.ts at
 * 2026.9.6): the agent's configured `identity.name`, else the Name in its
 * workspace's IDENTITY.md. The answering agent is the account's `agentId`,
 * else the agent OpenClaw routes Pipbit turns to, else the agent setup was
 * started for. "OpenClaw" when none of them has a name, or when nothing
 * decides the agent.
 */
export function resolveSpokenName(cfg: unknown, sources: SpokenNameSources): string {
  const explicit = trimmed(sources.agentId) ?? trimmed(sources.routedAgentId);
  let agentId: string | null = explicit ? normalizeAgentId(explicit) : null;
  let workspaceDir: string | null = null;
  const owner = trimmed(sources.ownerWorkspaceDir);
  if (!agentId && owner) {
    agentId = findAgentByWorkspace(cfg, owner, sources.paths);
    workspaceDir = resolve(owner);
  }
  if (!agentId && !workspaceDir) {
    return FALLBACK_DISPLAY_NAME;
  }
  const entry = agentId ? findAgentEntry(cfg, agentId) : null;
  const identity = entry?.["identity"];
  const configured = isRecord(identity) ? identityName(identity["name"]) : null;
  if (configured) {
    return configured;
  }
  const dir = workspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId ?? IMPLICIT_AGENT_ID, sources.paths);
  let text: string | null = null;
  try {
    text = sources.readIdentityFile(dir);
  } catch {
    text = null;
  }
  return (text !== null ? identityName(parseIdentityName(text)) : null) ?? FALLBACK_DISPLAY_NAME;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** The account keys a pairing owns; a new pairing replaces all of them. */
const CREDENTIAL_KEYS = ["agentName", "displayName", "secret", "baseUrl", "connectUrl", "pairedAt"] as const;

function withPipbitSection<T>(cfg: T, section: PipbitChannelConfig): T {
  const root: Json = isRecord(cfg) ? cfg : {};
  const channels: Json = isRecord(root["channels"]) ? root["channels"] : {};
  return { ...root, channels: { ...channels, [CHANNEL_ID]: section } } as T;
}

export interface PairingWrite {
  accountId: string;
  /** The spoken name, as the platform recorded it. */
  displayName: string;
  /** ISO time of the claim. */
  pairedAt: string;
}

/** The two channel-root fields a named account inherits (resolvePipbitAccount in src/channel/base.ts). */
const INHERITED_KEYS = ["baseUrl", "connectUrl"] as const;

/**
 * The config with a fresh pairing saved as `channels.pipbit.accounts.<id>`.
 * Every credential the old pairing held is replaced (at the account and at
 * the channel root, where an older single-account layout may have left
 * them); settings that are not credentials (`agentId`, `proactiveSpeech`,
 * other accounts) are kept. A named account that inherited the Pipbit
 * addresses from the channel root gets a copy of them first, so removing
 * them from the root does not move it to another platform.
 */
export function applyPairingClaim<T>(cfg: T, claim: PairingClaim, write: PairingWrite): T {
  const section: PipbitChannelConfig = { ...readPipbitSection(cfg) };
  const accounts = isRecord(section.accounts) ? { ...section.accounts } : {};
  for (const [id, entry] of Object.entries(accounts)) {
    if (id === DEFAULT_ACCOUNT_ID || id === write.accountId || !isRecord(entry)) {
      continue;
    }
    const inherited: PipbitAccountConfig = {};
    for (const key of INHERITED_KEYS) {
      if (entry[key] === undefined && section[key] !== undefined) {
        inherited[key] = section[key];
      }
    }
    if (Object.keys(inherited).length > 0) {
      accounts[id] = { ...entry, ...inherited };
    }
  }
  for (const key of CREDENTIAL_KEYS) {
    delete section[key];
  }
  const previous = isRecord(accounts[write.accountId]) ? { ...accounts[write.accountId] } : {};
  for (const key of CREDENTIAL_KEYS) {
    delete previous[key];
  }
  accounts[write.accountId] = {
    ...previous,
    enabled: true,
    agentName: claim.agentName,
    displayName: write.displayName,
    secret: claim.secret,
    baseUrl: claim.baseUrl,
    connectUrl: claim.connectUrl,
    pairedAt: write.pairedAt,
  };
  return withPipbitSkillOn(
    withPipbitSection(cfg, {
      ...section,
      enabled: true,
      defaultAccount: write.accountId,
      accounts,
    }),
  );
}

/** The key the plugin's skill goes by under `skills.entries` (its name in skills/pipbit/SKILL.md). */
export const PIPBIT_SKILL_KEY = "pipbit";

/**
 * The config with the Pipbit skill switched back on: an
 * `skills.entries.pipbit.enabled: false` is removed, and everything else in
 * that entry stays (an entry, `skills.entries` or `skills` left empty by the
 * removal goes too). OpenClaw's `openclaw doctor --fix` writes that false
 * for any skill whose requirements it finds unmet, and some hosts run it at
 * every start: an earlier copy of the skill required `channels.pipbit`,
 * which does not exist before the first pairing, and doctor never switches
 * a skill back on. Setting Pipbit up is the person asking for it, so setup
 * does: a new pairing, and a setup run that keeps the saved pairing (an
 * install paired before this fix keeps its false otherwise; see the
 * wizard's keepSavedPairing).
 *
 * Returns the very same object when there is nothing to remove, so a caller
 * can tell "nothing to write" by identity.
 */
export function withPipbitSkillOn<T>(cfg: T): T {
  const root: Json = isRecord(cfg) ? cfg : {};
  const skills = isRecord(root["skills"]) ? root["skills"] : null;
  const entries = skills && isRecord(skills["entries"]) ? skills["entries"] : null;
  const entry = entries && isRecord(entries[PIPBIT_SKILL_KEY]) ? entries[PIPBIT_SKILL_KEY] : null;
  if (!skills || !entries || !entry || entry["enabled"] !== false) {
    return cfg;
  }
  const { enabled: _off, ...keptEntry } = entry;
  const { [PIPBIT_SKILL_KEY]: _old, ...otherEntries } = entries;
  const nextEntries: Json = Object.keys(keptEntry).length > 0 ? { ...otherEntries, [PIPBIT_SKILL_KEY]: keptEntry } : otherEntries;
  const { entries: _entries, ...otherSkills } = skills;
  const nextSkills: Json = Object.keys(nextEntries).length > 0 ? { ...otherSkills, entries: nextEntries } : otherSkills;
  const { skills: _skills, ...rest } = root;
  return (Object.keys(nextSkills).length > 0 ? { ...rest, skills: nextSkills } : rest) as T;
}

/** The config with `channels.pipbit.enabled` set to false and all else kept. */
export function disablePipbitChannel<T>(cfg: T): T {
  return withPipbitSection(cfg, { ...readPipbitSection(cfg), enabled: false });
}
