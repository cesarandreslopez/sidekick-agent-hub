/**
 * Stills that the video takes don't cover, for the docs: CLI Events, Charts and
 * Kanban panels, the HTML report, and VS Code's Kanban, Mind Map, Project Timeline
 * and Cost views.
 * Same sandbox and demo session as the clips; the live turn is played to the end
 * first so every view is populated. Writes 1600x900 PNGs to out/screenshots/final/stills/.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { buildSandbox, sidekick } from '../lib/generate.mjs';
import { Feeder } from '../lib/feeder.mjs';
import { openTerminal } from '../lib/terminal.mjs';
import { prepareVsCode, launchVsCode, runCommand, workbenchText } from '../lib/vscode.mjs';
import { LeakCheck } from '../lib/leakcheck.mjs';
import { CLI_BIN } from '../lib/sandbox.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const name = 'screenshots';

function toStill(src, dest) {
  execFileSync('sips', ['--resampleWidth', '1600', src, '--out', dest], { stdio: 'ignore' });
  rmSync(src, { force: true });
}

export async function capture({ outDir }) {
  const stills = join(outDir, 'final', 'stills');
  const raw = join(outDir, 'raw');
  mkdirSync(stills, { recursive: true });
  mkdirSync(raw, { recursive: true });
  const leak = new LeakCheck(name);
  const { paths, live, files } = buildSandbox({ gapMs: 45_000 });
  // Play the live turn up to its second to-do update, so the boards show work in
  // every column (done, in progress, pending) and the rest of the views are full.
  let todos = 0;
  await new Feeder({ files, entries: live, speed: 40, maxGapMs: 150 }).play({
    until: (e) => e.phase === 'tool_result' && e.line.message?.content?.[0]?.content === 'Todos have been modified successfully.' && ++todos === 2,
  });

  // CLI panels.
  const term = await openTerminal(paths, [process.execPath, CLI_BIN, 'dashboard', '--provider', 'claude-code', '--project', paths.project], { captionBand: 0 });
  try {
    await sleep(2_500);
    await term.page.keyboard.press('Enter');
    await sleep(2_500);
    for (const [key, file] of [['7', 'cli-events'], ['8', 'cli-charts'], ['3', 'cli-kanban']]) {
      await term.page.keyboard.press(key);
      await sleep(1_400);
      leak.check(file, await term.screenText());
      await term.page.screenshot({ path: join(raw, `${file}.png`) });
      toStill(join(raw, `${file}.png`), join(stills, `${file}.png`));
    }
  } finally {
    await term.close();
  }

  // HTML report, rendered in Chromium.
  const report = join(raw, 'report.html');
  sidekick(paths, ['report', '--no-open', '--output', report]);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 2, colorScheme: 'dark' });
    await page.goto(`file://${report}`);
    await sleep(1_500);
    leak.check('html-report', await page.evaluate(() => document.body.innerText));
    await page.screenshot({ path: join(raw, 'html-report.png') });
    toStill(join(raw, 'html-report.png'), join(stills, 'html-report.png'));
  } finally {
    await browser.close();
  }

  // VS Code views.
  prepareVsCode(paths);
  const { app, win } = await launchVsCode(paths);
  try {
    await sleep(4_000);
    await runCommand(win, 'Notifications: Clear All Notifications', { settleMs: 300 });
    await runCommand(win, 'View: Close All Editors', { settleMs: 300 });
    await runCommand(win, 'Sidekick: Open Session Dashboard', { settleMs: 2_500 });
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
    await sleep(800);

    // Cost: the Session tab's Cost view.
    let dash = null;
    for (const frame of win.frames()) {
      const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (text.includes('Session Analytics') && text.includes('Provider')) dash = frame;
    }
    const sessionsHeader = await dash.locator('text=Sessions').first().boundingBox();
    await win.mouse.click(sessionsHeader.x + 20, sessionsHeader.y + sessionsHeader.height / 2);
    await sleep(500);
    const cost = await dash.locator('text="Cost"').first().boundingBox();
    await win.mouse.click(cost.x + cost.width / 2, cost.y + cost.height / 2);
    await win.mouse.move(1400, 790);
    await sleep(1_500);
    leak.check('vscode-cost', await workbenchText(win));
    await win.screenshot({ path: join(raw, 'vscode-cost.png') });
    toStill(join(raw, 'vscode-cost.png'), join(stills, 'vscode-cost.png'));

    // Kanban and Mind Map get the whole sidebar: collapse Session Analytics, widen further.
    const analyticsHeader = await win.locator('.pane-header:has-text("Session Analytics")').first().boundingBox();
    await win.mouse.click(analyticsHeader.x + 60, analyticsHeader.y + analyticsHeader.height / 2);
    const sash2 = await win.evaluate(() => {
      const r = [...document.querySelectorAll('.monaco-sash.vertical')]
        .map((s) => s.getBoundingClientRect())
        .find((b) => b.height > 400 && b.left > 300 && b.left < 800);
      return r ? { x: r.left + r.width / 2, y: r.top + 300 } : null;
    });
    if (sash2) {
      await win.mouse.move(sash2.x, sash2.y);
      await win.mouse.down();
      await win.mouse.move(1150, sash2.y, { steps: 10 });
      await win.mouse.up();
    }
    for (const [title, file] of [['Sidekick: Open Kanban Board', 'vscode-kanban'], ['Sidekick: Open Mind Map', 'vscode-mindmap'], ['Project Timeline: Focus on Project Timeline View', 'vscode-timeline']]) {
      // Show only the view being captured.
      for (const other of ['Kanban Board', 'Mind Map', 'Project Timeline']) {
        const header = win.locator(`.pane-header.expanded:has-text("${other}")`).first();
        if (await header.count()) await header.click();
      }
      await runCommand(win, title, { settleMs: 3_000 });
      if (file === 'vscode-kanban') {
        // Fold Pending so In Progress and Done are in view.
        for (const frame of win.frames()) {
          const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
          if (!text.includes('Kanban Board') || !text.includes('PENDING')) continue;
          const collapse = frame.locator('text=Collapse').first();
          if (await collapse.count()) await collapse.click();
        }
        await sleep(600);
      }
      await win.mouse.move(1430, 800);
      await sleep(1_000);
      leak.check(file, await workbenchText(win));
      // Just the activity bar and the sidebar: the empty editor beside them adds nothing.
      const sidebar = await win.evaluate(() => {
        const r = document.querySelector('.part.sidebar')?.getBoundingClientRect();
        return r ? { x: 0, y: 0, width: Math.round(r.right + 4), height: Math.round(document.documentElement.clientHeight) } : null;
      });
      await win.screenshot({ path: join(raw, `${file}.png`), ...(sidebar ? { clip: sidebar } : {}) });
      toStill(join(raw, `${file}.png`), join(stills, `${file}.png`));
    }
  } finally {
    await app.close().catch(() => {});
  }
  rmSync(raw, { recursive: true, force: true });
  return { leak, stills };
}
