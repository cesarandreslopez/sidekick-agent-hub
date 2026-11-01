/**
 * Tests for the typed cli-config.json accessor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({ getConfigDir: vi.fn() }));

vi.mock('sidekick-shared', () => ({
  getConfigDir: mocks.getConfigDir,
}));

import {
  cliConfigPath,
  parsePricingConfig,
  readCliConfig,
  readPricingConfig,
  writeCliConfig,
  readDashboardConfig,
  updateDashboardConfig,
} from './cliConfig';

describe('cliConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-cliconfig-'));
    mocks.getConfigDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads {} when the file is missing or malformed', () => {
    expect(readCliConfig()).toEqual({});
    fs.writeFileSync(cliConfigPath(), 'not json');
    expect(readCliConfig()).toEqual({});
  });

  it('round-trips a config object', () => {
    writeCliConfig({ accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } } });
    expect(readCliConfig()).toEqual({
      accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } },
    });
  });

  it('writes with owner-only permissions', () => {
    writeCliConfig({});
    const mode = fs.statSync(cliConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('updateDashboardConfig merges without clobbering other sections', () => {
    writeCliConfig({ accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } } });
    updateDashboardConfig({ mouseEnabled: false });
    expect(readCliConfig()).toEqual({
      accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } },
      dashboard: { mouseEnabled: false },
    });
    updateDashboardConfig({ mouseEnabled: true });
    expect(readDashboardConfig()).toEqual({ mouseEnabled: true });
  });

  it('readDashboardConfig defaults to {}', () => {
    expect(readDashboardConfig()).toEqual({});
  });
});

describe('parsePricingConfig', () => {
  const rates = { inputCostPerMillion: 3, outputCostPerMillion: 15 };

  it('is empty and silent without a pricing section', () => {
    expect(parsePricingConfig(undefined)).toEqual({
      entries: {},
      onlyIfMissing: false,
      warnings: [],
    });
  });

  it('accepts valid entries, trims ids, and defaults cache rates to the input rate', () => {
    expect(
      parsePricingConfig({
        models: {
          ' my-model ': rates,
          other: { ...rates, cacheWriteCostPerMillion: 3.75, cacheReadCostPerMillion: 0.3 },
          free: { inputCostPerMillion: 0, outputCostPerMillion: 0 },
        },
        onlyIfMissing: true,
      }),
    ).toEqual({
      entries: {
        'my-model': { ...rates, cacheWriteCostPerMillion: 3, cacheReadCostPerMillion: 3 },
        other: { ...rates, cacheWriteCostPerMillion: 3.75, cacheReadCostPerMillion: 0.3 },
        free: {
          inputCostPerMillion: 0,
          outputCostPerMillion: 0,
          cacheWriteCostPerMillion: 0,
          cacheReadCostPerMillion: 0,
        },
      },
      onlyIfMissing: true,
      warnings: [],
    });
  });

  it('skips invalid entries with a warning each and keeps the valid ones', () => {
    const parsed = parsePricingConfig({
      models: {
        good: rates,
        negative: { inputCostPerMillion: -1, outputCostPerMillion: 15 },
        missing: { inputCostPerMillion: 3 },
        text: { inputCostPerMillion: '3', outputCostPerMillion: 15 },
        infinite: { ...rates, cacheReadCostPerMillion: Infinity },
        notObject: 12,
        '  ': rates,
        typo: { ...rates, cacheReadCostPerMilion: 0.3 },
      },
      onlyIfMissing: 'yes',
      extra: 1,
    });
    expect(Object.keys(parsed.entries).sort()).toEqual(['good', 'typo']);
    expect(parsed.onlyIfMissing).toBe(false);
    const joined = parsed.warnings.join('\n');
    expect(joined).toContain('pricing.extra is not a known setting');
    expect(joined).toContain('onlyIfMissing must be true or false');
    expect(joined).toContain('["negative"]: inputCostPerMillion must be a non-negative number');
    expect(joined).toContain('["missing"]: outputCostPerMillion must be a non-negative number');
    expect(joined).toContain('["text"]: inputCostPerMillion');
    expect(joined).toContain('["infinite"]: cacheReadCostPerMillion');
    expect(joined).toContain('["notObject"]: expected an object');
    expect(joined).toContain('the model id is empty');
    expect(joined).toContain('["typo"]: unknown field(s) cacheReadCostPerMilion ignored');
  });

  it('rejects a malformed section without throwing', () => {
    expect(parsePricingConfig([]).warnings).toEqual([
      'cli-config.json "pricing" must be an object; ignored.',
    ]);
    expect(parsePricingConfig({ models: [] }).warnings[0]).toContain('pricing.models must be');
  });
});

describe('readPricingConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-cliconfig-'));
    mocks.getConfigDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads the pricing section from cli-config.json', () => {
    expect(readPricingConfig().entries).toEqual({});
    writeCliConfig({
      pricing: { models: { 'my-model': { inputCostPerMillion: 1, outputCostPerMillion: 2 } } },
    });
    expect(readPricingConfig().entries['my-model']).toMatchObject({ outputCostPerMillion: 2 });
  });
});
