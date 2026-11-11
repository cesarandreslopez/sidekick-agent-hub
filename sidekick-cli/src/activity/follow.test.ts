import { describe, expect, it } from 'vitest';
import type { SessionEvent } from 'sidekick-shared';
import { followKeyFor } from './MapFollowApp';
import { inMotion } from './follow';
import { LiveActivity } from './liveActivity';

describe('followKeyFor', () => {
  it('maps the documented keys and ignores the rest', () => {
    expect(followKeyFor('q', {})).toEqual({ type: 'quit' });
    expect(followKeyFor('', { escape: true })).toEqual({ type: 'quit' });
    expect(followKeyFor('c', { ctrl: true })).toEqual({ type: 'quit' });
    expect(followKeyFor('f', {})).toEqual({ type: 'feed' });
    expect(followKeyFor('i', {})).toEqual({ type: 'insights' });
    expect(followKeyFor('p', {})).toEqual({ type: 'pause' });
    expect(followKeyFor(' ', {})).toEqual({ type: 'pause' });
    expect(followKeyFor('l', {})).toEqual({ type: 'live' });
    expect(followKeyFor('', { leftArrow: true })).toEqual({ type: 'seek', ms: -10_000 });
    expect(followKeyFor('', { rightArrow: true, shift: true })).toEqual({
      type: 'seek',
      ms: 60_000,
    });
    expect(followKeyFor('z', {})).toBeNull();
  });
});

describe('inMotion', () => {
  const at = Date.parse('2026-11-10T22:00:00Z');
  const start: SessionEvent = {
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      role: 'assistant',
      id: 'm1',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 30' } }],
    },
  } as SessionEvent;

  it('is moving while a call runs and still once the turn ended long ago', () => {
    const live = new LiveActivity({ providerId: 'claude-code' });
    live.observe(start);
    expect(inMotion(live, at + 60_000)).toBe(true);
    live.observe({
      type: 'user',
      timestamp: new Date(at + 1_000).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }],
      },
    } as SessionEvent);
    live.observe({
      type: 'assistant',
      timestamp: new Date(at + 2_000).toISOString(),
      message: {
        role: 'assistant',
        id: 'm2',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      },
    } as SessionEvent);
    expect(live.snapshot().turn.working).toBe(false);
    expect(inMotion(live, at + 60_000)).toBe(false);
    expect(inMotion(live, at + 2_500)).toBe(true);
  });
});
