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
      toolFailures: {},
      compactionEstimate: 0,
      truncationCount: 0,
      costUsd: 0,
      costProvenance: 'none',
      unpricedCalls: 0,
      availability: 'full',
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

  it('extracts labels only for the sessions inside the limit', () => {
    const labelCalls: string[] = [];
    const provider = providerFixture([]);
    const counting: SessionProviderBase = {
      ...provider,
      extractSessionLabel: (sessionPath) => {
        labelCalls.push(sessionPath);
        return provider.extractSessionLabel(sessionPath);
      },
    };

    const sessions = listRecentSessions(counting, '/workspace', { limit: 1 });

    expect(sessions).toHaveLength(1);
    // The label is the only per-file content read, so sessions sorted out by
    // the limit must never pay for it.
    expect(labelCalls).toEqual(['/sessions/new.jsonl']);
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
