import { describe, expect, it } from 'vitest';
import { matchesSessionFilter, normalizeSessionId, sameSession } from './sessionScope';

const UUID = '0b9d8f2e-1c3a-4b5d-8e7f-0123456789ab';
const OTHER = 'ffffffff-1c3a-4b5d-8e7f-0123456789ab';
const item = (data: unknown) => ({ id: 'x', label: 'x', sortKey: 0, data });
const active = { active: true, label: '● active session' };

describe('sameSession', () => {
  it('matches the same UUID however a host recorded it', () => {
    expect(sameSession(UUID, UUID)).toBe(true);
    // The CLI follows a Codex rollout by file name; the extension stores the UUID.
    expect(sameSession(UUID, `rollout-2026-11-15T10-00-00-${UUID}`)).toBe(true);
    expect(sameSession(UUID.toUpperCase(), UUID)).toBe(true);
  });

  it('accepts a legacy 8-character UUID prefix', () => {
    expect(sameSession(UUID.slice(0, 8), UUID)).toBe(true);
  });

  it('never matches on a shared non-UUID prefix', () => {
    expect(sameSession('rollout-', `rollout-2026-11-15T10-00-00-${UUID}`)).toBe(false);
    expect(sameSession(`rollout-2026-01-01T00-00-00-${OTHER}`, `rollout-2026-11-15T10-00-00-${UUID}`)).toBe(false);
    expect(sameSession(OTHER, UUID)).toBe(false);
  });

  it('normalises to the UUID', () => {
    expect(normalizeSessionId(`rollout-x-${UUID}`)).toBe(UUID);
    expect(normalizeSessionId('ses_ABC')).toBe('ses_abc');
  });
});

describe('matchesSessionFilter (active)', () => {
  it('keeps records of the live session and hides other sessions', () => {
    expect(matchesSessionFilter(item({ sessionOrigin: UUID }), active, UUID)).toBe(true);
    expect(matchesSessionFilter(item({ sessionOrigin: OTHER }), active, UUID)).toBe(false);
    expect(matchesSessionFilter(item({ sessionId: UUID }), active, UUID)).toBe(true);
  });

  it('always shows records that name no session or were written by the CLI', () => {
    expect(matchesSessionFilter(item({ sessionId: 'cli' }), active, UUID)).toBe(true);
    expect(matchesSessionFilter(item({ subject: 'no id' }), active, UUID)).toBe(true);
  });

  it('is a no-op while there is no live session id', () => {
    expect(matchesSessionFilter(item({ sessionOrigin: OTHER }), active, undefined)).toBe(true);
  });

  it('follows the live session id, so it tracks an auto-switch', () => {
    const record = item({ sessionOrigin: OTHER });
    expect(matchesSessionFilter(record, active, UUID)).toBe(false);
    expect(matchesSessionFilter(record, active, OTHER)).toBe(true);
  });

  it('reads plans inside their envelope and keeps the live plan', () => {
    expect(matchesSessionFilter(item({ type: 'historical', plan: { sessionId: OTHER } }), active, UUID)).toBe(false);
    expect(matchesSessionFilter(item({ type: 'historical', plan: { sessionId: UUID } }), active, UUID)).toBe(true);
    expect(matchesSessionFilter(item({ type: 'active', plan: { title: 'live' } }), active, UUID)).toBe(true);
  });
});

describe('matchesSessionFilter (date)', () => {
  const byDate = { date: '2026-11-15', label: '⊛ 2026-11-15' };

  it('matches the record date, including plans in their envelope', () => {
    expect(matchesSessionFilter(item({ createdAt: '2026-11-15T09:00:00Z' }), byDate, UUID)).toBe(true);
    expect(matchesSessionFilter(item({ createdAt: '2026-11-14T09:00:00Z' }), byDate, UUID)).toBe(false);
    expect(
      matchesSessionFilter(
        item({ type: 'historical', plan: { createdAt: '2026-11-15T09:00:00Z' } }),
        byDate,
        UUID,
      ),
    ).toBe(true);
  });
});
