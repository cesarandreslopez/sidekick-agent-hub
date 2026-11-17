/**
 * `sidekick map --follow` in a terminal: the live activity map of the running
 * session, then its insights. See STORYBOARD.md.
 */
import { buildSandbox } from '../lib/generate.mjs';
import { Feeder } from '../lib/feeder.mjs';
import { openTerminal, TERMINAL_VIEWPORT } from '../lib/terminal.mjs';
import { installOverlay, caption, keycap } from '../lib/overlay.mjs';
import { Recorder } from '../lib/recorder.mjs';
import { LeakCheck } from '../lib/leakcheck.mjs';
import { CLI_BIN } from '../lib/sandbox.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = 'map-follow';

export async function record({ outDir }) {
  const { paths, live, files } = buildSandbox({ gapMs: 40_000 });
  const term = await openTerminal(paths, [process.execPath, CLI_BIN, 'map', '--follow', '--provider', 'claude-code', '--project', paths.project], { captionBand: 170 });
  const leak = new LeakCheck(name);
  const sample = async (where) => leak.check(where, await term.screenText());
  try {
    await sleep(2_500);
    await installOverlay(term.page, { scale: 2, captionBottom: 16 });
    await sample('map (before)');
    const rec = new Recorder(term.page, { dir: outDir, viewport: TERMINAL_VIEWPORT });
    const feeder = new Feeder({ files, entries: live, speed: 5.5, maxGapMs: 1_900 });
    await rec.start();
    const feeding = feeder.play();

    await sleep(200);
    await caption(term.page, 'sidekick map --follow');
    rec.still('map-follow-live', 3_000);
    await sleep(4_600);
    await sample('map live');

    await keycap(term.page, 'i');
    await term.page.keyboard.press('i');
    await sleep(500);
    await caption(term.page, 'Retries and slow steps, live');
    rec.still('map-follow-insights', 1_800);
    await sleep(3_800);
    await sample('insights');

    await caption(term.page, '');
    await sleep(400);
    await rec.stop();
    await Promise.race([feeding, sleep(100)]);
    return { recorder: rec, leak, encode: { name, loopFadeMs: 700 } };
  } finally {
    await term.close();
  }
}
