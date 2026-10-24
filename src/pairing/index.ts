// src/pairing: the agent pairing routes, the name rules, and the spoken
// pairing loop built on them. Knows nothing about OpenClaw; the setup
// wizard (src/setup) drives runPairingFlow with its own PairingFlowUi.

export {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_PATTERN,
  DERIVED_NAME_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  NAME_SUFFIX_LENGTH,
  RESERVED_AGENT_NAMES,
  agentNameFromDisplay,
  checkDisplayName,
  isReservedName,
  isValidAgentName,
  tidyDisplayName,
  withNameSuffix,
} from "./names.ts";
export type { NameCheck, NameProblem } from "./names.ts";

export {
  DEFAULT_EXPIRES_IN_S,
  DEFAULT_INTERVAL_S,
  PAIRING_HTTP_TIMEOUT_MS,
  PAIRING_USER_AGENT,
  PendingPairing,
  buildStartBody,
  cancelPairing,
  classifyPairingAnswer,
  groupUserCode,
  pollPairing,
  startPairing,
} from "./http.ts";
export type {
  CancelOutcome,
  PairingAnswer,
  PairingRequestOptions,
  PollOutcome,
  StartPairingOptions,
  StartPairingRequest,
} from "./http.ts";

export { MAX_NAME_TRIES, MAX_STARTS_PER_FLOW, RATE_LIMITED_MESSAGE, runPairingFlow } from "./flow.ts";
export { defaultPairingClient } from "./client-info.ts";
