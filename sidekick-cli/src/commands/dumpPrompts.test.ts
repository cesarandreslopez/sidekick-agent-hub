import { describe, expect, it, vi } from 'vitest';
import type {
  CollectSessionPromptHistoryOptions,
  PromptHistorySession,
  SessionPromptHistoryResult,
} from 'sidekick-shared';
import {
  collectAllPromptSessions,
  collectPromptUsage,
  formatPromptUsage,
  indexPromptUsage,
  withPromptUsage,
  formatPromptSessionsJsonl,
  formatPromptSessionsMarkdown,
  formatPromptSessionsText,
  formatPromptTime,
  parsePromptDumpFormat,
  promptDumpNotices,
  promptDumpProviders,
  resolvePromptSessionId,
} from './dumpPrompts';

function session(overrides: Partial<PromptHistorySession> = {}): PromptHistorySession {
  return {
    provider: 'claude-code',
    sessionId: 'abc-123',
    startedAt: '2026-09-20T10:00:00.000Z',
    lastActivityAt: '2026-09-20T10:45:00.000Z',
    cwds: ['/work/repo'],
    gitBranches: ['main'],
    models: ['claude-opus-5-5'],
    prompts: [
      {
        ordinal: 0,
        timestamp: '2026-09-20T10:01:00.000Z',
        text: 'fix the login bug\nit fails on refresh',
        cwd: '/work/repo',
        metadataStatus: 'final',
        reply: { text: 'Fixed the token refresh.', timestamp: '2026-09-20T10:05:00.000Z' },
      },
      {
        ordinal: 2,
        timestamp: '2026-09-20T10:30:00.000Z',
        text: 'no, keep ```the old``` name',
        cwd: '/work/repo',
        metadataStatus: 'final',
      },
    ],
    signals: [
      { kind: 'compaction', timestamp: '2026-09-20T10:00:30.000Z', afterOrdinal: -1 },
      {
        kind: 'toolRejected',
        timestamp: '2026-09-20T10:02:00.000Z',
        afterOrdinal: 0,
        tool: 'Edit',
        text: 'keep the old name\nand the old tests',
      },
      {
        kind: 'toolError',
        timestamp: '2026-09-20T10:31:00.000Z',
        afterOrdinal: 2,
        tool: 'Bash',
        text: 'Exit code 1\nFAIL src/a.test.ts',
      },
    ],
    complete: false,
    truncated: false,
    droppedPrompts: 1,
    excludedRecords: 0,
    ...overrides,
  };
}

function result(overrides: Partial<SessionPromptHistoryResult> = {}): SessionPromptHistoryResult {
  return {
    sessions: [],
    unread: [],
    boundsHit: [],
    exclusions: [],
    stats: {
      sessionsMatched: 0,
      sessionsScanned: 0,
      sessionsReturned: 0,
      sessionsWithoutPrompts: 0,
      sessionsOutOfScope: 0,
      sessionsNotInteractive: 0,
      sessionsTruncated: 0,
      recordsOverSizeLimit: 0,
      recordsMalformed: 0,
      promptsMissingTimestamp: 0,
      promptsOutOfScope: 0,
    },
    ...overrides,
  };
}

describe('promptDumpProviders', () => {
  it('reads both providers unless one is named, and rejects OpenCode', () => {
    expect(promptDumpProviders(undefined)).toEqual(['claude-code', 'codex']);
    expect(promptDumpProviders('auto')).toEqual(['claude-code', 'codex']);
    expect(promptDumpProviders('codex')).toEqual(['codex']);
    expect(promptDumpProviders('opencode')).toEqual({
      error: 'Prompt dumps support claude-code and codex sessions.',
    });
  });
});

describe('parsePromptDumpFormat', () => {
  it('accepts jsonl, lets --json win, and rejects unknown formats', () => {
    expect(parsePromptDumpFormat(undefined, false)).toBe('text');
    expect(parsePromptDumpFormat('jsonl', false)).toBe('jsonl');
    expect(parsePromptDumpFormat('markdown', true)).toBe('json');
    expect(parsePromptDumpFormat('xml', false)).toHaveProperty('error');
  });
});

describe('resolvePromptSessionId', () => {
  const candidates = [
    { provider: 'claude-code' as const, sessionId: 'abc-123' },
    { provider: 'claude-code' as const, sessionId: 'abd-456' },
    { provider: 'codex' as const, sessionId: '0199-codex' },
  ];

  it('prefers an exact id, then a unique prefix', () => {
    expect(resolvePromptSessionId('abc-123', candidates)).toEqual({ sessionId: 'abc-123' });
    expect(resolvePromptSessionId('abd', candidates)).toEqual({ sessionId: 'abd-456' });
    expect(resolvePromptSessionId('0199', candidates)).toEqual({ sessionId: '0199-codex' });
  });

  it('reports ambiguity and passes unknown ids through for worktree sessions', () => {
    expect(resolvePromptSessionId('ab', candidates)).toEqual({
      error: 'Session ab is ambiguous. Matches: abc-123, abd-456',
    });
    expect(resolvePromptSessionId('elsewhere-1', candidates)).toEqual({
      sessionId: 'elsewhere-1',
    });
    expect(resolvePromptSessionId('  ', candidates)).toHaveProperty('error');
  });
});

describe('collectAllPromptSessions', () => {
  const options: CollectSessionPromptHistoryOptions = { workspacePaths: ['/work/repo'] };

  it('continues from unread sessions and merges the calls', async () => {
    const collect = vi
      .fn()
      .mockResolvedValueOnce(
        result({
          sessions: [session({ sessionId: 'a', lastActivityAt: '2026-09-20T09:00:00.000Z' })],
          unread: [
            { provider: 'claude-code', sessionId: 'b' },
            { provider: 'codex', sessionId: 'c' },
          ],
          boundsHit: ['deadline'],
          stats: { ...result().stats, sessionsMatched: 3, sessionsScanned: 1 },
        }),
      )
      .mockResolvedValueOnce(
        result({
          sessions: [
            session({ sessionId: 'b', lastActivityAt: '2026-09-20T11:00:00.000Z' }),
            session({ sessionId: 'c', lastActivityAt: '2026-09-20T08:00:00.000Z' }),
          ],
          stats: { ...result().stats, sessionsMatched: 2, sessionsScanned: 2 },
        }),
      );

    const merged = await collectAllPromptSessions({ ...options, limit: 5 }, collect);

    expect(collect).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionIds: ['b', 'c'],
        providers: ['claude-code', 'codex'],
        limit: 4,
      }),
    );
    expect(merged.sessions.map((grouped) => grouped.sessionId)).toEqual(['b', 'a', 'c']);
    expect(merged.unread).toEqual([]);
    expect(merged.boundsHit).toEqual(['deadline']);
    expect(merged.stats).toMatchObject({
      sessionsMatched: 3,
      sessionsScanned: 3,
      sessionsReturned: 3,
    });
  });

  it('stops when a call makes no progress', async () => {
    const stuck = result({
      unread: [{ provider: 'codex', sessionId: 'huge' }],
      boundsHit: ['deadline'],
    });
    const collect = vi.fn().mockResolvedValue(stuck);

    const merged = await collectAllPromptSessions(options, collect);

    expect(collect).toHaveBeenCalledTimes(2);
    expect(merged.unread).toEqual([{ provider: 'codex', sessionId: 'huge' }]);
    expect(promptDumpNotices(merged)).toEqual(['1 session not read (deadline): huge']);
  });
});

describe('formatPromptSessionsText', () => {
  it('prints a header, every prompt in full, replies, and signals in order', () => {
    const text = formatPromptSessionsText([session()], { width: 100 });
    const lines = text.split('\n');

    expect(lines[1]).toContain('claude-code  ·  abc-123');
    expect(lines[1]).toContain('2 prompts  ·  main');
    expect(lines[2]).toContain('incomplete: 1 prompt(s) out of scope');
    expect(text).toContain(
      '#0  ' + formatPromptTime('2026-09-20T10:01:00.000Z', session().startedAt),
    );
    expect(text).toContain('    fix the login bug\n    it fails on refresh\n');
    expect(text).toContain('    ↳ reply');
    expect(text).toContain('      Fixed the token refresh.');
    expect(text).toContain(
      'toolRejected (Edit):\n        keep the old name\n        and the old tests',
    );
    expect(text).toContain('toolError (Bash): Exit code 1 …');
    expect(text.indexOf('compaction')).toBeLessThan(text.indexOf('#0'));
  });
});

describe('formatPromptSessionsMarkdown', () => {
  it('fences prompt text verbatim with a fence longer than any backtick run', () => {
    const markdown = formatPromptSessionsMarkdown([
      session({
        prompts: [
          {
            ordinal: 0,
            timestamp: '2026-09-20T10:01:00.000Z',
            text: 'keep\n\n\n## not a heading\n```js\ncode\n```',
            cwd: '/work/repo',
            metadataStatus: 'final',
          },
        ],
        signals: [],
      }),
    ]);

    expect(markdown).toContain('## claude-code · `abc-123`');
    expect(markdown).toContain('- **Complete:** no (1 prompt(s) out of scope)');
    expect(markdown).toContain('````text\nkeep\n\n\n## not a heading\n```js\ncode\n```\n````');
  });
});

describe('formatPromptSessionsJsonl', () => {
  it('writes one parseable session per line', () => {
    const jsonl = formatPromptSessionsJsonl([
      session({ sessionId: 'a' }),
      session({ sessionId: 'b' }),
    ]);
    const rows = jsonl
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as PromptHistorySession);
    expect(rows.map((row) => row.sessionId)).toEqual(['a', 'b']);
    expect(rows[0].prompts[0].reply?.text).toBe('Fixed the token refresh.');
  });
});

function usageEvent(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: Date.parse('2026-09-20T10:02:00.000Z'),
    provider: 'claude-code',
    sessionId: 'abc-123',
    project: '/work/repo',
    model: 'claude-opus-5-5',
    tokens: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheWriteTokens: 0,
      cacheReadTokens: 8500,
      totalTokens: 10_000,
    },
    costUsd: 0.05,
    costProvenance: 'model-catalog',
    promptOrdinal: 0,
    ...overrides,
  } as never;
}

describe('per-prompt usage', () => {
  const events = [
    usageEvent(),
    // A subagent call carries the parent session and the prompt that spawned it.
    usageEvent({ subagent: { agentId: 'a1', parentSessionId: 'abc-123' }, costUsd: 0.02 }),
    usageEvent({ promptOrdinal: 2, costUsd: null, costProvenance: 'unpriced' }),
    usageEvent({ promptOrdinal: 2, costUsd: 0.01 }),
    usageEvent({ promptOrdinal: null }),
    usageEvent({ model: '<synthetic>', costUsd: null, costProvenance: 'unpriced' }),
    usageEvent({ sessionId: 'other' }),
  ];

  it('sums tokens and cost per (provider, session, ordinal), subagents included', () => {
    const index = indexPromptUsage(events);
    const usage = index.get('claude-code\u0000abc-123')!;
    expect(usage.byOrdinal.get(0)).toEqual({
      calls: 2,
      totalTokens: 20_000,
      reasoningTokens: 0,
      costUsd: expect.closeTo(0.07, 10),
      costSource: 'estimated',
      partial: false,
    });
    expect(usage.byOrdinal.get(2)).toMatchObject({ calls: 2, costUsd: 0.01, partial: true });
    // The whole session counts the call before the first prompt; never <synthetic>.
    expect(usage.total.calls).toBe(5);
    expect(index.get('claude-code\u0000other')?.total.calls).toBe(1);
    expect(formatPromptUsage(usage.byOrdinal.get(0)!)).toBe('20.0k tokens · $0.07 (est.)');
    expect(formatPromptUsage(usage.byOrdinal.get(2)!)).toBe('20.0k tokens · $0.01 (est., partial)');
  });

  it('shows usage beside each prompt and in each session header', () => {
    const index = indexPromptUsage(events);
    const text = formatPromptSessionsText([session()], { width: 140, usage: index });
    expect(text).toContain('usage: 50.0k tokens');
    expect(text).toMatch(/#0 {2}\S+ {2}· {2}20\.0k tokens · \$0\.07 \(est\.\)/);
    expect(text).toMatch(/#2 {2}\S+ {2}· {2}20\.0k tokens · \$0\.01 \(est\., partial\)/);
    const markdown = formatPromptSessionsMarkdown([session()], { usage: index });
    expect(markdown).toContain('- **Usage:** 50.0k tokens');
    expect(markdown).toMatch(/### #0 · \S+ · 20\.0k tokens · \$0\.07 \(est\.\)/);
    // Without an index nothing changes.
    expect(formatPromptSessionsText([session()], { width: 140 })).not.toContain('tokens ·');
  });

  it('adds promptUsage and sessionUsage to JSON without touching the existing usage field', () => {
    const base = session();
    base.prompts[0].usage = { inputTokens: 7 };
    const [augmented] = withPromptUsage([base], indexPromptUsage(events));
    expect(augmented.sessionUsage?.calls).toBe(5);
    expect(augmented.prompts[0].usage).toEqual({ inputTokens: 7 });
    expect(augmented.prompts[0].promptUsage?.calls).toBe(2);
    expect(augmented.prompts[1].promptUsage?.partial).toBe(true);
    expect(withPromptUsage([base], undefined)).toEqual([base]);
  });

  it('reads usage over the dumped sessions only, from their earliest start', async () => {
    const collect = vi.fn(async () => ({
      events,
      sessions: [],
      diagnostics: [],
      cacheHits: 0,
      cacheMisses: 0,
    }));
    const index = await collectPromptUsage([session()], {
      workspacePath: '/work/repo',
      collect: collect as never,
    });
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePaths: ['/work/repo'],
        since: new Date('2026-09-20T10:00:00.000Z'),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(index instanceof Map && [...index.keys()]).toEqual(['claude-code\u0000abc-123']);
  });

  it('gives up with a notice when the usage read runs past its deadline', async () => {
    const collect = vi.fn(
      (options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason));
        }),
    );
    const outcome = await collectPromptUsage([session()], {
      workspacePath: '/work/repo',
      deadlineMs: 5,
      collect: collect as never,
    });
    expect(outcome).toEqual({ error: expect.stringContaining('took longer than 0 s') });
  });
});
