import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const calls = vi.hoisted(() => ({ readdir: [] as string[], stat: [] as string[] }));
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
      stat: ((...args: Parameters<typeof actual.promises.stat>) => {
        calls.stat.push(String(args[0]));
        return (actual.promises.stat as (...a: unknown[]) => unknown)(...args);
      }) as typeof actual.promises.stat,
    },
  };
});

import { DirectoryListingCache, splitWatchedPath } from './directoryListingCache';

const HOUR_MS = 60 * 60_000;

function touch(filePath: string, content: string, mtime: Date): void {
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, mtime, mtime);
}

/** Push a directory's mtime into the past so the coarse-mtime guard trusts it. */
function ageDirectory(dir: string, ageMs = HOUR_MS): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, when, when);
}

describe('DirectoryListingCache', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-dir-cache-'));
    calls.readdir.length = 0;
    calls.stat.length = 0;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('lists once, then serves an unchanged directory with a single stat and no readdir', async () => {
    const old = new Date(Date.now() - 2 * HOUR_MS);
    touch(path.join(root, 'a.jsonl'), 'a', old);
    touch(path.join(root, 'b.jsonl'), 'bb', old);
    touch(path.join(root, 'notes.txt'), 'x', old);
    fs.mkdirSync(path.join(root, 'sub'));
    ageDirectory(root);
    const cache = new DirectoryListingCache();
    const accept = (name: string) => name.endsWith('.jsonl');
    const stats = {};

    const first = await cache.listDirectory(root, accept, { stats });
    expect(first).not.toBeNull();
    expect([...first!.files.keys()].sort()).toEqual(['a.jsonl', 'b.jsonl']);
    expect(first!.files.get('b.jsonl')).toMatchObject({ sizeBytes: 2 });
    expect(first!.subdirectories).toEqual(['sub']);
    expect(stats).toEqual({ directoriesStatted: 1, directoriesListed: 1, filesStatted: 2 });

    calls.readdir.length = 0;
    calls.stat.length = 0;
    const second = await cache.listDirectory(root, accept);
    expect(second).toBe(first);
    expect(calls.readdir).toEqual([]);
    expect(calls.stat).toEqual([root]);
  });

  it('re-lists a changed directory but stats only the names it has not seen', async () => {
    const old = new Date(Date.now() - 2 * HOUR_MS);
    touch(path.join(root, 'a.jsonl'), 'a', old);
    ageDirectory(root);
    const cache = new DirectoryListingCache();
    const accept = (name: string) => name.endsWith('.jsonl');
    await cache.listDirectory(root, accept);

    touch(path.join(root, 'b.jsonl'), 'bb', old);
    ageDirectory(root, HOUR_MS / 2);
    calls.readdir.length = 0;
    calls.stat.length = 0;
    const listing = await cache.listDirectory(root, accept);
    expect(calls.readdir).toEqual([root]);
    expect(calls.stat).toEqual([root, path.join(root, 'b.jsonl')]);
    expect([...listing!.files.keys()].sort()).toEqual(['a.jsonl', 'b.jsonl']);

    fs.rmSync(path.join(root, 'a.jsonl'));
    ageDirectory(root, HOUR_MS / 4);
    const after = await cache.listDirectory(root, accept);
    expect([...after!.files.keys()]).toEqual(['b.jsonl']);
  });

  it('does not trust a listing taken within the coarse-mtime guard window', async () => {
    touch(path.join(root, 'a.jsonl'), 'a', new Date());
    const cache = new DirectoryListingCache();
    const accept = (name: string) => name.endsWith('.jsonl');
    await cache.listDirectory(root, accept);
    calls.readdir.length = 0;
    await cache.listDirectory(root, accept);
    // The directory's mtime is "now", so the entry may still be racing.
    expect(calls.readdir).toEqual([root]);
  });

  it('refreshFile updates or removes an entry in an existing listing and never creates one', async () => {
    const old = new Date(Date.now() - 2 * HOUR_MS);
    const a = path.join(root, 'a.jsonl');
    touch(a, 'a', old);
    ageDirectory(root);
    const cache = new DirectoryListingCache();
    const accept = (name: string) => name.endsWith('.jsonl');

    const unlisted = path.join(root, 'later.jsonl');
    touch(unlisted, 'zzz', old);
    expect(await cache.refreshFile(unlisted)).toMatchObject({ sizeBytes: 3 });
    expect(cache.peek(root)).toBeUndefined();

    await cache.listDirectory(root, accept);
    fs.appendFileSync(a, 'ppend');
    const stats = {};
    expect(await cache.refreshFile(a, stats)).toMatchObject({ sizeBytes: 6 });
    expect(stats).toEqual({ filesStatted: 1 });
    expect(cache.peek(root)!.files.get('a.jsonl')).toMatchObject({ sizeBytes: 6 });

    fs.rmSync(a);
    expect(await cache.refreshFile(a)).toBeNull();
    expect(cache.peek(root)!.files.has('a.jsonl')).toBe(false);
  });

  it('revalidateRecent re-stats only files modified inside the recent window', async () => {
    const old = new Date(Date.now() - 2 * HOUR_MS);
    const recent = new Date(Date.now() - 60_000);
    const live = path.join(root, 'live.jsonl');
    touch(path.join(root, 'old.jsonl'), 'o', old);
    touch(live, 'l', recent);
    ageDirectory(root);
    const cache = new DirectoryListingCache({ recentWindowMs: 30 * 60_000 });
    const accept = (name: string) => name.endsWith('.jsonl');
    await cache.listDirectory(root, accept);

    // An append does not change the directory's mtime.
    fs.appendFileSync(live, 'ive');
    fs.utimesSync(live, recent, new Date(recent.getTime() + 1_000));
    calls.readdir.length = 0;
    calls.stat.length = 0;
    const cachedOnly = await cache.listDirectory(root, accept);
    expect(cachedOnly!.files.get('live.jsonl')).toMatchObject({ sizeBytes: 1 });

    const revalidated = await cache.listDirectory(root, accept, { revalidateRecent: true });
    expect(calls.readdir).toEqual([]);
    expect(calls.stat).toEqual([root, root, live]);
    expect(revalidated!.files.get('live.jsonl')).toMatchObject({ sizeBytes: 4 });
  });

  it('bounds cached directories least-recently-used first', async () => {
    const dirs = ['x', 'y', 'z'].map((name) => {
      const dir = path.join(root, name);
      fs.mkdirSync(dir);
      ageDirectory(dir);
      return dir;
    });
    const cache = new DirectoryListingCache({ maxDirectories: 2 });
    for (const dir of dirs) await cache.listDirectory(dir, () => true);
    expect(cache.size).toBe(2);
    expect(cache.peek(dirs[0])).toBeUndefined();
    expect(cache.peek(dirs[2])).toBeDefined();

    await cache.listDirectory(dirs[1], () => true);
    await cache.listDirectory(dirs[0], () => true);
    expect(cache.peek(dirs[2])).toBeUndefined();
    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  it('returns null for missing paths and files, dropping stale listings', async () => {
    const cache = new DirectoryListingCache();
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(await cache.listDirectory(path.join(root, 'nope'), () => true)).toBeNull();
    expect(await cache.listDirectory(file, () => true)).toBeNull();
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    await cache.listDirectory(sub, () => true);
    fs.rmSync(sub, { recursive: true });
    expect(await cache.listDirectory(sub, () => true)).toBeNull();
    expect(cache.peek(sub)).toBeUndefined();
  });
});

describe('splitWatchedPath', () => {
  it('splits on either separator and rejects escapes', () => {
    expect(splitWatchedPath('proj/abc.jsonl')).toEqual(['proj', 'abc.jsonl']);
    expect(splitWatchedPath('2026\\09\\04\\rollout-x.jsonl')).toEqual([
      '2026',
      '09',
      '04',
      'rollout-x.jsonl',
    ]);
    expect(splitWatchedPath('/leading//double/')).toEqual(['leading', 'double']);
    expect(splitWatchedPath('')).toBeNull();
    expect(splitWatchedPath('../escape.jsonl')).toBeNull();
  });
});
