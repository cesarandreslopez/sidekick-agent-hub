import { describe, expect, it } from 'vitest';
import {
  createActivityState,
  createActivityTimeline,
  snapshotActivity,
  summarizeActivity,
} from 'sidekick-shared/activity';
import type { ActivityRecord } from 'sidekick-shared/activity';
import { ActivityTimelineModel } from './model';
import { HostClock } from './clock';
import { IDLE_GAP_MS, PlaybackController } from './playback';
import { defaultActivityMapInit, readActivityMapInit, parseViewOptions } from './init';
import { ACTIVITY_MAP_INIT_ELEMENT_ID } from '../../types/activityMap';
import { formatClock, formatDuration, formatOffset } from './format';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const source = { kind: 'live' as const, providerId: 'claude-code' as const, label: 'Claude Code' };

function records(): ActivityRecord[] {
  return [
    { seq: 0, at: T0, kind: 'session', providerId: 'claude-code' },
    { seq: 1, at: T0, kind: 'prompt' },
    {
      seq: 2,
      at: T0 + 1_000,
      kind: 'toolStart',
      id: 'a',
      station: 'files',
      label: 'src/a.ts',
      tool: 'Read',
    },
    { seq: 3, at: T0 + 1_500, kind: 'toolEnd', id: 'a', outcome: 'ok' },
    {
      seq: 4,
      at: T0 + 120_000,
      kind: 'toolStart',
      id: 'b',
      station: 'shell',
      label: 'npm test',
      tool: 'Bash',
    },
    { seq: 5, at: T0 + 125_000, kind: 'toolEnd', id: 'b', outcome: 'error' },
  ];
}

const init = (list = records(), epoch = 1) => ({
  type: 'activity/init' as const,
  protocol: 1 as const,
  source,
  epoch,
  baseSeq: list[0]?.seq ?? 0,
  nextSeq: list.length > 0 ? list[list.length - 1].seq + 1 : 0,
  base: createActivityState(),
  records: list,
  hostNow: T0 + 130_000,
  live: true,
});

describe('ActivityTimelineModel', () => {
  it('folds an init and exposes range, snapshots and insights', () => {
    const model = new ActivityTimelineModel();
    model.init(init());
    expect(model.hasSession).toBe(true);
    expect(model.range()).toEqual({ startAt: T0, endAt: T0 + 125_000 });
    expect(model.snapshotAt().stations.find((s) => s.id === 'shell')?.faults).toBe(1);
    // Before the failing test ran, Shell had not been used yet.
    const earlier = model.snapshotAt(T0 + 2_000);
    expect(earlier.stations.find((s) => s.id === 'shell')?.count).toBe(0);
    expect(earlier.stations.find((s) => s.id === 'files')?.count).toBe(1);
    expect(model.insightsAt().totals.calls).toBe(2);
    expect(model.insightsAt(T0 + 2_000).totals.calls).toBe(1);
  });

  it('appends in order, ignores overlap, and reports gaps and stale epochs', () => {
    const model = new ActivityTimelineModel();
    const list = records();
    model.init(init(list.slice(0, 3)));
    const version = model.version;
    expect(
      model.append({
        type: 'activity/append',
        epoch: 1,
        fromSeq: 1,
        records: list.slice(1, 5),
        hostNow: 0,
      }),
    ).toBe('ok');
    expect(model.nextSeq).toBe(5);
    expect(model.version).toBeGreaterThan(version);
    expect(
      model.append({ type: 'activity/append', epoch: 1, fromSeq: 7, records: [], hostNow: 0 }),
    ).toBe('gap');
    expect(
      model.append({
        type: 'activity/append',
        epoch: 2,
        fromSeq: 5,
        records: list.slice(5),
        hostNow: 0,
      }),
    ).toBe('epoch');
    expect(model.nextSeq).toBe(5);
  });

  it('measures density and finds the next record after a moment', () => {
    const model = new ActivityTimelineModel();
    model.init(init());
    const density = model.density(10);
    expect(density.reduce((a, b) => a + b, 0)).toBe(2);
    expect(density[0]).toBe(1);
    expect(model.nextRecordAfter(T0 + 2_000)).toBe(T0 + 120_000);
    expect(model.nextRecordAfter(T0 + 200_000)).toBeUndefined();
  });

  it('folds the records on the init base, and on an empty one when it is unusable', () => {
    // A host timeline that dropped old records (the cap keeps two checkpoint intervals).
    const host = createActivityTimeline([], { checkpointEvery: 16, maxRecords: 40 });
    const list: ActivityRecord[] = [];
    for (let i = 0; i < 100; i++) {
      list.push(
        {
          seq: 2 * i,
          at: T0 + i * 1_000,
          kind: 'toolStart',
          id: `c${i}`,
          station: 'files',
          label: `f${i}.ts`,
          tool: 'Read',
        },
        {
          seq: 2 * i + 1,
          at: T0 + i * 1_000 + 10,
          kind: 'toolEnd',
          id: `c${i}`,
          outcome: i % 7 === 0 ? 'error' : 'ok',
        },
      );
    }
    host.append(list);
    const held = [...host.records()];
    expect(held[0].seq).toBeGreaterThan(0);
    const message = JSON.parse(JSON.stringify({ ...init(held), base: host.base() }));

    const model = new ActivityTimelineModel();
    model.init(message);
    expect(model.snapshotAt()).toEqual(snapshotActivity(host.head()));
    expect(model.insightsAt()).toEqual(summarizeActivity(host.head()));
    expect(model.snapshotAt().stations.find((s) => s.id === 'files')?.count).toBe(100);

    const fallback = new ActivityTimelineModel();
    fallback.init({ ...message, base: { nope: true } });
    const kept = held.filter((record) => record.kind === 'toolStart').length;
    expect(fallback.snapshotAt().stations.find((s) => s.id === 'files')?.count).toBe(kept);
  });

  it('clears back to no session', () => {
    const model = new ActivityTimelineModel();
    model.init(init());
    model.clear();
    expect(model.hasSession).toBe(false);
    expect(model.range()).toBeNull();
  });
});

describe('HostClock', () => {
  it('keeps the largest recent offset, since delay only shrinks a sample', () => {
    let local = 1_000;
    const clock = new HostClock(() => local);
    clock.observe(6_000); // offset 5000
    local = 2_000;
    clock.observe(6_500); // offset 4500 (a slower delivery)
    expect(clock.offsetMs).toBe(5_000);
    expect(clock.now()).toBe(7_000);
  });
});

describe('PlaybackController', () => {
  const range = { startAt: T0, endAt: T0 + 125_000 };

  it('starts live, or paused at a focus', () => {
    expect(new PlaybackController().mode).toBe('live');
    const focused = new PlaybackController({ at: T0 + 5 });
    expect(focused.mode).toBe('paused');
    expect(focused.cursorAt()).toBe(T0 + 5);
  });

  it('plays at speed, skips idle stretches and rejoins live at the end of a live session', () => {
    const playback = new PlaybackController();
    playback.seek(T0, range);
    playback.setSpeed(10);
    playback.play(range);
    playback.tick(100, range, { live: true });
    expect(playback.state.cursor).toBe(T0 + 1_000);
    // From 2s in, the next record is ~118s away: more than the idle gap, so skipped.
    playback.seek(T0 + 2_000, range);
    playback.play(range);
    playback.tick(16, range, { live: true, nextRecordAfter: () => T0 + 120_000 });
    expect(T0 + 120_000 - playback.state.cursor).toBeLessThan(IDLE_GAP_MS);
    playback.tick(1_000_000, range, { live: true });
    expect(playback.mode).toBe('live');
  });

  it('pauses at the end of a finished session and scrubbing always pauses', () => {
    const playback = new PlaybackController();
    playback.play(range); // from live: starts over at the beginning
    expect(playback.state.cursor).toBe(T0);
    playback.tick(1_000_000, range, { live: false });
    expect(playback.mode).toBe('paused');
    expect(playback.state.cursor).toBe(range.endAt);
    playback.goLive();
    playback.seek(T0 - 10_000, range);
    expect(playback.mode).toBe('paused');
    expect(playback.state.cursor).toBe(T0);
    playback.step(-5_000, range);
    expect(playback.state.cursor).toBe(T0);
  });
});

describe('init and formatting', () => {
  it('reads the init block and survives a malformed one', () => {
    const doc = (text: string | null) => ({
      getElementById: (id: string) =>
        id === ACTIVITY_MAP_INIT_ELEMENT_ID ? { textContent: text } : null,
    });
    expect(readActivityMapInit(doc(null))).toEqual(defaultActivityMapInit());
    expect(readActivityMapInit(doc('{oops'))).toEqual(defaultActivityMapInit());
    const parsed = readActivityMapInit(
      doc(
        JSON.stringify({
          mode: 'panel',
          options: { motion: 'none', reduceMotion: 'on', layout: 'you-bottom', coreName: 'X' },
          focus: { at: 5, station: 'shell' },
        }),
      ),
    );
    expect(parsed).toMatchObject({
      mode: 'panel',
      options: { motion: 'none', reduceMotion: 'on', layout: 'you-bottom', coreName: 'X' },
      focus: { at: 5, station: 'shell' },
    });
    expect(parseViewOptions({ motion: 'spin', layout: 'left' })).toMatchObject({
      motion: 'auto',
      layout: 'you-top',
    });
  });

  it('formats durations, offsets and clock times', () => {
    expect(formatDuration(850)).toBe('850ms');
    expect(formatDuration(4_200)).toBe('4.2s');
    expect(formatDuration(192_000)).toBe('3m12s');
    expect(formatDuration(3_840_000)).toBe('1h04m');
    expect(formatOffset(842_000)).toBe('+14m02s');
    expect(formatClock(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});
