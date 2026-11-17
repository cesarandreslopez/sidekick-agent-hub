/**
 * The real VS Code, driven by Playwright, inside the demo sandbox.
 *
 * The extension is installed from a .vsix into the sandbox's own extensions
 * folder (an --extensionDevelopmentPath window titles itself "[Extension
 * Development Host]"), next to the recording-only network shim. VSCODE_CLI=1
 * stops VS Code re-reading the environment from a login shell, so the sandbox
 * HOME and config folders reach the extension host unchanged.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { DEMO_DIR, REPO_ROOT, sandboxEnv } from './sandbox.mjs';

const APP = '/Applications/Visual Studio Code.app';
const CODE_BIN = join(APP, 'Contents/MacOS/Code');
const CODE_CLI = join(APP, 'Contents/Resources/app/bin/code');
const VSCE = join(DEMO_DIR, 'node_modules/.bin/vsce');
export const VSCODE_VIEWPORT = { width: 1440, height: 810 };

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Package the extension and the shim when their inputs changed. */
export function ensureVsix() {
  const outDir = join(DEMO_DIR, 'out', 'vsix');
  mkdirSync(outDir, { recursive: true });
  const extDir = join(REPO_ROOT, 'sidekick-vscode');
  const version = JSON.parse(readFileSync(join(extDir, 'package.json'), 'utf8')).version;
  const sidekick = join(outDir, `sidekick-for-max-${version}.vsix`);
  // vsce runs vscode:prepublish (a production build); repackage when the source moved on.
  const newestSource = Math.max(mtime(join(extDir, 'package.json')), mtime(join(extDir, 'src')), mtime(join(extDir, 'out/extension.js')));
  if (mtime(sidekick) < newestSource) {
    execFileSync(VSCE, ['package', '-o', sidekick], { cwd: extDir, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  const shimDir = join(DEMO_DIR, 'vscode-shim');
  const shim = join(outDir, 'demo-network-shim-0.0.1.vsix');
  if (mtime(shim) < Math.max(mtime(join(shimDir, 'extension.js')), mtime(join(shimDir, 'package.json')))) {
    execFileSync(VSCE, ['package', '--allow-missing-repository', '--skip-license', '-o', shim], { cwd: shimDir, stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return { sidekick, shim };
}

/** Install both extensions into the sandbox and write its user settings. */
export function prepareVsCode(paths, { settings = {} } = {}) {
  const { sidekick, shim } = ensureVsix();
  execFileSync(
    CODE_CLI,
    ['--user-data-dir', paths.vscodeUserData, '--extensions-dir', paths.vscodeExtensions, '--install-extension', shim, '--install-extension', sidekick, '--force'],
    { env: sandboxEnv(paths, { VSCODE_CLI: '1', NODE_OPTIONS: '' }), stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const userDir = join(paths.vscodeUserData, 'User');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'settings.json'),
    JSON.stringify(
      {
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.startupEditor': 'none',
        'workbench.tips.enabled': false,
        'workbench.enableExperiments': false,
        'workbench.welcomePage.walkthroughs.openOnInstall': false,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.layoutControl.enabled': false,
        'window.commandCenter': true,
        'window.restoreWindows': 'none',
        'window.title': '${rootName}',
        'editor.minimap.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'extensions.ignoreRecommendations': true,
        'security.workspace.trust.enabled': false,
        'chat.disableAIFeatures': true,
        'git.enabled': false,
        'scm.diffDecorations': 'none',
        'sidekick.sessionProvider': 'claude-code',
        'sidekick.updateCheck.enabled': false,
        ...settings,
      },
      null,
      2,
    ),
  );
}

/** Launch VS Code on the demo project, retrying once (a cold first start can be slow). Returns { app, win }. */
export async function launchVsCode(paths) {
  try {
    return await launchOnce(paths);
  } catch (error) {
    console.warn(`  VS Code did not start (${error.message.split('\n')[0]}); retrying once`);
    return launchOnce(paths);
  }
}

async function launchOnce(paths) {
  const env = sandboxEnv(paths, { VSCODE_CLI: '1' });
  delete env.NODE_OPTIONS; // VS Code strips it from the extension host anyway; the shim extension covers that process.
  const app = await electron.launch({
    executablePath: CODE_BIN,
    args: [
      paths.project,
      `--user-data-dir=${paths.vscodeUserData}`,
      `--extensions-dir=${paths.vscodeExtensions}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-telemetry',
      '--disable-updates',
      '--new-window',
    ],
    env,
    timeout: 90_000,
  });
  // The first window Electron reports is not always the workbench; wait for the one that is.
  let win = null;
  const deadline = Date.now() + 60_000;
  while (!win && Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if (await candidate.$('.monaco-workbench').catch(() => null)) win = candidate;
    }
    if (!win) await sleep(500);
  }
  if (!win) {
    await app.close().catch(() => {});
    throw new Error('no VS Code workbench window within 60 s');
  }
  await app.evaluate(({ BrowserWindow }, size) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(size.width, size.height);
    w.center();
  }, VSCODE_VIEWPORT);
  return { app, win };
}

/** Run a command from the palette. */
export async function runCommand(win, title, { settleMs = 1_200 } = {}) {
  await win.keyboard.press('Meta+Shift+P');
  await win.waitForSelector('.quick-input-widget:not(.hidden) input', { timeout: 10_000 });
  await win.keyboard.type(title, { delay: 12 });
  await sleep(450);
  await win.keyboard.press('Enter');
  await sleep(settleMs);
}

/** All visible text in the workbench and every webview frame (for the leak check). */
export async function workbenchText(win) {
  const parts = [];
  for (const frame of win.frames()) {
    try {
      parts.push(await frame.evaluate(() => document.body?.innerText ?? ''));
    } catch {
      /* frame went away */
    }
  }
  return parts.join('\n');
}
