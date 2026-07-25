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

function plan(steps: string[], completionRate: number, status = 'in_progress') {
  return {
    id: 'plan-1',
    projectSlug: 'proj',
    sessionId: 'sess-1',
    title: 'Ship it',
    source: 'claude-code',
    // A plan updated in place keeps createdAt and has no completedAt while it
    // runs, so neither timestamp moves as its steps advance.
    createdAt: '2026-07-01T00:00:00.000Z',
    status,
    steps: steps.map((s, i) => ({ id: `s${i}`, description: `step ${i}`, status: s })),
    completionRate,
  } as unknown as StaticData['plans'][number];
}

describe('staticDataFingerprint', () => {
  it('changes when a step advances under an unchanged timestamp', () => {
    const before = base();
    before.plans = [plan(['completed', 'pending', 'pending'], 33)];
    const after = base();
    after.plans = [plan(['completed', 'completed', 'pending'], 66)];
    expect(staticDataFingerprint(after)).not.toBe(staticDataFingerprint(before));
  });

  it('changes when a plan fails without recording an exit timestamp', () => {
    const before = base();
    before.plans = [plan(['completed', 'pending'], 50)];
    const after = base();
    after.plans = [plan(['completed', 'pending'], 50, 'failed')];
    expect(staticDataFingerprint(after)).not.toBe(staticDataFingerprint(before));
  });

  it('is stable for identical plan progress', () => {
    const a = base();
    a.plans = [plan(['completed', 'pending'], 50)];
    const b = base();
    b.plans = [plan(['completed', 'pending'], 50)];
    expect(staticDataFingerprint(a)).toBe(staticDataFingerprint(b));
  });

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
