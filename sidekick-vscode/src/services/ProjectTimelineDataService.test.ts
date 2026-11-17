import { describe, expect, it, vi } from 'vitest';

vi.mock('./Logger', () => ({ log: vi.fn() }));

import { ProjectTimelineDataService } from './ProjectTimelineDataService';

const DAY = 24 * 60 * 60 * 1000;

interface FakeSession {
  path: string;
  mtime: number;
  startTime: string;
  label?: string | null;
}

/** A provider over synthetic (DB-style) paths, so mtimes come from metadata. */
function fakeProvider(sessions: FakeSession[]) {
  const byPath = new Map(sessions.map((s) => [s.path, s]));
  return {
    id: 'claude-code',
    findAllSessions: vi.fn(() => sessions.map((s) => s.path)),
    getSessionId: (p: string) => p.replace(/^.*\//, ''),
    getSessionMetadata: (p: string) => {
      const s = byPath.get(p);
      return s ? { mtime: new Date(s.mtime) } : null;
    },
    extractSessionLabel: vi.fn(() => 'From file'),
    readSessionStats: vi.fn((p: string) => {
      const s = byPath.get(p)!;
      return {
        providerId: 'claude-code',
        sessionId: p,
        filePath: p,
        label: s.label === undefined ? 'Fix the parser' : s.label,
        startTime: s.startTime,
        endTime: new Date(new Date(s.startTime).getTime() + 60_000).toISOString(),
        // Full-session counts (a head/tail sample would see a handful).
        messageCount: 2200,
        tokens: { input: 1000, output: 500, cacheWrite: 200, cacheRead: 223_000_000 },
        modelUsage: { 'claude-opus-4': { calls: 1, tokens: 1, costUsd: 1, priced: true } },
        toolUsage: { TaskCreate: 3, Bash: 40 },
        toolFailures: { Bash: 2, Edit: 1 },
        compactionEstimate: 0,
        truncationCount: 0,
        costUsd: 12.5,
        costProvenance: 'catalog',
        unpricedCalls: 0,
        availability: 'full',
        reportedCost: 12.5,
      };
    }),
    createReader: vi.fn(),
  };
}

describe('ProjectTimelineDataService', () => {
  it('summarises Claude sessions with the full stats reader', async () => {
    const now = Date.now();
    const provider = fakeProvider([
      { path: '/s/a', mtime: now, startTime: new Date(now - 60_000).toISOString() },
    ]);
    const service = new ProjectTimelineDataService(provider as never);

    const entries = await service.loadTimelineEntries('/ws', 'all', '/s/a');

    expect(provider.readSessionStats).toHaveBeenCalledWith('/s/a');
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      messageCount: 2200,
      totalTokens: 223_001_700,
      taskCount: 3,
      errorCount: 3,
      totalCost: 12.5,
      label: 'Fix the parser',
      isCurrent: true,
      isActive: true,
      models: ['claude-opus-4'],
    });
  });

  it('falls back to the file label, then the id, when stats carry no label', async () => {
    const now = Date.now();
    const provider = fakeProvider([
      { path: '/s/abcdef123', mtime: now, startTime: new Date(now).toISOString(), label: null },
    ]);
    provider.extractSessionLabel.mockReturnValueOnce(null as never);
    const service = new ProjectTimelineDataService(provider as never);

    const entries = await service.loadTimelineEntries('/ws', 'all');
    expect(entries![0].label).toBe('abcdef12');
  });

  it('skips sessions last written before the range without reading them', async () => {
    const now = Date.now();
    const provider = fakeProvider([
      { path: '/s/old', mtime: now - 10 * DAY, startTime: new Date(now - 10 * DAY).toISOString() },
      { path: '/s/new', mtime: now, startTime: new Date(now - DAY / 2).toISOString() },
    ]);
    const service = new ProjectTimelineDataService(provider as never);

    const entries = await service.loadTimelineEntries('/ws', '7d');

    expect(entries!.map((e) => e.sessionPath)).toEqual(['/s/new']);
    expect(provider.readSessionStats).toHaveBeenCalledTimes(1);
  });

  it('reads each unchanged session once and reports parsing only when it reads', async () => {
    const now = Date.now();
    const provider = fakeProvider([
      { path: '/s/a', mtime: now, startTime: new Date(now).toISOString() },
      { path: '/s/b', mtime: now, startTime: new Date(now - 1000).toISOString() },
    ]);
    const service = new ProjectTimelineDataService(provider as never);
    const onParseStart = vi.fn();

    await service.loadTimelineEntries('/ws', 'all', null, { onParseStart });
    await service.loadTimelineEntries('/ws', 'all', null, { onParseStart });

    expect(provider.readSessionStats).toHaveBeenCalledTimes(2);
    expect(onParseStart).toHaveBeenCalledTimes(1);
  });

  it('abandons a scan a newer request superseded', async () => {
    const now = Date.now();
    const provider = fakeProvider([
      { path: '/s/a', mtime: now, startTime: new Date(now).toISOString() },
      { path: '/s/b', mtime: now, startTime: new Date(now).toISOString() },
      { path: '/s/c', mtime: now, startTime: new Date(now).toISOString() },
    ]);
    const service = new ProjectTimelineDataService(provider as never);
    let stale = false;
    provider.readSessionStats.mockImplementationOnce((p: string) => {
      stale = true;
      return fakeProvider([
        { path: p, mtime: now, startTime: new Date(now).toISOString() },
      ]).readSessionStats(p);
    });

    const entries = await service.loadTimelineEntries('/ws', 'all', null, {
      isStale: () => stale,
    });

    expect(entries).toBeNull();
    expect(provider.readSessionStats).toHaveBeenCalledTimes(1);
  });

  it('drops sessions the stats reader could not read', async () => {
    const now = Date.now();
    const provider = fakeProvider([
      { path: '/s/a', mtime: now, startTime: new Date(now).toISOString() },
    ]);
    provider.readSessionStats.mockReturnValueOnce({
      availability: 'unavailable',
      startTime: '',
    } as never);
    const service = new ProjectTimelineDataService(provider as never);

    expect(await service.loadTimelineEntries('/ws', 'all')).toEqual([]);
  });
});
