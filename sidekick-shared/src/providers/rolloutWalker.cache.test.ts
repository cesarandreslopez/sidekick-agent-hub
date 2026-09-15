import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const calls = vi.hoisted(() => ({ readdir: [] as string[] }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: ((...args: Parameters<typeof actual.promises.readdir>) => {
        calls.readdir.push(String(args[0]));
        return (actual.promises.readdir as (...a: unknown[]) => unknown)(...args);
      }) as typeof actual.promises.readdir,
    },
  };
});

import { DirectoryListingCache } from './directoryListingCache';
import { isDatedDirectoryBefore, walkRolloutFilesAsync } from './rolloutWalker';

const HOUR_MS = 60 * 60_000;

function uuid(seed: number): string {
  return `019d86b0-b20c-7b02-a3b2-${String(seed).padStart(12, '0')}`;
}

function ageDirectory(dir: string, ageMs = HOUR_MS): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
}

function writeRollout(root: string, day: [string, string, string], seed: number, mtime: Date) {
  const dir = path.join(root, ...day);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-${day.join('')}-${uuid(seed)}.jsonl`);
  fs.writeFileSync(filePath, '{"type":"session_meta"}\n');
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

/** Age every directory in the tree so listings are trusted on the second walk. */
function ageTree(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) ageTree(path.join(dir, entry.name));
  }
  ageDirectory(dir);
}

describe('walkRolloutFilesAsync with bounds and a directory cache', () => {
  let tmpDir: string;
  let root: string;
  const base = Date.parse('2026-09-05T12:00:00Z');
  const days: Array<[string, string, string]> = [
    ['2026', '09', '01'],
    ['2026', '09', '02'],
    ['2026', '09', '03'],
    ['2026', '09', '04'],
    ['2026', '09', '05'],
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-rollout-cache-'));
    root = path.join(tmpDir, 'sessions');
    days.forEach((day, index) => {
      writeRollout(root, day, index * 2 + 1, new Date(base - (4 - index) * 86_400_000));
      writeRollout(root, day, index * 2 + 2, new Date(base - (4 - index) * 86_400_000 - 1_000));
    });
    ageTree(root);
    calls.readdir.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('limit lists only the newest dated directories', async () => {
    const files = await walkRolloutFilesAsync([root], { limit: 3 });
    expect(files).toHaveLength(3);
    expect(files.map((file) => path.basename(path.dirname(file.path)))).toEqual(['05', '05', '04']);
    const listed = calls.readdir.map((dir) => path.relative(root, dir)).filter(Boolean);
    expect(listed).toEqual([
      '2026',
      path.join('2026', '09'),
      path.join('2026', '09', '05'),
      path.join('2026', '09', '04'),
    ]);
  });

  it('since prunes dated directories that ended before it and drops older files', async () => {
    const since = base - 0.5 * 86_400_000; // 2026-09-05T00:00Z
    const files = await walkRolloutFilesAsync([root], { since });
    expect(files.map((file) => path.basename(path.dirname(file.path)))).toEqual(['05', '05']);
    const listed = calls.readdir.map((dir) => path.relative(root, dir)).filter(Boolean);
    // 04 (and, depending on the zone, 03) sit inside the one-day slack: listed, then filtered by mtime.
    expect(listed).not.toContain(path.join('2026', '09', '02'));
    expect(listed).not.toContain(path.join('2026', '09', '01'));
  });

  it('a warm cache walks an unchanged tree with no readdir and reports counters', async () => {
    const cache = new DirectoryListingCache();
    const cold = {};
    const first = await walkRolloutFilesAsync([root], { cache, stats: cold });
    expect(first).toHaveLength(10);
    expect(cold).toMatchObject({ directoriesListed: 8, filesStatted: 10 });

    calls.readdir.length = 0;
    const warm = {};
    const second = await walkRolloutFilesAsync([root], { cache, stats: warm });
    expect(second.map((file) => file.path)).toEqual(first.map((file) => file.path));
    expect(calls.readdir).toEqual([]);
    expect(warm).toEqual({ directoriesStatted: 8 });
  });

  it('a warm cache still sees a rollout added to a dated directory', async () => {
    const cache = new DirectoryListingCache();
    await walkRolloutFilesAsync([root], { cache });
    const added = writeRollout(root, ['2026', '09', '05'], 99, new Date(base + 60_000));
    ageDirectory(path.join(root, '2026', '09', '05'), HOUR_MS / 2);
    const files = await walkRolloutFilesAsync([root], { cache });
    expect(files[0].path).toBe(added);
    expect(files).toHaveLength(11);
  });
});

describe('isDatedDirectoryBefore', () => {
  const since = Date.parse('2026-09-05T00:00:00Z');

  it('prunes years, months, and days that ended more than a day before since', () => {
    expect(isDatedDirectoryBefore(['2025'], since)).toBe(true);
    expect(isDatedDirectoryBefore(['2026'], since)).toBe(false);
    expect(isDatedDirectoryBefore(['2026', '08'], since)).toBe(true);
    expect(isDatedDirectoryBefore(['2026', '09'], since)).toBe(false);
    expect(isDatedDirectoryBefore(['2026', '09', '01'], since)).toBe(true);
    expect(isDatedDirectoryBefore(['2026', '09', '04'], since)).toBe(false);
  });

  it('never prunes non-numeric or malformed names', () => {
    expect(isDatedDirectoryBefore(['archive'], since)).toBe(false);
    expect(isDatedDirectoryBefore(['2026', '13'], since)).toBe(false);
    expect(isDatedDirectoryBefore(['2026', '09', '04', 'extra'], since)).toBe(false);
    expect(isDatedDirectoryBefore([], since)).toBe(false);
  });
});
