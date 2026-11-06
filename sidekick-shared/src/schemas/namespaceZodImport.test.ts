import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const esmSchemasDir = path.resolve(__dirname, '..', '..', 'dist', 'esm', 'schemas');

// esbuild cannot tree-shake Zod's `z` namespace object when it is imported by
// name, so `import { z } from 'zod'` drags every Zod locale (~230 KB minified)
// into consumer bundles. The namespace form keeps member accesses shakeable.
// ESLint guards the source; this guards what is actually published.
describe('published ESM schemas import Zod as a namespace', () => {
  it('never emits a named or default Zod import', async () => {
    expect(existsSync(esmSchemasDir), 'build sidekick-shared first').toBe(true);
    const files = (await fs.readdir(esmSchemasDir)).filter((file) => file.endsWith('.js'));
    let zodImporters = 0;
    for (const file of files) {
      const code = await fs.readFile(path.join(esmSchemasDir, file), 'utf8');
      expect(code, `${file} imports { z }`).not.toMatch(
        /import\s*\{[^}]*\bz\b[^}]*\}\s*from\s*['"]zod/,
      );
      expect(code, `${file} default-imports zod`).not.toMatch(
        /import\s+[A-Za-z_$][\w$]*\s*(?:,|from)\s*['"]zod/,
      );
      if (/import \* as z from ['"]zod['"]/.test(code)) zodImporters += 1;
    }
    expect(zodImporters).toBeGreaterThanOrEqual(12);
  });
});
