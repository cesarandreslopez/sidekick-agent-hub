import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';

const pkgRoot = path.resolve(__dirname, '..');
const distDir = path.join(pkgRoot, 'dist');
const browserJs = path.join(distDir, 'browser.js');
const nodeJs = path.join(distDir, 'node.js');

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
      'formatCost',
    ]) {
      expect(typeof m[k]).toBe('function');
    }
    expect(typeof m.DEFAULT_CONTEXT_WINDOW).toBe('number');
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

  // Consumer-perspective resolution: exercises the real package.json exports
  // map. Catches typos (wrong subpath key, missing `types`, bad default path)
  // that file-existence checks miss.
  it('package.json `exports` resolves the advertised subpaths', () => {
    const expected: Record<string, string> = {
      'sidekick-shared': path.join(distDir, 'index.js'),
      'sidekick-shared/browser': browserJs,
      'sidekick-shared/node': nodeJs,
      'sidekick-shared/phrases': path.join(distDir, 'phrases.js'),
      'sidekick-shared/modelContext': path.join(distDir, 'modelContext.js'),
      'sidekick-shared/modelInfo': path.join(distDir, 'modelInfo.js'),
      // Compat path — downstream consumers still rely on these in this release.
      'sidekick-shared/dist/phrases': path.join(distDir, 'phrases.js'),
      'sidekick-shared/dist/providers/types': path.join(distDir, 'providers', 'types.js'),
    };
    for (const [specifier, resolvedPath] of Object.entries(expected)) {
      expect(pkgRequire.resolve(specifier)).toBe(resolvedPath);
    }
  });
});
