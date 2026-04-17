import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  hydratePricingCatalog,
  normalizeLiteLlmCatalog,
} from './pricingCatalog';
import { _clearPricingOverrides, _getPricingOverrides, getModelPricing } from './modelInfo';

// ── Test helpers ──

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-pricing-'));
}

function mockFetchOk(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function mockFetchFails(error: Error): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

function mockFetchHttpError(status: number): typeof fetch {
  return (async () =>
    new Response('nope', { status })) as unknown as typeof fetch;
}

const SAMPLE_CATALOG = {
  sample_spec: { foo: 'bar' },
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125,
    cache_creation_input_token_cost: 0,
  },
  'openai/o3-mini': {
    input_cost_per_token: 0.0000011,
    output_cost_per_token: 0.0000044,
  },
  // Entry missing required fields — must be skipped.
  'broken-entry': {
    some_other_field: 1,
  },
};

// ── Tests ──

describe('normalizeLiteLlmCatalog', () => {
  it('converts LiteLLM entries into ModelPricing (per-million)', () => {
    const out = normalizeLiteLlmCatalog(SAMPLE_CATALOG);
    expect(out['gpt-4o']).toEqual({
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10.0,
      cacheWriteCostPerMillion: 0,
      cacheReadCostPerMillion: 1.25,
    });
  });

  it('also records provider-stripped aliases', () => {
    const out = normalizeLiteLlmCatalog(SAMPLE_CATALOG);
    expect(out['openai/o3-mini']).toBeDefined();
    expect(out['o3-mini']).toEqual({
      inputCostPerMillion: 1.1,
      outputCostPerMillion: 4.4,
      cacheWriteCostPerMillion: 0,
      cacheReadCostPerMillion: 0,
    });
  });

  it('skips entries without input/output pricing', () => {
    const out = normalizeLiteLlmCatalog(SAMPLE_CATALOG);
    expect(out['broken-entry']).toBeUndefined();
  });

  it('skips the sample_spec header entry', () => {
    const out = normalizeLiteLlmCatalog(SAMPLE_CATALOG);
    expect(out['sample_spec']).toBeUndefined();
  });

  it('returns empty map for non-objects', () => {
    expect(normalizeLiteLlmCatalog(null)).toEqual({});
    expect(normalizeLiteLlmCatalog('nope')).toEqual({});
    expect(normalizeLiteLlmCatalog(42)).toEqual({});
  });
});

describe('hydratePricingCatalog', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await makeTempDir();
    _clearPricingOverrides();
  });

  afterEach(async () => {
    _clearPricingOverrides();
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('fetches from network, writes cache, applies overrides', async () => {
    const result = await hydratePricingCatalog({
      cacheDir,
      fetchImpl: mockFetchOk(SAMPLE_CATALOG),
    });

    expect(result.source).toBe('network');
    expect(result.entries).toBeGreaterThan(0);

    const cached = JSON.parse(
      await fs.readFile(path.join(cacheDir, 'pricing-catalog.json'), 'utf8'),
    );
    expect(cached.overrides['gpt-4o']).toBeDefined();

    // Override affects lookup.
    expect(getModelPricing('gpt-4o')!.inputCostPerMillion).toBe(2.5);
  });

  it('uses fresh on-disk cache without hitting the network', async () => {
    const fetchSpy = vi.fn(mockFetchOk(SAMPLE_CATALOG));
    await hydratePricingCatalog({ cacheDir, fetchImpl: fetchSpy });

    fetchSpy.mockClear();
    _clearPricingOverrides();

    const result = await hydratePricingCatalog({ cacheDir, fetchImpl: fetchSpy });
    expect(result.source).toBe('cache');
    expect(fetchSpy).not.toHaveBeenCalled();
    // Override is repopulated from cache.
    expect(_getPricingOverrides()['gpt-4o']).toBeDefined();
  });

  it('refetches when cache is older than ttlMs', async () => {
    // Prime cache with an obviously old timestamp.
    const stalePath = path.join(cacheDir, 'pricing-catalog.json');
    await fs.writeFile(
      stalePath,
      JSON.stringify({
        fetchedAt: new Date(0).toISOString(),
        url: 'test',
        overrides: { 'gpt-4o': { inputCostPerMillion: 1, outputCostPerMillion: 1, cacheWriteCostPerMillion: 0, cacheReadCostPerMillion: 0 } },
      }),
    );

    const fetchSpy = vi.fn(mockFetchOk(SAMPLE_CATALOG));
    const result = await hydratePricingCatalog({
      cacheDir,
      fetchImpl: fetchSpy,
      ttlMs: 1000,
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.source).toBe('network');
  });

  it('falls back to stale cache on network failure', async () => {
    // Pre-seed a stale cache.
    await fs.writeFile(
      path.join(cacheDir, 'pricing-catalog.json'),
      JSON.stringify({
        fetchedAt: new Date(0).toISOString(),
        url: 'test',
        overrides: {
          'gpt-4o': {
            inputCostPerMillion: 99,
            outputCostPerMillion: 99,
            cacheWriteCostPerMillion: 0,
            cacheReadCostPerMillion: 0,
          },
        },
      }),
    );

    const result = await hydratePricingCatalog({
      cacheDir,
      fetchImpl: mockFetchFails(new Error('offline')),
      ttlMs: 1_000,
    });

    expect(result.source).toBe('cache');
    expect(getModelPricing('gpt-4o')!.inputCostPerMillion).toBe(99);
  });

  it('ignores malformed cache and still attempts network', async () => {
    await fs.writeFile(path.join(cacheDir, 'pricing-catalog.json'), 'not-json');

    const result = await hydratePricingCatalog({
      cacheDir,
      fetchImpl: mockFetchOk(SAMPLE_CATALOG),
    });

    expect(result.source).toBe('network');
    expect(_getPricingOverrides()['gpt-4o']).toBeDefined();
  });

  it('returns offline when network fails and no cache exists', async () => {
    const result = await hydratePricingCatalog({
      cacheDir,
      fetchImpl: mockFetchFails(new Error('no route to host')),
    });

    expect(result.source).toBe('offline');
    expect(result.entries).toBe(0);
  });

  it('treats non-2xx HTTP as failure', async () => {
    const result = await hydratePricingCatalog({
      cacheDir,
      fetchImpl: mockFetchHttpError(500),
    });

    expect(result.source).toBe('offline');
  });
});
