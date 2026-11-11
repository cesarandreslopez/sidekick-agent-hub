import { describe, expect, it } from 'vitest';
import {
  buildFollowFrame,
  buildTextReport,
  feedRows,
  fitRow,
  formatSpan,
  FOLLOW_MIN_HEIGHT,
} from './frame';
import type { FrameRow } from './frame';
import { segmentsToPlain } from './tones';
import { sampleActivity, T0 } from './activityFixtures.testkit';

const plain = (rows: FrameRow[]) => rows.map(segmentsToPlain);
const width = (row: FrameRow) => Array.from(segmentsToPlain(row)).length;

describe('formatSpan', () => {
  it('reads like a duration at every scale', () => {
    expect(formatSpan(90)).toBe('90ms');
    expect(formatSpan(4_200)).toBe('4.2s');
    expect(formatSpan(185_000)).toBe('3m05s');
    expect(formatSpan(4_020_000)).toBe('1h07m');
  });
});

describe('fitRow', () => {
  it('cuts a row to its width with an ellipsis', () => {
    const row = fitRow(
      [
        { text: 'abcdef', tone: 'default' },
        { text: 'ghij', tone: 'hot' },
      ],
      7,
    );
    expect(segmentsToPlain(row)).toBe('abcdef…');
    expect(width(row)).toBe(7);
  });
});

describe('feedRows', () => {
  it('folds the feed newest first, marks the running call and the failure', () => {
    const { snapshot } = sampleActivity();
    const now = T0 + 20_000;
    const rows = plain(feedRows(snapshot, { now, max: 10, width: 80 }));
    expect(rows[0]).toMatch(/^● Network\s+example\.com\s+4\.0s$/);
    expect(rows.some((row) => row.startsWith('✕ Shell') && row.includes('npm test'))).toBe(true);
  });

  it('filters to one station', () => {
    const { snapshot } = sampleActivity();
    const rows = plain(
      feedRows(snapshot, { now: T0 + 20_000, max: 10, width: 80, station: 'files' }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.includes('Files'))).toBe(true);
  });
});

describe('buildFollowFrame', () => {
  const base = {
    now: T0 + 20_000,
    panel: 'feed' as const,
    mode: 'live' as const,
    providerLabel: 'Claude Code',
    sessionLabel: 'sess-cli',
  };

  it('fills exactly the terminal, every row within its width', () => {
    const { snapshot, insights } = sampleActivity();
    for (const [w, h] of [
      [100, 40],
      [60, 20],
      [40, FOLLOW_MIN_HEIGHT],
    ]) {
      const rows = buildFollowFrame({ ...base, snapshot, insights, width: w, height: h });
      expect(rows).toHaveLength(h);
      for (const row of rows) expect(width(row)).toBeLessThanOrEqual(w);
    }
  });

  it('shows the live header, the map, the feed and the key hints', () => {
    const { snapshot, insights } = sampleActivity();
    const text = plain(
      buildFollowFrame({ ...base, snapshot, insights, width: 100, height: 40 }),
    ).join('\n');
    expect(text).toContain('● LIVE');
    expect(text).toContain('Claude Code · sess-cli');
    expect(text).toContain('CLAUDE');
    expect(text).toContain('── Activity');
    expect(text).toContain('q quit');
  });

  it('shows the insights panel and the paused hints on request', () => {
    const { snapshot, insights } = sampleActivity();
    const text = plain(
      buildFollowFrame({
        ...base,
        snapshot,
        insights,
        width: 100,
        height: 40,
        panel: 'insights',
        mode: 'paused',
      }),
    ).join('\n');
    expect(text).toContain('‖ PAUSED');
    expect(text).toContain('── Insights');
    expect(text).toContain('l live');
  });

  it('shows the session span, not idle clock time, once nothing runs', () => {
    const { snapshot, insights } = sampleActivity();
    const quiet = { ...snapshot, running: [], turn: { ...snapshot.turn, working: false } };
    const header = plain(
      buildFollowFrame({
        ...base,
        snapshot: quiet,
        insights,
        now: T0 + 50 * 3_600_000,
        width: 100,
        height: 40,
      }),
    )[0];
    expect(header).not.toMatch(/\d+h\d+m/);
    expect(header).toMatch(/· 17\.0s$/);
  });

  it('waits when there is no session yet', () => {
    const text = plain(
      buildFollowFrame({
        ...base,
        snapshot: null,
        insights: null,
        mode: 'waiting',
        width: 80,
        height: 20,
        workspaceLabel: 'my-project',
      }),
    ).join('\n');
    expect(text).toContain('Waiting for a session in my-project');
  });

  it('asks for room below the minimum size', () => {
    const { snapshot, insights } = sampleActivity();
    const rows = plain(buildFollowFrame({ ...base, snapshot, insights, width: 30, height: 10 }));
    expect(rows[0]).toContain('Enlarge the terminal');
  });
});

describe('buildTextReport', () => {
  it('prints the map, the moment, the feed and the insights', () => {
    const { snapshot, insights } = sampleActivity();
    const text = plain(
      buildTextReport({ snapshot, insights, now: T0 + 20_000, width: 90, mapHeight: 20 }),
    ).join('\n');
    expect(text).toContain('CLAUDE');
    expect(text).toContain('── Activity');
    expect(text).toContain('── Insights');
    expect(text).toMatch(/calls at \d+ stations/);
  });
});
