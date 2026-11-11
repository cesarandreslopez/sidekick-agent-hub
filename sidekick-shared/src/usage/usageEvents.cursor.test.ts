import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

import { ClaudeCodeProvider } from '../providers/claudeCode';
import { computeSessionKey } from '../sessionKey';
import { appendJsonl, createSessionLogFixtures, writeJsonl } from '../testing/sessionLogFixtures';
import {
  USAGE_CACHE_VERSION,
  collectUsageEvents,
  parseUsageEventsCursor,
  type CollectUsageEventsOptions,
  type CollectUsageEventsResult,
} from './usageEvents';

let repo: string;
let provider: ClaudeCodeProvider;
const fx = createSessionLogFixtures(() => ({ home: tmpDir, repo }));

function session(id: string, calls = 2): string {
  const file = fx.claudeFile(repo, id);
  writeJsonl(file, [
    fx.claudeUser('hello', 1),
    ...Array.from({ length: calls }, (_, index) =>
      fx.claudeAssistant(`${id}-m${index}`, 2 + index),
    ),
  ]);
  return file;
}

function collect(extra: Partial<CollectUsageEventsOptions> = {}) {
  return collectUsageEvents({ providers: [provider], workspacePaths: [repo], ...extra });
}

/** Calls again with the cursor until nothing is left. */
async function drain(extra: Partial<CollectUsageEventsOptions>) {
  const calls: CollectUsageEventsResult[] = [];
  let cursor = extra.cursor;
  for (let call = 0; call < 20; call++) {
    const result = await collect({ ...extra, cursor });
    calls.push(result);
    cursor = JSON.parse(JSON.stringify(result.cursor));
    if (!result.hasMore) return { calls, cursor };
  }
  throw new Error('no end');
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-usage-cursor-')));
  repo = path.join(tmpDir, 'work', 'app');
  fs.mkdirSync(repo, { recursive: true });
  provider = new ClaudeCodeProvider({ homes: { claudeHomes: [path.join(tmpDir, '.claude')] } });
});

afterEach(() => {
  provider.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectUsageEvents without bounds or cursor', () => {
  it('returns everything plus a cursor that records every session', async () => {
    session('a');
    session('b');
    const result = await collect({ noCache: true });
    expect(result.events).toHaveLength(4);
    expect(result).toMatchObject({ hasMore: false, boundsHit: [], pricingChanged: false });
    expect(Object.keys(result.cursor.sessions).sort()).toEqual(
      result.sessions.map((s) => s.sessionKey).sort(),
    );
    expect(result.changed.map((ref) => ref.sessionId).sort()).toEqual(['a', 'b']);
    // Keys join prompt history's.
    const file = fx.claudeFile(repo, 'a');
    expect(result.events.find((event) => event.sessionId === 'a')?.sessionKey).toBe(
      computeSessionKey('claude-code', 'a', file),
    );
  });
});

describe('collectUsageEvents with a cursor', () => {
  it('skips unchanged sessions and returns a changed one whole', async () => {
    session('a');
    const changing = session('b');
    const first = await collect();
    const cursor = JSON.parse(JSON.stringify(first.cursor));

    const quiet = await collect({ cursor });
    expect(quiet.events).toEqual([]);
    expect(quiet.sessions).toEqual([]);
    expect(quiet.changed).toEqual([]);
    expect(quiet.stats.sessionsSkippedUnchanged).toBe(2);

    appendJsonl(changing, [fx.claudeAssistant('b-m9', 30)]);
    const after = await collect({ cursor: quiet.cursor });
    expect(after.sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(after.events).toHaveLength(3);
    expect(after.changed).toEqual([
      { provider: 'claude-code', sessionId: 'b', sessionKey: expect.any(String) },
    ]);
  });

  it('returns every session again when prices changed', async () => {
    session('a');
    const first = await collect();
    const stale = { ...first.cursor, pricing: 'fnv1a64:0000000000000000' };
    const result = await collect({ cursor: stale });
    expect(result.pricingChanged).toBe(true);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(['a']);
  });

  it('returns every session again once for a cursor of another cache version', async () => {
    session('a');
    session('b');
    const first = await collect();
    expect(first.cursor.cacheVersion).toBe(USAGE_CACHE_VERSION);
    // What 0.32.0 stored: the same prices, no cache version.
    const { cacheVersion: _cacheVersion, ...older } = JSON.parse(JSON.stringify(first.cursor));
    const again = await collect({ cursor: older });
    expect(again.pricingChanged).toBe(true);
    expect(again.sessions.map((s) => s.sessionId).sort()).toEqual(['a', 'b']);
    expect(again.changed).toHaveLength(2);

    const quiet = await collect({ cursor: JSON.parse(JSON.stringify(again.cursor)) });
    expect(quiet.pricingChanged).toBe(false);
    expect(quiet.sessions).toEqual([]);
  });

  it('refuses until together with a cursor', async () => {
    const first = await collect();
    await expect(collect({ cursor: first.cursor, until: new Date() })).rejects.toThrow(TypeError);
  });
});

describe('collectUsageEvents with bounds', () => {
  it('stops before a session that would pass a bound and continues from the cursor', async () => {
    for (const id of ['a', 'b', 'c']) session(id);
    const full = await collect({ noCache: true });

    const { calls } = await drain({ bounds: { maxSessions: 1 }, noCache: true });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ hasMore: true, boundsHit: ['maxSessions'] });
    expect(calls.at(-1)).toMatchObject({ hasMore: false, boundsHit: [] });
    // Each session exactly once, in key order, never split.
    const seen = calls.flatMap((call) => call.sessions.map((s) => s.sessionId));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
    expect(new Set(seen).size).toBe(3);
    const drained = calls.flatMap((call) => call.events);
    expect(drained.map((event) => event.requestId).sort()).toEqual(
      full.events.map((event) => event.requestId).sort(),
    );
  });

  it('counts only cache misses, and always reads the first session', async () => {
    for (const id of ['a', 'b', 'c']) session(id);
    await collect();
    const warm = await collect({ bounds: { maxSessions: 1, maxTotalBytes: 1 } });
    expect(warm).toMatchObject({ hasMore: false, cacheHits: 3, cacheMisses: 0 });
    expect(warm.sessions).toHaveLength(3);

    const cold = await collect({ bounds: { maxTotalBytes: 1 }, noCache: true });
    expect(cold.sessions).toHaveLength(1);
    expect(cold).toMatchObject({ hasMore: true, boundsHit: ['maxTotalBytes'] });

    const events = await collect({ bounds: { maxEvents: 1 }, noCache: true });
    expect(events.sessions).toHaveLength(1);
    expect(events.boundsHit).toEqual(['maxEvents']);
  });

  it('rejects a negative bound', async () => {
    await expect(collect({ bounds: { maxSessions: -1 } })).rejects.toThrow(RangeError);
  });
});

describe('parseUsageEventsCursor', () => {
  it('round-trips a cursor and rejects anything else', () => {
    const cursor = { version: 1, sessions: { k: 'f' }, next: 'k', pricing: 'p', cacheVersion: 4 };
    expect(parseUsageEventsCursor(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
    for (const bad of [
      null,
      [],
      'x',
      { version: 2, sessions: {} },
      { version: 1, sessions: [] },
      { version: 1, sessions: { k: 1 } },
      { version: 1, sessions: {}, next: 3 },
      { version: 1, sessions: {}, cacheVersion: '4' },
      { version: 1, sessions: {}, cacheVersion: 4.5 },
    ]) {
      expect(parseUsageEventsCursor(bad)).toBeUndefined();
    }
  });
});
