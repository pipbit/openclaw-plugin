// The Pipbit plugin's doctor contract, for OpenClaw's Doctor and its plugin
// installer.
//
// When OpenClaw's upgrade checks run while this plugin is configured but
// cannot be loaded (0.1.0 on OpenClaw 2026.10, whose plugin API it did not
// admit), OpenClaw records a pending "data/settings upgrade" for it. Doctor
// and the installer clear that record only for an external channel plugin
// that declares what it migrates. For one that declares nothing it stays
// pending for good, and from then on OpenClaw refuses to install or update
// the plugin over it ("Plugin config repair could not be inspected").
// openclaw.plugin.json declares `doctorContract` with `stateMigrations: []`
// and `configRepair: true`, and OpenClaw loads this module (built to
// dist/doctor-contract-api.js) for the code behind the declaration.
//
// The plugin has nothing for OpenClaw to migrate: its config under
// `channels.pipbit` keeps one shape, and its only state is its own JSON
// file per account in the state directory, which it reads and writes
// itself. So there are no state migrations, and the config normalizer
// changes nothing. The normalizer still has to exist: a record that kept
// plugin config (`plugins.entries.pipbit.config`, or the host's
// `session.store`) asks for a config repair before the install goes ahead.
//
// The manifest's `stateMigrations` must stay equal to the list below. Keep
// this module free of imports and side effects: OpenClaw also loads it
// outside Doctor (at every Gateway start on 2026.9.4 and 9.6, and while the
// plugin is disabled). Because the manifest declares `configRepair`,
// OpenClaw 2026.9.36 and later refuse to install or update the plugin
// whenever they cannot load this module and find its normalizer.

/** No state migrations: the manifest declares `stateMigrations: []`. */
export const stateMigrations: readonly never[] = [];

/**
 * OpenClaw's compatibility pass over the config: returns it unchanged with
 * no changes, so Doctor and the installer have nothing to apply. `changes`
 * must stay an array (OpenClaw reads its length; a throw aborts the install).
 */
export function normalizeCompatibilityConfig<T>(params: { cfg: T }): { config: T; changes: string[] } {
  return { config: params.cfg, changes: [] };
}
