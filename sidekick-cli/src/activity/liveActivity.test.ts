import { describe, expect, it } from 'vitest';
import type { SessionEvent } from 'sidekick-shared';
import { LiveActivity } from './liveActivity';

const T = (s: number) => new Date(Date.parse('2026-11-10T22:00:00Z') + s * 1_000).toISOString();

function prompt(s: number, text: string): SessionEvent {
  return {
    type: 'user',
    timestamp: T(s),
    message: { role: 'user', content: text },
  } as SessionEvent;
}

function toolUse(
  s: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
): SessionEvent {
  return {
    type: 'assistant',
    timestamp: T(s),
    message: {
      role: 'assistant',
      id: `msg-${id}`,
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as SessionEvent;
}

function toolResult(s: number, id: string, content: string, isError = false): SessionEvent {
  return {
    type: 'user',
    timestamp: T(s),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  } as SessionEvent;
}

const events: SessionEvent[] = [
  prompt(0, 'fix the tests'),
  toolUse(1, 'r1', 'Read', { file_path: '/repo/src/app.ts' }),
  toolResult(2, 'r1', 'export const x = 1;'),
  toolUse(3, 'b1', 'Bash', { command: 'npm test', description: 'Run the tests' }),
  toolResult(6, 'b1', 'FAIL', true),
];

describe('LiveActivity', () => {
  it('folds events into a snapshot and insights, and bumps its version', () => {
    const live = new LiveActivity({ providerId: 'claude-code', sessionId: 's1' });
    const before = live.version;
    expect(live.observeMany(events)).toBeGreaterThan(0);
    expect(live.version).toBeGreaterThan(before);
    const snapshot = live.snapshot();
    const files = snapshot.stations.find((s) => s.id === 'files');
    const shell = snapshot.stations.find((s) => s.id === 'shell');
    expect(files?.count).toBe(1);
    expect(shell?.faults).toBe(1);
    expect(live.snapshot()).toBe(snapshot);
    expect(live.insights().totals.errors).toBe(1);
  });

  it('labels with descriptions only when asked', () => {
    const names = new LiveActivity({ providerId: 'claude-code' });
    names.observeMany(events);
    const descriptive = new LiveActivity({
      providerId: 'claude-code',
      recorder: { labels: 'descriptive' },
    });
    descriptive.observeMany(events);
    const label = (live: LiveActivity) =>
      live.snapshot().entries.find((entry) => entry.station === 'shell')?.label;
    expect(label(names)).not.toContain('Run the tests');
    expect(label(descriptive)).toBe('Run the tests');
  });

  it('round-trips through a checkpoint and keeps counting where it left off', () => {
    const live = new LiveActivity({ providerId: 'claude-code', sessionId: 's1' });
    live.observeMany(events.slice(0, 4));
    const saved = JSON.parse(JSON.stringify(live.serialize()));

    const restored = new LiveActivity({ providerId: 'claude-code', sessionId: 's1' });
    expect(restored.restore(saved)).toBe(true);
    restored.observe(events[4]);

    const uninterrupted = new LiveActivity({ providerId: 'claude-code', sessionId: 's1' });
    uninterrupted.observeMany(events);
    expect(restored.snapshot().stations).toEqual(uninterrupted.snapshot().stations);
    expect(restored.insights().totals).toEqual(uninterrupted.insights().totals);
  });

  it('refuses a malformed checkpoint and starts over', () => {
    const live = new LiveActivity({ providerId: 'claude-code' });
    live.observeMany(events);
    expect(live.restore({ version: 99 })).toBe(false);
    expect(live.snapshot().totals.calls).toBe(0);
  });

  it('scrubs back through kept records', () => {
    const live = new LiveActivity({ providerId: 'claude-code', keepRecords: 1_000 });
    live.observeMany(events);
    const range = live.range();
    expect(range).not.toBeNull();
    const early = live.snapshotAt(Date.parse(T(2.5)));
    expect(early.stations.find((s) => s.id === 'shell')?.count ?? 0).toBe(0);
    expect(live.snapshotAt(range!.endMs)).toBe(live.snapshot());
  });

  it('resets for a new session', () => {
    const live = new LiveActivity({ providerId: 'claude-code', sessionId: 's1' });
    live.observeMany(events);
    live.reset('s2');
    expect(live.sessionId).toBe('s2');
    expect(live.snapshot().totals.calls).toBe(0);
  });
});
