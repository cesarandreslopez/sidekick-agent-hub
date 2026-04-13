import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import type { QuotaState } from './quota';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

describe('quotaSnapshots', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-quota-snapshot-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists and reloads provider/account-scoped quota snapshots as stale cache entries', () => {
    const quota: QuotaState = {
      fiveHour: { utilization: 41, resetsAt: '2026-04-13T20:00:00Z' },
      sevenDay: { utilization: 64, resetsAt: '2026-04-18T20:00:00Z' },
      available: true,
      providerId: 'codex',
      source: 'session',
      capturedAt: '2026-04-13T12:00:00Z',
      fiveHourLabel: 'Primary',
      sevenDayLabel: 'Secondary',
    };

    writeQuotaSnapshot('codex', 'codex-1', quota);

    const cached = readQuotaSnapshot('codex', 'codex-1');

    expect(cached).toEqual(
      expect.objectContaining({
        available: true,
        providerId: 'codex',
        source: 'cache',
        stale: true,
        capturedAt: '2026-04-13T12:00:00Z',
        fiveHourLabel: 'Primary',
        sevenDayLabel: 'Secondary',
      }),
    );
  });
});
