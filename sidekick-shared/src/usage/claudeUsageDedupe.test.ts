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
