import { describe, expect, it } from 'vitest';
import { describePricingCatalog, formatAge } from './pricingCatalogLabel';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

describe('describePricingCatalog', () => {
  it('describes a fetched catalog, custom prices, and ignored entries', () => {
    const lines = describePricingCatalog(
      {
        source: 'litellm',
        fetchedAt: '2026-11-01T09:00:00.000Z',
        digest: 'fnv1a64:0123456789abcdef',
        catalogEntries: 2431,
        registeredEntries: 1,
      },
      { applied: ['local-model'], invalid: ['bad'], onlyIfMissing: true },
      NOW,
    );
    expect(lines).toEqual([
      {
        label: 'Source',
        value: 'LiteLLM catalog · fetched 3h ago · 2,431 entries',
        warning: false,
      },
      { label: 'Custom prices', value: '1 registered (fill gaps only)' },
      {
        label: 'Ignored',
        value: expect.stringContaining('bad — each needs inputCostPerMillion'),
        warning: true,
      },
      { label: 'Digest', value: 'fnv1a64:0123456789abcdef' },
    ]);
  });

  it('flags a stale cache and reports built-in prices', () => {
    expect(
      describePricingCatalog(
        { source: 'stale-cache', digest: 'd', catalogEntries: 3, registeredEntries: 0 },
        undefined,
        NOW,
      )[0],
    ).toEqual({
      label: 'Source',
      value: 'LiteLLM catalog (stale cache) · 3 entries',
      warning: true,
    });
    const builtIn = describePricingCatalog(
      { source: 'static', digest: 'd', catalogEntries: 0, registeredEntries: 0 },
      { applied: [], invalid: [], onlyIfMissing: false },
      NOW,
    );
    expect(builtIn[0].value).toBe('Built-in prices only');
    expect(builtIn[1].value).toBe('none (sidekick.customModelPricing)');
  });
});

describe('formatAge', () => {
  it('rounds to the largest sensible unit', () => {
    expect(formatAge(5_000)).toBe('just now');
    expect(formatAge(12 * 60_000)).toBe('12m ago');
    expect(formatAge(3 * 3_600_000)).toBe('3h ago');
    expect(formatAge(72 * 3_600_000)).toBe('3d ago');
  });
});
