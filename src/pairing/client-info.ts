// The `client` block a pairing start carries. Pip reads its name aloud when
// the person did not say the agent's name ("that code is for Clementine from
// OpenClaw"), so the name is the speakable PAIRING_CLIENT_NAME, not the
// package name the hello uses.

import type { ClientInfo } from "../shared/contracts.ts";
import { PAIRING_CLIENT_NAME, PLUGIN_VERSION } from "../shared/contracts.ts";

/** `{name: "OpenClaw", version: "0.1.0", runtime: "node/24.21.0"}`. */
export function defaultPairingClient(): ClientInfo {
  return {
    name: PAIRING_CLIENT_NAME,
    version: PLUGIN_VERSION,
    runtime: `node/${process.versions.node}`,
  };
}
