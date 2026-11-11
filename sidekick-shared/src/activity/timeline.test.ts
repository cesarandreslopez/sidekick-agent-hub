import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { replayActivity } from '../activityReplay';
import { ClaudeCodeProvider } from '../providers/claudeCode';
import { applyActivityRecords, createActivityState, snapshotActivity } from './state';
import {
  buildActivitySnapshot,
  createActivityTimeline,
  exportActivity,
  normalizeActivityRecords,
} from './timeline';
import type { ActivityRecord } from './types';

const sessionPath = path.join(
  __dirname,
  '..',
  'fixtures',
  'activity',
  'claude-code',
  'sess-activity.jsonl',
);

function records(): ActivityRecord[] {
  return replayActivity({ provider: new ClaudeCodeProvider(), sessionPath }).records;
}

/** A small deterministic generator, so the property test is reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('activity timeline', () => {
  it('snapshotAt(t) through checkpoints equals a full fold to t', () => {
    const all = records();
    const timeline = createActivityTimeline(all, { checkpointEvery: 16 });
    const start = timeline.startAt!;
    const span = timeline.endAt! - start;
    const random = lcg(42);
    for (let run = 0; run < 200; run++) {
      const at = start - 1000 + Math.floor(random() * (span + 2000));
      expect(timeline.snapshotAt(at)).toEqual(buildActivitySnapshot(all, { until: at }));
    }
  });

  it('live append equals a batch build', () => {
    const all = records();
    const live = createActivityTimeline([], { checkpointEvery: 16 });
    for (let index = 0; index < all.length; index += 3) live.append(all.slice(index, index + 3));
    const batch = createActivityTimeline(all, { checkpointEvery: 16 });
    expect(snapshotActivity(live.head())).toEqual(snapshotActivity(batch.head()));
    expect(live.markers()).toEqual(batch.markers());
  });

  it('keeps totals after trimming old records', () => {
    const all = records();
    const timeline = createActivityTimeline([], { checkpointEvery: 16, maxRecords: 40 });
    timeline.append(all);
    expect(timeline.length).toBeLessThan(all.length);
    const state = createActivityState();
    applyActivityRecords(state, all);
    expect(snapshotActivity(timeline.head())).toEqual(snapshotActivity(state));
    expect(timeline.snapshotAt(timeline.endAt!)).toEqual(snapshotActivity(state));
  });

  it('lists markers for the scrubber', () => {
    const kinds = new Set(
      createActivityTimeline(records())
        .markers()
        .map((marker) => marker.kind),
    );
    for (const kind of ['prompt', 'turnEnd', 'fault', 'compaction', 'modelSwitch', 'pattern']) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });

  it('normalizes: corrected starts move back and seq is renumbered', () => {
    const input = [
      { kind: 'toolStart', at: 100, seq: 0, id: 'a', station: 'shell', label: 'x', tool: 'Bash' },
      { kind: 'toolEnd', at: 100, seq: 1, id: 'a', outcome: 'ok', startedAt: 40 },
      { kind: 'prompt', at: 50, seq: 2 },
    ] as ActivityRecord[];
    const normalized = normalizeActivityRecords(input);
    expect(normalized.map((record) => [record.kind, record.at, record.seq])).toEqual([
      ['toolStart', 40, 0],
      ['prompt', 50, 1],
      ['toolEnd', 100, 2],
    ]);
  });

  it('exports with the snapshot’s session by default', () => {
    const replay = replayActivity({ provider: new ClaudeCodeProvider(), sessionPath });
    const exported = exportActivity({ snapshot: replay.snapshot, insights: replay.insights });
    expect(exported).toMatchObject({
      schemaVersion: 1,
      kind: 'sidekick-activity',
      providerId: 'claude-code',
      sessionId: 'sess-activity',
      at: replay.snapshot.at,
    });
    expect(exported.records).toBeUndefined();
  });
});
