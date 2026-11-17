#!/usr/bin/env node
/**
 * Copy approved recordings into the repo.
 *
 *   node sync.mjs
 *
 * GIFs go to assets/demo/v1/ (the READMEs load them from raw.githubusercontent.com)
 * and docs/images/demo/v1/ (the docs site). Stills go to docs/images/demo/v1/,
 * and the few the READMEs use also to assets/demo/v1/. PNGs are quantized with
 * pngquant on the way. Every copy is checked byte-for-byte against its twin.
 *
 * The folder is versioned: a new set of recordings goes to v2/, and old files are
 * never deleted, because every published README (npm, Marketplace, Open VSX)
 * keeps pointing at the files that existed when it shipped.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEMO_DIR, REPO_ROOT } from './lib/sandbox.mjs';

const VERSION = 'v1';
const CLIPS = ['cli-dashboard', 'map-follow', 'vscode-tour'];
/** Stills the READMEs show (everything else is docs-only). */
const README_STILLS = [
  'vscode-activity-map.png',
  'vscode-session.png',
  'vscode-kanban.png',
  'vscode-mindmap.png',
  'vscode-timeline.png',
  'vscode-accounts.png',
  'html-report.png',
  'cli-map.png',
  'cli-quota.png',
  'cli-accounts.png',
];

const assets = join(REPO_ROOT, 'assets', 'demo', VERSION);
const docs = join(REPO_ROOT, 'docs', 'images', 'demo', VERSION);
const out = join(DEMO_DIR, 'out');
mkdirSync(assets, { recursive: true });
mkdirSync(docs, { recursive: true });

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const kb = (file) => `${Math.round(statSync(file).size / 1024)} KB`;

function quantize(src, dest) {
  try {
    execFileSync('pngquant', ['--quality=80-95', '--speed=1', '--strip', '--force', '--output', dest, src], { stdio: 'ignore' });
  } catch {
    copyFileSync(src, dest); // pngquant missing or refused (quality floor): keep the original
  }
}

const copied = [];
for (const clip of CLIPS) {
  const gif = join(out, clip, 'final', `${clip}.gif`);
  if (!existsSync(gif)) throw new Error(`missing ${gif}: record it first (node record.mjs ${clip})`);
  for (const dir of [assets, docs]) copyFileSync(gif, join(dir, `${clip}.gif`));
  copied.push(`${clip}.gif (${kb(gif)})`);
}

const stillDirs = [...CLIPS, 'screenshots'].map((c) => join(out, c, 'final', 'stills')).filter(existsSync);
for (const dir of stillDirs) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
    const dest = join(docs, file);
    quantize(join(dir, file), dest);
    if (README_STILLS.includes(file)) copyFileSync(dest, join(assets, file));
    copied.push(`${file} (${kb(dest)})`);
  }
}

// Every file in assets/demo/<v> must equal its docs twin.
for (const file of readdirSync(assets)) {
  if (!existsSync(join(docs, file)) || sha(join(assets, file)) !== sha(join(docs, file))) {
    throw new Error(`assets/demo/${VERSION}/${file} differs from docs/images/demo/${VERSION}/${file}`);
  }
}
for (const name of README_STILLS) if (!existsSync(join(assets, name))) throw new Error(`README still ${name} was not produced`);

console.log(`synced ${copied.length} files into assets/demo/${VERSION}/ and docs/images/demo/${VERSION}/:`);
for (const line of copied) console.log(`  ${line}`);
