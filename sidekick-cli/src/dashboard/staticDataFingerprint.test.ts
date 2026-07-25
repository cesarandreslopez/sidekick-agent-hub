import { describe, expect, it } from 'vitest';
import { staticDataFingerprint } from './staticDataFingerprint';
import type { StaticData } from './StaticDataLoader';

function base(): StaticData {
  return {
    sessions: [],
    tasks: [],
    decisions: [],
    notes: [],
    plans: [],
    totalTokens: 0,
    totalCost: 0,
    totalSessions: 0,
  };
}

function task(id: string, updatedAt: string) {
  return {
    taskId: id,
    subject: `task ${id}`,
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt,
    toolCallCount: 0,
    blockedBy: [],
    blocks: [],
  } as unknown as StaticData['tasks'][number];
}

describe('staticDataFingerprint', () => {
  it('is stable for identical content', () => {
    const a = base();
    a.tasks = [task('1', '2026-07-01T00:00:00.000Z')];
    const b = base();
    b.tasks = [task('1', '2026-07-01T00:00:00.000Z')];
    expect(staticDataFingerprint(a)).toBe(staticDataFingerprint(b));
  });

  it('changes when an item is added', () => {
    const before = base();
    const after = base();
    after.tasks = [task('1', '2026-07-01T00:00:00.000Z')];
    expect(staticDataFingerprint(after)).not.toBe(staticDataFingerprint(before));
  });

  it('changes when an item is removed', () => {
    const before = base();
    before.tasks = [task('1', '2026-07-01T00:00:00.000Z'), task('2', '2026-07-01T00:00:00.000Z')];
    const after = base();
    after.tasks = [task('1', '2026-07-01T00:00:00.000Z')];
    expect(staticDataFingerprint(after)).not.toBe(staticDataFingerprint(before));
  });

  it('changes when an item is edited in place', () => {
    // Same count, same ids — only the timestamp moved. This is the case a
    // length-only signature would miss.
    const before = base();
    before.tasks = [task('1', '2026-07-01T00:00:00.000Z')];
    const after = base();
    after.tasks = [task('1', '2026-07-02T00:00:00.000Z')];
    expect(staticDataFingerprint(after)).not.toBe(staticDataFingerprint(before));
  });

  it('changes when aggregate totals move', () => {
    const before = base();
    const after = base();
    after.totalCost = 0.42;
    expect(staticDataFingerprint(after)).not.toBe(staticDataFingerprint(before));
  });

  it('tracks each collection independently', () => {
    const withNote = base();
    withNote.notes = [
      { id: 'n1', updatedAt: '2026-07-03T00:00:00.000Z' } as unknown as StaticData['notes'][number],
    ];
    const withDecision = base();
    withDecision.decisions = [
      {
        id: 'd1',
        timestamp: '2026-07-03T00:00:00.000Z',
      } as unknown as StaticData['decisions'][number],
    ];
    expect(staticDataFingerprint(withNote)).not.toBe(staticDataFingerprint(withDecision));
    expect(staticDataFingerprint(withNote)).not.toBe(staticDataFingerprint(base()));
  });
});
