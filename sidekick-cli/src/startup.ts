/**
 * Startup side effects, deferred until a command actually runs.
 *
 * These used to execute at module scope in `cli.ts`, so `sidekick --help` and
 * `sidekick --version` both made a network request and bootstrapped account
 * files under the config directory before printing anything.
 */

import { ensureDefaultAccounts } from 'sidekick-shared';
import {
  hydratePricingCatalog,
  loadObservedContextWindows,
  registerModelPricing,
} from 'sidekick-shared/node';
import { recordConfiguredPricing, recordPricingHydration } from './pricingBasis';
import { readPricingConfig } from './utils/cliConfig';

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

/**
 * Register the custom prices in cli-config.json's `pricing` section. Invalid
 * entries are skipped with a warning on stderr; nothing here can fail a run.
 * The registered layer survives catalog hydration, so the order relative to
 * `hydratePricingCatalog` does not matter — only that it precedes pricing.
 */
export function applyConfiguredPricing(
  write: (text: string) => void = (text) => process.stderr.write(text),
): void {
  try {
    const pricing = readPricingConfig();
    for (const warning of pricing.warnings) write(`Warning: ${warning}\n`);
    const entries = Object.keys(pricing.entries).length;
    if (entries > 0) {
      registerModelPricing(pricing.entries, { onlyIfMissing: pricing.onlyIfMissing });
    }
    recordConfiguredPricing({
      entries,
      onlyIfMissing: pricing.onlyIfMissing,
      warnings: pricing.warnings,
    });
  } catch (error) {
    write(
      `Warning: custom prices in cli-config.json were not applied: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
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
export function runStartupSideEffects(
  commandToken: string | undefined,
  options: { accountDoctor?: boolean } = {},
): Promise<void> {
  // Doctor must inspect the original stores, and --fix must ask before any repair.
  if (options.accountDoctor) return Promise.resolve();
  if (started) return started;
  started = (async () => {
    // Context windows a provider reported on an earlier run. Cheap local read,
    // offline-safe, and useful to every command that prices or gauges context.
    void loadObservedContextWindows().catch(() => {
      /* non-fatal; catalog and static tables still work */
    });

    if (!needsFullStartup(commandToken)) return;

    // Before anything is priced: every command that runs full startup prices
    // usage (or can), and they must all apply the same custom prices.
    applyConfiguredPricing();

    // cacheDir defaults to the config dir, which honors SIDEKICK_CONFIG_DIR.
    // The result is kept so report footers and doctor can say how the active
    // prices were obtained (fresh fetch, cache, offline, or not at all).
    const offline = isOfflineRun();
    await Promise.all([
      hydratePricingCatalog({ offline }).then(
        (result) => recordPricingHydration({ state: 'done', result, offline }),
        () => recordPricingHydration({ state: 'failed' }),
      ),
      ensureDefaultAccounts().catch(() => {
        /* non-fatal; account bootstrap must not block startup */
      }),
    ]);
  })();
  return started;
}
