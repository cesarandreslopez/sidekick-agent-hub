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

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewExplainCtx.watch(), webviewErrorCtx.watch(), webviewDashboardCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await webviewExplainCtx.rebuild();
    await webviewErrorCtx.rebuild();
    await webviewDashboardCtx.rebuild();
    await extensionCtx.dispose();
    await webviewExplainCtx.dispose();
    await webviewErrorCtx.dispose();
    await webviewDashboardCtx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
