// The Pipbit Connect client, for the channel (src/channel) and the
// conformance harness (conformance/harness.ts). See client.ts for what it
// does and frames.ts for the numbers it plays by.

export { ConnectClient } from "./client.ts";
export { classifyPushResult, frameResultFrom, type FrameResult } from "./classify.ts";
export {
  BACKOFF_BASE_S,
  BACKOFF_CAP_S,
  CANCEL_REASONS,
  CLIENT_CAPABILITIES,
  DEFAULT_ACK_DEADLINE_S,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_PING_INTERVAL_S,
  DEFAULT_PONG_DEADLINE_S,
  DEFAULT_RESULT_WAIT_S,
  FATAL_CLOSE_CODES,
  FATAL_HELLO_ERRORS,
  HANDSHAKE_TIMEOUT_MS,
  HELLO_ACK_TIMEOUT_MS,
  PROTOCOL_VERSIONS,
  PUSH_READY_WAIT_MS,
  PUSH_RESULT_TIMEOUT_MS,
  RESULT_SEND_WAIT_MS,
  SUPERSEDED_HOLDOFF_S,
  SUPERSEDED_JITTER_S,
  TURN_DEDUP_WINDOW_MS,
  buildCancelAck,
  buildHello,
  buildMessageBody,
  buildPing,
  buildPong,
  buildReplyBody,
  buildSilenceBody,
  buildTurnAck,
  buildTurnResult,
  decodeFrame,
  defaultHelloClient,
  newNonce,
  signHello,
  withEnvelope,
  type CancelOutcome,
  type Frame,
  type HelloInput,
  type TurnResultBody,
} from "./frames.ts";
export { createWebSocketFactory } from "./socket.ts";
export { TimerSet } from "./timers.ts";
export {
  ConnectTurnRequest,
  normalizeHandlerResult,
  parseTurnPayload,
  type NormalizedOutcome,
  type ParsedTurn,
  type TurnControl,
} from "./turn.ts";
