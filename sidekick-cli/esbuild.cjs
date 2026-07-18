const { build } = require('esbuild');
const pkg = require('./package.json');

// Stub out react-devtools-core (optional Ink dev dependency, not installed)
const stubDevtools = {
  name: 'stub-react-devtools-core',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default undefined;',
    }));
  },
};

async function main() {
  const common = {
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    banner: {
      js: [
        'import { createRequire as __createRequire } from "module";',
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
    define: {
      __CLI_VERSION__: JSON.stringify(pkg.version),
    },
    loader: { '.md': 'text' },
    plugins: [stubDevtools],
    jsx: 'automatic',
    jsxImportSource: 'react',
    sourcemap: false,
    minify: true,
  };
  await build({
    ...common,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/sidekick-main.mjs',
  });
  await build({
    ...common,
    entryPoints: ['src/entry.ts'],
    outfile: 'dist/sidekick-cli.mjs',
    external: ['./sidekick-main.mjs'],
    banner: {
      js: ['#!/usr/bin/env node', common.banner.js].join('\n'),
    },
  });
}

main().catch(() => process.exit(1));
