import { describe, expect, it } from 'vitest';
import {
  busySnapshot,
  hostileSnapshot,
  NOW,
  quietSnapshot,
  thinkingSnapshot,
} from '../../testing/activityFixtures.setup';
import type { ActivityTextLayout } from '../types';
import { layoutActivityMapText } from './text';

const GOLDEN = '../../fixtures/activity/golden';

function plain(layout: ActivityTextLayout): string {
  return `${layout.mode}\n${layout.rows.map((row) => row.map((s) => s.text).join('')).join('\n')}\n`;
}

const codePoints = (text: string) => Array.from(text).length;

describe('layoutActivityMapText', () => {
  it('lays out a ring when there is room, a list otherwise (golden)', async () => {
    const ring = layoutActivityMapText(busySnapshot(), { now: NOW, width: 80, height: 19 });
    expect(ring.mode).toBe('ring');
    await expect(plain(ring)).toMatchFileSnapshot(`${GOLDEN}/busy-text-80.txt`);
    const list = layoutActivityMapText(busySnapshot(), { now: NOW, width: 40 });
    expect(list.mode).toBe('list');
    await expect(plain(list)).toMatchFileSnapshot(`${GOLDEN}/busy-text-40.txt`);
  });

  it('never exceeds the width, at any size, in either mode', () => {
    for (const snapshot of [
      busySnapshot(),
      quietSnapshot(),
      thinkingSnapshot(),
      hostileSnapshot(),
    ]) {
      for (let width = 20; width <= 140; width += 7) {
        for (const mode of ['auto', 'ring', 'list'] as const) {
          const layout = layoutActivityMapText(snapshot, { now: NOW, width, height: 20, mode });
          expect(layout.width).toBe(width);
          for (const row of layout.rows) {
            expect(row.reduce((n, s) => n + codePoints(s.text), 0)).toBeLessThanOrEqual(width);
          }
        }
      }
    }
  });

  it('respects a measure that counts wide characters twice', () => {
    const wide = (text: string) =>
      Array.from(text).reduce((n, ch) => n + (/[　-鿿]/.test(ch) ? 2 : 1), 0);
    const layout = layoutActivityMapText(busySnapshot(), {
      now: NOW,
      width: 70,
      height: 18,
      measure: wide,
      strings: { stations: { files: 'ファイル', shell: 'シェル' } as never },
    });
    expect(plain(layout)).toContain('ファイル');
    for (const row of layout.rows) {
      expect(row.reduce((n, s) => n + wide(s.text), 0)).toBeLessThanOrEqual(70);
    }
  });

  it('turns the spinner with time and marks faults and concurrency', () => {
    const a = plain(layoutActivityMapText(busySnapshot(), { now: NOW, width: 90, height: 19 }));
    const b = plain(
      layoutActivityMapText(busySnapshot(), { now: NOW + 250, width: 90, height: 19 }),
    );
    expect(a).not.toBe(b);
    expect(a).toContain('Shell 27 ✕3 ×2');
    expect(a).toContain('Memory 3 ↓2');
  });

  it('caps rows at the height and keeps the route last in list mode', () => {
    const list = layoutActivityMapText(busySnapshot(), { now: NOW, width: 50, mode: 'list' });
    expect(list.rows).toHaveLength(13);
    expect(list.rows[12][0].text).toBe('↝ ');
    const short = layoutActivityMapText(busySnapshot(), { now: NOW, width: 50, height: 5 });
    expect(short.rows).toHaveLength(5);
  });

  it('dims stations outside the highlight and tags segments by station', () => {
    const layout = layoutActivityMapText(busySnapshot(), {
      now: NOW,
      width: 50,
      mode: 'list',
      highlight: ['shell'],
    });
    const files = layout.rows.find((row) =>
      row.some((s) => s.station === 'files' && s.text.startsWith('Files')),
    );
    const shell = layout.rows.find((row) =>
      row.some((s) => s.station === 'shell' && s.text.startsWith('Shell')),
    );
    expect(files?.find((s) => s.station === 'files')?.tone).toBe('dim');
    expect(shell?.find((s) => s.station === 'shell')?.tone).toBe('fault');
  });

  it('shows the thinking model as running and the core box with context', () => {
    const ring = plain(
      layoutActivityMapText(thinkingSnapshot(), { now: NOW, width: 80, height: 17 }),
    );
    expect(ring).toMatch(/[◐◓◑◒] Model 6/);
    expect(ring).toContain('CODEX');
    expect(ring).toContain('93%');
  });
});
