import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';

const pkgRoot = path.resolve(__dirname, '..');
const distDir = path.join(pkgRoot, 'dist');
const browserJs = path.join(distDir, 'browser.js');
const nodeJs = path.join(distDir, 'node.js');
const schemasJs = path.join(distDir, 'schemas', 'index.js');

// Rooted at the package itself so require.resolve exercises the real
// package.json `exports` map as a self-consumer.
const pkgRequire = createRequire(path.join(pkgRoot, 'package.json'));

describe('packaging contract', () => {
  it('dist/browser.js exposes the browser-safe surface', () => {
    expect(existsSync(browserJs)).toBe(true);
    const m = require(browserJs);
    for (const k of [
      'getModelContextWindowSize',
      'parseModelId',
      'getModelPricing',
      'getModelInfo',
      'calculateCost',
      'calculateCostWithPricing',
      'calculateCostWithProvenance',
      'mergeCostSources',
      'shortModelName',
      'getModelDisplayInfo',
      'compareModelIds',
      'sortModelIds',
      'formatCost',
      'formatDurationMs',
      'formatTokenCount',
      'buildSessionContextSnapshot',
      'calculateSessionContextPressure',
      'createSessionContextProjector',
    ]) {
      expect(typeof m[k]).toBe('function');
    }
    expect(typeof m.DEFAULT_CONTEXT_WINDOW).toBe('number');
    // Schemas live on the dedicated `/schemas` subpath, not here — keeping
    // zod out of bundles that only need the pure math/formatting helpers.
    expect(m.quotaStateSchema).toBeUndefined();
    expect(m.sessionEventSchema).toBeUndefined();
  });

  it('dist/schemas/index.js exposes the boundary-validation surface', () => {
    expect(existsSync(schemasJs)).toBe(true);
    const m = require(schemasJs);
    for (const k of [
      'messageUsageSchema',
      'sessionMessageSchema',
      'sessionEventSchema',
      'permissionModeSchema',
      'quotaWindowSchema',
      'quotaStateSchema',
      'peakHoursStateSchema',
      'quotaFailureDescriptorSchema',
      'providerQuotaStateSchema',
      'claudeProviderQuotaStateSchema',
      'codexProviderQuotaStateSchema',
      'providerQuotaMapSchema',
      'quotaHistorySampleSchema',
      'quotaHistoryDailyBucketSchema',
      'activeProviderAccountStatusSchema',
      'activeAccountStatusSchema',
    ]) {
      expect(typeof m[k]?.safeParse).toBe('function');
    }
    expect(typeof m.extractSessionEvents).toBe('function');
  });

  it('dist/node.js exposes pricing hydration', () => {
    expect(existsSync(nodeJs)).toBe(true);
    const m = require(nodeJs);
    expect(typeof m.hydratePricingCatalog).toBe('function');
    expect(typeof m.normalizeLiteLlmCatalog).toBe('function');
    expect(typeof m.LITELLM_CATALOG_URL).toBe('string');
  });

  it('dist/index.js exposes account bootstrap', () => {
    const m = require(path.join(distDir, 'index.js'));
    expect(typeof m.ensureDefaultAccounts).toBe('function');
    expect(typeof m.getActiveAccountStatus).toBe('function');
    expect(typeof m.CodexQuotaWatcher).toBe('function');
    expect(typeof m.MultiProviderQuotaService).toBe('function');
    expect(typeof m.createJsonlTail).toBe('function');
    expect(typeof m.formatDurationMs).toBe('function');
    expect(typeof m.formatTokenCount).toBe('function');
    expect(typeof m.extractToolCall).toBe('function');
    expect(typeof m.readSessionContextSnapshot).toBe('function');
    expect(typeof m.buildSessionContextSnapshot).toBe('function');
    expect(typeof m.extractSessionEvents).toBe('function');
    expect(typeof m.quotaStateSchema?.safeParse).toBe('function');
    expect(typeof m.activeAccountStatusSchema?.safeParse).toBe('function');
  });

  it('dist/phrases.js exposes flat and categorized phrase surfaces', () => {
    const m = require(path.join(distDir, 'phrases.js'));
    expect(Array.isArray(m.ALL_PHRASES)).toBe(true);
    expect(Array.isArray(m.PHRASE_CATEGORIES)).toBe(true);
    expect(m.PHRASE_CATEGORIES.length).toBeGreaterThan(0);
  });

  it('dist/browser.js does not transitively load node:fs or node:path', async () => {
    const src = await fs.readFile(browserJs, 'utf8');
    expect(src).not.toMatch(/require\(["']node:fs["']\)/);
    expect(src).not.toMatch(/require\(["']node:path["']\)/);
    expect(src).not.toMatch(/require\(["']fs["']\)/);
    expect(src).not.toMatch(/require\(["']path["']\)/);
    // The whole point is to keep pricing hydration out of browser bundles.
    expect(src).not.toMatch(/pricingCatalog/);
  });

  it('dist/schemas/* does not transitively load node:fs or node:path', async () => {
    // The schema modules `import type` from Node-flavored sources
    // (quotaHistory, accountStatus); those must stay erased at emit.
    const schemasDir = path.join(distDir, 'schemas');
    const files = (await fs.readdir(schemasDir)).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = await fs.readFile(path.join(schemasDir, file), 'utf8');
      expect(src).not.toMatch(/require\(["']node:fs["']\)/);
      expect(src).not.toMatch(/require\(["']node:path["']\)/);
      expect(src).not.toMatch(/require\(["']fs["']\)/);
      expect(src).not.toMatch(/require\(["']path["']\)/);
    }
  });

  // Consumer-perspective resolution: exercises the real package.json exports
  // map. Catches typos (wrong subpath key, missing `types`, bad default path)
  // that file-existence checks miss.
  it('package.json `exports` resolves the advertised subpaths', () => {
    const expected: Record<string, string> = {
      'sidekick-shared': path.join(distDir, 'index.js'),
      'sidekick-shared/browser': browserJs,
      'sidekick-shared/node': nodeJs,
      'sidekick-shared/schemas': schemasJs,
      'sidekick-shared/phrases': path.join(distDir, 'phrases.js'),
      'sidekick-shared/modelContext': path.join(distDir, 'modelContext.js'),
      'sidekick-shared/modelInfo': path.join(distDir, 'modelInfo.js'),
      'sidekick-shared/formatting': path.join(distDir, 'formatting.js'),
      // Compat path — downstream consumers still rely on these in this release.
      'sidekick-shared/dist/phrases': path.join(distDir, 'phrases.js'),
      'sidekick-shared/dist/providers/types': path.join(distDir, 'providers', 'types.js'),
    };
    for (const [specifier, resolvedPath] of Object.entries(expected)) {
      expect(pkgRequire.resolve(specifier)).toBe(resolvedPath);
    }
  });
});
