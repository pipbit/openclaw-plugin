// The Pipbit channel's secret contract, for OpenClaw's secret tools.
//
// OpenClaw learns which config paths of an external channel hold secrets
// only from this module, which it looks for as `secret-contract-api` under
// the package's dist/ (built from this file) or its root. With it,
// `openclaw secrets audit` reports a plaintext Pipbit secret, `openclaw
// secrets configure` can move it into a SecretRef, and the Gateway resolves
// a SecretRef from any source (env, file, exec, a secret store) before the
// channel starts. Without it, only the env form worked (src/channel/secret.ts).
//
// Which secret is in use follows the channel's own account rules
// (src/channel/base.ts): `channels.pipbit.secret` belongs to the default
// account unless `accounts.default` has a secret of its own, and a named
// account never inherits it; `channels.pipbit.accounts.<id>.secret` belongs
// to that account. A disabled channel or account leaves its secret unused.
// A secret that cannot be resolved affects only its own account, never the
// Gateway's start.

import {
  collectSecretInputAssignment,
  createChannelSecretTargetRegistryEntries,
  getChannelRecord,
  hasOwnProperty,
  isRecord,
  type ResolverContext,
  type SecretDefaults,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { CHANNEL_ID, DEFAULT_ACCOUNT_ID } from "./src/shared/contracts.ts";

const FIELD = "secret";

export const secretTargetRegistryEntries = createChannelSecretTargetRegistryEntries({
  channelKey: CHANNEL_ID,
  account: [FIELD],
  channel: [FIELD],
});

type AssignmentOwner = NonNullable<Parameters<typeof collectSecretInputAssignment>[0]["owner"]>;

/** One owner per account, so a secret that fails to resolve degrades only that account. */
function ownerFor(accountId: string, channel: Record<string, unknown>, account: Record<string, unknown>): AssignmentOwner {
  const { accounts: _accounts, ...channelDefaults } = channel;
  return {
    ownerKind: "account",
    ownerId: `${CHANNEL_ID}:${accountId.trim().toLowerCase()}`,
    requiredForGateway: false,
    disposition: "isolate",
    contract: { channel: channelDefaults, account },
  } as AssignmentOwner;
}

/** OpenClaw's config path for an account id (quoted when it is not a plain word). */
function accountPath(accountId: string): string {
  const base = `channels.${CHANNEL_ID}.accounts`;
  return /^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(accountId) ? `${base}.${accountId}` : `${base}[${JSON.stringify(accountId)}]`;
}

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const channel = getChannelRecord(params.config, CHANNEL_ID);
  if (!channel) {
    return;
  }
  const channelEnabled = channel["enabled"] !== false;
  const accounts = isRecord(channel["accounts"]) ? channel["accounts"] : {};
  const ownDefault = isRecord(accounts[DEFAULT_ACCOUNT_ID]) ? accounts[DEFAULT_ACCOUNT_ID] : undefined;

  if (hasOwnProperty(channel, FIELD)) {
    const shadowed = ownDefault !== undefined && hasOwnProperty(ownDefault, FIELD);
    const defaultDisabled = ownDefault !== undefined && ownDefault["enabled"] === false;
    collectSecretInputAssignment({
      value: channel[FIELD],
      path: `channels.${CHANNEL_ID}.${FIELD}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: channelEnabled && !shadowed && !defaultDisabled,
      inactiveReason: !channelEnabled
        ? "the Pipbit channel is disabled."
        : shadowed
          ? "accounts.default has a secret of its own."
          : "the default Pipbit account is disabled.",
      owner: ownerFor(DEFAULT_ACCOUNT_ID, channel, ownDefault ?? {}),
      apply: (value) => {
        channel[FIELD] = value;
      },
    });
  }

  for (const [accountId, account] of Object.entries(accounts)) {
    if (!isRecord(account) || !hasOwnProperty(account, FIELD)) {
      continue;
    }
    collectSecretInputAssignment({
      value: account[FIELD],
      path: `${accountPath(accountId)}.${FIELD}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: channelEnabled && account["enabled"] !== false,
      inactiveReason: channelEnabled ? "this Pipbit account is disabled." : "the Pipbit channel is disabled.",
      owner: ownerFor(accountId, channel, account),
      apply: (value) => {
        account[FIELD] = value;
      },
    });
  }
}

export const channelSecrets = {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
