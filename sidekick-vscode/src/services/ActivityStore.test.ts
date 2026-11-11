import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from 'sidekick-shared';
import { ActivityStore } from './ActivityStore';

const T0 = Date.parse('2026-11-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function prompt(offsetMs: number, text = 'go'): SessionEvent {
  return {
    type: 'user',
    timestamp: iso(offsetMs),
    message: { role: 'user', content: text },
  } as SessionEvent;
}

function toolUse(
  offsetMs: number,
  id: string,
  name: string,
  input: Record<string, unknown>,
): SessionEvent {
  return {
    type: 'assistant',
    timestamp: iso(offsetMs),
    message: {
      id: `msg-${id}`,
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'tool_use', id, name, input }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  } as SessionEvent;
}

function toolResult(offsetMs: number, id: string, content: string, isError = false): SessionEvent {
  return {
    type: 'user',
    timestamp: iso(offsetMs),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  } as SessionEvent;
}

function session(): SessionEvent[] {
  return [
    prompt(0),
    toolUse(1_000, 't1', 'Read', { file_path: '/repo/src/index.ts' }),
    toolResult(1_500, 't1', 'export {}'),
    toolUse(2_000, 't2', 'Bash', { command: 'npm test', description: 'Run the tests' }),
    toolResult(4_000, 't2', 'FAIL', true),
  ];
}

const newStore = (overrides: Partial<ConstructorParameters<typeof ActivityStore>[0]> = {}) =>
  new ActivityStore({
    recorder: { providerId: 'claude-code', sessionId: 'sess-1', deriveContext: false },
    ...overrides,
  });

afterEach(() => {
  vi.useRealTimers();
});

describe('ActivityStore', () => {
  it('numbers records without gaps and folds them into a snapshot', () => {
    const store = newStore();
    let produced = 0;
    for (const event of session()) produced += store.observe(event);
    expect(produced).toBeGreaterThan(0);
    const records = store.records();
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
    expect(store.nextSeq).toBe(records.length);
    expect(store.baseSeq).toBe(0);
    const snapshot = store.snapshot();
    const files = snapshot.stations.find((s) => s.id === 'files');
    const shell = snapshot.stations.find((s) => s.id === 'shell');
    expect(files?.count).toBe(1);
    expect(shell?.count).toBe(1);
    expect(shell?.faults).toBe(1);
    expect(store.insights().totals.calls).toBe(2);
  });

  it('hands out the records after a seq, and null for one it does not hold', () => {
    const store = newStore();
    for (const event of session()) store.observe(event);
    const all = store.records();
    expect(store.recordsFrom(0)).toEqual([...all]);
    expect(store.recordsFrom(all.length)).toEqual([]);
    expect(store.recordsFrom(2)?.[0].seq).toBe(2);
    expect(store.recordsFrom(all.length + 1)).toBeNull();
    expect(store.recordsFrom(-1)).toBeNull();
  });

  it('starts a new epoch on reset, empty and renumbered', () => {
    const store = newStore();
    for (const event of session()) store.observe(event);
    const epoch = store.epoch;
    store.reset({ providerId: 'codex', sessionId: 'sess-2' });
    expect(store.epoch).toBe(epoch + 1);
    expect(store.records()).toEqual([]);
    expect(store.nextSeq).toBe(0);
    expect(store.providerId).toBe('codex');
    expect(store.sessionId).toBe('sess-2');
  });

  it('coalesces notifications and stays silent during a replay', () => {
    vi.useFakeTimers();
    const store = newStore({ coalesceMs: 100, maxWaitMs: 250 });
    const heard: number[] = [];
    store.onDidAppend((event) => heard.push(event.nextSeq));

    store.beginReplay();
    for (const event of session()) store.observe(event);
    vi.advanceTimersByTime(1_000);
    expect(heard).toEqual([]);
    store.endReplay();
    vi.advanceTimersByTime(100);
    expect(heard).toEqual([store.nextSeq]);

    // Live: several events within the window give one notification.
    store.observe(prompt(10_000, 'next'));
    store.observe(toolUse(10_100, 't3', 'Grep', { pattern: 'x' }));
    vi.advanceTimersByTime(99);
    expect(heard).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(heard).toHaveLength(2);
    expect(heard[1]).toBe(store.nextSeq);
  });

  it('never waits longer than maxWaitMs under a steady stream', () => {
    vi.useFakeTimers();
    const store = newStore({ coalesceMs: 100, maxWaitMs: 250 });
    let calls = 0;
    store.onDidAppend(() => calls++);
    for (let i = 0; i < 6; i++) {
      store.observe(prompt(i * 50, `p${i}`));
      vi.advanceTimersByTime(50);
    }
    expect(calls).toBe(1);
  });

  it('turns host context measurements into context records', () => {
    const store = newStore();
    store.observe(prompt(0));
    expect(
      store.observeContext({ at: T0 + 500, usedTokens: 250_000, windowTokens: 1_000_000 }),
    ).toBe(1);
    expect(store.snapshot().context).toMatchObject({
      percent: 25,
      tokens: 250_000,
      window: 1_000_000,
    });
    expect(store.observeContext({ at: T0 + 600, usedTokens: 10, windowTokens: 0 })).toBe(0);
    expect(store.observeContext({ at: Number.NaN, usedTokens: 10, windowTokens: 100 })).toBe(0);
  });

  it('round-trips through serialize and restore, and keeps numbering after it', () => {
    const store = newStore();
    for (const event of session()) store.observe(event);
    const persisted = JSON.parse(JSON.stringify(store.serialize()));

    const resumed = newStore();
    const epoch = resumed.epoch;
    expect(resumed.restore(persisted)).toBe(true);
    expect(resumed.epoch).toBe(epoch + 1);
    expect(resumed.snapshot()).toEqual(store.snapshot());
    expect(resumed.nextSeq).toBe(store.nextSeq);

    // The open Bash call settles on its result, as it would have without the restart.
    const next = toolUse(5_000, 't4', 'Edit', { file_path: '/repo/src/a.ts' });
    store.observe(next);
    resumed.observe(next);
    expect(resumed.records()).toEqual(store.records());
  });

  it('refuses a state from another session or provider, or a malformed one', () => {
    const store = newStore();
    for (const event of session()) store.observe(event);
    const persisted = store.serialize();

    const otherSession = new ActivityStore({
      recorder: { providerId: 'claude-code', sessionId: 'other', deriveContext: false },
    });
    expect(otherSession.restore(persisted)).toBe(false);
    const otherProvider = new ActivityStore({
      recorder: { providerId: 'codex', sessionId: 'sess-1', deriveContext: false },
    });
    expect(otherProvider.restore(persisted)).toBe(false);
    expect(newStore().restore({ ...persisted, version: 2 })).toBe(false);
    expect(newStore().restore(null)).toBe(false);
    const gap = [...persisted.records.slice(0, 2), ...persisted.records.slice(3)];
    expect(newStore().restore({ ...persisted, records: gap })).toBe(false);
    expect(newStore().restore({ ...persisted, base: { kind: 'other' } })).toBe(false);
    const withoutBase: Record<string, unknown> = { ...persisted };
    delete withoutBase.base;
    expect(newStore().restore(withoutBase)).toBe(false);
  });

  it('restores a log that dropped old records, totals and all', () => {
    // A cap drops old records (the timeline keeps at least two checkpoint intervals, 512).
    const capped = newStore({ maxRecords: 40 });
    capped.observe(prompt(0));
    for (let i = 0; i < 300; i++) {
      capped.observe(toolUse(i * 1_000, `c${i}`, 'Read', { file_path: `/repo/f${i}.ts` }));
      capped.observe(toolResult(i * 1_000 + 10, `c${i}`, 'ok', i % 9 === 0));
    }
    expect(capped.baseSeq).toBeGreaterThan(0);
    expect(capped.recordsFrom(0)).toBeNull();
    // Totals still count every call.
    expect(capped.snapshot().stations.find((s) => s.id === 'files')?.count).toBe(300);

    const persisted = JSON.parse(JSON.stringify(capped.serialize()));
    const resumed = newStore({ maxRecords: 40 });
    expect(resumed.restore(persisted)).toBe(true);
    expect(resumed.baseSeq).toBe(capped.baseSeq);
    expect(resumed.nextSeq).toBe(capped.nextSeq);
    expect(resumed.snapshot()).toEqual(capped.snapshot());
    expect(resumed.insights()).toEqual(capped.insights());
    const mid = capped.records()[Math.floor(capped.records().length / 2)].at;
    expect(resumed.snapshot(mid)).toEqual(capped.snapshot(mid));

    const next = toolUse(400_000, 'n1', 'Bash', { command: 'npm test' });
    capped.observe(next);
    resumed.observe(next);
    expect(resumed.records()).toEqual(capped.records());
    expect(resumed.insights()).toEqual(capped.insights());
  });

  it('applies new label settings to later events without renumbering', () => {
    const store = newStore();
    store.observe(prompt(0));
    store.observe(
      toolUse(1_000, 'b1', 'Bash', { command: 'npm run lint', description: 'Lint it' }),
    );
    const before = store.nextSeq;
    store.reconfigure({ labels: 'none', deriveContext: false });
    store.observe(
      toolUse(2_000, 'b2', 'Bash', { command: 'npm run lint', description: 'Lint it' }),
    );
    const records = store.records();
    expect(store.recordsFrom(before)?.[0].seq).toBe(before);
    expect(records.map((r) => r.seq)).toEqual(records.map((_, i) => i));
    const starts = records.filter((r) => r.kind === 'toolStart');
    expect(starts[1]).toMatchObject({ kind: 'toolStart', labelKey: expect.any(String) });
  });
});
