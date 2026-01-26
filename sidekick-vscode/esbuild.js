const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Copy CSS files to output directory
 */
function copyWebviewAssets() {
  const srcCss = path.join(__dirname, 'src', 'webview', 'styles.css');
  const outDir = path.join(__dirname, 'out', 'webview');
  const outCss = path.join(outDir, 'styles.css');

  // Ensure output directory exists
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // Copy CSS file
  fs.copyFileSync(srcCss, outCss);
  console.log('Copied styles.css to out/webview/');
}

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

  // Webview context - RSVP (Browser)
  const webviewRsvpCtx = await esbuild.context({
    entryPoints: ['src/webview/rsvp.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'out/webview/rsvp.js',
    target: ['es2020'],
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

  // Copy webview assets (CSS files)
  copyWebviewAssets();

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewRsvpCtx.watch(), webviewExplainCtx.watch(), webviewErrorCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await webviewRsvpCtx.rebuild();
    await webviewExplainCtx.rebuild();
    await webviewErrorCtx.rebuild();
    await extensionCtx.dispose();
    await webviewRsvpCtx.dispose();
    await webviewExplainCtx.dispose();
    await webviewErrorCtx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
