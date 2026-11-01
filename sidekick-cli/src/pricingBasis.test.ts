import { afterEach, describe, expect, it } from 'vitest';
import type { PricingCatalogInfo } from 'sidekick-shared';
import {
  _resetPricingBasisForTests,
  describePricingCatalog,
  formatPricingFooter,
  getConfiguredPricing,
  getPricingHydration,
  pricingHealthCheck,
  recordConfiguredPricing,
  recordPricingHydration,
} from './pricingBasis';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const DIGEST = 'fnv1a64:0123456789abcdef';

function info(overrides: Partial<PricingCatalogInfo> = {}): PricingCatalogInfo {
  return {
    source: 'litellm',
    fetchedAt: '2026-11-01T10:00:00Z',
    digest: DIGEST,
    catalogEntries: 5000,
    registeredEntries: 0,
    ...overrides,
  };
}

const done = (offline: boolean, source: 'cache' | 'network' | 'offline' = 'cache') => ({
  state: 'done' as const,
  offline,
  result: { source, entries: 0, contextWindowEntries: 0, fetchedAt: '', digest: DIGEST },
});

afterEach(() => _resetPricingBasisForTests());

describe('describePricingCatalog', () => {
  it('names the catalog and its age', () => {
    expect(describePricingCatalog(info(), { now: NOW })).toBe('LiteLLM catalog, fetched 2h ago');
  });

  it('says why a stale cache or the static table is in use', () => {
    const stale = info({ source: 'stale-cache', fetchedAt: '2026-10-29T12:00:00Z' });
    expect(describePricingCatalog(stale, { now: NOW, hydration: done(true) })).toBe(
      'stale LiteLLM cache, fetched 3d ago (offline run)',
    );
    expect(describePricingCatalog(stale, { now: NOW, hydration: done(false) })).toContain(
      'refresh failed',
    );
    const staticInfo = info({ source: 'static', fetchedAt: undefined, catalogEntries: 0 });
    expect(describePricingCatalog(staticInfo, { now: NOW, hydration: { state: 'not-run' } })).toBe(
      'built-in static prices only (catalog not loaded for this command)',
    );
    expect(
      describePricingCatalog(staticInfo, { now: NOW, hydration: done(true, 'offline') }),
    ).toContain('offline run with no cached catalog');
    expect(
      describePricingCatalog(staticInfo, { now: NOW, hydration: done(false, 'offline') }),
    ).toContain('catalog unavailable');
  });
});

describe('formatPricingFooter', () => {
  it('carries the digest and any custom prices', () => {
    expect(formatPricingFooter(info({ registeredEntries: 2 }), { now: NOW })).toBe(
      `Pricing: LiteLLM catalog, fetched 2h ago + 2 custom prices (cli-config.json) · ${DIGEST}`,
    );
  });
});

describe('pricingHealthCheck', () => {
  it('is ok on a fresh catalog', () => {
    const check = pricingHealthCheck(info(), { now: NOW });
    expect(check).toMatchObject({ id: 'pricing_catalog', status: 'ok', title: 'Pricing catalog' });
    expect(check.message).toContain('LiteLLM catalog, fetched 2h ago');
    expect(check.message).toContain(`digest ${DIGEST}`);
    expect(check.repair).toBeUndefined();
  });

  it('warns on static-only or stale pricing and on invalid custom prices', () => {
    const staticCheck = pricingHealthCheck(info({ source: 'static', catalogEntries: 0 }), {
      now: NOW,
      hydration: done(true, 'offline'),
    });
    expect(staticCheck.status).toBe('warning');
    expect(staticCheck.repair).toContain('without --offline');
    expect(pricingHealthCheck(info({ source: 'stale-cache' }), { now: NOW }).status).toBe(
      'warning',
    );
    const configCheck = pricingHealthCheck(info({ registeredEntries: 1 }), {
      now: NOW,
      configured: { entries: 1, onlyIfMissing: true, warnings: ['bad entry'] },
    });
    expect(configCheck.status).toBe('warning');
    expect(configCheck.message).toContain('1 custom price from cli-config.json (gap-filling only)');
    expect(configCheck.message).toContain('bad entry');
    expect(configCheck.repair).toContain('"pricing" section');
  });
});

describe('recorded state', () => {
  it('keeps what startup recorded until reset', () => {
    expect(getPricingHydration()).toEqual({ state: 'not-run' });
    recordPricingHydration({ state: 'failed' });
    recordConfiguredPricing({ entries: 3, onlyIfMissing: false, warnings: [] });
    expect(getPricingHydration()).toEqual({ state: 'failed' });
    expect(getConfiguredPricing().entries).toBe(3);
  });
});
