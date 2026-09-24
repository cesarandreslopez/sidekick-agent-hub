import { describe, expect, it, vi } from 'vitest';
import type {
  CollectSessionPromptHistoryOptions,
  PromptHistorySession,
  SessionPromptHistoryResult,
} from 'sidekick-shared';
import {
  collectAllPromptSessions,
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
