/**
 * Regression tests for the Date filter mode: panels that wrap their record in
 * an envelope must expose the item timestamp via getItemTimestamp(), otherwise
 * the Date filter's null-timestamp guard excludes every item and blanks the
 * list. The prior itemTimestampMs unit tests only fed flat objects, so they
 * never caught the wrapped-shape case these panels actually produce.
 */

import { describe, it, expect } from 'vitest';
import { EventStreamPanel } from './EventStreamPanel';
import { PlansPanel } from './PlansPanel';
import { SessionsPanel } from './SessionsPanel';
import type { PanelItem } from './types';

const ISO = '2026-06-15T10:00:00Z';
const MS = Date.parse(ISO);

function item(data: unknown): PanelItem {
  return { id: 'x', label: 'x', sortKey: 0, data };
}

describe('Date filter getItemTimestamp on wrapped panel items', () => {
  it('EventStreamPanel reads the wrapped event.timestamp', () => {
    const panel = new EventStreamPanel();
    expect(panel.getItemTimestamp(item({ index: 0, event: { timestamp: ISO } }))).toBe(MS);
    expect(panel.getItemTimestamp(item({ index: 0, event: {} }))).toBeNull();
  });

  it('PlansPanel reads the wrapped plan.createdAt', () => {
    const panel = new PlansPanel();
    expect(panel.getItemTimestamp(item({ type: 'historical', plan: { createdAt: ISO } }))).toBe(MS);
    expect(panel.getItemTimestamp(item({ type: 'historical', plan: {} }))).toBeNull();
    panel.dispose?.();
  });

  it('SessionsPanel reads sessionStartTime for active and date for historical', () => {
    const panel = new SessionsPanel();
    expect(
      panel.getItemTimestamp(item({ type: 'active', metrics: { sessionStartTime: ISO } })),
    ).toBe(MS);
    expect(
      panel.getItemTimestamp(item({ type: 'historical', session: { date: '2026-06-15' } })),
    ).toBe(new Date(2026, 5, 15).getTime());
    expect(panel.getItemTimestamp(item({ type: 'active', metrics: {} }))).toBeNull();
    panel.dispose?.();
  });
});
