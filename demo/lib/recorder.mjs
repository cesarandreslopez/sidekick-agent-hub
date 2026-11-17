/**
 * Records a page with the CDP screencast, in real time, so the page's own
 * transitions are what they are. Frames land as JPEGs with their arrival time;
 * camera moves and still markers are noted against the same clock. encode()
 * hands it all to encode.swift (MP4 + PNG stills) and gifski (GIF).
 */
import { mkdirSync, rmSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEMO_DIR } from './sandbox.mjs';

export class Recorder {
  constructor(page, { dir, viewport }) {
    this.page = page;
    this.dir = dir;
    this.viewport = viewport;
    this.frames = [];
    this.camera = [];
    this.stills = [];
    this.t0 = 0;
  }

  /** Milliseconds since the recording started. */
  now() {
    return Date.now() - this.t0;
  }

  async start() {
    rmSync(join(this.dir, 'frames'), { recursive: true, force: true });
    mkdirSync(join(this.dir, 'frames'), { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    let n = 0;
    this.cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const file = `frames/f-${String(n++).padStart(5, '0')}.jpg`;
      writeFileSync(join(this.dir, file), Buffer.from(data, 'base64'));
      const arrived = metadata.timestamp ? metadata.timestamp * 1000 : Date.now();
      this.frames.push({ file, t: Math.max(0, arrived - this.t0) });
      await this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    this.t0 = Date.now();
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    // Nudge a repaint so frame 0 exists even if the page is idle.
    await this.page.evaluate(() => document.body.getBoundingClientRect()).catch(() => {});
  }

  /** Ease the camera to a rect (CSS px; height follows 16:9) over `d` ms, starting now. */
  shot({ x = 0, y = 0, w = this.viewport.width }, d = 900) {
    this.camera.push({ t: this.now(), d, x, y, w });
  }

  /** Full frame again. */
  wide(d = 900) {
    this.shot({ x: 0, y: 0, w: this.viewport.width }, d);
  }

  /** Mark a still to export at the current moment. */
  still(name, offsetMs = 0) {
    this.stills.push({ t: this.now() + offsetMs, name });
  }

  async stop() {
    this.durationMs = this.now();
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }

  /**
   * Encode the take. Returns the paths written: `<name>.mp4`, `<name>.gif`, and
   * one PNG per still under `stills/`.
   */
  encode({ name, fps = 30, width = 1920, height = 1080, bitrate = 3_000_000, gifWidth = 960, gifFps = 12, gifQuality = 82, loopFadeMs = 700, trimStartMs = 0 }) {
    const outDir = join(this.dir, 'final');
    // Only this take's stills: a director whose beats changed must not leave old ones behind.
    rmSync(join(outDir, 'stills'), { recursive: true, force: true });
    mkdirSync(join(outDir, 'stills'), { recursive: true });
    const shift = (t) => Math.max(0, t - trimStartMs);
    const frames = this.frames
      .map((f) => ({ ...f, t: shift(f.t) }))
      .filter((f, i, all) => f.t > 0 || all.findLastIndex((g) => g.t === 0) === i);
    const timeline = {
      frames,
      camera: this.camera.map((c) => ({ ...c, t: shift(c.t) })),
      viewport: this.viewport,
      durationMs: this.durationMs - trimStartMs,
      out: join(outDir, `${name}.mp4`),
      width,
      height,
      fps,
      bitrate,
      stills: this.stills.map((s) => ({ t: shift(s.t), file: join(outDir, 'stills', `${s.name}.png`) })),
      stillWidth: 1600,
      loopFadeMs,
    };
    const timelinePath = join(this.dir, 'timeline.json');
    writeFileSync(timelinePath, JSON.stringify(timeline, null, 1));
    execFileSync('swift', [join(DEMO_DIR, 'encode.swift'), timelinePath], { stdio: ['ignore', 'inherit', 'pipe'] });
    // AVAssetWriter can leave `<name>.mp4.sb-*` scratch files beside its output.
    for (const f of readdirSync(outDir)) if (f.startsWith(`${name}.mp4.sb-`)) rmSync(join(outDir, f), { force: true });
    const gif = join(outDir, `${name}.gif`);
    execFileSync('gifski', ['--quiet', '--fps', String(gifFps), '--width', String(gifWidth), '--quality', String(gifQuality), '-o', gif, timeline.out], { stdio: 'inherit' });
    const sizeMb = statSync(gif).size / 1_048_576;
    return { mp4: timeline.out, gif, gifMb: Number(sizeMb.toFixed(2)), stills: timeline.stills.map((s) => s.file) };
  }
}
