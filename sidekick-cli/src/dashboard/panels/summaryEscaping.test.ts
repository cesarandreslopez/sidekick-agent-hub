/**
 * Agent text is data: a summary that happens to contain a real tag name
 * (`{bold}`, `{red-fg}`) must render literally, never restyle the row (or,
 * since open tags carry across wrapped lines, the rest of the pane).
 */
import { describe, expect, it } from 'vitest';
import { EventStreamPanel } from './EventStreamPanel';
import { stripBlessedTags } from '../formatters';
import type { DashboardMetrics } from '../DashboardState';

const summary = 'Please fix {bold}the{/bold} layout and {red-fg}this';

function metrics(): DashboardMetrics {
  return {
    timeline: [{ type: 'assistant', timestamp: '2026-11-15T10:00:00Z', summary }],
    timelineAppendCount: 1,
  } as unknown as DashboardMetrics;
}

describe('event summaries with tag-like text', () => {
  it('keep their braces in the side list', () => {
    const [item] = new EventStreamPanel().getItems(metrics());
    expect(stripBlessedTags(item.label)).toContain(summary);
  });

  it('keep their braces in the Full Event tab', () => {
    const panel = new EventStreamPanel();
    const m = metrics();
    const [item] = panel.getItems(m);
    const lines = panel.detailTabs[0].render(item, m, {} as never, { width: 120 } as never);
    const text = (Array.isArray(lines) ? lines : [lines])
      .map(String)
      .map(stripBlessedTags)
      .join('\n');
    expect(text).toContain(summary);
  });
});
