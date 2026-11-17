#!/usr/bin/env node
/**
 * A local page for reviewing a recording pass before anything is synced or
 * committed: each clip's GIF (as the READMEs show it), its MP4, its stills,
 * sizes, and the GIF it replaces.
 *
 *   node review.mjs          writes out/review.html and opens it
 *   node review.mjs --no-open
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEMO_DIR, REPO_ROOT } from './lib/sandbox.mjs';

const CLIPS = [
  {
    name: 'cli-dashboard',
    title: 'Hero: the terminal dashboard',
    replaces: 'assets/sidekick-cli.gif',
    usedIn: 'Root README (hero), npm README, docs home, CLI docs',
    beats: ['Live session: tokens, cost and context tick', 'Tab, G: quota and the five-hour billing block', '9: the activity map, live', '⏎ ]: Insights (where the time went)', 'A: accounts overlay'],
  },
  {
    name: 'map-follow',
    title: 'sidekick map --follow',
    replaces: null,
    usedIn: 'Root README (terminal section), activity-map docs',
    beats: ['The live map of the running session', 'i: insights (faults, retries, slow steps)'],
  },
  {
    name: 'vscode-tour',
    title: 'VS Code tour',
    replaces: 'assets/sidekick-agent-hub.gif',
    usedIn: 'Root README (VS Code section), Marketplace/Open VSX README, docs home, quick start',
    beats: ['Session Analytics and the Activity Map, live', 'History tab: usage across days', 'Camera on the activity map', 'Accounts view, hovering an account'],
  },
];

const mb = (file) => (statSync(file).size / 1_048_576).toFixed(2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const outDir = join(DEMO_DIR, 'out');
const rel = (file) => relative(outDir, file);

const sections = CLIPS.map((clip) => {
  const dir = join(outDir, clip.name, 'final');
  const gif = join(dir, `${clip.name}.gif`);
  const mp4 = join(dir, `${clip.name}.mp4`);
  if (!existsSync(gif)) return `<section><h2>${esc(clip.title)}</h2><p class="missing">Not recorded yet: <code>node record.mjs ${clip.name}</code></p></section>`;
  const stillsDir = join(dir, 'stills');
  const stills = existsSync(stillsDir) ? readdirSync(stillsDir).filter((f) => f.endsWith('.png')).sort() : [];
  const old = clip.replaces ? join(REPO_ROOT, clip.replaces) : null;
  const over = Number(mb(gif)) > 4;
  return `
<section>
  <h2>${esc(clip.title)} <span class="file">${esc(clip.name)}.gif</span></h2>
  <p class="meta"><b class="${over ? 'bad' : 'ok'}">${mb(gif)} MB</b> GIF (budget 4 MB) · ${mb(mp4)} MB MP4 · used in: ${esc(clip.usedIn)}</p>
  <ol class="beats">${clip.beats.map((b) => `<li>${esc(b)}</li>`).join('')}</ol>
  <div class="row">
    <figure class="main"><img src="${esc(rel(gif))}" alt="${esc(clip.title)}"><figcaption>New GIF, as the READMEs show it</figcaption></figure>
  </div>
  <details><summary>MP4 (docs site)</summary><video src="${esc(rel(mp4))}" controls loop muted playsinline></video></details>
  ${old && existsSync(old) ? `<details><summary>The GIF it replaces (${esc(clip.replaces)}, ${mb(old)} MB)</summary><img class="old" src="${esc(relative(outDir, old))}" alt="old"></details>` : ''}
  ${stills.length ? `<h3>Stills</h3><div class="stills">${stills.map((s) => `<figure><img src="${esc(rel(join(stillsDir, s)))}" alt="${esc(s)}"><figcaption>${esc(s)}</figcaption></figure>`).join('')}</div>` : ''}
</section>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo Review</title>
<style>
  :root { --bg: #0f1117; --panel: #171a22; --text: #e6e6ef; --muted: #9aa0b4; --accent: #c4a7e7; --ok: #7fd18b; --bad: #ff7a7a; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 32px 16px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 20px; margin: 0 0 6px; } h3 { font-size: 15px; color: var(--muted); margin: 18px 0 8px; }
  .lead { color: var(--muted); margin: 0 0 28px; }
  section { background: var(--panel); border-radius: 14px; padding: 22px; margin: 0 0 28px; }
  .file { font: 13px "SF Mono", Menlo, monospace; color: var(--accent); margin-left: 8px; }
  .meta { color: var(--muted); margin: 0 0 8px; } .ok { color: var(--ok); } .bad { color: var(--bad); }
  .beats { color: var(--muted); margin: 0 0 14px; padding-left: 20px; }
  figure { margin: 0; } figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .main img { width: 100%; max-width: 960px; border-radius: 8px; display: block; }
  video, .old { width: 100%; max-width: 960px; border-radius: 8px; margin-top: 10px; }
  details { margin-top: 12px; } summary { cursor: pointer; color: var(--accent); }
  .stills { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .stills img { width: 100%; border-radius: 6px; display: block; }
  .missing { color: var(--bad); }
</style></head>
<body><main>
<h1>Demo recordings: review</h1>
<p class="lead">Local only. Recorded in the demo sandbox (no real sessions, accounts or credentials) on ${esc(new Date().toLocaleString())}. Nothing here is synced into the repo until approved (<code>node sync.mjs</code>).</p>
${sections}
</main></body></html>`;

const file = join(outDir, 'review.html');
writeFileSync(file, html);
console.log(file);
if (!process.argv.includes('--no-open')) execFileSync('open', [file]);
