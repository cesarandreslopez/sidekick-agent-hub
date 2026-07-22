import type { FollowEvent } from 'sidekick-shared';

export function newTimelineEntries(
  timeline: FollowEvent[],
  totalAppends: number,
  previousTotalAppends: number,
): FollowEvent[] {
  const added = Math.max(0, totalAppends - previousTotalAppends);
  return timeline.slice(Math.max(0, timeline.length - Math.min(added, timeline.length)));
}
