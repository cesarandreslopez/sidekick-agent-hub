/**
 * What priced this run's figures: the active pricing tables (from
 * `getPricingCatalogInfo()`), how startup obtained them, and the custom prices
 * cli-config.json registered. Report footers, `--json` output, and `doctor`
 * all describe the basis through this module, so they agree with each other
 * and with the prices actually applied, including runs that never hydrated
 * the catalog.
 */

import { formatQuotaAge, getPricingCatalogInfo } from 'sidekick-shared';
import type { PricingCatalogInfo } from 'sidekick-shared';
import type { HydrateResult } from 'sidekick-shared/node';

/** How this run's startup obtained the pricing catalog. */
export type PricingHydration =
  | { state: 'not-run' }
  | { state: 'failed' }
  | { state: 'done'; result: HydrateResult; offline: boolean };

/** Custom prices cli-config.json registered at startup. */
export interface ConfiguredPricing {
  entries: number;
  onlyIfMissing: boolean;
  warnings: string[];
}

let hydration: PricingHydration = { state: 'not-run' };
let configured: ConfiguredPricing = { entries: 0, onlyIfMissing: false, warnings: [] };

export function recordPricingHydration(value: PricingHydration): void {
  hydration = value;
}

export function getPricingHydration(): PricingHydration {
  return hydration;
}

export function recordConfiguredPricing(value: ConfiguredPricing): void {
  configured = value;
}

export function getConfiguredPricing(): ConfiguredPricing {
  return configured;
}

/** Test-only. */
export function _resetPricingBasisForTests(): void {
  hydration = { state: 'not-run' };
  configured = { entries: 0, onlyIfMissing: false, warnings: [] };
}

function fetchedAgo(info: PricingCatalogInfo, now: number): string {
  const at = info.fetchedAt ? Date.parse(info.fetchedAt) : NaN;
  return Number.isFinite(at) ? `fetched ${formatQuotaAge(Math.max(0, now - at))}` : '';
}

/**
 * The active price tables in a phrase: `LiteLLM catalog, fetched 2h ago`,
 * `stale LiteLLM cache, fetched 3d ago (offline run)`, `built-in static prices
 * only (catalog not loaded for this command)`.
 */
export function describePricingCatalog(
  info: PricingCatalogInfo,
  options: { now?: number; hydration?: PricingHydration } = {},
): string {
  const now = options.now ?? Date.now();
  const run = options.hydration ?? hydration;
  const ago = fetchedAgo(info, now);
  switch (info.source) {
    case 'litellm':
      return ago ? `LiteLLM catalog, ${ago}` : 'LiteLLM catalog';
    case 'stale-cache': {
      const why =
        run.state === 'done' && run.offline ? 'offline run' : 'refresh failed; using the cache';
      return `stale LiteLLM cache${ago ? `, ${ago}` : ''} (${why})`;
    }
    case 'imported':
      return 'prices imported from another process';
    case 'static':
    default: {
      const why =
        run.state === 'not-run'
          ? 'catalog not loaded for this command'
          : run.state === 'done' && run.offline
            ? 'offline run with no cached catalog'
            : 'catalog unavailable and not cached';
      return `built-in static prices only (${why})`;
    }
  }
}

function customPrices(info: PricingCatalogInfo): string {
  const count = info.registeredEntries;
  return count > 0 ? ` + ${count} custom price${count === 1 ? '' : 's'} (cli-config.json)` : '';
}

/** One footer line for report tables: the pricing basis and its digest. */
export function formatPricingFooter(
  info: PricingCatalogInfo = getPricingCatalogInfo(),
  options: { now?: number; hydration?: PricingHydration } = {},
): string {
  return `Pricing: ${describePricingCatalog(info, options)}${customPrices(info)} · ${info.digest}`;
}

export interface PricingHealthCheck {
  id: 'pricing_catalog';
  status: 'ok' | 'warning' | 'info';
  title: string;
  message: string;
  repair?: string;
}

/**
 * The `doctor` pricing check: a warning when only the built-in table or a
 * stale cache priced this run, or when cli-config.json had invalid prices.
 */
export function pricingHealthCheck(
  info: PricingCatalogInfo = getPricingCatalogInfo(),
  options: { now?: number; hydration?: PricingHydration; configured?: ConfiguredPricing } = {},
): PricingHealthCheck {
  const config = options.configured ?? configured;
  const parts = [describePricingCatalog(info, options)];
  if (info.catalogEntries > 0) parts.push(`${info.catalogEntries} catalog entries`);
  if (info.registeredEntries > 0) {
    parts.push(
      `${info.registeredEntries} custom price${info.registeredEntries === 1 ? '' : 's'} from cli-config.json${config.onlyIfMissing ? ' (gap-filling only)' : ''}`,
    );
  }
  parts.push(`digest ${info.digest}`);
  const repairs: string[] = [];
  let status: PricingHealthCheck['status'] = info.source === 'imported' ? 'info' : 'ok';
  if (info.source === 'static') {
    status = 'warning';
    repairs.push(
      'Run sidekick once with network access (without --offline or SIDEKICK_OFFLINE=1) to cache the LiteLLM catalog; until then models missing from the built-in table stay unpriced.',
    );
  } else if (info.source === 'stale-cache') {
    status = 'warning';
    repairs.push(
      'Re-run with network access to refresh the cached catalog (it is refreshed after 24 h).',
    );
  }
  if (config.warnings.length > 0) {
    status = 'warning';
    parts.push(
      `${config.warnings.length} cli-config.json pricing problem${config.warnings.length === 1 ? '' : 's'}: ${config.warnings.join(' ')}`,
    );
    repairs.push('Fix the "pricing" section of cli-config.json.');
  }
  return {
    id: 'pricing_catalog',
    status,
    title: 'Pricing catalog',
    message: parts.join(' · '),
    ...(repairs.length > 0 ? { repair: repairs.join(' ') } : {}),
  };
}
