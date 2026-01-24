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

  // Webview context (Browser)
  const webviewCtx = await esbuild.context({
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

  // Copy webview assets (CSS files)
  copyWebviewAssets();

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
