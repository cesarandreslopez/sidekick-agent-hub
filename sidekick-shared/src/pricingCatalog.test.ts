import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  hydratePricingCatalog,
  normalizeLiteLlmCatalog,
  normalizeLiteLlmContextWindows,
} from './pricingCatalog';
import { _clearPricingOverrides, _getPricingOverrides, getModelPricing } from './modelInfo';
import {
  _clearCatalogContextWindows,
  _getCatalogContextWindows,
  getModelContextWindowSize,
} from './modelContext';

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
  return (async () => new Response('nope', { status })) as unknown as typeof fetch;
}

const SAMPLE_CATALOG = {
  sample_spec: { foo: 'bar', max_input_tokens: 999 },
  'gpt-4o': {
    input_cost_per_token: 0.0000025,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.00000125,
    cache_creation_input_token_cost: 0,
    max_input_tokens: 128_000,
  },
  'openai/o3-mini': {
    input_cost_per_token: 0.0000011,
    output_cost_per_token: 0.0000044,
    max_input_tokens: 200_000,
  },
  // Entry missing required fields — must be skipped.
  'broken-entry': {
    some_other_field: 1,
  },
  // Priced but no context window — contributes pricing only.
  'priced-only': {
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000002,
  },
  // Context window but unpriced — contributes context only. `max_tokens` is
  // the output cap and must never be read as the context window.
  'context-only': {
    max_input_tokens: 400_000,
    max_tokens: 64_000,
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

describe('normalizeLiteLlmContextWindows', () => {
  it('reads max_input_tokens, not max_tokens', () => {
    const out = normalizeLiteLlmContextWindows(SAMPLE_CATALOG);
    expect(out['gpt-4o']).toBe(128_000);
    // `max_tokens: 64_000` on this entry is the output cap, not the window.
    expect(out['context-only']).toBe(400_000);
  });

  it('records context for entries that have no pricing', () => {
    // Coverage differs between the two maps: an entry can have one without
    // the other, which is why these are normalized separately.
    const pricing = normalizeLiteLlmCatalog(SAMPLE_CATALOG);
    const windows = normalizeLiteLlmContextWindows(SAMPLE_CATALOG);
    expect(pricing['context-only']).toBeUndefined();
    expect(windows['context-only']).toBe(400_000);
    expect(pricing['priced-only']).toBeDefined();
    expect(windows['priced-only']).toBeUndefined();
  });

  it('also records provider-stripped aliases', () => {
    const out = normalizeLiteLlmContextWindows(SAMPLE_CATALOG);
    expect(out['openai/o3-mini']).toBe(200_000);
    expect(out['o3-mini']).toBe(200_000);
  });

  it('drops an alias when providers disagree about the window', () => {
    // Regression: a `provider/model` entry states that provider's deployment
    // window, not the model's. The live catalog lists `claude-sonnet-4` at 128K
    // under GitHub Copilot and 1M under Vertex; first-wins picked Copilot's
    // truncated number purely on JSON key order. With no defensible answer we
    // record none and let the static table respond.
    const out = normalizeLiteLlmContextWindows({
      'github_copilot/claude-sonnet-4': { max_input_tokens: 128_000 },
      'vertex_ai/claude-sonnet-4': { max_input_tokens: 1_000_000 },
    });
    expect(out['github_copilot/claude-sonnet-4']).toBe(128_000);
    expect(out['vertex_ai/claude-sonnet-4']).toBe(1_000_000);
    expect(out['claude-sonnet-4']).toBeUndefined();
  });

  it('records an alias when every provider agrees', () => {
    const out = normalizeLiteLlmContextWindows({
      'vertex_ai/claude-opus-4-7': { max_input_tokens: 1_000_000 },
      'bedrock/claude-opus-4-7': { max_input_tokens: 1_000_000 },
    });
    expect(out['claude-opus-4-7']).toBe(1_000_000);
  });

  it('never lets a derived alias shadow a top-level entry', () => {
    // The top-level key is authoritative no matter where it lands in iteration
    // order — previously this depended on the alias being written second.
    const out = normalizeLiteLlmContextWindows({
      'github_copilot/gpt-5.4': { max_input_tokens: 128_000 },
      'gpt-5.4': { max_input_tokens: 1_050_000 },
    });
    expect(out['gpt-5.4']).toBe(1_050_000);
  });

  it('strips only the first path segment, matching the pricing map', () => {
    const out = normalizeLiteLlmContextWindows({
      'openrouter/anthropic/claude-sonnet-4': { max_input_tokens: 1_000_000 },
    });
    expect(out['anthropic/claude-sonnet-4']).toBe(1_000_000);
    expect(out['claude-sonnet-4']).toBeUndefined();
  });

  it('skips entries without a context window', () => {
    const out = normalizeLiteLlmContextWindows(SAMPLE_CATALOG);
    expect(out['broken-entry']).toBeUndefined();
  });

  it('skips the sample_spec header entry', () => {
    const out = normalizeLiteLlmContextWindows(SAMPLE_CATALOG);
    expect(out['sample_spec']).toBeUndefined();
  });

  it('skips non-positive and non-numeric windows', () => {
    const out = normalizeLiteLlmContextWindows({
      a: { max_input_tokens: 0 },
      b: { max_input_tokens: -5 },
      c: { max_input_tokens: 'lots' },
      d: { max_input_tokens: 1_000 },
    });
    expect(out).toEqual({ d: 1_000 });
  });

  it('returns empty map for non-objects', () => {
    expect(normalizeLiteLlmContextWindows(null)).toEqual({});
    expect(normalizeLiteLlmContextWindows('nope')).toEqual({});
    expect(normalizeLiteLlmContextWindows(42)).toEqual({});
  });
});

describe('hydratePricingCatalog', { timeout: 30_000 }, () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await makeTempDir();
    _clearPricingOverrides();
    _clearCatalogContextWindows();
  });

  afterEach(async () => {
    _clearPricingOverrides();
    _clearCatalogContextWindows();
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
        overrides: {
          'gpt-4o': {
            inputCostPerMillion: 1,
            outputCostPerMillion: 1,
            cacheWriteCostPerMillion: 0,
            cacheReadCostPerMillion: 0,
          },
        },
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
    expect(result.contextWindowEntries).toBe(0);
  });

  describe('context window hydration', () => {
    it('applies and persists context windows on the network path', async () => {
      const result = await hydratePricingCatalog({
        cacheDir,
        fetchImpl: mockFetchOk(SAMPLE_CATALOG),
      });

      expect(result.contextWindowEntries).toBeGreaterThan(0);
      expect(getModelContextWindowSize('context-only')).toBe(400_000);

      const cached = JSON.parse(
        await fs.readFile(path.join(cacheDir, 'pricing-catalog.json'), 'utf8'),
      );
      expect(cached.contextWindows['gpt-4o']).toBe(128_000);
    });

    it('applies context windows from a fresh cache', async () => {
      await hydratePricingCatalog({ cacheDir, fetchImpl: mockFetchOk(SAMPLE_CATALOG) });
      _clearCatalogContextWindows();

      const result = await hydratePricingCatalog({
        cacheDir,
        fetchImpl: mockFetchFails(new Error('should not be called')),
      });

      expect(result.source).toBe('cache');
      expect(_getCatalogContextWindows()['context-only']).toBe(400_000);
    });

    it('applies context windows from a stale cache when the network fails', async () => {
      await hydratePricingCatalog({ cacheDir, fetchImpl: mockFetchOk(SAMPLE_CATALOG) });
      _clearCatalogContextWindows();

      const result = await hydratePricingCatalog({
        cacheDir,
        ttlMs: -1,
        fetchImpl: mockFetchFails(new Error('offline')),
      });

      expect(result.source).toBe('cache');
      expect(_getCatalogContextWindows()['gpt-4o']).toBe(128_000);
    });

    it('loads a pre-existing cache written before context hydration', async () => {
      // Back-compat: caches on disk today have no `contextWindows` key. They
      // must still apply pricing rather than being rejected as malformed.
      await fs.writeFile(
        path.join(cacheDir, 'pricing-catalog.json'),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          url: 'https://example.test/catalog.json',
          overrides: {
            'gpt-4o': {
              inputCostPerMillion: 2.5,
              outputCostPerMillion: 10,
              cacheWriteCostPerMillion: 0,
              cacheReadCostPerMillion: 1.25,
            },
          },
        }),
        'utf8',
      );

      const result = await hydratePricingCatalog({
        cacheDir,
        fetchImpl: mockFetchFails(new Error('should not be called')),
      });

      expect(result.source).toBe('cache');
      expect(result.entries).toBe(1);
      expect(result.contextWindowEntries).toBe(0);
      expect(getModelPricing('gpt-4o')!.inputCostPerMillion).toBe(2.5);
      // Falls through to the static table, not to the default.
      expect(getModelContextWindowSize('gpt-4o')).toBe(128_000);
    });
  });
});
