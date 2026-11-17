#!/usr/bin/env node
/**
 * Record the README/docs demos.
 *
 *   node record.mjs                 every clip
 *   node record.mjs cli-dashboard   one clip (cli-dashboard, map-follow, vscode-tour)
 *   node record.mjs --keep          keep raw frames after encoding
 *   node record.mjs --skip-test     skip the generator test (generate.test.mjs) that runs first
 *
 * Each take runs in a fresh sandbox (lib/sandbox.mjs), fails if the leak check
 * finds anything on screen, then encodes to out/<clip>/final/: MP4, GIF, stills.
 * `node sync.mjs` copies approved finals into assets/ and docs/.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEMO_DIR } from './lib/sandbox.mjs';

const CLIPS = {
  'cli-dashboard': () => import('./directors/cli-dashboard.mjs'),
  'map-follow': () => import('./directors/map-follow.mjs'),
  'vscode-tour': () => import('./directors/vscode-tour.mjs'),
};

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const wanted = args.filter((a) => !a.startsWith('--'));
const clips = wanted.length ? wanted : Object.keys(CLIPS);

// The demo session must parse the way the clips rely on; never record a broken one.
if (!args.includes('--skip-test')) {
  const test = spawnSync(process.execPath, ['--test', 'generate.test.mjs'], { cwd: DEMO_DIR, stdio: 'inherit' });
  if (test.status !== 0) throw new Error('generate.test.mjs failed; fix the scenario or the generator before recording');
}

for (const clip of clips) {
  if (!CLIPS[clip]) throw new Error(`unknown clip "${clip}" (have: ${Object.keys(CLIPS).join(', ')})`);
  const director = await CLIPS[clip]();
  const outDir = join(DEMO_DIR, 'out', clip);
  mkdirSync(outDir, { recursive: true });
  console.log(`● ${clip}: recording`);
  const { recorder, leak, encode } = await director.record({ outDir });
  console.log(`  ${leak.assertClean()}`);
  console.log(`  ${recorder.frames.length} frames over ${(recorder.durationMs / 1000).toFixed(1)}s; encoding`);
  const result = recorder.encode(encode);
  console.log(`  ${result.gif} (${result.gifMb} MB), ${result.stills.length} stills`);
  if (result.gifMb > 4) console.warn(`  ! ${clip}.gif is over the 4 MB budget`);
  if (!keep) rmSync(join(outDir, 'frames'), { recursive: true, force: true });
}
