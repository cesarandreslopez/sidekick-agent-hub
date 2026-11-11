import { describe, expect, it } from 'vitest';
import { summarizeActivity } from './insights';
import {
  applyActivityRecord,
  applyActivityRecords,
  cloneActivityState,
  createActivityState,
  restoreActivityState,
  snapshotActivity,
} from './state';
import type { ActivityRecord } from './types';

type Draft = Record<string, unknown> & { kind: ActivityRecord['kind']; at: number };

function build(drafts: Draft[]): ActivityRecord[] {
  return drafts.map((draft, seq) => ({ ...draft, seq }) as unknown as ActivityRecord);
}

const start = (
  at: number,
  id: string,
  station: string,
  extra: Record<string, unknown> = {},
): Draft => ({
  kind: 'toolStart',
  at,
  id,
  station,
  label: `${station}-${id}`,
  tool: 'Tool',
  ...extra,
});
const end = (
  at: number,
  id: string,
  outcome = 'ok',
  extra: Record<string, unknown> = {},
): Draft => ({
  kind: 'toolEnd',
  at,
  id,
  outcome,
  ...extra,
});

describe('activity state', () => {
  it('counts calls, running calls and faults since the last prompt', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([
        { kind: 'prompt', at: 0 },
        start(1, 'a', 'shell'),
        start(1, 'b', 'shell'),
        end(5, 'a', 'error'),
      ]),
    );
    let snapshot = snapshotActivity(state);
    const shell = snapshot.stations.find((station) => station.id === 'shell')!;
    expect(shell).toMatchObject({ count: 2, running: 1, faults: 1, runningSince: 1 });
    expect(snapshot.running.map((entry) => entry.key)).toEqual(['b']);

    applyActivityRecord(state, build([{ kind: 'prompt', at: 6 }])[0]);
    snapshot = snapshotActivity(state);
    expect(snapshot.stations.find((station) => station.id === 'shell')!.faults).toBe(0);
  });

  it('measures busy time as a wall-clock union, not a sum', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([start(0, 'a', 'shell'), start(500, 'b', 'shell'), end(1000, 'a'), end(2000, 'b')]),
    );
    const shell = summarizeActivity(state).stations.find((station) => station.id === 'shell')!;
    expect(shell.busyMs).toBe(2000);
    expect(shell.callMs).toBe(2500);
    expect(shell.shareOfBusy).toBe(1);
  });

  it('keeps the route without repeats and fills the transition matrix', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([
        start(0, 'a', 'files'),
        end(1, 'a'),
        start(2, 'b', 'files'),
        end(3, 'b'),
        start(4, 'c', 'shell'),
        end(5, 'c'),
        start(6, 'd', 'model'),
      ]),
    );
    expect(snapshotActivity(state).route.map((stop) => stop.station)).toEqual(['files', 'shell']);
    const insights = summarizeActivity(state);
    const files = insights.transitions.stations.indexOf('files');
    const shell = insights.transitions.stations.indexOf('shell');
    expect(insights.transitions.counts[files][files]).toBe(1);
    expect(insights.transitions.counts[files][shell]).toBe(1);
  });

  it('opens a retry streak, keeps it across other stations, and marks recovery', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([
        { kind: 'prompt', at: 0 },
        start(1, 't1', 'shell', { hint: 'test' }),
        end(2, 't1', 'error'),
        start(3, 'e1', 'files', { hint: 'edit' }),
        end(4, 'e1'),
        start(5, 't2', 'shell', { hint: 'test' }),
        end(6, 't2', 'error'),
        start(7, 't3', 'shell', { hint: 'test' }),
        end(8, 't3', 'error'),
      ]),
    );
    expect(snapshotActivity(state).patterns).toEqual([
      expect.objectContaining({
        kind: 'retry-streak',
        station: 'shell',
        failures: 3,
        state: 'open',
      }),
    ]);
    applyActivityRecords(
      state,
      build([start(9, 't4', 'shell'), end(10, 't4')]).map((r, i) => ({ ...r, seq: 100 + i })),
    );
    expect(snapshotActivity(state).patterns[0]).toMatchObject({ state: 'recovered', endAt: 10 });
  });

  it('abandons an open retry streak when the turn ends', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([
        start(1, 'a', 'shell'),
        end(2, 'a', 'error'),
        start(3, 'b', 'shell'),
        end(4, 'b', 'error'),
        start(5, 'c', 'shell'),
        end(6, 'c', 'denied'),
        { kind: 'turnEnd', at: 7, outcome: 'done' },
      ]),
    );
    expect(snapshotActivity(state).patterns[0]).toMatchObject({ state: 'abandoned' });
  });

  it('detects an edit-test alternation', () => {
    const drafts: Draft[] = [];
    let at = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
      drafts.push(start(at++, `e${cycle}`, 'files', { hint: 'edit' }), end(at++, `e${cycle}`));
      drafts.push(start(at++, `t${cycle}`, 'shell', { hint: 'test' }), end(at++, `t${cycle}`));
    }
    const state = createActivityState();
    applyActivityRecords(state, build(drafts));
    expect(snapshotActivity(state).patterns).toEqual([
      expect.objectContaining({
        kind: 'alternation',
        stations: ['files', 'shell'],
        cycles: 3,
        state: 'open',
        flavor: 'edit-test',
      }),
    ]);
  });

  it('marks a model switch, compactions and memory pushed', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([
        { kind: 'step', at: 1, model: 'claude-opus-5-5' },
        { kind: 'context', at: 1, percent: 50, tokens: 500, window: 1000, source: 'usage' },
        { kind: 'step', at: 2, model: 'claude-fable-5-2' },
        { kind: 'compaction', at: 3, tokensBefore: 500, tokensAfter: 100 },
        { kind: 'memoryPushed', at: 4, label: 'src/CLAUDE.md', via: 'attachment' },
      ]),
    );
    const snapshot = snapshotActivity(state);
    expect(snapshot.model).toMatchObject({
      id: 'claude-fable-5-2',
      previous: 'claude-opus-5-5',
      switchedAt: 2,
    });
    expect(snapshot.context).toMatchObject({ percent: 10, tokens: 100 });
    expect(snapshot.compactions).toBe(1);
    expect(snapshot.stations.find((station) => station.id === 'memory')).toMatchObject({
      count: 1,
      pushed: 1,
    });
    expect(snapshot.entries.map((entry) => entry.mark)).toEqual([
      undefined,
      'switch',
      undefined,
      'compaction',
      'pushed',
    ]);
  });

  it('draws only notable hooks but counts every run', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([
        {
          kind: 'hook',
          at: 1,
          hookEvent: 'PreToolUse',
          outcome: 'ok',
          durationMs: 5,
          label: 'quick',
        },
        {
          kind: 'hook',
          at: 2,
          hookEvent: 'PreToolUse',
          outcome: 'ok',
          durationMs: 900,
          label: 'slow',
        },
        { kind: 'hook', at: 3, hookEvent: 'PreToolUse', outcome: 'blocked', label: 'blocked' },
      ]),
    );
    const snapshot = snapshotActivity(state);
    expect(snapshot.entries.map((entry) => entry.label)).toEqual(['slow', 'blocked']);
    expect(snapshot.stations.find((station) => station.id === 'hooks')!.faults).toBe(1);
    expect(summarizeActivity(state).totals.hookRuns).toBe(3);
  });

  it('shows the model thinking when a turn runs with no main call open', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([{ kind: 'prompt', at: 10 }, start(11, 'a', 'files'), end(12, 'a')]),
    );
    expect(snapshotActivity(state).turn).toMatchObject({ working: true, thinkingSince: 12 });
    applyActivityRecord(state, build([start(13, 'b', 'shell')])[0]);
    expect(snapshotActivity(state).turn.thinkingSince).toBeUndefined();
  });

  it('keeps subagents in the orbit until they end', () => {
    const state = createActivityState();
    applyActivityRecords(
      state,
      build([
        { kind: 'subagentStart', at: 1, agentId: 'a', label: 'Explore' },
        { kind: 'subagentStart', at: 2, agentId: 'b', label: 'Plan' },
        { kind: 'subagentEnd', at: 3, agentId: 'a', outcome: 'ok' },
      ]),
    );
    expect(snapshotActivity(state).agents).toEqual([{ agentId: 'b', label: 'Plan', startedAt: 2 }]);
    expect(summarizeActivity(state).totals.subagents).toBe(2);
  });

  it('bounds the drawn entries but not the totals', () => {
    const drafts: Draft[] = [];
    for (let index = 0; index < 200; index++)
      drafts.push(start(index * 2, `c${index}`, 'files'), end(index * 2 + 1, `c${index}`));
    const state = createActivityState(undefined, { ringSize: 20 });
    applyActivityRecords(state, build(drafts));
    const snapshot = snapshotActivity(state);
    expect(snapshot.entries).toHaveLength(20);
    expect(snapshot.totals.calls).toBe(200);
    expect(summarizeActivity(state).stations.find((station) => station.id === 'files')!.calls).toBe(
      200,
    );
  });

  it('survives JSON round trips and rejects foreign values', () => {
    const state = createActivityState({ providerId: 'codex' });
    applyActivityRecords(state, build([start(1, 'a', 'shell'), end(2, 'a', 'error')]));
    const restored = restoreActivityState(JSON.parse(JSON.stringify(state)));
    expect(restored).not.toBeNull();
    expect(snapshotActivity(restored!)).toEqual(snapshotActivity(state));
    expect(snapshotActivity(cloneActivityState(state))).toEqual(snapshotActivity(state));
    expect(restoreActivityState({ kind: 'other' })).toBeNull();
    expect(restoreActivityState(null)).toBeNull();
  });
});
