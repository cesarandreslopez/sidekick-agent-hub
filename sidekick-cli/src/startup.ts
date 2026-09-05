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

/**
 * Whether this run must never refresh the pricing catalog over the network.
 *
 * `--offline` on the command line or `SIDEKICK_OFFLINE=1` in the environment.
 * The flag is read from argv directly because startup runs before Commander
 * has parsed options.
 */
export function isOfflineRun(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes('--offline')) return true;
  const value = env.SIDEKICK_OFFLINE;
  return value === '1' || value === 'true';
}

let started: Promise<void> | null = null;

/** Reset the memoised run. Test-only. */
export function _resetStartupForTests(): void {
  started = null;
}

/**
 * Run the startup side effects once, awaiting what a command depends on.
 *
 * The pricing catalog is awaited so that every figure a command prints is
 * priced from the same catalog. Hydration is bounded: a fresh on-disk cache is
 * a local read, and a refresh is capped by the catalog's own 3 s network
 * timeout before falling back to the cached or static tables. Before this was
 * awaited, a command that finished quickly could price from the static table
 * while the next run priced from LiteLLM rates, so the same session reported
 * two different costs.
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
    await Promise.all([
      hydratePricingCatalog({ offline: isOfflineRun() }).catch(() => {
        /* non-fatal; static table still works */
      }),
      ensureDefaultAccounts().catch(() => {
        /* non-fatal; account bootstrap must not block startup */
      }),
    ]);
  })();
  return started;
}
