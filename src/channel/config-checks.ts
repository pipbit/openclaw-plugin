// Config the plugin cannot work around, found by reading the Gateway config
// the way OpenClaw 2026.9.x does, and shown as status issues (base.ts).
// Pure and setup-safe: no socket, no runtime object.
//
// Two things are checked for an account:
//
//   - which agent answers. With several agents, none marked to answer and
//     no binding for the pipbit channel, OpenClaw's routing refuses to pick
//     one (AgentSelectionRequiredError), so every turn goes unanswered unless
//     the account names its agent.
//   - whether pipbit_handback survives OpenClaw's tool policy. Every turn
//     without a verified voice (the usual connect intro included) is run
//     with only that tool; when the policy removes it, OpenClaw refuses the
//     run before the model is called ("No callable tools remain after
//     resolving explicit tool allowlist"). The channel then asks again with
//     no tools at all (inbound.ts), so the person still hears an answer, but
//     the agent can never hand them back to Pip. The layers that remove a
//     plugin tool: the sandbox tool list (Pipbit sessions are never the main
//     session, so sandbox mode "non-main" or "all" covers them), and an
//     explicit tools.allow or agents.<id>.tools.allow list.
//
// This mirrors OpenClaw's rules closely but not exhaustively (deny lists
// and per-provider lists are not read); it exists to name the config line to
// add, not to decide anything at run time.

import { CHANNEL_ID, HANDBACK_TOOL_NAME } from "../shared/contracts.ts";

export interface PipbitConfigIssue {
  message: string;
  fix: string;
}

type Json = Record<string, unknown>;

/** OpenClaw's refusal to pick an agent when several exist and none owns the route. */
export function isAgentSelectionRequired(error: unknown): boolean {
  const fields = (typeof error === "object" && error !== null ? error : {}) as { name?: unknown; code?: unknown };
  return fields.name === "AgentSelectionRequiredError" || fields.code === "AGENT_SELECTION_REQUIRED";
}

/** Where an account's own settings live: `channels.pipbit.accounts.<id>` or the channel root. */
export function accountConfigPath(cfg: unknown, accountId: string): string {
  const accounts = record(record(record(cfg)?.["channels"])?.[CHANNEL_ID])?.["accounts"];
  return record(accounts)?.[accountId] !== undefined
    ? `channels.${CHANNEL_ID}.accounts.${accountId}`
    : `channels.${CHANNEL_ID}`;
}

/** The issue for an account whose agent OpenClaw's routing cannot pick. */
export function agentSelectionIssue(cfg: unknown, accountId: string): PipbitConfigIssue {
  const path = `${accountConfigPath(cfg, accountId)}.agentId`;
  return {
    message: "OpenClaw has several agents and none is set to answer on Pipbit, so Pipbit turns go unanswered.",
    fix: `Name the agent that should answer: set ${path} (openclaw config set ${path} <agent id>), or add a binding for the pipbit channel.`,
  };
}

/**
 * Why pipbit_handback would not be offered to `agentId` (null: the agent is
 * not known, so only the settings every agent shares are read). Empty when
 * nothing in the config removes it.
 */
export function findHandbackBlockers(cfg: unknown, agentId: string | null): PipbitConfigIssue[] {
  const issues: PipbitConfigIssue[] = [];
  const root = record(cfg);
  const agent = agentId ? findAgentEntry(cfg, agentId) : undefined;
  const agentPath = agentId ? `agents.entries.${agentId}` : null;

  // The sandbox tool list, when Pipbit sessions are sandboxed.
  const defaultsSandbox = record(record(record(root?.["agents"])?.["defaults"])?.["sandbox"]);
  const mode = stringOf(record(agent?.["sandbox"])?.["mode"]) ?? stringOf(defaultsSandbox?.["mode"]) ?? "off";
  if (mode === "non-main" || mode === "all") {
    const agentLists = record(record(record(agent?.["tools"])?.["sandbox"])?.["tools"]);
    const globalLists = record(record(record(root?.["tools"])?.["sandbox"])?.["tools"]);
    const allow = listOf(agentLists?.["allow"]) ?? listOf(globalLists?.["allow"]);
    const alsoAllow = listOf(agentLists?.["alsoAllow"]) ?? listOf(globalLists?.["alsoAllow"]);
    // `allow: []` means every tool in OpenClaw's sandbox policy.
    const allowsAll = allow !== undefined && allow.length === 0;
    if (!allowsAll && !allowsHandback([...(allow ?? []), ...(alsoAllow ?? [])])) {
      const agentOwnsList = listOf(agentLists?.["alsoAllow"]) !== undefined && agentPath !== null;
      const path = `${agentOwnsList ? `${agentPath}.` : ""}tools.sandbox.tools.alsoAllow`;
      issues.push({
        message: `Pipbit sessions run in OpenClaw's sandbox (sandbox mode "${mode}"), and its tool list leaves out ${HANDBACK_TOOL_NAME}: the agent cannot hand the person back to Pip, and turns from an unrecognised voice get an answer without it.`,
        fix: `Add "${HANDBACK_TOOL_NAME}" to ${path} in the OpenClaw config.`,
      });
    }
  }

  // An explicit allow list, shared by every agent or the agent's own.
  const globalTools = record(root?.["tools"]);
  const globalAllow = listOf(globalTools?.["allow"]);
  if (globalAllow && globalAllow.length > 0 && !allowsHandback([...globalAllow, ...(listOf(globalTools?.["alsoAllow"]) ?? [])])) {
    issues.push({
      message: `tools.allow leaves out ${HANDBACK_TOOL_NAME}: the agent cannot hand the person back to Pip, and turns from an unrecognised voice get an answer without it.`,
      fix: `Add "${HANDBACK_TOOL_NAME}" to tools.alsoAllow (or to tools.allow) in the OpenClaw config.`,
    });
  }
  const agentTools = record(agent?.["tools"]);
  const agentAllow = listOf(agentTools?.["allow"]);
  if (agentPath && agentAllow && agentAllow.length > 0 && !allowsHandback([...agentAllow, ...(listOf(agentTools?.["alsoAllow"]) ?? [])])) {
    issues.push({
      message: `${agentPath}.tools.allow leaves out ${HANDBACK_TOOL_NAME}: the agent cannot hand the person back to Pip, and turns from an unrecognised voice get an answer without it.`,
      fix: `Add "${HANDBACK_TOOL_NAME}" to ${agentPath}.tools.alsoAllow (or to ${agentPath}.tools.allow) in the OpenClaw config.`,
    });
  }
  return issues;
}

/** Whether a tool policy list lets pipbit_handback through (by name, glob, plugin id or group). */
export function allowsHandback(entries: readonly string[]): boolean {
  const name = HANDBACK_TOOL_NAME;
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "*" || entry === name || entry === CHANNEL_ID || entry === "group:plugins") {
      return true;
    }
    if (!entry.includes("*")) {
      return false;
    }
    const pattern = new RegExp(`^${entry.split("*").map(escapeRegExp).join(".*")}$`);
    return pattern.test(name);
  });
}

/** An agent's config entry: the keyed `agents.entries` form or the older `agents.list`. */
function findAgentEntry(cfg: unknown, agentId: string): Json | undefined {
  const agents = record(record(cfg)?.["agents"]);
  const wanted = agentId.trim().toLowerCase();
  const entries = record(agents?.["entries"]);
  if (entries) {
    for (const [key, value] of Object.entries(entries)) {
      if (key.trim().toLowerCase() === wanted) {
        return record(value);
      }
    }
  }
  const list = agents?.["list"];
  if (Array.isArray(list)) {
    for (const value of list) {
      const entry = record(value);
      if (stringOf(entry?.["id"])?.toLowerCase() === wanted) {
        return entry;
      }
    }
  }
  return undefined;
}

function record(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function listOf(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
