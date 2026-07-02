/**
 * Layout-aware detail width: panels must wrap to the width threaded via
 * DetailRenderContext, not the legacy full-terminal estimate.
 */

import { describe, it, expect } from 'vitest';
import { NotesPanel } from './NotesPanel';
import { DashboardState } from '../DashboardState';
import type { DashboardMetrics } from '../DashboardState';
import type { StaticData } from '../StaticDataLoader';
import type { PanelItem } from './types';
import { visibleLength } from '../formatters';

const LONG =
  'The quick brown fox jumps over the lazy dog again and again and again, ' +
  'wrapping across many columns to exercise the word wrapper thoroughly.';

function renderNoteAt(width: number | undefined): string {
  const panel = new NotesPanel();
  const item: PanelItem = {
    id: 'n1',
    label: 'note',
    sortKey: 0,
    data: { noteType: 'tip', content: LONG, filePath: 'a.ts' },
  };
  const metrics = new DashboardState().getMetrics() as DashboardMetrics;
  const ctx = width === undefined ? undefined : { width };
  return panel.detailTabs[0].render(item, metrics, { sessions: [] } as unknown as StaticData, ctx);
}

describe('DetailRenderContext width threading', () => {
  // The four layout modes yield side widths 0 / 22 / 26 / 40; spot-check
  // representative content widths on an 80-column terminal.
  for (const width of [45, 51, 54, 77]) {
    it(`wraps content within ${width} columns`, () => {
      const out = renderNoteAt(width);
      for (const line of out.split('\n')) {
        expect(visibleLength(line), `line too wide: ${line}`).toBeLessThanOrEqual(width);
      }
    });
  }

  it('falls back to the legacy estimate without ctx', () => {
    const out = renderNoteAt(undefined);
    expect(out).toContain('Content');
  });
});
