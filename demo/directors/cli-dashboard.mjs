/**
 * Hero clip: `sidekick dashboard` following a live session.
 *
 * Beats (see STORYBOARD.md): Summary with tokens and context ticking → quota
 * and the billing block → the Map, then its Insights → the accounts overlay.
 */
import { buildSandbox } from '../lib/generate.mjs';
import { Feeder } from '../lib/feeder.mjs';
import { openTerminal, TERMINAL_VIEWPORT } from '../lib/terminal.mjs';
import { installOverlay, caption, keycap } from '../lib/overlay.mjs';
import { Recorder } from '../lib/recorder.mjs';
import { LeakCheck } from '../lib/leakcheck.mjs';
import { CLI_BIN } from '../lib/sandbox.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForText(term, needle, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await term.screenText()).includes(needle)) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for "${needle}" on screen`);
}

export const name = 'cli-dashboard';

export async function record({ outDir }) {
  const { paths, live, files } = buildSandbox({ gapMs: 50_000 });
  const term = await openTerminal(paths, [process.execPath, CLI_BIN, 'dashboard', '--provider', 'claude-code', '--project', paths.project], { captionBand: 170 });
  const leak = new LeakCheck(name);
  const sample = async (where) => leak.check(where, await term.screenText());
  const press = async (key, label = key) => {
    await keycap(term.page, label);
    await term.page.keyboard.press(key);
  };
  try {
    // The picker opens on the newest session; choosing it follows that session live.
    await waitForText(term, 'storefront', 20_000).catch(() => {});
    await sleep(800);
    await sample('picker');
    await term.page.keyboard.press('Enter');
    await waitForText(term, 'Tokens');
    await sleep(1_500);
    await installOverlay(term.page, { scale: 2, captionBottom: 16 });
    await sample('summary (before)');

    const rec = new Recorder(term.page, { dir: outDir, viewport: TERMINAL_VIEWPORT });
    const feeder = new Feeder({ files, entries: live, speed: 5.5, maxGapMs: 2_000 });
    await rec.start();
    const feeding = feeder.play();

    await sleep(250);
    await caption(term.page, 'See every tool call');
    rec.still('cli-summary', 2_600);
    await sleep(3_400);
    await sample('summary');

    // Cost: scroll the summary to quota and the billing block.
    await press('Tab');
    await sleep(250);
    await press('G');
    await sleep(500);
    await caption(term.page, 'Know what it costs');
    rec.shot({ x: 545, y: 150, w: 1760 }, 900);
    rec.still('cli-quota', 1_800);
    await sleep(2_800);
    await sample('quota');
    rec.wide(700);

    await press('9');
    await sleep(700);
    await caption(term.page, 'What the agent touches');
    rec.still('cli-map', 1_600);
    await sleep(2_600);
    await sample('map');
    await press('Enter', '⏎');
    await sleep(350);
    await press(']');
    await sleep(600);
    await caption(term.page, 'Where the time went');
    rec.shot({ x: 520, y: 100, w: 1900 }, 900);
    rec.still('cli-insights', 1_700);
    await sleep(2_700);
    await sample('insights');

    rec.wide(700);
    await press('Escape', 'esc');
    await sleep(300);
    await press('A');
    await sleep(700);
    await caption(term.page, 'Switch accounts without logging out');
    rec.still('cli-accounts', 1_200);
    await sleep(2_600);
    await sample('accounts');

    await caption(term.page, '');
    await sleep(500);
    await rec.stop();
    await Promise.race([feeding, sleep(100)]);
    return { recorder: rec, leak, encode: { name, loopFadeMs: 800 } };
  } finally {
    await term.close();
  }
}
