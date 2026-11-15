import { describe, expect, it } from 'vitest';
import { EventStreamPanel } from './EventStreamPanel';
import { DashboardState } from '../DashboardState';
import { stripBlessedTags, visibleLength } from '../formatters';

function feed(state: DashboardState, count: number, start = 0): void {
  for (let i = start; i < start + count; i++) {
    state.processEvent({
      providerId: 'claude-code',
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 10, 15, 10, 0, i)).toISOString(),
      summary: `event ${i}`,
    });
  }
}

describe('EventStreamPanel', () => {
  it('keeps an event id stable when the ring shifts under it', () => {
    const state = new DashboardState();
    const panel = new EventStreamPanel();
    feed(state, 250);
    const before = panel.getItems(state.getMetrics());
    const target = before.find((item) => stripBlessedTags(item.label).includes('event 240'))!;
    feed(state, 5, 250);
    const after = panel.getItems(state.getMetrics());
    const same = after.find((item) => item.id === target.id)!;
    expect(stripBlessedTags(same.label)).toContain('event 240');
    // The slot moved, the id did not.
    expect(after.indexOf(same)).not.toBe(before.indexOf(target));
  });

  it('fits the token breakdown and raw JSON to narrow panes', () => {
    const state = new DashboardState();
    state.processEvent({
      providerId: 'claude-code',
      type: 'assistant',
      timestamp: '2026-11-15T10:00:00.000Z',
      summary: 'hi',
      tokens: { input: 175_400, output: 2_300 },
    });
    const panel = new EventStreamPanel();
    const item = panel.getItems(state.getMetrics())[0];
    const out = panel.detailTabs[0].render(item, state.getMetrics(), {} as never, { width: 40 });
    const lines = out.split('\n');
    const start = lines.findIndex((line) => line.includes('Tokens'));
    const end = lines.findIndex((line, i) => i > start && line === '');
    expect(end - start).toBeGreaterThanOrEqual(2);
    for (const line of lines.slice(start, end)) expect(visibleLength(line)).toBeLessThanOrEqual(40);
    // Raw JSON braces are escaped so the tag parser keeps them.
    expect(out).toContain('{open}');
    expect(out).toContain('175.4k');
  });
});
