import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(__dirname, '..');
const distDir = path.join(pkgRoot, 'dist');
// Rooted at the package so require.resolve goes through the real `exports` map.
const pkgRequire = createRequire(path.join(pkgRoot, 'package.json'));

interface Closure {
  modules: Set<string>;
  externals: Set<string>;
}

/** Static `require()` graph of a built entry: package-relative modules and bare specifiers. */
async function requireClosure(entry: string): Promise<Closure> {
  const modules = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    const src = await fs.readFile(file, 'utf8');
    for (const match of src.matchAll(/require\(["']([^"']+)["']\)/g)) {
      const spec = match[1];
      if (!spec.startsWith('.')) {
        externals.add(spec.replace(/^node:/, ''));
        continue;
      }
      const base = path.resolve(path.dirname(file), spec);
      const resolved = [base, `${base}.js`, path.join(base, 'index.js')].find(
        (candidate) => candidate.endsWith('.js') && existsSync(candidate),
      );
      expect(resolved, `${file} requires ${spec}`).toBeDefined();
      queue.push(resolved!);
    }
  }
  return { modules, externals };
}

const NODE_RUNTIME = ['fs', 'child_process', 'http', 'https', 'net', 'tls', 'os', 'crypto'];

const SUBPATHS = [
  { name: 'pricing', pure: true, maxModules: 12 },
  { name: 'providerFailure', pure: true, maxModules: 1 },
  { name: 'statusline/payload', pure: true, maxModules: 3 },
  // 0.31: +1 for parsers/codexInheritedHistory (readCodexInheritedHistoryBoundary),
  // +1 for codexLayout (Codex home and rollout file-name helpers) and +1 for
  // mapWithConcurrency (bounded re-stats in the directory-listing cache).
  { name: 'codex', pure: false, maxModules: 17 },
  // Single-module entries for hosts that need only these constants or helpers.
  { name: 'providerIds', pure: true, maxModules: 1 },
  { name: 'handoffUrl', pure: true, maxModules: 1 },
  // 0.31: headless output parsers (TextDecoder only).
  { name: 'headless', pure: true, maxModules: 14 },
  // 0.31: dependency-free agent paths for hook bundles (Node built-ins only).
  { name: 'agentPaths', pure: false, maxModules: 5 },
  // 0.32: the activity map (records, reducer, insights, renderers). Pure and
  // Zod-free; the budget covers its own modules plus the shared helpers it
  // classifies with (tool categories, MCP names, subagents, turn state, shell).
  { name: 'activity', pure: true, maxModules: 30 },
  // 0.33: text token estimates as one module, for workers that load nothing else.
  { name: 'tokenEstimation', pure: true, maxModules: 1 },
  // 0.33: LiteLLM catalog hydration and observed context windows without the
  // /node graph: the pricing tables plus the config-dir and atomic-write helpers.
  { name: 'pricingHydration', pure: false, maxModules: 12 },
] as const;

describe('lean subpath entries', { timeout: 30_000 }, () => {
  for (const subpath of SUBPATHS) {
    describe(`sidekick-shared/${subpath.name}`, () => {
      const resolved = () => pkgRequire.resolve(`sidekick-shared/${subpath.name}`);

      it('resolves through the exports map, with types and an ESM build', () => {
        expect(resolved()).toBe(path.join(distDir, `${subpath.name}.js`));
        expect(existsSync(path.join(distDir, `${subpath.name}.d.ts`))).toBe(true);
        expect(existsSync(path.join(distDir, 'esm', `${subpath.name}.js`))).toBe(true);
      });

      it('stays small and never loads Zod or the root barrel', async () => {
        const { modules, externals } = await requireClosure(resolved());
        expect(modules.size).toBeLessThanOrEqual(subpath.maxModules);
        expect(modules.has(path.join(distDir, 'index.js'))).toBe(false);
        expect(externals.has('zod')).toBe(false);
        if (subpath.pure) {
          for (const builtin of NODE_RUNTIME) {
            expect(externals.has(builtin), `${subpath.name} requires ${builtin}`).toBe(false);
          }
        }
      });

      it('exports the same bindings as the package root', () => {
        const entry = pkgRequire(`sidekick-shared/${subpath.name}`) as Record<string, unknown>;
        const root = pkgRequire('sidekick-shared') as Record<string, unknown>;
        const names = Object.keys(entry);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          expect(root[name], `root export ${name}`).toBe(entry[name]);
        }
      });
    });
  }
});

// Hook bundles may load nothing beyond these: pin the exact closure.
describe('sidekick-shared/agentPaths closure', () => {
  it('loads exactly its five modules and only fs, os and path', async () => {
    const { modules, externals } = await requireClosure(
      pkgRequire.resolve('sidekick-shared/agentPaths'),
    );
    expect([...modules].map((file) => path.relative(distDir, file)).sort()).toEqual([
      'agentHomes.js',
      'agentPaths.js',
      'agentVersion.js',
      'claudePaths.js',
      'codexLayout.js',
    ]);
    for (const external of externals) {
      expect(['fs', 'os', 'path'], `agentPaths requires ${external}`).toContain(external);
    }
  });
});

// The hydration entry writes into the pricing tables `/pricing` reads, so a
// host can hydrate through one entry and price through the other.
describe('sidekick-shared/pricingHydration shares the pricing tables', { timeout: 30_000 }, () => {
  const probeModel = 'sidekick-hydration-probe-model';
  const catalog = {
    [probeModel]: {
      input_cost_per_token: 0.000007,
      output_cost_per_token: 0.000021,
      max_input_tokens: 123_456,
    },
  };
  const fetchCatalog = (async () =>
    new Response(JSON.stringify(catalog), { status: 200 })) as unknown as typeof fetch;

  it('is visible to sidekick-shared/pricing through require()', async () => {
    const hydration = pkgRequire('sidekick-shared/pricingHydration');
    const pricing = pkgRequire('sidekick-shared/pricing');
    const modelInfo = pkgRequire('sidekick-shared/dist/modelInfo');
    const modelContext = pkgRequire('sidekick-shared/dist/modelContext');
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-hydration-cjs-'));
    try {
      expect(pricing.getModelPricing(probeModel)).toBeNull();
      const result = await hydration.hydratePricingCatalog({ cacheDir, fetchImpl: fetchCatalog });
      expect(result.source).toBe('network');
      expect(pricing.getModelPricing(probeModel)).toMatchObject({
        inputCostPerMillion: 7,
        outputCostPerMillion: 21,
      });
      expect(hydration.getPricingCatalogInfo().digest).toBe(pricing.getPricingCatalogInfo().digest);
    } finally {
      modelInfo._clearPricingOverrides();
      modelContext._clearCatalogContextWindows();
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('is visible to sidekick-shared/pricing through import() in Node', async () => {
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidekick-hydration-esm-'));
    try {
      const script = [
        "const hydration = await import('sidekick-shared/pricingHydration');",
        "const pricing = await import('sidekick-shared/pricing');",
        `const catalog = ${JSON.stringify(catalog)};`,
        'const before = pricing.getModelPricing(process.env.PROBE_MODEL) ?? null;',
        'await hydration.hydratePricingCatalog({',
        '  cacheDir: process.env.PROBE_CACHE_DIR,',
        '  fetchImpl: async () => new Response(JSON.stringify(catalog), { status: 200 }),',
        '});',
        'const after = pricing.getModelPricing(process.env.PROBE_MODEL) ?? null;',
        'process.stdout.write(JSON.stringify({ before, after }));',
      ].join('\n');
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: pkgRoot,
        encoding: 'utf8',
        env: { ...process.env, PROBE_MODEL: probeModel, PROBE_CACHE_DIR: cacheDir },
      });
      const { before, after } = JSON.parse(stdout) as {
        before: unknown;
        after: { inputCostPerMillion: number; outputCostPerMillion: number } | null;
      };
      expect(before).toBeNull();
      expect(after).toMatchObject({ inputCostPerMillion: 7, outputCostPerMillion: 21 });
    } finally {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
