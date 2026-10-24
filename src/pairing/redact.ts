// Keeping codes and the secret out of logs, internal to src/pairing.
//
// The pairing objects the rest of the plugin handles carry things that must
// never be printed: the pairing code (in PairingCode, three times over:
// userCode, userCodeDisplay and the instructions sentence) and the agent
// secret (in PairingClaim). The fields stay readable, because the wizard has
// to show the sentence and store the secret, but an accidental
// `JSON.stringify(code)` or `console.log(claim)` prints a summary without
// them. The two hooks are non-enumerable, so spreading or comparing the
// objects sees only their real fields.

import { inspect } from "node:util";

/**
 * Give `target` a toJSON and a Node inspect hook that both show `summary()`
 * instead of the object's fields. Returns `target`.
 */
export function withRedactedView<T extends object>(target: T, label: string, summary: () => Record<string, unknown>): T {
  Object.defineProperty(target, "toJSON", {
    value: () => summary(),
    enumerable: false,
    configurable: true,
    writable: false,
  });
  Object.defineProperty(target, inspect.custom, {
    value: () => `${label} ${inspect(summary())}`,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return target;
}

/**
 * `text` with every occurrence of each non-empty string in `secrets`
 * replaced by a placeholder. Used on platform messages before they become
 * an error's message: the platform never echoes a code today, and this makes
 * sure a future wording cannot put one into a log line.
 */
export function scrub(text: string, secrets: readonly (string | null | undefined)[]): string {
  let result = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result;
}
