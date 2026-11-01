import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../types/sessionEvent';
import {
  ClaudeUsageDeduper,
  SYNTHETIC_MODEL,
  dedupedRawClaudeUsage,
  normalizeClaudeUsage,
} from './claudeUsageDedupe';

function assistant(
  id: string | undefined,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  model = 'claude-opus-4-6',
): SessionEvent {
  return normalizeClaudeUsage({
    type: 'assistant',
    timestamp: '2026-09-01T00:00:00.000Z',
    message: {
      role: 'assistant',
      ...(id ? { id } : {}),
      model,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        cache_creation_input_tokens: usage.cacheWrite ?? 0,
      },
    },
  } as SessionEvent);
}

describe('ClaudeUsageDeduper', () => {
  it('passes the first line of a message through unchanged', () => {
    const deduper = new ClaudeUsageDeduper();
    const event = assistant('msg_1', { input: 3, output: 1, cacheRead: 1000, cacheWrite: 50 });
    const out = deduper.apply(event);
    expect(out).toBe(event);
    expect(out.message?.usageKind).toBeUndefined();
  });

  it('strips usage from identical split lines of the same response', () => {
    const deduper = new ClaudeUsageDeduper();
    deduper.apply(assistant('msg_1', { input: 3, output: 40, cacheRead: 1000 }));
    const repeat = deduper.apply(assistant('msg_1', { input: 3, output: 40, cacheRead: 1000 }));
    expect(repeat.message?.usage).toBeUndefined();
    expect(repeat.message?.normalizedUsage).toBeUndefined();
    expect(repeat.message?.id).toBe('msg_1');
  });

  it('emits only the growth of a streamed output count, as a correction', () => {
    const deduper = new ClaudeUsageDeduper();
    const first = deduper.apply(assistant('msg_1', { input: 3, output: 1, cacheRead: 1000 }));
    const second = deduper.apply(assistant('msg_1', { input: 3, output: 1, cacheRead: 1000 }));
    const final = deduper.apply(assistant('msg_1', { input: 3, output: 145, cacheRead: 1000 }));
    expect(first.message?.normalizedUsage?.totalTokens).toBe(1004);
    expect(second.message?.normalizedUsage).toBeUndefined();
    expect(final.message?.usageKind).toBe('correction');
    expect(final.message?.normalizedUsage).toMatchObject({
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 144,
      totalTokens: 144,
    });
    // First + correction = the last copy's usage (last wins).
    expect(1004 + 144).toBe(3 + 145 + 1000);
  });

  it('counts different messages independently', () => {
    const deduper = new ClaudeUsageDeduper();
    deduper.apply(assistant('msg_1', { input: 3, output: 10 }));
    const other = deduper.apply(assistant('msg_2', { input: 3, output: 10 }));
    expect(other.message?.normalizedUsage?.totalTokens).toBe(13);
    expect(other.message?.usageKind).toBeUndefined();
  });

  it('passes lines without a message id through', () => {
    const deduper = new ClaudeUsageDeduper();
    const a = deduper.apply(assistant(undefined, { input: 1, output: 1 }));
    const b = deduper.apply(assistant(undefined, { input: 1, output: 1 }));
    expect(a.message?.normalizedUsage?.totalTokens).toBe(2);
    expect(b.message?.normalizedUsage?.totalTokens).toBe(2);
  });

  it('strips <synthetic> usage so it adds no call or model row', () => {
    const deduper = new ClaudeUsageDeduper();
    const out = deduper.apply(assistant('msg_s', { input: 0, output: 0 }, SYNTHETIC_MODEL));
    expect(out.message?.usage).toBeUndefined();
    expect(out.message?.normalizedUsage).toBeUndefined();
  });

  it('evicts the oldest ids beyond its bound and forgets everything on reset', () => {
    const deduper = new ClaudeUsageDeduper(2);
    deduper.apply(assistant('a', { input: 1, output: 1 }));
    deduper.apply(assistant('b', { input: 1, output: 1 }));
    deduper.apply(assistant('c', { input: 1, output: 1 }));
    expect(deduper.has('a')).toBe(false);
    expect(deduper.has('c')).toBe(true);
    deduper.reset();
    expect(deduper.has('c')).toBe(false);
  });
});

describe('ClaudeUsageDeduper resume state', () => {
  const total = (events: SessionEvent[]) =>
    events.reduce((sum, event) => sum + (event.message?.normalizedUsage?.totalTokens ?? 0), 0);

  it('does not recount a response split across the export boundary', () => {
    // One response written as three lines, the snapshot taken after the first.
    const lines = [
      assistant('msg_1', { input: 3, output: 1, cacheRead: 1000 }),
      assistant('msg_1', { input: 3, output: 1, cacheRead: 1000 }),
      assistant('msg_1', { input: 3, output: 145, cacheRead: 1000 }),
      assistant('msg_2', { input: 2, output: 9 }),
    ];
    const full = new ClaudeUsageDeduper();
    const expected = total(lines.map((line) => full.apply(line)));

    const live = new ClaudeUsageDeduper();
    const before = total([live.apply(lines[0])]);
    const state = JSON.parse(JSON.stringify(live.exportState()));
    expect(state).toEqual({
      version: 1,
      entries: [['msg_1', { input: 3, cacheRead: 1000, cacheWrite: 0, output: 1, reasoning: 0 }]],
    });

    const resumed = new ClaudeUsageDeduper();
    expect(resumed.importState(state)).toBe(true);
    const after = lines.slice(1).map((line) => resumed.apply(line));
    expect(after[0].message?.normalizedUsage).toBeUndefined();
    expect(after[1].message).toMatchObject({
      usageKind: 'correction',
      normalizedUsage: { outputTokens: 144, totalTokens: 144 },
    });
    expect(before + total(after)).toBe(expected);

    // Without the state the boundary response is counted twice.
    const fresh = new ClaudeUsageDeduper();
    expect(before + total(lines.slice(1).map((line) => fresh.apply(line)))).toBe(expected + 1004);
  });

  it('exports the most recent entries, oldest first, and imports within capacity', () => {
    const deduper = new ClaudeUsageDeduper();
    for (const id of ['a', 'b', 'c', 'd']) deduper.apply(assistant(id, { input: 1, output: 1 }));
    expect(deduper.exportState(2).entries.map(([id]) => id)).toEqual(['c', 'd']);
    expect(deduper.exportState(0).entries).toEqual([]);
    expect(deduper.exportState().entries).toHaveLength(4);

    const small = new ClaudeUsageDeduper(3);
    expect(small.importState(deduper.exportState())).toBe(true);
    expect(['a', 'b', 'c', 'd'].map((id) => small.has(id))).toEqual([false, true, true, true]);
  });

  it('replaces existing state on import', () => {
    const source = new ClaudeUsageDeduper();
    source.apply(assistant('new', { input: 1, output: 1 }));
    const target = new ClaudeUsageDeduper();
    target.apply(assistant('old', { input: 1, output: 1 }));
    expect(target.importState(source.exportState())).toBe(true);
    expect(target.has('old')).toBe(false);
    expect(target.has('new')).toBe(true);
  });

  const buckets = { input: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 };
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'state'],
    ['another version', { version: 2, entries: [] }],
    ['entries that are not an array', { version: 1, entries: {} }],
    ['an entry that is not a pair', { version: 1, entries: [['a']] }],
    ['an empty id', { version: 1, entries: [['', buckets]] }],
    ['a numeric id', { version: 1, entries: [[1, buckets]] }],
    ['missing buckets', { version: 1, entries: [['a', null]] }],
    ['a missing count', { version: 1, entries: [['a', { ...buckets, reasoning: undefined }]] }],
    ['a negative count', { version: 1, entries: [['a', { ...buckets, output: -1 }]] }],
    ['a non-finite count', { version: 1, entries: [['a', { ...buckets, input: Infinity }]] }],
    ['a string count', { version: 1, entries: [['a', { ...buckets, input: '1' }]] }],
    [
      'one bad entry among good ones',
      {
        version: 1,
        entries: [
          ['a', buckets],
          ['b', { ...buckets, cacheRead: Number.NaN }],
        ],
      },
    ],
  ])('rejects %s and keeps its state', (_label, state) => {
    const deduper = new ClaudeUsageDeduper();
    deduper.apply(assistant('kept', { input: 1, output: 1 }));
    expect(deduper.importState(state)).toBe(false);
    expect(deduper.has('kept')).toBe(true);
    expect(deduper.has('a')).toBe(false);
  });
});

describe('dedupedRawClaudeUsage', () => {
  it('reads raw JSONL assistant lines with last-copy-wins totals', () => {
    const deduper = new ClaudeUsageDeduper();
    const raw = (output: number) => ({
      type: 'assistant',
      timestamp: '2026-09-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        id: 'msg_1',
        model: 'claude-opus-4-6',
        usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 100 },
      },
    });
    const totals = [raw(1), raw(1), raw(30)]
      .map((line) => dedupedRawClaudeUsage(line, deduper)?.totalTokens ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(totals).toBe(5 + 30 + 100);
    expect(dedupedRawClaudeUsage({ type: 'user' }, deduper)).toBeNull();
  });
});
