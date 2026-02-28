const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  // Extension context (Node.js)
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'out/extension.js',
    external: ['vscode'],
    conditions: ['import'],
    // Polyfill import.meta.url for ESM deps bundled into CJS.
    // Needed so createRequire(import.meta.url) inside bundled SDKs
    // resolves to the bundle's filesystem path (not undefined).
    banner: { js: 'var import_meta_url = require("url").pathToFileURL(__filename).href;' },
    define: { 'import.meta.url': 'import_meta_url' },
    logLevel: 'warning',
  });

  // Webview context - Explain (Browser)
  const webviewExplainCtx = await esbuild.context({
    entryPoints: ['src/webview/explain.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'out/webview/explain.js',
    target: ['es2020'],
    logLevel: 'warning',
  });

  // Webview context - Error (Browser)
  const webviewErrorCtx = await esbuild.context({
    entryPoints: ['src/webview/error.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'out/webview/error.js',
    target: ['es2020'],
    logLevel: 'warning',
  });

  // Webview context - Dashboard (Browser)
  const webviewDashboardCtx = await esbuild.context({
    entryPoints: ['src/webview/dashboard.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'out/webview/dashboard.js',
    target: ['es2020'],
    logLevel: 'warning',
  });

  // Webview vendor bundle - Chart.js (Browser)
  const webviewChartjsCtx = await esbuild.context({
    entryPoints: ['src/webview/chartjs-vendor.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'out/webview/chartjs-vendor.js',
    target: ['es2020'],
    logLevel: 'warning',
  });

  // Webview vendor bundle - D3.js (Browser)
  const webviewD3Ctx = await esbuild.context({
    entryPoints: ['src/webview/d3-vendor.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'out/webview/d3-vendor.js',
    target: ['es2020'],
    logLevel: 'warning',
  });

  const allContexts = [extensionCtx, webviewExplainCtx, webviewErrorCtx, webviewDashboardCtx, webviewChartjsCtx, webviewD3Ctx];

  if (watch) {
    await Promise.all(allContexts.map(ctx => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(allContexts.map(ctx => ctx.rebuild()));
    await Promise.all(allContexts.map(ctx => ctx.dispose()));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
