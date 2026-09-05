import { describe, expect, it } from 'vitest';
import { buildSessionListRows, sessionListFooter } from './dump';
import type { SessionPreview } from 'sidekick-shared';

function preview(overrides: Partial<SessionPreview>): SessionPreview {
  return {
    provider: 'claude-code',
    sessionId: 'abc123',
    filePath: '/sessions/abc123.jsonl',
    modifiedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    sizeBytes: 2048,
    firstUserPrompt: 'Fix the login bug',
    firstTimestamp: null,
    workspacePath: null,
    ...overrides,
  };
}

describe('buildSessionListRows', () => {
  it('maps preview fields onto the --list row shape', () => {
    const [row] = buildSessionListRows([preview({})]);

    expect(row).toMatchObject({
      id: 'abc123',
      label: 'Fix the login bug',
      size: 2048,
      age: '5m ago',
    });
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('falls back to the file basename when a preview has no session id', () => {
    const [row] = buildSessionListRows([
      preview({ sessionId: '', filePath: '/sessions/rollout-fallback.jsonl' }),
    ]);

    expect(row.id).toBe('rollout-fallback');
  });

  it('renders promptless sessions with an empty label', () => {
    const [row] = buildSessionListRows([preview({ firstUserPrompt: null })]);
    expect(row.label).toBe('');
  });
});

describe('sessionListFooter', () => {
  it('offers a larger limit only when candidates were left out', () => {
    expect(sessionListFooter(50, true)).toContain('raise --limit');
    // Exactly `limit` sessions with nothing beyond them is a complete listing.
    expect(sessionListFooter(50, false)).toBe('\n50 session(s) found.\n');
  });
});
