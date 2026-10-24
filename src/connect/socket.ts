import WebSocket from "ws";

import type { WebSocketFactory, WebSocketLike } from "../shared/contracts.ts";

// The one place the client touches the `ws` package. Everything else speaks
// WebSocketLike (src/shared/contracts.ts), so the tests can hand the client
// a scripted fake instead.

/**
 * Dial with `ws`: the subprotocol list, an upgrade timeout, a cap on the
 * size of any frame the server sends (a bigger one closes the socket with
 * 1009, which the client treats as an ordinary drop), and one User-Agent
 * header naming this client. No other header is sent: the agent secret
 * never leaves the hello proof.
 */
export function createWebSocketFactory(userAgent: string): WebSocketFactory {
  return (url, protocols, options): WebSocketLike => {
    const socket = new WebSocket(url, protocols, {
      handshakeTimeout: options.handshakeTimeoutMs,
      maxPayload: options.maxPayloadBytes,
      headers: { "User-Agent": userAgent },
    });
    return socket;
  };
}
