import { describe, it, expect, vi } from 'vitest';

// Mock sidekick-shared readers
vi.mock('sidekick-shared', () => ({
  getProjectSlug: () => 'test-project',
  getProjectSlugRaw: () => 'test-project',
  readHistory: vi.fn(),
  readTasks: vi.fn(),
  readDecisions: vi.fn(),
  readNotes: vi.fn(),
}));

import { loadStaticData } from './StaticDataLoader';
import { readHistory, readTasks, readDecisions, readNotes } from 'sidekick-shared';

describe('StaticDataLoader', () => {
  it('returns empty data when no files exist', async () => {
    vi.mocked(readHistory).mockResolvedValue(null);
    vi.mocked(readTasks).mockResolvedValue([]);
    vi.mocked(readDecisions).mockResolvedValue([]);
    vi.mocked(readNotes).mockResolvedValue([]);

    const data = await loadStaticData('/test');
    expect(data.sessions).toEqual([]);
    expect(data.tasks).toEqual([]);
    expect(data.decisions).toEqual([]);
    expect(data.notes).toEqual([]);
    expect(data.totalCost).toBe(0);
  });

  it('extracts session records from daily history', async () => {
    vi.mocked(readHistory).mockResolvedValue({
      schemaVersion: 1,
      daily: {
        '2025-02-20': {
          date: '2025-02-20',
          tokens: { inputTokens: 100000, outputTokens: 50000, cacheWriteTokens: 0, cacheReadTokens: 0 },
          totalCost: 8.50,
          messageCount: 42,
          sessionCount: 2,
          modelUsage: [{ model: 'claude-sonnet-4', calls: 20, tokens: 150000, cost: 8.50 }],
          toolUsage: [{ tool: 'Read', calls: 15, successCount: 15, failureCount: 0 }],
          updatedAt: '2025-02-20T14:00:00Z',
        },
      },
      monthly: {},
      allTime: {
        tokens: { inputTokens: 100000, outputTokens: 50000, cacheWriteTokens: 0, cacheReadTokens: 0 },
        totalCost: 8.50,
        messageCount: 42,
        sessionCount: 2,
        firstDate: '2025-02-20',
        lastDate: '2025-02-20',
        modelUsage: [],
        toolUsage: [],
        updatedAt: '2025-02-20T14:00:00Z',
      },
      lastSaved: '2025-02-20T14:00:00Z',
    });
    vi.mocked(readTasks).mockResolvedValue([]);
    vi.mocked(readDecisions).mockResolvedValue([]);
    vi.mocked(readNotes).mockResolvedValue([]);

    const data = await loadStaticData('/test');
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].date).toBe('2025-02-20');
    expect(data.sessions[0].inputTokens).toBe(100000);
    expect(data.sessions[0].totalCost).toBe(8.50);
    expect(data.totalTokens).toBe(150000);
    expect(data.totalCost).toBe(8.50);
    expect(data.totalSessions).toBe(2);
  });

  it('passes through tasks, decisions, notes from readers', async () => {
    vi.mocked(readHistory).mockResolvedValue(null);
    vi.mocked(readTasks).mockResolvedValue([
      {
        taskId: '1', subject: 'Test task', status: 'pending',
        createdAt: '', updatedAt: '', toolCallCount: 0,
        blockedBy: [], blocks: [], sessionOrigin: 'abc',
        carriedOver: false, sessionAge: 0,
      },
    ]);
    vi.mocked(readDecisions).mockResolvedValue([
      {
        id: 'd1', description: 'Use JWT', rationale: 'Stateless',
        chosenOption: 'JWT', source: 'plan_mode',
        sessionId: 'abc', timestamp: '2025-02-20T10:00:00Z',
      },
    ]);
    vi.mocked(readNotes).mockResolvedValue([
      {
        id: 'n1', noteType: 'gotcha', content: 'Always hash with bcrypt',
        filePath: 'src/auth.ts', source: 'manual', status: 'active',
        importance: 'high', createdAt: '', updatedAt: '', lastReviewedAt: '',
      },
    ]);

    const data = await loadStaticData('/test');
    expect(data.tasks).toHaveLength(1);
    expect(data.decisions).toHaveLength(1);
    expect(data.notes).toHaveLength(1);
  });

  it('handles reader errors gracefully', async () => {
    vi.mocked(readHistory).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(readTasks).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(readDecisions).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(readNotes).mockRejectedValue(new Error('ENOENT'));

    const data = await loadStaticData('/test');
    expect(data.sessions).toEqual([]);
    expect(data.tasks).toEqual([]);
  });
});
