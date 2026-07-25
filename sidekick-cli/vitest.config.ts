import { defineConfig } from 'vitest/config';

export default defineConfig({
  // esbuild injects this at build time; without it any test that imports
  // cli.ts or StatusBar.tsx dies on a ReferenceError. `define` is a Vite root
  // option — nested under `test` it is silently ignored, so the guard was inert.
  define: { __CLI_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    globals: true,
    environment: 'node',
    // .tsx must be listed explicitly — "*.test.ts" does not match "*.test.tsx",
    // which silently excluded every component-level test from the run.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules', 'dist'],
    },
  },
});
