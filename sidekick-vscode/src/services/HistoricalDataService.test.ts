import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../types/historicalData';

let temporaryHome: string;

vi.mock('vscode', () => ({}));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => temporaryHome };
});
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { HistoricalDataService } from './HistoricalDataService';

function summary(inputTokens: number): SessionSummary {
  return {
    sessionId: 'session-1',
    startTime: '2026-07-21T12:00:00.000Z',
    endTime: '2026-07-21T12:05:00.000Z',
    tokens: {
      inputTokens,
      outputTokens: 20,
      cacheWriteTokens: 10,
      cacheReadTokens: 30,
    },
    totalCost: inputTokens / 100,
    messageCount: 2,
    modelUsage: [{ model: 'test-model', calls: 2, tokens: inputTokens + 50, cost: 1 }],
    toolUsage: [{ tool: 'Read', calls: 1, successCount: 1, failureCount: 0 }],
  };
}

describe('HistoricalDataService', () => {
  beforeAll(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-history-test-'));
    // The homedir mock above cannot reach the externalized sidekick-shared
    // bundle, so redirect its getConfigDir() through the env override too.
    process.env.SIDEKICK_CONFIG_DIR = path.join(temporaryHome, '.config', 'sidekick');
  });

  afterAll(() => {
    delete process.env.SIDEKICK_CONFIG_DIR;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });

  it('replaces a saved session contribution instead of accumulating it again', async () => {
    const service = new HistoricalDataService();
    await service.initialize();

    service.saveSessionSummary(summary(100));
    service.saveSessionSummary(summary(250));

    const [day] = service.getDailyData('2026-07-21', '2026-07-21');
    expect(day).toMatchObject({
      sessionCount: 1,
      messageCount: 2,
      totalCost: 2.5,
      tokens: { inputTokens: 250, outputTokens: 20, cacheWriteTokens: 10, cacheReadTokens: 30 },
      modelUsage: [{ model: 'test-model', calls: 2, tokens: 300, cost: 1 }],
      toolUsage: [{ tool: 'Read', calls: 1, successCount: 1, failureCount: 0 }],
    });
    expect(service.getAllTimeStats()).toMatchObject({
      sessionCount: 1,
      tokens: { inputTokens: 250 },
    });
    expect(service.getSessionRecords()).toHaveLength(1);
    service.dispose();
  });

  it('uses the same local timezone for daily and hourly buckets', async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Bogota';
    const service = new HistoricalDataService();
    try {
      await service.initialize();
      service.saveSessionSummary({
        ...summary(50),
        sessionId: 'timezone-session',
        startTime: '2026-01-01T02:00:00.000Z',
        endTime: '2026-01-01T02:05:00.000Z',
      });

      expect(service.getDailyData('2025-12-31', '2025-12-31')).toHaveLength(1);
      expect(service.getHourlyData('2025-12-31')).toEqual([
        expect.objectContaining({ hour: 21, sessionCount: 1 }),
      ]);
    } finally {
      service.dispose();
      process.env.TZ = previousTimezone;
    }
  });
});
