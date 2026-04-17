/**
 * Runtime pricing catalog hydration (Node-only).
 *
 * Fetches LiteLLM's community-maintained model pricing catalog, caches the
 * normalized result to disk, and pushes it into `modelInfo.ts` as an override
 * map. Static `PRICING_TABLE` remains the offline baseline.
 *
 * This module lives on the `sidekick-shared/node` subpath so browser bundles
 * (VS Code webviews) never pull it in. Webviews receive pre-computed costs
 * from the extension host and don't need pricing data locally.
 *
 * Non-goals:
 *   - Perfect billing reconciliation. Best-effort estimate based on LiteLLM.
 *   - Aggressive refresh. Default 24h TTL is plenty for a pricing table.
 *   - Blocking startup. Every error path is non-fatal; static table keeps working.
 *
 * @module pricingCatalog
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { _setPricingOverrides, type ModelPricing } from './modelInfo';

// ── Types ──

export interface HydrateOptions {
  /** Directory for the on-disk cache (e.g. ~/.config/sidekick). */
  cacheDir: string;
  /** Inject a fetch implementation (tests, custom agents). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Cache TTL in ms. Default 24h. */
  ttlMs?: number;
  /** Network timeout in ms. Default 3000. */
  timeoutMs?: number;
  /** Override the catalog URL (tests). */
  url?: string;
  /** Optional logger (useful for diagnostics without pulling a logger dep). */
  logger?: (msg: string) => void;
}

export interface HydrateResult {
  /** Where the loaded pricing came from. */
  source: 'cache' | 'network' | 'offline';
  /** Number of pricing entries applied to the override map. */
  entries: number;
  /** ISO timestamp of the fetch that produced the cache. */
  fetchedAt: string;
}

interface CacheFile {
  fetchedAt: string;
  url: string;
  overrides: Record<string, ModelPricing>;
}

/** Shape of a single LiteLLM catalog entry we care about. */
interface LiteLlmEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_cached?: number;
  [k: string]: unknown;
}

// ── Constants ──

export const LITELLM_CATALOG_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const CACHE_FILE_NAME = 'pricing-catalog.json';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 3_000;

// ── Public API ──

/**
 * Hydrate the pricing override map.
 *
 * Order:
 *   1. If a fresh on-disk cache exists (< ttlMs old), load it and return.
 *   2. Otherwise attempt a network fetch; on success, persist + apply.
 *   3. On any failure, load a stale cache if present; else leave overrides empty.
 *
 * Always resolves — never throws. Offline-safe.
 */
export async function hydratePricingCatalog(
  options: HydrateOptions,
): Promise<HydrateResult> {
  const {
    cacheDir,
    fetchImpl = (globalThis as { fetch?: typeof fetch }).fetch,
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    url = LITELLM_CATALOG_URL,
    logger,
  } = options;

  const cachePath = path.join(cacheDir, CACHE_FILE_NAME);
  const now = Date.now();

  // 1. Fresh cache?
  const cached = await readCache(cachePath);
  if (cached && now - Date.parse(cached.fetchedAt) < ttlMs) {
    _setPricingOverrides(cached.overrides);
    return {
      source: 'cache',
      entries: Object.keys(cached.overrides).length,
      fetchedAt: cached.fetchedAt,
    };
  }

  // 2. Try network.
  if (fetchImpl) {
    const fetched = await fetchCatalog(url, fetchImpl, timeoutMs, logger);
    if (fetched) {
      const overrides = normalizeLiteLlmCatalog(fetched);
      const payload: CacheFile = {
        fetchedAt: new Date(now).toISOString(),
        url,
        overrides,
      };
      await writeCache(cachePath, payload, logger);
      _setPricingOverrides(overrides);
      return {
        source: 'network',
        entries: Object.keys(overrides).length,
        fetchedAt: payload.fetchedAt,
      };
    }
  }

  // 3. Fall back to stale cache if present.
  if (cached) {
    _setPricingOverrides(cached.overrides);
    return {
      source: 'cache',
      entries: Object.keys(cached.overrides).length,
      fetchedAt: cached.fetchedAt,
    };
  }

  // 4. Nothing we can do — stay on static table.
  return { source: 'offline', entries: 0, fetchedAt: new Date(now).toISOString() };
}

/**
 * Convert a LiteLLM catalog payload to our `ModelPricing` override map.
 * Exported for tests; rarely called directly.
 */
export function normalizeLiteLlmCatalog(
  raw: unknown,
): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    // LiteLLM ships a `sample_spec` header entry. Skip it.
    if (key === 'sample_spec') continue;
    if (!entry || typeof entry !== 'object') continue;

    const pricing = liteLlmEntryToPricing(entry as LiteLlmEntry);
    if (!pricing) continue;

    // Catalog keys use both `provider/model` and bare `model` forms. Record both
    // the raw key and the bare-model form so lookups work regardless of caller.
    out[key] = pricing;
    const bare = stripProviderPrefix(key);
    if (bare && bare !== key && !out[bare]) {
      out[bare] = pricing;
    }
  }

  return out;
}

// ── Internals ──

function liteLlmEntryToPricing(entry: LiteLlmEntry): ModelPricing | null {
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  // Need at least input+output to be useful.
  if (typeof input !== 'number' || typeof output !== 'number') return null;

  // LiteLLM sometimes reports cached input under `input_cost_per_token_cached`.
  const cacheRead =
    typeof entry.cache_read_input_token_cost === 'number'
      ? entry.cache_read_input_token_cost
      : typeof entry.input_cost_per_token_cached === 'number'
        ? entry.input_cost_per_token_cached
        : 0;
  const cacheWrite =
    typeof entry.cache_creation_input_token_cost === 'number'
      ? entry.cache_creation_input_token_cost
      : 0;

  return {
    inputCostPerMillion: input * 1_000_000,
    outputCostPerMillion: output * 1_000_000,
    cacheWriteCostPerMillion: cacheWrite * 1_000_000,
    cacheReadCostPerMillion: cacheRead * 1_000_000,
  };
}

function stripProviderPrefix(key: string): string | null {
  const slash = key.indexOf('/');
  if (slash < 0) return null;
  return key.slice(slash + 1);
}

async function readCache(cachePath: string): Promise<CacheFile | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.fetchedAt !== 'string' ||
      !parsed.overrides ||
      typeof parsed.overrides !== 'object'
    ) {
      return null;
    }
    return parsed as CacheFile;
  } catch {
    return null;
  }
}

async function writeCache(
  cachePath: string,
  payload: CacheFile,
  logger?: (msg: string) => void,
): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    logger?.(`pricingCatalog: failed to write cache: ${String(err)}`);
  }
}

async function fetchCatalog(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  logger?: (msg: string) => void,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      logger?.(`pricingCatalog: HTTP ${res.status} from ${url}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    logger?.(`pricingCatalog: fetch failed: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
