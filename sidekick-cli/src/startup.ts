/**
 * Startup side effects, deferred until a command actually runs.
 *
 * These used to execute at module scope in `cli.ts`, so `sidekick --help` and
 * `sidekick --version` both made a network request and bootstrapped account
 * files under the config directory before printing anything.
 */

import { ensureDefaultAccounts } from 'sidekick-shared';
import { hydratePricingCatalog, loadObservedContextWindows } from 'sidekick-shared/node';

/** Commands that answer purely from cached local state. */
const CACHE_ONLY_COMMANDS = new Set(['statusline', 'today', 'history']);

/**
 * Whether this invocation needs the pricing catalog and account bootstrap.
 *
 * False for a bare invocation, for flag-only invocations (`--help`,
 * `--version`), and for the cache-only commands, which are expected to be fast
 * and offline — `statusline` runs on every shell prompt.
 */
export function needsFullStartup(commandToken: string | undefined): boolean {
  if (commandToken === undefined) return false;
  if (commandToken.startsWith('-')) return false;
  return !CACHE_ONLY_COMMANDS.has(commandToken);
}

let started: Promise<void> | null = null;

/** Reset the memoised run. Test-only. */
export function _resetStartupForTests(): void {
  started = null;
}

/**
 * Run the startup side effects once, awaiting only what a command depends on.
 *
 * Resolves when account bootstrap is done. The pricing catalog is deliberately
 * left unawaited so it warms in parallel with the command rather than delaying
 * it — a stale or missing catalog falls back to the static price table.
 */
export function runStartupSideEffects(commandToken: string | undefined): Promise<void> {
  if (started) return started;
  started = (async () => {
    // Context windows a provider reported on an earlier run. Cheap local read,
    // offline-safe, and useful to every command that prices or gauges context.
    void loadObservedContextWindows().catch(() => {
      /* non-fatal; catalog and static tables still work */
    });

    if (!needsFullStartup(commandToken)) return;

    // cacheDir defaults to the config dir, which honors SIDEKICK_CONFIG_DIR.
    void hydratePricingCatalog().catch(() => {
      /* non-fatal; static table still works */
    });

    await ensureDefaultAccounts().catch(() => {
      /* non-fatal; account bootstrap must not block startup */
    });
  })();
  return started;
}
