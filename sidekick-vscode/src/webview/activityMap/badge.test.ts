import { describe, expect, it } from 'vitest';
import { sessionBadge } from './index';

describe('sessionBadge', () => {
  it('uses the shared status words for the monitored session', () => {
    expect(sessionBadge(false, undefined, false, true)).toBe('No session');
    expect(sessionBadge(true, 'live', true, true)).toBe('Live');
    expect(sessionBadge(true, 'live', false, true)).toBe('Viewing');
  });

  it('keeps Ended for a replayed past session and Replay for scrubbing', () => {
    expect(sessionBadge(true, 'archive', false, true)).toBe('Ended');
    expect(sessionBadge(true, 'archive', false, false)).toBe('Replay');
    expect(sessionBadge(true, 'live', true, false)).toBe('Replay');
  });
});
