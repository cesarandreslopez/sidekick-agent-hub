import { describe, expect, it } from 'vitest';
import { decideSessionFollow } from './sessionFollow';

describe('decideSessionFollow', () => {
  it('stays on a chosen session when another known session is written to', () => {
    // The user picked /b; /a was already there and is now the newest by mtime.
    const known = new Set(['/a', '/b']);
    const decision = decideSessionFollow({
      sessions: ['/a', '/b'],
      known,
      followed: '/b',
      pinned: false,
    });
    expect(decision).toEqual({ action: 'none' });
  });

  it('does not switch to the session it already follows', () => {
    const known = new Set<string>();
    expect(
      decideSessionFollow({ sessions: ['/a'], known, followed: '/a', pinned: false }),
    ).toEqual({ action: 'none' });
    expect(
      decideSessionFollow({ sessions: ['/a'], known: new Set(), followed: '/a', pinned: true }),
    ).toEqual({ action: 'none' });
  });

  it('follows a session that did not exist before', () => {
    const known = new Set(['/a']);
    expect(
      decideSessionFollow({ sessions: ['/new', '/a'], known, followed: '/a', pinned: false }),
    ).toEqual({ action: 'switch', sessionPath: '/new' });
    // Seen once, it is no longer new.
    expect(known.has('/new')).toBe(true);
    expect(
      decideSessionFollow({ sessions: ['/a', '/new'], known, followed: '/new', pinned: false }),
    ).toEqual({ action: 'none' });
  });

  it('offers a new session instead of following it while pinned', () => {
    const known = new Set(['/a']);
    expect(
      decideSessionFollow({ sessions: ['/new', '/a'], known, followed: '/a', pinned: true }),
    ).toEqual({ action: 'pending', sessionPath: '/new' });
  });

  it('follows the first session to appear when the dashboard started with none', () => {
    const known = new Set<string>();
    expect(
      decideSessionFollow({ sessions: ['/first'], known, followed: undefined, pinned: false }),
    ).toEqual({ action: 'switch', sessionPath: '/first' });
  });

  it('does nothing when the list is empty', () => {
    expect(
      decideSessionFollow({ sessions: [], known: new Set(), followed: undefined, pinned: false }),
    ).toEqual({ action: 'none' });
  });
});
