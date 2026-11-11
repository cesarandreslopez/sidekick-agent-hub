import { describe, expect, it } from 'vitest';
import {
  busyInsights,
  busySnapshot,
  NOW,
  quietSnapshot,
  thinkingSnapshot,
} from '../testing/activityFixtures.setup';
import { describeActivityInsights, describeActivityNow, describeActivityPattern } from './describe';
import type { ActivityInsights } from './types';

describe('describeActivityNow', () => {
  it('names the newest main-loop call, how many more run, and the context', () => {
    expect(describeActivityNow(busySnapshot(), { now: NOW })).toBe(
      'Files: activity/types.ts and 3 more · context 74%',
    );
  });

  it('says the model is thinking, or that nothing runs', () => {
    expect(describeActivityNow(thinkingSnapshot())).toBe('Model: thinking · context 93%');
    expect(describeActivityNow(quietSnapshot())).toBe('Nothing is running. · context 23%');
    expect(describeActivityNow({ ...quietSnapshot(), context: undefined })).toBe(
      'Nothing is running.',
    );
  });

  it('translates vocabulary labels and station names', () => {
    const snapshot = busySnapshot();
    const running = [
      {
        ...snapshot.running[0],
        label: 'x',
        labelKey: 'webSearch' as const,
        station: 'network' as const,
      },
    ];
    expect(
      describeActivityNow(
        { ...snapshot, running, context: undefined },
        {
          strings: {
            stations: { network: 'Red' } as never,
            labels: { webSearch: 'búsqueda' } as never,
          },
        },
      ),
    ).toBe('Red: búsqueda');
  });
});

describe('describeActivityPattern', () => {
  it('describes retry streaks and loops', () => {
    const [streak, loop] = busySnapshot().patterns;
    expect(describeActivityPattern(streak)).toBe('Shell failed 3× in a row');
    expect(describeActivityPattern({ ...streak, state: 'recovered' })).toBe(
      'Shell failed 3× in a row, then recovered',
    );
    expect(describeActivityPattern({ ...streak, state: 'abandoned' })).toBe(
      'Shell failed 3× in a row, then moved on',
    );
    expect(describeActivityPattern(loop)).toBe('edit ↔ test loop ×4');
    expect(describeActivityPattern({ ...loop, flavor: undefined })).toBe('Files ↔ Shell ×4');
  });
});

describe('describeActivityInsights', () => {
  it('summarizes where the time, the context and the faults went (golden)', async () => {
    await expect(`${describeActivityInsights(busyInsights())}\n`).toMatchFileSnapshot(
      '../fixtures/activity/golden/busy-insights.txt',
    );
  });

  it('keeps to maxLines and handles an empty session', () => {
    expect(describeActivityInsights(busyInsights(), { maxLines: 2 }).split('\n')).toHaveLength(2);
    const empty: ActivityInsights = {
      ...busyInsights(),
      span: { activeMs: 0 },
      totals: Object.fromEntries(
        Object.keys(busyInsights().totals).map((k) => [k, 0]),
      ) as ActivityInsights['totals'],
      stations: busyInsights().stations.map((s) => ({
        ...s,
        calls: 0,
        errors: 0,
        denials: 0,
        busyMs: 0,
        estTokens: 0,
      })),
      patterns: [],
      models: [],
      slowest: [],
    };
    expect(describeActivityInsights(empty)).toBe(
      '0 calls at 0 stations · 0 prompts, 0 model steps.',
    );
  });
});
