import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Record which directories the walker lists, to prove the early exit.
const readdirCalls = vi.hoisted(() => [] as string[]);
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      readdirCalls.push(String(args[0]));
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.readdirSync,
  };
});

import {
  extractRolloutSessionId,
  isRolloutFile,
  walkRolloutFiles,
  walkRolloutFilesAsync,
} from './rolloutWalker';

let tmpDir: string;

function uuid(seed: number): string {
  return `019d86b0-b20c-7b02-a3b2-${String(seed).padStart(12, '0')}`;
}

function writeRollout(
  root: string,
  day: [string, string, string],
  name: string,
  mtime: Date,
  content = '{"type":"session_meta"}\n',
): string {
  const dir = path.join(root, ...day);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

describe('walkRolloutFiles', () => {
  let root: string;
  const base = Date.parse('2026-09-04T12:00:00Z');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-rollout-walker-'));
    root = path.join(tmpDir, 'sessions');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns rollouts newest first with size and session id, skipping empty and foreign files', () => {
    const old = writeRollout(
      root,
      ['2026', '09', '03'],
      `rollout-a-${uuid(1)}.jsonl`,
      new Date(base - 86_400_000),
    );
    const newer = writeRollout(
      root,
      ['2026', '09', '04'],
      `rollout-b-${uuid(2)}.jsonl`,
      new Date(base),
    );
    writeRollout(root, ['2026', '09', '04'], `rollout-empty-${uuid(3)}.jsonl`, new Date(base), '');
    writeRollout(root, ['2026', '09', '04'], 'notes.jsonl', new Date(base));

    const files = walkRolloutFiles([root]);

    expect(files.map((file) => file.path)).toEqual([newer, old]);
    expect(files[0]).toMatchObject({ sessionId: uuid(2), sizeBytes: 24 });
    expect(files[0].mtime.getTime()).toBe(base);
    expect(walkRolloutFiles([root], { includeEmpty: true })).toHaveLength(3);
  });

  it('deduplicates paths across roots and skips missing roots', () => {
    const file = writeRollout(
      root,
      ['2026', '09', '04'],
      `rollout-${uuid(4)}.jsonl`,
      new Date(base),
    );
    const files = walkRolloutFiles([root, root, path.join(tmpDir, 'missing')]);
    expect(files.map((file) => file.path)).toEqual([file]);
  });

  it('honours the session id filter case-insensitively and the depth cap', () => {
    const wanted = writeRollout(
      root,
      ['2026', '09', '04'],
      `rollout-x-${uuid(5)}.jsonl`,
      new Date(base),
    );
    writeRollout(root, ['2026', '09', '04'], `rollout-y-${uuid(6)}.jsonl`, new Date(base));
    expect(
      walkRolloutFiles([root], { sessionId: uuid(5).toUpperCase() }).map((f) => f.path),
    ).toEqual([wanted]);
    expect(walkRolloutFiles([root], { sessionId: uuid(9) })).toEqual([]);
    // sessions/2026/09/04 is depth 3; a cap of 2 never reaches the day directories.
    expect(walkRolloutFiles([root], { maxDepth: 2 })).toEqual([]);
  });

  it('stops early with a limit, visiting the newest-dated directories first', () => {
    writeRollout(
      root,
      ['2026', '08', '30'],
      `rollout-a-${uuid(7)}.jsonl`,
      new Date(base - 5 * 86_400_000),
    );
    writeRollout(
      root,
      ['2026', '09', '03'],
      `rollout-b-${uuid(8)}.jsonl`,
      new Date(base - 86_400_000),
    );
    const newest = writeRollout(
      root,
      ['2026', '09', '04'],
      `rollout-c-${uuid(9)}.jsonl`,
      new Date(base),
    );
    readdirCalls.length = 0;

    const files = walkRolloutFiles([root], { limit: 1 });

    expect(files.map((file) => file.path)).toEqual([newest]);
    // sessions, 2026, 09, 04: the older day and month directories are never read.
    const visited = [...readdirCalls];
    expect(visited).toHaveLength(4);
    expect(visited.some((dir) => dir.endsWith(path.join('09', '03')))).toBe(false);
    expect(visited.some((dir) => dir.endsWith(path.join('2026', '08')))).toBe(false);
  });

  it('caps the total file count', () => {
    for (let index = 0; index < 5; index += 1) {
      writeRollout(
        root,
        ['2026', '09', '04'],
        `rollout-${index}-${uuid(10 + index)}.jsonl`,
        new Date(base - index),
      );
    }
    expect(walkRolloutFiles([root], { maxFiles: 3 })).toHaveLength(3);
    expect(walkRolloutFiles([root], { maxFiles: 0 })).toHaveLength(0);
  });

  it('matches the async walk result for result', async () => {
    writeRollout(root, ['2026', '09', '03'], `rollout-a-${uuid(20)}.jsonl`, new Date(base - 1000));
    writeRollout(root, ['2026', '09', '04'], `rollout-b-${uuid(21)}.jsonl`, new Date(base));
    const sync = walkRolloutFiles([root]);
    const async = await walkRolloutFilesAsync([root]);
    expect(async).toEqual(sync);
    expect(await walkRolloutFilesAsync([root], { limit: 1 })).toEqual(sync.slice(0, 1));
  });
});

describe('rollout names', () => {
  it('recognises rollout files and extracts the trailing uuid', () => {
    expect(
      isRolloutFile('rollout-2026-09-04T12-00-00-019d86b0-b20c-7b02-a3b2-000000000001.jsonl'),
    ).toBe(true);
    expect(isRolloutFile('notes.jsonl')).toBe(false);
    expect(
      extractRolloutSessionId(
        'rollout-2026-09-04T12-00-00-019d86b0-b20c-7b02-a3b2-000000000001.jsonl',
      ),
    ).toBe('019d86b0-b20c-7b02-a3b2-000000000001');
    expect(extractRolloutSessionId('rollout-garbage.jsonl')).toBe('garbage');
  });
});
