import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  ChannelSetupWizardAdapter,
  OpenClawConfig,
  WizardPrompter,
  WizardProgress,
} from "openclaw/plugin-sdk/setup";
import {
  CHANNEL_ID,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_BASE_URL,
  FALLBACK_DISPLAY_NAME,
  PAIRING_AGENCY_NAME,
  PAIRING_CLIENT_NAME,
  PLUGIN_VERSION,
  type Logger,
  type PairingClaim,
  type PairingCode,
  type PairingFlowOptions,
  type PairingFlowUi,
  type PipbitAccountStateFile,
} from "../shared/contracts.ts";
import { PairingError } from "../shared/errors.ts";
import {
  IDENTITY_FILENAME,
  accountSpokenName,
  applyPairingClaim,
  disablePipbitChannel,
  isAccountPaired,
  readPipbitAccount,
  resolveSpokenName,
  withPipbitSkillOn,
  type OpenClawPaths,
} from "./config.ts";
import { waitForFirstConnect, type WaitOutput } from "./connect-wait.ts";
import {
  ABORTED_LINE,
  ANOTHER_NAME_PLACEHOLDER,
  CHAT_SETUP_LINE,
  CODE_TITLE,
  NO_NAME_LINE,
  NEW_CODE_LEAD,
  NEW_CODE_QUESTION,
  NEW_CODE_TITLE,
  STOPPED_WORD,
  addedLine,
  handoverLine,
  pairingFailureLine,
  refusalWords,
  refusedLine,
  refusedQuestion,
  refusedStopLine,
  replaceQuestion,
  skillBackOnLine,
  waitingLine,
} from "./messages.ts";

// The OpenClaw setup wizard for Pipbit Connect: it shows the platform's
// pairing sentence, waits while the person says it to their Pipbit (Pip
// approves by voice), and saves the claimed credentials into the Gateway
// config. OpenClaw runs the same wizard from the terminal
// (`openclaw channels add pipbit`, `openclaw onboard`) and from the Control
// UI (Channels, then Set up), where each prompt travels to the browser over
// the Gateway's wizard RPC.
//
// It is the imperative form of an OpenClaw setup wizard (a
// ChannelSetupWizardAdapter: getStatus, configure and friends) rather than
// the declarative ChannelSetupWizard, because only the imperative form has a
// hook that runs after the host has written the config (afterConfigWritten).
// The declarative form is wrapped by OpenClaw into an adapter that drops that
// hook (src/channels/plugins/setup-wizard.ts at 2026.9.6), and the wait for
// "Connected" can only start once the config is on disk. The imperative form
// also owns the "already paired" case (configureInteractive), so keeping a
// saved pairing is one question and writes nothing (unless the Pipbit skill
// was switched off, see keepSavedPairing).
//
// The secret goes from the pairing claim straight into the returned config
// and nowhere else: it is never shown, logged, or passed to a prompt.

type ConfigureContext = Parameters<ChannelSetupWizardAdapter["configure"]>[0];
type InteractiveContext = Parameters<NonNullable<ChannelSetupWizardAdapter["configureInteractive"]>>[0];
type PostWriteContext = Parameters<NonNullable<ChannelSetupWizardAdapter["afterConfigWritten"]>>[0];
type StatusContext = Parameters<ChannelSetupWizardAdapter["getStatus"]>[0];
type SetupStatus = Awaited<ReturnType<ChannelSetupWizardAdapter["getStatus"]>>;
type SetupResult = Awaited<ReturnType<ChannelSetupWizardAdapter["configure"]>>;
type SetupOptions = ConfigureContext["options"];

/** Everything the wizard needs from outside; tests pass fakes. */
export interface PipbitSetupWizardDeps {
  /** The pairing flow (src/pairing). Aborting `signal` cancels the pairing on the platform. */
  runPairingFlow(options: PairingFlowOptions): Promise<PairingClaim>;
  /** The account's state file as the channel last wrote it, or null. */
  readAccountState(accountId: string): Promise<PipbitAccountStateFile | null>;
  /** The error that tells OpenClaw the person cancelled (its WizardCancelledError). */
  createCancelledError(message: string): Promise<Error>;
  /**
   * Call `listener` when the process is asked to stop (Ctrl+C) while a code
   * is pending; returns the function that stops listening.
   */
  onInterrupt(listener: () => void): () => void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** `process.versions.node`, sent as `node/<version>` with the pairing start. */
  nodeVersion: string;
  /**
   * The agent OpenClaw routes Pipbit turns to (its own resolveAgentRoute for
   * channel pipbit, account default), or null when routing cannot decide.
   */
  routeAgentId(cfg: OpenClawConfig): Promise<string | null>;
  /** OpenClaw's state, home and default workspace directories. */
  openClawPaths(): Promise<OpenClawPaths>;
  /** The text of `<workspaceDir>/IDENTITY.md`, or null when there is none. */
  readIdentityFile(workspaceDir: string): string | null;
  logger?: Logger;
  /** The wait for "Connected" after the config is saved (see connect-wait.ts). */
  connectWait?: { timeoutMs?: number; connectedMs?: number; pollMs?: number; quietMs?: number };
}

/** What configure leaves for afterConfigWritten: one entry per finished pairing. */
interface FinishedPairing {
  agentName: string;
  displayName: string;
  pairedAtMs: number;
  prompter: WizardPrompter;
  /** The wizard ran on a remote client (the Control UI) inside the Gateway. */
  remote: boolean;
}

/**
 * True when the prompter is a remote client (the Control UI or another app
 * speaking the Gateway's wizard RPC) rather than the terminal. There, a note
 * is a screen with a Continue button that holds the wizard until it is
 * pressed, so the code is shown on a progress screen instead; see showCode.
 * OpenClaw (2026.9.4 and 2026.9.6 alike) marks the Control UI's channel flow
 * with `deferDeviceLinkToClient`, and only its remote prompter implements the
 * optional `deviceCode` method (the wizard never calls it: its wording is a
 * browser sign-in with a phishing warning, which does not fit a spoken code).
 */
export function isRemotePrompter(prompter: WizardPrompter, options?: SetupOptions): boolean {
  return options?.deferDeviceLinkToClient === true || typeof prompter.deviceCode === "function";
}

/**
 * True when OpenClaw's own chat runs this setup ("connect pipbit" in the
 * OpenClaw chat or its TUI; runHostedChannelSetup in src/system-agent at
 * 2026.9.4 and 2026.9.6): a remote prompter, the channel told to ask who
 * may message it (the chat passes forceAllowFromChannels for the channel it
 * sets up, which no other flow does for Pipbit) and no
 * deferDeviceLinkToClient (which marks the Control UI's Channels page). That
 * chat answers every note and progress step by itself and replies only when
 * a question comes up, so a code shown while the pairing waits would reach
 * the person after it had expired.
 */
export function isChatHostedSetup(ctx: Pick<ConfigureContext, "prompter" | "options" | "forceAllowFrom">): boolean {
  return (
    ctx.forceAllowFrom === true &&
    ctx.options?.deferDeviceLinkToClient !== true &&
    typeof ctx.prompter.deviceCode === "function"
  );
}

/** OpenClaw's Back key at a prompt (its WizardNavigationError), matched by name. */
function isNavigation(error: unknown): boolean {
  return error instanceof Error && error.name === "WizardNavigationError";
}

/** The pairing UI over OpenClaw's prompter, plus what the wizard needs to know afterwards. */
interface PairingScreen {
  ui: PairingFlowUi;
  /** The spoken name of the last code shown (the platform's echo of it). */
  lastDisplayName(): string | null;
  /** Stop the progress line, leaving `message` behind when one is given. */
  stop(message?: string): void;
  /** The error a prompt threw (the person cancelled at a prompt), if any. */
  promptError(): unknown;
  /** True when the person left the "another name" question empty. */
  gaveUpOnName(): boolean;
}

function createPairingScreen(params: {
  prompter: WizardPrompter;
  remote: boolean;
  onPromptError: () => void;
}): PairingScreen {
  const { prompter, remote } = params;
  let progress: WizardProgress | null = null;
  let progressText = "";
  let current: PairingCode | null = null;
  let reminted = false;
  let failedPrompt: { error: unknown } | null = null;
  let noName = false;

  const show = (text: string) => {
    if (text === progressText && progress) {
      return;
    }
    progressText = text;
    if (progress) {
      progress.update(text);
    } else {
      progress = prompter.progress(text);
    }
  };
  const stop = (message?: string) => {
    if (progress) {
      progress.stop(message);
      progress = null;
      progressText = "";
    }
  };
  const codeLines = (code: PairingCode): string[] => [
    ...(reminted ? [NEW_CODE_LEAD] : []),
    code.instructions,
    handoverLine(code.displayName),
  ];
  const waitingText = (secondsLeft: number): string => {
    if (!current) {
      return waitingLine(secondsLeft);
    }
    // On a remote client the progress screen is the only thing in view, so
    // it carries the sentence itself. In a terminal the note above the
    // spinner already shows it.
    return remote
      ? [reminted ? NEW_CODE_TITLE : CODE_TITLE, ...codeLines(current), waitingLine(secondsLeft)].join("\n")
      : waitingLine(secondsLeft);
  };
  // A prompt that throws means the person cancelled (Ctrl+C at a terminal
  // prompt, or Cancel in the Control UI while a question was open). Record
  // it and abort the flow so the pending code is withdrawn. Where `onBack`
  // is given, OpenClaw's Back key answers the question instead.
  const guard = async <T>(prompt: () => Promise<T>, onBack?: () => T): Promise<T> => {
    try {
      return await prompt();
    } catch (error) {
      if (onBack && isNavigation(error)) {
        return onBack();
      }
      failedPrompt ??= { error };
      params.onPromptError();
      throw error;
    }
  };

  const ui: PairingFlowUi = {
    async showCode(code, info) {
      if (!current) {
        // A code is live on the platform from here on. OpenClaw's Back key
        // replays the whole setup with its output hidden, which would start
        // codes nobody sees, so Back is switched off (as OpenClaw itself does
        // before a lasting effect).
        prompter.disableBackNavigation?.();
      }
      current = code;
      reminted = info.reminted;
      if (remote) {
        // A note on a remote client waits for Continue before the wizard can
        // go on, and the flow only polls once showCode returns. A person who
        // says the sentence straight away would then be approved while
        // nothing polls, and Pip gives up on the hand-off after about two
        // minutes. The progress screen never waits for a click.
        show(waitingText(code.expiresInS));
        return;
      }
      stop();
      await guard(() => prompter.note(codeLines(code).join("\n"), reminted ? NEW_CODE_TITLE : CODE_TITLE));
      show(waitingText(code.expiresInS));
    },
    onWaiting(secondsLeft) {
      if (current) {
        show(waitingText(secondsLeft));
      }
    },
    async confirmNewCode() {
      stop(STOPPED_WORD);
      // Back at this question means "no new code", never a replay.
      return await guard(
        () => prompter.confirm({ message: NEW_CODE_QUESTION, initialValue: true }),
        () => false,
      );
    },
    async askForAnotherName(message) {
      stop();
      // The flow's notice already asks for another name ("... is reserved
      // for Pipbit's own assistant; choose another name."), so it is the
      // whole question.
      const answer = await guard(() =>
        prompter.text({
          message: message.trim(),
          placeholder: ANOTHER_NAME_PLACEHOLDER,
          validate: (value) => (value.trim().length > 80 ? "Use 80 characters or fewer." : undefined),
        }),
      );
      const name = answer.trim();
      noName = name.length === 0;
      return noName ? null : name;
    },
  };

  return {
    ui,
    lastDisplayName: () => current?.displayName ?? null,
    stop,
    promptError: () => failedPrompt?.error,
    gaveUpOnName: () => noName,
  };
}

/** What setup does about a saved pairing that Pipbit refused for good. */
export type RefusalHandling = "pair_again" | "stop" | "ask";

/**
 * What setup does when the account's state file says Pipbit refused the
 * saved pairing for good (the `hello.error` word, or `revoked` with the
 * `revoked` frame's word as `detail`; SDK/connect_spec/v1/PROTOCOL.md
 * sections 5 and 10.1):
 *
 * - pair_again: the agent is gone from the person's Pipbit (removed by
 *   voice, which the platform reports as grant_revoked; deleted; or Pipbit
 *   Connect switched off for it). A new pairing cannot leave a second agent
 *   with the same name there, so setup says so in one line and pairs.
 * - stop: pairing again would not help. A suspended agent and a transport
 *   mismatch need Pipbit's support; a plugin too old for Pipbit needs an
 *   update. Setup ends with one line saying so and changes nothing.
 * - ask: the agent may still be on the Pipbit (credentials refused, for
 *   example from a clock that is off, or replaced; or a refusal this plugin
 *   cannot place). Setup asks, with "remove <name>" first, and never pairs
 *   again without a yes.
 */
export function refusalHandling(state: Pick<PipbitAccountStateFile, "reason" | "detail">): RefusalHandling {
  const { reason, detail } = refusalWords(state);
  if (reason === "revoked") {
    switch (detail) {
      case "grant_revoked":
      case "deleted":
        return "pair_again";
      case "suspended":
      case "agent_suspended":
        return "stop";
      default:
        return "ask";
    }
  }
  switch (reason) {
    case "connect_not_enabled":
      return "pair_again";
    case "agent_suspended":
    case "transport_mismatch":
    case "protocol_unsupported":
      return "stop";
    default:
      return "ask";
  }
}

function agentDisplayName(claim: PairingClaim): string | null {
  const value = claim.agent["display_name"];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function createPipbitSetupWizard(deps: PipbitSetupWizardDeps): ChannelSetupWizardAdapter {
  const finished = new Map<string, FinishedPairing>();

  async function readStateQuietly(accountId: string): Promise<PipbitAccountStateFile | null> {
    try {
      return await deps.readAccountState(accountId);
    } catch {
      return null;
    }
  }

  /**
   * The spoken name for a new pairing: the name of the OpenClaw agent that
   * will answer Pipbit turns (see resolveSpokenName). Anything that fails on
   * the way leaves that source out; the fallback is "OpenClaw".
   */
  async function spokenNameFor(cfg: OpenClawConfig, agentId: string | undefined, options: SetupOptions): Promise<string> {
    const explicit = agentId?.trim() ? agentId : null;
    let routedAgentId: string | null = null;
    if (!explicit) {
      try {
        routedAgentId = await deps.routeAgentId(cfg);
      } catch {
        routedAgentId = null;
      }
    }
    let paths: OpenClawPaths;
    try {
      paths = await deps.openClawPaths();
    } catch {
      // Without OpenClaw's directories only a configured identity name counts.
      paths = { stateDir: "", homeDir: "", defaultWorkspaceDir: "" };
    }
    return resolveSpokenName(cfg, {
      agentId: explicit,
      routedAgentId,
      ownerWorkspaceDir: options?.workspaceDir ?? null,
      paths,
      readIdentityFile: (dir) => (paths.stateDir || paths.defaultWorkspaceDir ? deps.readIdentityFile(dir) : null),
    });
  }

  async function pair(ctx: ConfigureContext): Promise<SetupResult> {
    const { cfg, prompter, options } = ctx;
    const accountId = DEFAULT_ACCOUNT_ID;
    const account = readPipbitAccount(cfg, accountId);
    const spokenName = await spokenNameFor(cfg, account?.agentId, options);
    const baseUrl = account?.baseUrl?.trim() || DEFAULT_BASE_URL;
    const controller = new AbortController();
    const remote = isRemotePrompter(prompter, options);
    let interrupted = false;

    const screen = createPairingScreen({
      prompter,
      remote,
      onPromptError: () => controller.abort(new Error("setup prompt cancelled")),
    });
    const stopListening = deps.onInterrupt(() => {
      interrupted = true;
      controller.abort(new Error("setup interrupted"));
    });

    let claim: PairingClaim;
    try {
      claim = await deps.runPairingFlow({
        displayName: spokenName,
        baseUrl,
        client: { name: PAIRING_CLIENT_NAME, version: PLUGIN_VERSION, runtime: `node/${deps.nodeVersion}` },
        agencyName: PAIRING_AGENCY_NAME,
        ui: screen.ui,
        // A remote client's Cancel never reaches the flow (the progress
        // screen just goes quiet), so there every new code is asked for:
        // the question throws once the session is gone, which ends the flow
        // at the first expiry instead of minting a code nobody can see.
        ...(remote ? { autoRemint: false } : {}),
        signal: controller.signal,
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
    } catch (error) {
      const promptError = screen.promptError();
      if (promptError !== undefined) {
        // The person cancelled at a prompt; OpenClaw's own error says so.
        screen.stop();
        throw promptError;
      }
      if (interrupted || (error instanceof PairingError && error.reason === "aborted")) {
        screen.stop(ABORTED_LINE);
        throw await deps.createCancelledError(ABORTED_LINE);
      }
      screen.stop(STOPPED_WORD);
      const name = screen.lastDisplayName() ?? spokenName;
      throw new Error(screen.gaveUpOnName() ? NO_NAME_LINE : pairingFailureLine(error, baseUrl, name));
    } finally {
      stopListening();
    }

    const displayName = agentDisplayName(claim) ?? screen.lastDisplayName() ?? spokenName;
    const pairedAtMs = deps.now();
    if (remote) {
      // A progress line on a remote client is replaced by OpenClaw's next
      // screen at once, so the line that asks the person to hurry is a note
      // they click through. It never costs the claim.
      screen.stop();
      try {
        await prompter.note(addedLine(displayName, true), "Pipbit");
      } catch {
        // The session ended; OpenClaw will not save the config either way.
      }
    } else {
      screen.stop(addedLine(displayName));
    }
    const next = applyPairingClaim(cfg, claim, {
      accountId,
      displayName,
      pairedAt: new Date(pairedAtMs).toISOString(),
    });
    finished.set(accountId, { agentName: claim.agentName, displayName, pairedAtMs, prompter, remote });
    return { cfg: next, accountId };
  }

  /**
   * Asked before a new pairing replaces a saved one. Returns false when the
   * saved pairing stays: the person kept it, or pairing again would not
   * help (see refusalHandling).
   */
  async function confirmReplace(cfg: OpenClawConfig, prompter: WizardPrompter): Promise<boolean> {
    const account = readPipbitAccount(cfg, DEFAULT_ACCOUNT_ID);
    if (!isAccountPaired(account)) {
      return true;
    }
    const name = accountSpokenName(account) ?? FALLBACK_DISPLAY_NAME;
    const state = await readStateQuietly(DEFAULT_ACCOUNT_ID);
    if (state && state.link === "failed" && state.agentName === account?.agentName) {
      switch (refusalHandling(state)) {
        case "pair_again":
          // The agent is gone from the person's Pipbit, so there is nothing
          // worth keeping and no duplicate to fear: say so and go on.
          await prompter.note(refusedLine(name, state), "Pipbit");
          return true;
        case "stop":
          await prompter.note(refusedStopLine(name, state), "Pipbit");
          return false;
        case "ask":
          return await prompter.confirm({ message: refusedQuestion(name, state), initialValue: false });
      }
    }
    return await prompter.confirm({ message: replaceQuestion(name), initialValue: false });
  }

  /**
   * What setup returns when the saved pairing stays: nothing to write
   * (null), or the config with the Pipbit skill switched back on. Installs
   * paired with an earlier copy of the plugin can carry a
   * `skills.entries.pipbit.enabled: false` that OpenClaw's doctor wrote
   * before their first pairing (see withPipbitSkillOn); a new pairing
   * removes it, but those installs are already paired, and doctor never
   * removes it. Running setup is the person asking for Pipbit, so a setup
   * that keeps the pairing switches the skill on too, and says so.
   *
   * The result is marked "paused": OpenClaw saves it without the questions
   * that follow a new account (who administers from chat, which agent
   * answers) and without running afterConfigWritten, which has nothing to
   * wait for here.
   */
  async function keepSavedPairing(cfg: OpenClawConfig, prompter: WizardPrompter): Promise<SetupResult | null> {
    const next = withPipbitSkillOn(cfg);
    if (next === cfg) {
      return null;
    }
    const name = accountSpokenName(readPipbitAccount(cfg, DEFAULT_ACCOUNT_ID)) ?? FALLBACK_DISPLAY_NAME;
    await prompter.note(skillBackOnLine(name), "Pipbit");
    return { cfg: next, completion: "paused" };
  }

  return {
    channel: CHANNEL_ID,

    async getStatus(ctx: StatusContext): Promise<SetupStatus> {
      const account = readPipbitAccount(ctx.cfg, DEFAULT_ACCOUNT_ID);
      const configured = isAccountPaired(account);
      if (!configured) {
        return {
          channel: CHANNEL_ID,
          configured: false,
          statusLines: ["Pipbit: not paired yet"],
          selectionHint: "pair by voice",
        };
      }
      const name = accountSpokenName(account) ?? "this agent";
      const state = await readStateQuietly(DEFAULT_ACCOUNT_ID);
      const link = state && state.agentName === account?.agentName ? state.link : null;
      const word =
        link === "connected"
          ? "connected"
          : link === "connecting" || link === "reconnecting"
            ? "reconnecting"
            : link === "failed"
              ? "needs attention"
              : null;
      return {
        channel: CHANNEL_ID,
        configured: true,
        statusLines: [`Pipbit: paired as ${name}${word ? `, ${word}` : ""}`],
        selectionHint: word ?? "paired",
      };
    },

    // Used by setup flows that do not offer configureInteractive.
    async configure(ctx: ConfigureContext): Promise<SetupResult> {
      if (isChatHostedSetup(ctx)) {
        throw new Error(CHAT_SETUP_LINE);
      }
      if (!(await confirmReplace(ctx.cfg, ctx.prompter))) {
        return (await keepSavedPairing(ctx.cfg, ctx.prompter)) ?? { cfg: ctx.cfg };
      }
      return await pair(ctx);
    },

    // OpenClaw's channel setup prefers this hook for both new and configured
    // channels; "skip" leaves the config untouched when the person keeps the
    // saved pairing (no routing questions, nothing written), unless the
    // Pipbit skill has to be switched back on (keepSavedPairing).
    async configureInteractive(ctx: InteractiveContext) {
      if (isChatHostedSetup(ctx)) {
        throw new Error(CHAT_SETUP_LINE);
      }
      if (!(await confirmReplace(ctx.cfg, ctx.prompter))) {
        return (await keepSavedPairing(ctx.cfg, ctx.prompter)) ?? "skip";
      }
      return await pair(ctx);
    },

    async afterConfigWritten(ctx: PostWriteContext): Promise<void> {
      const run = finished.get(ctx.accountId);
      if (!run) {
        return;
      }
      finished.delete(ctx.accountId);
      // Only wait when the committed config really holds this pairing.
      if (readPipbitAccount(ctx.cfg, ctx.accountId)?.agentName !== run.agentName) {
        return;
      }
      if (run.remote) {
        // On a remote client the wizard runs inside the Gateway, where the
        // whole wizard session counts as work in progress, and the Gateway
        // holds every channel reload back until such work is done
        // (src/gateway/server-reload-active-work.ts and
        // server-methods/setup-admission.ts at 2026.9.6). The channel starts
        // only when this session ends, so anything shown or awaited here
        // (a wait, or even a note to click through) delays the very connect
        // it would report. Return at once: if the channel is not online
        // inside Pip's hand-off window (about two minutes from her approval),
        // her approval line has already told the person to ask her to
        // connect them (bridge 7938072).
        return;
      }
      // In a terminal the CLI is its own process, so the Gateway reloads as
      // soon as the file changes, and the wait below can watch it happen.
      // The lines go through the prompter that ran the pairing rather than
      // runtime.log: the prompter is still live here (OpenClaw runs these
      // hooks before its closing message), and it draws the same spinner.
      const output = promptOutput(run.prompter);
      await waitForFirstConnect({
        agentName: run.agentName,
        displayName: run.displayName,
        pairedAtMs: run.pairedAtMs,
        readState: () => deps.readAccountState(ctx.accountId),
        output,
        now: deps.now,
        sleep: deps.sleep,
        ...deps.connectWait,
      });
    },

    disable(cfg: OpenClawConfig): OpenClawConfig {
      return disablePipbitChannel(cfg);
    },
  };
}

function promptOutput(prompter: WizardPrompter): WaitOutput {
  let progress: WizardProgress | null = null;
  return {
    start(label) {
      if (progress) {
        progress.update(label);
      } else {
        progress = prompter.progress(label);
      }
    },
    finish(line) {
      if (progress) {
        progress.stop(line);
        progress = null;
      } else {
        prompter.progress(line).stop(line);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The real dependencies. The pairing flow and the state reader are loaded on
// first use, so loading the setup entry (which OpenClaw does for status and
// channel lists) never pulls in the network code.
// ---------------------------------------------------------------------------

/**
 * Join Ctrl+C (SIGINT) and SIGTERM while a code is pending, but only when
 * something already handles that signal: the first listener on a signal
 * would switch off Node's default exit for it. In a terminal the spinner's
 * own handler is usually there; note that a TTY spinner reads Ctrl+C as a
 * keypress and exits the process itself, so there the code simply lapses
 * (it lives 10 minutes, and without this process's device code nobody can
 * claim it).
 */
function onProcessInterrupt(listener: () => void): () => void {
  const joined: NodeJS.Signals[] = [];
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (process.listenerCount(signal) > 0) {
      process.on(signal, listener);
      joined.push(signal);
    }
  }
  return () => {
    for (const signal of joined) {
      process.off(signal, listener);
    }
  };
}

async function createOpenClawCancelledError(message: string): Promise<Error> {
  try {
    const setup = await import("openclaw/plugin-sdk/setup");
    return new setup.WizardCancelledError(message);
  } catch {
    const error = new Error(message);
    error.name = "WizardCancelledError";
    return error;
  }
}

/** A made-up peer for asking OpenClaw's router which agent answers the channel. */
const ROUTE_PROBE_PEER = { kind: "direct" as const, id: "pipbit-setup" };

/** OpenClaw reads at most 4 MiB of IDENTITY.md (src/agents/identity-file.ts). */
const MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;

/**
 * OpenClaw's default agent workspace for the current environment
 * (resolveDefaultAgentWorkspaceDir in src/agents/workspace-default-path.ts
 * at 2026.9.6).
 */
export function defaultWorkspaceDirFor(env: NodeJS.ProcessEnv, stateDir: string, homeDir: string): string {
  const workspace = env["OPENCLAW_WORKSPACE_DIR"]?.trim();
  if (workspace) {
    return resolve(workspace);
  }
  if (env["OPENCLAW_STATE_DIR"]?.trim()) {
    return join(stateDir, "workspace");
  }
  const profile = env["OPENCLAW_PROFILE"]?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return join(homeDir, `.openclaw-${profile}`, "workspace");
  }
  return join(homeDir, ".openclaw", "workspace");
}

export const defaultSetupWizardDeps: PipbitSetupWizardDeps = {
  async runPairingFlow(options) {
    const pairing = await import("../pairing/index.ts");
    return await pairing.runPairingFlow(options);
  },
  async readAccountState(accountId) {
    const state = await import("../channel/state.ts");
    return await state.readAccountState(await state.resolvePipbitStateDir(), accountId);
  },
  createCancelledError: createOpenClawCancelledError,
  onInterrupt: onProcessInterrupt,
  now: () => Date.now(),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  nodeVersion: process.versions.node,
  async routeAgentId(cfg) {
    try {
      const routing = await import("openclaw/plugin-sdk/routing");
      return routing.resolveAgentRoute({ cfg, channel: CHANNEL_ID, accountId: DEFAULT_ACCOUNT_ID, peer: ROUTE_PROBE_PEER })
        .agentId;
    } catch {
      // Several agents and nothing that picks one (OpenClaw's
      // AgentSelectionRequiredError): routing cannot decide.
      return null;
    }
  },
  async openClawPaths() {
    const paths = await import("openclaw/plugin-sdk/state-paths");
    const stateDir = paths.resolveStateDir(process.env);
    const homeDir = paths.resolveRequiredHomeDir(process.env);
    return { stateDir, homeDir, defaultWorkspaceDir: defaultWorkspaceDirFor(process.env, stateDir, homeDir) };
  },
  readIdentityFile(workspaceDir) {
    try {
      const file = realpathSync(join(workspaceDir, IDENTITY_FILENAME));
      const info = statSync(file);
      if (!info.isFile() || info.size > MAX_IDENTITY_FILE_BYTES) {
        return null;
      }
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  },
};

export const pipbitSetupWizard: ChannelSetupWizardAdapter = createPipbitSetupWizard(defaultSetupWizardDeps);
