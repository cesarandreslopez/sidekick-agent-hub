import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { SessionProviderBase } from '../providers/types';
import { createWatcher } from './factory';

const callbacks = { onEvent: vi.fn() };

function provider(sessions: string[]): SessionProviderBase {
  return {
    id: 'claude-code',
    displayName: 'Claude Code',
    findAllSessions: () => sessions,
    getSessionId: (sessionPath: string) => path.basename(sessionPath, '.jsonl'),
  } as unknown as SessionProviderBase;
}

describe('createWatcher session selection', () => {
  it('matches only session IDs, not directory substrings', () => {
    expect(() =>
      createWatcher({
        provider: provider(['/sessions/2026/session-one.jsonl']),
        workspacePath: '/workspace',
        sessionId: '2026',
        callbacks,
      }),
    ).toThrow(/not found/i);
  });

  it('accepts a unique ID prefix and rejects an ambiguous prefix', () => {
    const sessions = [
      '/sessions/abcdef-one.jsonl',
      '/sessions/abcdef-two.jsonl',
      '/sessions/unique-session.jsonl',
    ];

    expect(
      createWatcher({
        provider: provider(sessions),
        workspacePath: '/workspace',
        sessionId: 'unique',
        callbacks,
      }).sessionPath,
    ).toBe('/sessions/unique-session.jsonl');
    expect(() =>
      createWatcher({
        provider: provider(sessions),
        workspacePath: '/workspace',
        sessionId: 'abcdef',
        callbacks,
      }),
    ).toThrow(/ambiguous.*abcdef-one.*abcdef-two/i);
  });
});
