/**
 * VS Code tour: Session Analytics and the Activity Map following a live
 * session, the usage history, then the Accounts view. See STORYBOARD.md.
 */
import { buildSandbox } from '../lib/generate.mjs';
import { Feeder } from '../lib/feeder.mjs';
import { prepareVsCode, launchVsCode, runCommand, workbenchText, VSCODE_VIEWPORT } from '../lib/vscode.mjs';
import { installOverlay, caption, clickAt, moveCursor, hideCursor } from '../lib/overlay.mjs';
import { Recorder } from '../lib/recorder.mjs';
import { LeakCheck } from '../lib/leakcheck.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
/** Progress lines with DEMO_DEBUG=1, for finding where a take stalls. */
const step = (what) => process.env.DEMO_DEBUG && console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${what}`);

export const name = 'vscode-tour';

async function dashboardFrame(win) {
  for (let attempt = 0; attempt < 40; attempt++) {
    for (const frame of win.frames()) {
      try {
        const text = await frame.evaluate(() => document.body?.innerText ?? '');
        if (text.includes('Session Analytics') && text.includes('Provider')) return frame;
      } catch {
        /* detached */
      }
    }
    await sleep(250);
  }
  throw new Error('Session Analytics webview not found');
}

const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

export async function record({ outDir }) {
  const { paths, live, files } = buildSandbox({ gapMs: 45_000 });
  step('install extensions');
  prepareVsCode(paths);
  step('launch VS Code');
  const { app, win } = await launchVsCode(paths);
  const leak = new LeakCheck(name);
  const sample = async (where) => leak.check(where, await workbenchText(win));
  try {
    await sleep(4_000);
    await runCommand(win, 'Notifications: Clear All Notifications', { settleMs: 300 });
    await runCommand(win, 'View: Close All Editors', { settleMs: 300 });
    step('open Session Analytics');
    await runCommand(win, 'Sidekick: Open Session Dashboard', { settleMs: 2_500 });

    // A wider sidebar, so the dashboard shows its gauges side by side.
    const sash = await win.evaluate(() => {
      const r = [...document.querySelectorAll('.monaco-sash.vertical')]
        .map((s) => s.getBoundingClientRect())
        .find((b) => b.height > 400 && b.left > 200 && b.left < 600);
      return r ? { x: r.left + r.width / 2, y: r.top + 300 } : null;
    });
    if (sash) {
      await win.mouse.move(sash.x, sash.y);
      await win.mouse.down();
      await win.mouse.move(sash.x + 180, sash.y, { steps: 8 });
      await win.mouse.up();
    }
    step('find the dashboard webview');
    const dash = await dashboardFrame(win);
    const sessionsHeader = await dash.locator('text=Sessions').first().boundingBox();
    if (sessionsHeader) await win.mouse.click(sessionsHeader.x + 20, sessionsHeader.y + sessionsHeader.height / 2);
    await sleep(600);

    // The map in an editor tab beside it, so the first frame is already busy.
    step('open the Activity Map');
    await runCommand(win, 'Sidekick: Open Activity Map', { settleMs: 2_500 });
    await win.mouse.move(VSCODE_VIEWPORT.width - 40, VSCODE_VIEWPORT.height - 120);
    const editorLeft = await win.evaluate(() => document.querySelector('.part.editor')?.getBoundingClientRect().left ?? 540);
    await installOverlay(win, { scale: 1, captionBottom: 64, captionX: (editorLeft + 1440) / 2 });
    await sample('ready');

    const rec = new Recorder(win, { dir: outDir, viewport: VSCODE_VIEWPORT });
    const feeder = new Feeder({ files, entries: live, speed: 5, maxGapMs: 1_900 });
    step('start recording');
    await rec.start();
    const feeding = feeder.play();

    // 1. Quota and context, updating.
    await sleep(300);
    await caption(win, 'Quota and context, live');
    rec.still('vscode-session', 1_500);
    await sleep(3_200);
    await sample('session tab');

    // 2. Usage history.
    step('beat 2: History');
    const history = await dash.locator('text="History"').first().boundingBox();
    await clickAt(win, centre(history).x, centre(history).y);
    await sleep(400);
    await caption(win, 'Usage across days');
    rec.still('vscode-history', 1_400);
    await sleep(3_000);
    await sample('history tab');

    // 3. The activity map, closer.
    await hideCursor(win);
    await caption(win, 'Every tool call, mapped');
    rec.shot({ x: editorLeft + 10, y: 70, w: 1440 - editorLeft - 10 }, 1_100);
    rec.still('vscode-activity-map', 2_200);
    await sleep(4_300);
    await sample('activity map');
    rec.wide(900);
    await sleep(500);

    // 4. Accounts.
    step('beat 4: Accounts');
    const accounts = await win.locator('.pane-header:has-text("Accounts")').first().boundingBox();
    await clickAt(win, accounts.x + 60, accounts.y + accounts.height / 2);
    await sleep(500);
    await caption(win, 'Switch accounts in one click');
    step('hover Personal');
    const personal = await win.locator('.monaco-list-row:has-text("Personal")').first().boundingBox().catch(() => null);
    if (personal) await moveCursor(win, personal.x + personal.width - 60, personal.y + personal.height / 2, 800);
    rec.still('vscode-accounts', 1_200);
    await sleep(3_000);
    await sample('accounts');

    await caption(win, '');
    await sleep(500);
    step('stop recording');
    await rec.stop();
    await Promise.race([feeding, sleep(100)]);
    return { recorder: rec, leak, encode: { name, loopFadeMs: 800, gifFps: 12, gifQuality: 80 } };
  } finally {
    await app.close().catch(() => {});
  }
}
