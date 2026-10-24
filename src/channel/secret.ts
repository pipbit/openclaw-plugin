// Reading the agent secret out of the config at the moment the link starts.
//
// The config may hold it three ways (OpenClaw's SecretInput): a plain
// string, a `${ENV_VAR}` reference, or a SecretRef object. OpenClaw already
// substitutes `${VAR}` in config strings when it loads the file, so the
// substitution here is a second chance, not the main path. A SecretRef from
// any source (env, file, exec, a secret store) is resolved by the Gateway
// before the account starts, because the package ships a channel secret
// contract (secret-contract-api.ts) naming the secret's config paths; the
// account then arrives holding the resolved string. Here an `env` SecretRef
// is also read directly, and any other one that still arrives unresolved
// (it could not be read) makes the account read Needs attention.
//
// The value is returned to the caller and nowhere else: never logged, never
// put in a status, never in an error message.

import type { SecretInput } from "../shared/contracts.ts";
import { MESSAGES } from "./status.ts";

export type SecretResolution = { ok: true; value: string } | { ok: false; message: string };

const WHOLE_ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$|^\$([A-Z_][A-Z0-9_]*)$/;
const EMBEDDED_ENV_REFERENCE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function resolveSecretValue(secret: SecretInput | null | undefined, env: NodeJS.ProcessEnv = process.env): SecretResolution {
  if (secret === null || secret === undefined) {
    return { ok: false, message: MESSAGES.notSetUp };
  }
  if (typeof secret === "string") {
    return resolveSecretString(secret, env);
  }
  if (typeof secret === "object" && typeof secret.id === "string") {
    if (secret.source === "env") {
      return fromEnv(secret.id, env);
    }
    return { ok: false, message: MESSAGES.secretUnreadable };
  }
  return { ok: false, message: MESSAGES.secretUnreadable };
}

function resolveSecretString(raw: string, env: NodeJS.ProcessEnv): SecretResolution {
  const value = raw.trim();
  if (value === "") {
    return { ok: false, message: MESSAGES.notSetUp };
  }
  const whole = WHOLE_ENV_REFERENCE.exec(value);
  if (whole) {
    return fromEnv(whole[1] ?? whole[2] ?? "", env);
  }
  let missing = false;
  const substituted = value.replace(EMBEDDED_ENV_REFERENCE, (_match, name: string) => {
    const found = env[name];
    if (typeof found !== "string" || found.trim() === "") {
      missing = true;
      return "";
    }
    return found.trim();
  });
  if (missing || substituted.trim() === "") {
    return { ok: false, message: MESSAGES.secretUnreadable };
  }
  return { ok: true, value: substituted.trim() };
}

function fromEnv(name: string, env: NodeJS.ProcessEnv): SecretResolution {
  const found = name ? env[name] : undefined;
  if (typeof found !== "string" || found.trim() === "") {
    return { ok: false, message: MESSAGES.secretUnreadable };
  }
  return { ok: true, value: found.trim() };
}
