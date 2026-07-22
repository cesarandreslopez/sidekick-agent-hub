import { describe, expect, it } from 'vitest';
import type { FollowEvent } from 'sidekick-shared';
import { newTimelineEntries } from './timelineAlerts';

describe('timeline alerts', () => {
  it('includes a synthetic compaction entry appended beside one real event', () => {
    const timeline = [
      { type: 'summary', summary: 'Context compacted' },
      { type: 'assistant', summary: 'continued' },
    ] as FollowEvent[];
    expect(newTimelineEntries(timeline, 2, 0)).toEqual(timeline);
  });
});
