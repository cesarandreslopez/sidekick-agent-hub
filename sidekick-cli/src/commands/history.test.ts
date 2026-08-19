import { describe, expect, it, vi } from 'vitest';
import { formatHistoryTable, resolveHistorySession, tailBytesFor, toHistoryRow } from './history';
import type { HistoryRow } from './history';

const now = new Date('2026-02-20T12:00:00Z');

describe('toHistoryRow', () => {
  it('normalizes epoch-second timestamps', () => {
    const ts = Math.floor(new Date('2026-02-20T11:55:00Z').getTime() / 1000);
    const row = toHistoryRow({ sessionId: 'abc', ts, text: 'hello' }, now);

    expect(row.timestamp).toBe('2026-02-20T11:55:00.000Z');
    expect(row.age).toBe('5m ago');
  });

  it('accepts epoch-millisecond timestamps unchanged', () => {
    const ts = new Date('2026-02-20T11:55:00Z').getTime();
    const row = toHistoryRow({ sessionId: 'abc', ts, text: 'hello' }, now);

    expect(row.timestamp).toBe('2026-02-20T11:55:00.000Z');
  });

  it('collapses newlines and strips control characters from the prompt', () => {
    const row = toHistoryRow(
      { sessionId: 'abc', ts: 1, text: 'line one\n\tline two\u0007 end  ' },
      now,
    );

    expect(row.prompt).toBe('line one line two end');
  });
});

describe('formatHistoryTable', () => {
  const rows: HistoryRow[] = [
    {
      sessionId: '0198a3c2-9d1e-4f00-b111-222233334444',
      timestamp: '2026-02-20T11:55:00.000Z',
      age: '5m ago',
      prompt: 'Fix the flaky watcher test',
    },
    {
      sessionId: 'short',
      timestamp: '2026-02-19T11:00:00.000Z',
      age: '1d ago',
      prompt: 'x'.repeat(300),
    },
  ];

  it('renders header, truncated session ids, and the footer', () => {
    const table = formatHistoryTable(rows, 80);
    const lines = table.split('\n');

    expect(lines[0]).toMatch(/^AGE\s+SESSION\s+PROMPT$/);
    expect(lines[2]).toContain('0198a3c2');
    expect(lines[2]).not.toContain('0198a3c2-');
    expect(table).toContain('2 prompt(s) shown (Codex).');
  });

  it('truncates prompts to the available width', () => {
    const table = formatHistoryTable(rows, 60);
    const longRow = table.split('\n')[3];

    expect(longRow.length).toBeLessThanOrEqual(60);
    expect(longRow).toContain('…');
  });
});

describe('tailBytesFor', () => {
  it('keeps the reader default for small limits and scales past it for large ones', () => {
    // A --limit past what fits in the reader's default 512 KiB tail must
    // widen the read instead of silently returning fewer rows.
    expect(tailBytesFor(20)).toBe(512 * 1024);
    expect(tailBytesFor(2000)).toBe(2000 * 4096);
  });
});

describe('resolveHistorySession', () => {
  function deps(overrides: {
    rollouts?: Record<string, string>;
    historyIds?: string[];
  }): Parameters<typeof resolveHistorySession>[1] {
    const rollouts = overrides.rollouts ?? {};
    return {
      findCodexRolloutFile: vi.fn((id: string) => rollouts[id] ?? null),
      readCodexHistory: vi.fn(() =>
        (overrides.historyIds ?? []).map((sessionId, index) => ({
          sessionId,
          ts: index,
          text: 'prompt',
        })),
      ),
    };
  }

  it('resolves a full id directly without reading history', () => {
    const d = deps({ rollouts: { 'full-id': '/codex/sessions/full-id.jsonl' } });

    expect(resolveHistorySession('full-id', d)).toEqual({
      sessionId: 'full-id',
      rolloutPath: '/codex/sessions/full-id.jsonl',
    });
    expect(d.readCodexHistory).not.toHaveBeenCalled();
  });

  it('resolves a unique prefix case-insensitively', () => {
    const d = deps({
      rollouts: { '0198A3C2-full': '/codex/sessions/rollout.jsonl' },
      historyIds: ['0198A3C2-full', 'other-session'],
    });

    expect(resolveHistorySession('0198a3c2', d)).toEqual({
      sessionId: '0198A3C2-full',
      rolloutPath: '/codex/sessions/rollout.jsonl',
    });
    expect(d.readCodexHistory).toHaveBeenCalledWith({
      limit: 1000,
      maxTailBytes: tailBytesFor(1000),
    });
  });

  it('reports ambiguous prefixes with the matching ids', () => {
    const d = deps({ historyIds: ['abc-one', 'abc-two'] });
    const result = resolveHistorySession('abc', d);

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('abc-one');
    expect((result as { error: string }).error).toContain('abc-two');
  });

  it('reports unknown sessions and pruned rollout files', () => {
    expect(resolveHistorySession('missing', deps({}))).toEqual({
      error: 'no rollout file found for session missing',
    });
    // In history, but the rollout file itself was pruned.
    expect(resolveHistorySession('abc', deps({ historyIds: ['abc-one'] }))).toEqual({
      error: 'no rollout file found for session abc-one',
    });
  });
});
