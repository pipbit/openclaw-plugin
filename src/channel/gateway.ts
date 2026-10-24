// Running one paired Pipbit agent inside the OpenClaw Gateway.
//
// OpenClaw calls `startAccount` for each configured account and expects the
// returned promise to stay pending for as long as the account runs: if it
// settles, OpenClaw's channel supervisor restarts the account with backoff,
// unless the account's status says `terminalDisconnect` (then it logs
// "auto-restart skipped, terminal disconnect" and leaves it alone). So:
//
//   - the link is up, down or redialling: stay pending (the Connect client
//     does its own reconnecting);
//   - the Gateway stops the account (abortSignal): stop the client, return;
//   - Pipbit refused the agent for good (removed, bad credentials, ...):
//     publish Needs attention with terminalDisconnect and return, so nothing
//     redials until the person runs Set up again.
//
// Every link change is also written to the account's state file (state.ts)
// for the setup wizard and the CLI status line, and the file is deleted
// when the account stops because it was removed from the config.

import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { ChannelAccountSnapshot, ChannelGatewayContext, ChannelLogSink } from "openclaw/plugin-sdk/channel-contract";
import {
  CHANNEL_ID,
  HELLO_CLIENT_NAME,
  PLUGIN_VERSION,
  type ConnectClientApi,
  type ConnectClientOptions,
  type LinkState,
  type Logger,
} from "../shared/contracts.ts";
import { resolvePipbitAccount, type ResolvedPipbitAccount } from "./base.ts";
import { isAgentSelectionRequired } from "./config-checks.ts";
import { createTurnHandler, errorSummary, PIPBIT_DM_SCOPE, type PipbitTurnHandler } from "./inbound.ts";
import { registerRunningAccount, type RunningAccount } from "./registry.ts";
import { tryGetPipbitRuntime } from "./runtime.ts";
import { resolveSecretValue } from "./secret.ts";
import {
  AccountStateWriter,
  emptyAccountState,
  readAccountState,
  removeAccountState,
  resolvePipbitStateDir,
} from "./state.ts";
import { blockedStatusPatch, describeReconnect, isNewDisconnect, MESSAGES, statusPatchForLinkState } from "./status.ts";

/** Builds the Connect client; the plugin passes the real one, tests a fake. */
export type ConnectClientFactory = (options: ConnectClientOptions) => ConnectClientApi;

export interface PipbitGatewayOptions {
  createClient: ConnectClientFactory;
  /** Where the state files live; OpenClaw's state dir by default. */
  stateDir?: () => string;
  /** Environment for `${VAR}` secrets; process.env by default. */
  env?: () => NodeJS.ProcessEnv;
  /** OpenClaw's runtime when the context carries no channel runtime. */
  runtime?: () => PluginRuntime | null;
  now?: () => number;
  /** Least time between two transport-activity status updates (ms). */
  activityThrottleMs?: number;
  /** How long `stop` waits for the client (ms); OpenClaw allows about 5 s. */
  stopTimeoutMs?: number;
}

type GatewayAdapter = NonNullable<ChannelPlugin<ResolvedPipbitAccount>["gateway"]>;
type GatewayContext = ChannelGatewayContext<ResolvedPipbitAccount>;
type ChannelRuntime = PluginRuntime["channel"];

const DEFAULT_ACTIVITY_THROTTLE_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 4_000;

export function createPipbitGatewayAdapter(options: PipbitGatewayOptions): GatewayAdapter {
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? (() => process.env);
  const stateDirOf = options.stateDir ?? (() => resolvePipbitStateDir());
  const activityThrottleMs = options.activityThrottleMs ?? DEFAULT_ACTIVITY_THROTTLE_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const stopping = new WeakMap<ConnectClientApi, Promise<void>>();
  const running = new Map<string, { entry: RunningAccount; handler: PipbitTurnHandler }>();

  const stopClient = (client: ConnectClientApi, logger: Logger): Promise<void> => {
    let promise = stopping.get(client);
    if (!promise) {
      promise = Promise.resolve()
        .then(() => client.stop(stopTimeoutMs))
        .catch((error: unknown) => {
          logger.warn(`pipbit: stopping the link failed: ${errorSummary(error)}`);
        });
      stopping.set(client, promise);
    }
    return promise;
  };

  const channelRuntimeFor = (ctx: GatewayContext): ChannelRuntime => {
    const fromContext = ctx.channelRuntime as unknown as Partial<ChannelRuntime> | undefined;
    if (fromContext?.inbound?.dispatch && fromContext.routing?.resolveAgentRoute) {
      return fromContext as ChannelRuntime;
    }
    const runtime = options.runtime?.() ?? tryGetPipbitRuntime();
    if (!runtime) {
      throw new Error("OpenClaw's channel runtime is not available to the Pipbit channel.");
    }
    return runtime.channel;
  };

  const configFor = (ctx: GatewayContext): OpenClawConfig => {
    const runtime = options.runtime?.() ?? tryGetPipbitRuntime();
    try {
      const live = runtime?.config?.current?.();
      if (live) {
        return live as OpenClawConfig;
      }
    } catch {
      // Fall back to the config the account was started with.
    }
    return ctx.cfg;
  };

  const startAccount = async (ctx: GatewayContext): Promise<void> => {
    const accountId = ctx.accountId;
    const logger = toLogger(ctx.log);
    const setStatus = (patch: ChannelAccountSnapshot): void => {
      try {
        ctx.setStatus(patch);
      } catch (error) {
        logger.warn(`pipbit: could not publish status: ${errorSummary(error)}`);
      }
    };

    const account = ctx.account;
    if (!account || !account.configured || !account.agentName) {
      setStatus(blockedStatusPatch(accountId, MESSAGES.notSetUp));
      logger.warn(`pipbit: account ${accountId} is not set up; not connecting`);
      return;
    }
    const agentName = account.agentName;
    const secret = resolveSecretValue(account.secret, env());
    if (!secret.ok) {
      setStatus(blockedStatusPatch(accountId, secret.message));
      logger.warn(`pipbit: account ${accountId} has no usable secret; not connecting`);
      return;
    }
    if (ctx.abortSignal.aborted) {
      return;
    }

    const stateDir = stateDirOf();
    const prior = await readAccountState(stateDir, accountId).catch(() => null);
    const samePairing = prior !== null && prior.agentName === agentName;
    const writer = new AccountStateWriter({
      stateDir,
      initial: samePairing ? prior : emptyAccountState(accountId, agentName, new Date(now())),
      now: () => new Date(now()),
      onError: (error) => logger.warn(`pipbit: could not write the state file: ${errorSummary(error)}`),
    });

    const entry: RunningAccount = {
      accountId,
      agentName,
      agentId: normalizeAgentId(account.agentId),
      routedAgentId: null,
      ownerSubjectId: samePairing ? prior.ownerSubjectId : null,
      client: null,
      link: "connecting",
    };
    // Which OpenClaw agent answers for this account, known before any turn
    // arrives, so the speak tool never lends the account to another agent
    // while it is unknown (tools.ts).
    if (entry.agentId === null) {
      try {
        const route = channelRuntimeFor(ctx).routing.resolveAgentRoute({
          cfg: configFor(ctx),
          channel: CHANNEL_ID,
          accountId,
          ...(entry.ownerSubjectId ? { peer: { kind: "direct" as const, id: entry.ownerSubjectId } } : {}),
          dmScope: PIPBIT_DM_SCOPE,
        });
        entry.routedAgentId = normalizeAgentId(route.agentId);
      } catch (error) {
        if (isAgentSelectionRequired(error)) {
          logger.warn(
            `pipbit: account ${accountId}: OpenClaw has several agents and none is set to answer on Pipbit, so its turns go unanswered until the account names its agent (the Pipbit status names the config line)`,
          );
        } else {
          // The route was asked with the owner's subject id as the peer, so
          // the error may quote it.
          const owner = entry.ownerSubjectId;
          logger.warn(
            `pipbit: account ${accountId}: could not tell which agent answers yet: ${errorSummary(error, owner ? [owner, owner.toLowerCase()] : [])}`,
          );
        }
      }
    }
    const unregister = registerRunningAccount(entry);

    let lastActivityAt = 0;
    const handler = createTurnHandler({
      accountId,
      agentId: account.agentId,
      channelRuntime: () => channelRuntimeFor(ctx),
      config: () => configFor(ctx),
      client: () => entry.client,
      logger,
      onOwner: (subjectId) => {
        if (entry.ownerSubjectId !== subjectId) {
          entry.ownerSubjectId = subjectId;
          void writer.update({ ownerSubjectId: subjectId });
        }
      },
      onRouted: (agentId) => {
        entry.routedAgentId = normalizeAgentId(agentId);
      },
      onGreeting: (greeting) => {
        void writer.update({ lastIntroAt: new Date(now()).toISOString(), lastGreeting: greeting });
      },
      onInbound: () => setStatus({ accountId, lastInboundAt: now() }),
      onOutbound: () => setStatus({ accountId, lastOutboundAt: now() }),
      now,
    });
    running.set(accountId, { entry, handler });

    // Kept in an object: the closures below update it, and TypeScript does
    // not track assignments made inside callbacks.
    const link: { previous: LinkState | null; reconnectAttempts: number } = { previous: null, reconnectAttempts: 0 };
    let finish: (outcome: "aborted" | "failed") => void = () => {};
    const finished = new Promise<"aborted" | "failed">((resolve) => {
      finish = resolve;
    });

    const onStateChange = (state: LinkState): void => {
      try {
        const previous = link.previous;
        if (previous?.state === "failed") {
          // A refused client never dials again; its later "stopped" report
          // must not hide the refusal from the status line or the state file.
          return;
        }
        if (state.state === "connected") {
          link.reconnectAttempts = 0;
        } else if (state.state === "reconnecting") {
          const redial =
            previous?.state !== "reconnecting" ||
            (state.nextDialAtMs !== null && state.nextDialAtMs !== previous.nextDialAtMs);
          if (redial) {
            link.reconnectAttempts += 1;
          }
        }
        const patch = statusPatchForLinkState(state, {
          accountId,
          now: now(),
          previous,
          reconnectAttempts: link.reconnectAttempts,
        });
        if (state.state === "reconnecting" && isNewDisconnect(state, previous)) {
          // The plain words for why: OpenClaw's status commands drop the
          // stateReason of a running account, so the Gateway log carries them.
          logger.info(`pipbit: account ${accountId} is reconnecting: ${describeReconnect(state)}`);
        }
        link.previous = { ...state };
        entry.link = state.state;
        setStatus(patch);
        void writer.update({ agentName, link: state.state, reason: state.reason, detail: state.detail });
        if (state.state === "failed") {
          finish("failed");
        }
      } catch (error) {
        logger.warn(`pipbit: could not record a link change: ${errorSummary(error)}`);
      }
    };

    const onActivity = (): void => {
      const time = now();
      if (time - lastActivityAt < activityThrottleMs) {
        return;
      }
      lastActivityAt = time;
      setStatus({ accountId, lastTransportActivityAt: time });
    };

    const onAbort = (): void => finish("aborted");
    ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

    let client: ConnectClientApi | null = null;
    let removeStateFile = false;
    try {
      setStatus({ accountId, running: true, connected: false, lifecycle: "starting", stateReason: "Connecting" });
      void writer.update({ agentName, link: "connecting", reason: null, detail: null });
      client = options.createClient({
        agent: agentName,
        secret: secret.value,
        connectUrl: account.connectUrl,
        handler: handler.handle,
        client: { name: HELLO_CLIENT_NAME, version: PLUGIN_VERSION, runtime: `node/${process.versions.node}` },
        logger,
        onStateChange,
        onActivity,
      });
      entry.client = client;
      if (ctx.abortSignal.aborted) {
        finish("aborted");
      } else {
        client.start();
      }

      const outcome = await finished;
      await stopClient(client, logger);
      if (outcome === "failed") {
        logger.warn(
          `pipbit: account ${accountId} stopped for good (${link.previous?.reason ?? "refused"}); it needs Set up again`,
        );
      } else if (entry.link !== "stopped" && entry.link !== "failed") {
        entry.link = "stopped";
        void writer.update({ link: "stopped" });
      }
      if (outcome === "aborted") {
        removeStateFile = isRemovedFromConfig(configFor(ctx), accountId);
      }
    } finally {
      ctx.abortSignal.removeEventListener("abort", onAbort);
      handler.abortAll();
      running.delete(accountId);
      unregister();
      await writer.flush();
      if (removeStateFile) {
        // Stopped because the account was deleted (lifecycle.onAccountRemoved
        // may already have deleted the file; the stop just wrote it again).
        await removeAccountState(stateDir, accountId).catch((error: unknown) => {
          logger.warn(`pipbit: could not delete the state file: ${errorSummary(error)}`);
        });
      }
    }
    const verdict = link.previous;
    if (verdict?.state === "failed") {
      // Re-publish the verdict last, so nothing published during the stop
      // can hide it.
      setStatus(
        statusPatchForLinkState(verdict, { accountId, now: now(), previous: verdict, reconnectAttempts: link.reconnectAttempts }),
      );
    }
  };

  const stopAccount = async (ctx: GatewayContext): Promise<void> => {
    const current = running.get(ctx.accountId);
    const client = current?.entry.client;
    if (client) {
      await stopClient(client, toLogger(ctx.log));
    }
  };

  return { startAccount, stopAccount };
}

/** True when the live config no longer holds any pairing under this account id. */
function isRemovedFromConfig(cfg: OpenClawConfig, accountId: string): boolean {
  const account = resolvePipbitAccount(cfg, accountId);
  return account.accountId === accountId && account.agentName === null && account.secret === null;
}

/** OpenClaw agent ids are case-insensitive; compare them lowercased. */
export function normalizeAgentId(agentId: string | null | undefined): string | null {
  const trimmed = typeof agentId === "string" ? agentId.trim().toLowerCase() : "";
  return trimmed === "" ? null : trimmed;
}

/** Adapt OpenClaw's log sink (debug optional) to the plugin's Logger. */
export function toLogger(sink: ChannelLogSink | undefined): Logger {
  return {
    debug: (message) => sink?.debug?.(message),
    info: (message) => sink?.info(message),
    warn: (message) => sink?.warn(message),
    error: (message) => sink?.error(message),
  };
}
