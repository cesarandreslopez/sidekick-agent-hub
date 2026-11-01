import { createRequire } from 'node:module';
import { existsSync, promises as fs } from 'node:fs';
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
  { name: 'providerFailure', pure: true, maxModules: 3 },
  { name: 'statusline/payload', pure: true, maxModules: 3 },
  { name: 'codex', pure: false, maxModules: 14 },
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
