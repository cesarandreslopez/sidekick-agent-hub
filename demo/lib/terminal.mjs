/**
 * A real terminal in Chromium: ttyd runs a command inside the sandbox and serves
 * it over xterm.js. The page is 2560x1440 CSS px at device scale 1 with a 34 px
 * font, which renders the same ~120x31 grid as a 1280x720 page at 2x without
 * xterm's WebGL renderer mis-scaling at devicePixelRatio 2. The font is bundled
 * and declared before xterm starts, then re-applied once loaded so the cell
 * metrics come from it rather than from a fallback. A band under the terminal
 * (`captionBand` px, terminal background) holds the captions, so they never
 * cover the app.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { DEMO_DIR, sandboxEnv } from './sandbox.mjs';

export const TERMINAL_VIEWPORT = { width: 2560, height: 1440 };
const FONT_SIZE = 34;
const THEME = {
  background: '#16161e',
  foreground: '#c0caf5',
  cursor: '#16161e',
  selectionBackground: '#33467c',
};

function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const fontData = (weight) =>
  readFileSync(join(DEMO_DIR, `node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-${weight}-normal.woff2`)).toString('base64');

/**
 * Start `command` (argv) in a terminal page. Returns { page, browser, close }.
 */
export async function openTerminal(paths, command, { cwd = paths.project, env = {}, captionBand = 150 } = {}) {
  const port = await freePort();
  const ttyd = spawn(
    'ttyd',
    [
      '-p', String(port), '-i', '127.0.0.1', '-W', '-o',
      '-t', 'disableLeaveAlert=true',
      '-t', 'disableResizeOverlay=true',
      '-t', 'rendererType=webgl',
      '-t', `fontSize=${FONT_SIZE}`,
      '-t', 'fontFamily=JBM, Menlo, monospace',
      '-t', 'cursorBlink=false',
      '-t', `theme=${JSON.stringify(THEME)}`,
      ...command,
    ],
    { cwd, env: sandboxEnv(paths, env), stdio: ['ignore', 'ignore', process.env.DEBUG ? 'inherit' : 'ignore'] },
  );
  await new Promise((r) => setTimeout(r, 700));

  // A page fulfilled through route() counts as public to Chromium, which then blocks
  // its WebSocket to 127.0.0.1 under Local Network Access; turn that check off.
  const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'] });
  const context = await browser.newContext({ viewport: TERMINAL_VIEWPORT, deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await context.newPage();
  const url = `http://127.0.0.1:${port}/`;
  const regular = fontData(400);
  const bold = fontData(700);
  await page.route(url, async (route) => {
    const res = await route.fetch();
    const css = `<style>@font-face{font-family:'JBM';font-weight:400;src:url(data:font/woff2;base64,${regular}) format('woff2');}@font-face{font-family:'JBM';font-weight:700;src:url(data:font/woff2;base64,${bold}) format('woff2');}html,body{background:${THEME.background};}#terminal-container{height:calc(100% - ${captionBand}px)!important;}</style>`;
    const html = (await res.text()).replace('<head>', `<head>${css}`);
    await route.fulfill({ response: res, body: html, headers: { ...res.headers(), 'content-type': 'text/html' } });
  });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.term), null, { timeout: 15_000 });
  await page.evaluate(async (size) => {
    await document.fonts.load(`${size}px JBM`);
    await document.fonts.load(`bold ${size}px JBM`);
    const t = window.term;
    t.options.fontFamily = 'monospace';
    t.options.fontFamily = 'JBM, Menlo, monospace';
    t.options.fontSize = size;
    window.dispatchEvent(new Event('resize'));
  }, FONT_SIZE);
  await page.waitForTimeout(500);
  const grid = await page.evaluate(() => ({ cols: window.term.cols, rows: window.term.rows }));

  return {
    page,
    browser,
    grid,
    /** Text currently on screen (for the leak check). */
    screenText: () =>
      page.evaluate(() => {
        const b = window.term.buffer.active;
        const out = [];
        for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
        return out.join('\n');
      }),
    async close() {
      await browser.close().catch(() => {});
      ttyd.kill('SIGTERM');
    },
  };
}
