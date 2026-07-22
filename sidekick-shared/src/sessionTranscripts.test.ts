import { describe, expect, it } from 'vitest';
import type { SessionProviderBase, SessionReader } from './providers/types';
import { listRecentSessions, readSessionTranscript } from './sessionTranscripts';
import type { SessionEvent } from './types/sessionEvent';

function providerFixture(events: SessionEvent[]): SessionProviderBase {
  const reader: SessionReader = {
    readNew: () => events,
    readAll: () => events,
    reset: () => {},
    exists: () => true,
    flush: () => {},
    getPosition: () => events.length,
    seekTo: () => {},
    wasTruncated: () => false,
  };
  return {
    id: 'codex',
    displayName: 'Codex',
    getSessionDirectory: () => '/sessions',
    discoverSessionDirectory: () => '/sessions',
    findActiveSession: () => '/sessions/new.jsonl',
    findAllSessions: () => ['/sessions/old.jsonl', '/sessions/new.jsonl'],
    findSessionsInDirectory: () => [],
    getAllProjectFolders: () => [],
    isSessionFile: () => true,
    getSessionId: (path) => (path.includes('new') ? 'new' : 'old'),
    encodeWorkspacePath: (path) => path,
    extractSessionLabel: (path) => (path.includes('new') ? 'New session' : 'Old session'),
    createReader: () => reader,
    scanSubagents: () => [],
    searchInSession: () => [],
    getProjectsBaseDir: () => '/sessions',
    readSessionStats: () => ({
      providerId: 'codex',
      sessionId: 'fixture',
      filePath: '/sessions/new.jsonl',
      label: null,
      startTime: '',
      endTime: '',
      messageCount: 0,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      modelUsage: {},
      toolUsage: {},
      compactionEstimate: 0,
      truncationCount: 0,
      reportedCost: 0,
    }),
    getSessionMetadata: (path) => ({
      mtime: new Date(path.includes('new') ? '2026-07-22T00:00:00Z' : '2026-07-21T00:00:00Z'),
    }),
    dispose: () => {},
  };
}

describe('session transcript read APIs', () => {
  it('lists recent sessions using provider discovery and metadata', () => {
    const sessions = listRecentSessions(providerFixture([]), '/workspace', { limit: 1 });
    expect(sessions).toEqual([
      {
        provider: 'codex',
        sessionId: 'new',
        sessionPath: '/sessions/new.jsonl',
        label: 'New session',
        modifiedAt: '2026-07-22T00:00:00.000Z',
      },
    ]);
  });

  it('reads through the provider reader and attaches source provenance', () => {
    const events: SessionEvent[] = [
      {
        type: 'user',
        timestamp: '2026-07-22T00:00:00Z',
        message: { role: 'user', content: 'hello' },
      },
    ];
    const transcript = readSessionTranscript(providerFixture(events), '/sessions/new.jsonl');
    expect(transcript).toMatchObject({
      provider: 'codex',
      sessionId: 'new',
      sourcePath: '/sessions/new.jsonl',
      messages: [{ text: 'hello', source: { provider: 'codex', sessionId: 'new' } }],
    });
  });
});
