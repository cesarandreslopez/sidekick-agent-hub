import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileContinuity } from './fileContinuity';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-continuity-'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Moves the mtime forward, as a later write on a coarse-clock filesystem would. */
function touchLater(target: string, ms = 5_000): void {
  fs.utimesSync(target, new Date(), new Date(Date.now() + ms));
}

/**
 * Runs one read cycle the way the readers do: open, fstat the descriptor,
 * check, adopt. `readOffset` / `committed` are the reader's positions before
 * this read; returns the reason and the file size (the new read position).
 */
function cycle(
  continuity: FileContinuity,
  readOffset: number,
  committed = readOffset,
): { reason: string | null; size: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const reason = continuity.check(fd, stat, readOffset, committed);
    continuity.adopt(stat);
    return { reason, size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

const LINE = '{"type":"user","n":1}\n';

describe('FileContinuity', () => {
  it('adopts a new file and continues while it is only appended to', () => {
    fs.writeFileSync(file, LINE);
    const continuity = new FileContinuity();
    const first = cycle(continuity, 0);
    expect(first.reason).toBeNull();
    expect(continuity.knownIdentity).not.toBeNull();
    expect(continuity.knownHead?.bytes).toBe(LINE.length);

    fs.appendFileSync(file, LINE);
    touchLater(file);
    expect(cycle(continuity, first.size).reason).toBeNull();
  });

  it('reports a same-size rewrite once the mtime moved', () => {
    fs.writeFileSync(file, LINE + LINE);
    const continuity = new FileContinuity();
    const { size } = cycle(continuity, 0);
    fs.writeFileSync(file, (LINE + LINE).replace('user', 'USER'));
    touchLater(file);
    expect(cycle(continuity, size).reason).toBe('rewritten');
    // Adopted: the rewritten file is now the known one.
    expect(cycle(continuity, 0).reason).toBeNull();
  });

  it('misses a same-size rewrite that kept the mtime (documented limit)', () => {
    fs.writeFileSync(file, LINE + LINE);
    // Whole seconds, so restoring the mtime below restores it exactly.
    const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(file, fixed, fixed);
    const continuity = new FileContinuity();
    const { size } = cycle(continuity, 0);
    fs.writeFileSync(file, (LINE + LINE).replace('user', 'USER'));
    fs.utimesSync(file, fixed, fixed);
    expect(cycle(continuity, size).reason).toBeNull();
  });

  it('reports a rewrite past the first 4 KiB when the resume point no longer follows a newline', () => {
    const head = `${'x'.repeat(5000)}\n`;
    fs.writeFileSync(file, head + LINE);
    const continuity = new FileContinuity();
    const { size } = cycle(continuity, 0);
    // Same head, longer second line: the old offset now lands mid-line.
    fs.writeFileSync(file, head + LINE.replace('user', 'user-longer') + LINE);
    touchLater(file);
    expect(cycle(continuity, size).reason).toBe('rewritten');
  });

  it('reports a rename-replace by identity, whatever the content', () => {
    fs.writeFileSync(file, LINE);
    const continuity = new FileContinuity();
    const { size } = cycle(continuity, 0);
    fs.writeFileSync(`${file}.next`, LINE + LINE);
    fs.renameSync(`${file}.next`, file);
    expect(cycle(continuity, size).reason).toBe('replaced');
  });

  it('reports a truncation without waiting for the mtime', () => {
    fs.writeFileSync(file, LINE + LINE);
    const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
    fs.utimesSync(file, fixed, fixed);
    const continuity = new FileContinuity();
    const { size } = cycle(continuity, 0);
    fs.writeFileSync(file, LINE);
    fs.utimesSync(file, fixed, fixed);
    expect(cycle(continuity, size).reason).toBe('truncated');
  });

  it('compares nothing after forget(): the next check adopts whatever file is there', () => {
    fs.writeFileSync(file, LINE);
    const continuity = new FileContinuity();
    cycle(continuity, 0);
    fs.writeFileSync(`${file}.next`, LINE.replace('user', 'USER') + LINE);
    fs.renameSync(`${file}.next`, file);
    continuity.forget();
    expect(continuity.knownIdentity).toBeNull();
    expect(cycle(continuity, LINE.length).reason).toBeNull();
    // ...but a position past the end is still a truncation.
    continuity.forget();
    expect(cycle(continuity, 10_000).reason).toBe('truncated');
  });

  it('re-records the head after a reset so a later rewrite is still caught', () => {
    fs.writeFileSync(file, LINE + LINE);
    const continuity = new FileContinuity();
    const { size } = cycle(continuity, 0);
    fs.writeFileSync(file, LINE);
    expect(cycle(continuity, size).reason).toBe('truncated');
    fs.writeFileSync(file, LINE.replace('user', 'USER'));
    touchLater(file);
    expect(cycle(continuity, LINE.length).reason).toBe('rewritten');
  });
});
