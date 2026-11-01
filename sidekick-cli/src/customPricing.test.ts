/**
 * cli-config.json custom prices against the real shared pricing resolver:
 * what startup registers is what usage is priced with.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateNormalizedUsageCost,
  clearRegisteredModelPricing,
  getPricingCatalogInfo,
  normalizeProviderUsage,
  resolveModelPricing,
} from 'sidekick-shared';
import { applyConfiguredPricing } from './startup';
import { formatPricingFooter } from './pricingBasis';

describe('custom prices (real resolver)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-custom-pricing-'));
    vi.stubEnv('SIDEKICK_CONFIG_DIR', dir);
    clearRegisteredModelPricing();
  });

  afterEach(() => {
    clearRegisteredModelPricing();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (config: unknown) =>
    fs.writeFileSync(path.join(dir, 'cli-config.json'), JSON.stringify(config));

  it('prices an unknown model from cli-config.json and reports it in the basis', () => {
    expect(resolveModelPricing('acme-coder-7').pricing).toBeNull();
    const before = getPricingCatalogInfo().digest;
    writeConfig({
      pricing: { models: { 'acme-coder-7': { inputCostPerMillion: 1, outputCostPerMillion: 4 } } },
    });
    applyConfiguredPricing(() => {});

    const resolved = resolveModelPricing('acme-coder-7-20261001');
    expect(resolved.provenance.source).toBe('registered');
    expect(resolved.pricing).toMatchObject({ inputCostPerMillion: 1, outputCostPerMillion: 4 });

    const usage = normalizeProviderUsage({
      semantics: 'anthropic',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const cost = calculateNormalizedUsageCost({ usage, modelId: 'acme-coder-7' });
    expect(cost.costUsd).toBeCloseTo(5);

    const info = getPricingCatalogInfo();
    expect(info.registeredEntries).toBe(1);
    expect(info.digest).not.toBe(before);
    expect(formatPricingFooter(info)).toContain('+ 1 custom price (cli-config.json)');
  });

  it('with onlyIfMissing, never replaces an exact built-in price', () => {
    const builtIn = resolveModelPricing('claude-sonnet-4-5');
    expect(builtIn.pricing).not.toBeNull();
    writeConfig({
      pricing: {
        onlyIfMissing: true,
        models: { 'claude-sonnet-4-5': { inputCostPerMillion: 99, outputCostPerMillion: 99 } },
      },
    });
    applyConfiguredPricing(() => {});
    expect(resolveModelPricing('claude-sonnet-4-5').pricing).toEqual(builtIn.pricing);
  });
});
