import { describe, expect, it } from 'vitest';
import { busySnapshot, NOW } from '../testing/activityFixtures.setup';
import { foldActivityFeed } from './feed';
import type { ActivityEntry } from './types';

function e(key: string, extra: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    key,
    station: 'files',
    label: key,
    from: 'core',
    startedAt: NOW,
    endedAt: NOW + 100,
    outcome: 'ok',
    ...extra,
  };
}

describe('foldActivityFeed', () => {
  it('returns the newest rows first and folds finished calls in a row at one station', () => {
    const rows = foldActivityFeed([
      e('a', { startedAt: NOW, endedAt: NOW + 100 }),
      e('b', { startedAt: NOW + 200, endedAt: NOW + 500 }),
      e('c', { startedAt: NOW + 600, endedAt: NOW + 700 }),
      e('d', { station: 'shell' }),
    ]);
    expect(rows.map((r) => [r.entry.key, r.times, r.tookMs])).toEqual([
      ['d', 1, 100],
      ['c', 3, 500],
    ]);
  });

  it('never folds a fault, a mark, a running call, another origin or another subagent', () => {
    const rows = foldActivityFeed([
      e('a'),
      e('err', { outcome: 'error' }),
      e('b'),
      e('run', { endedAt: undefined, outcome: undefined }),
      e('c'),
      e('agent', { from: 'agents', agentId: 'x' }),
      e('d'),
      e('marked', { mark: 'pushed' }),
      e('f'),
    ]);
    expect(rows.map((r) => r.entry.key)).toEqual([
      'f',
      'marked',
      'd',
      'agent',
      'c',
      'run',
      'b',
      'err',
      'a',
    ]);
    expect(rows.find((r) => r.entry.key === 'run')?.tookMs).toBe(0);
  });

  it('hides model steps by default, filters by station and caps rows', () => {
    const entries = busySnapshot().entries;
    const all = foldActivityFeed(entries, { max: 100 });
    expect(all.some((r) => r.entry.station === 'model' && r.entry.mark === undefined)).toBe(false);
    expect(all.some((r) => r.entry.mark === 'switch')).toBe(true);
    const withSteps = foldActivityFeed(entries, { max: 100, hideSteps: false });
    expect(withSteps.some((r) => r.entry.key === 's-1')).toBe(true);
    const shell = foldActivityFeed(entries, { station: 'shell' });
    expect(shell.every((r) => r.entry.station === 'shell')).toBe(true);
    expect(foldActivityFeed(entries, { max: 2 })).toHaveLength(2);
    expect(foldActivityFeed(entries, { max: 0 })).toEqual([]);
  });
});
