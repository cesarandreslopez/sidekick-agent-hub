import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { bucketForUtilization, renderProviderHeatmap } from './quotaHistory';
import {
  appendQuotaHistorySample,
  getWorkspaceIdFromPath,
  type QuotaHistorySample,
} from 'sidekick-shared';

// Sidekick-shared resolves history paths via getConfigDir(); pin that to a temp dir for the test.
let tmpDir: string;
vi.mock('sidekick-shared/dist/paths', async () => {
  const actual = (await vi.importActual<typeof import('sidekick-shared/dist/paths')>('sidekick-shared/dist/paths'));
  return {
    ...actual,
    getConfigDir: () => tmpDir,
  };
});

describe('bucketForUtilization', () => {
  it('partitions 0-100 into five buckets', () => {
    expect(bucketForUtilization(0)).toBe(0);
    expect(bucketForUtilization(10)).toBe(1);
    expect(bucketForUtilization(40)).toBe(2);
    expect(bucketForUtilization(60)).toBe(3);
    expect(bucketForUtilization(90)).toBe(4);
  });
});

describe('renderProviderHeatmap', () => {
  beforeEach(() => {
    chalk.level = 0;
  });

  it('emits 7 data rows plus header and footer', () => {
    const cells = [
      { date: '2026-05-13', utilization: 30, unavailable: false, samples: 4 },
      { date: '2026-05-14', utilization: 85, unavailable: false, samples: 6 },
      { date: '2026-05-15', utilization: 0, unavailable: true, samples: 2 },
    ];
    const output = renderProviderHeatmap('Claude', cells, 2);
    const lines = output.split('\n');
    expect(lines[0]).toMatch(/Claude/);
    // 7 day-of-week rows
    expect(lines.length).toBe(1 + 7 + 1);
    // The "Peak" footer reflects the 85% sample.
    expect(lines[lines.length - 1]).toMatch(/Peak.*85%/);
    expect(lines[lines.length - 1]).toMatch(/Unavailable 1/);
  });

  it('renders nothing but zero-bucket glyphs when all cells are empty', () => {
    const cells = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-05-1${i}`,
      utilization: 0,
      unavailable: false,
      samples: 0,
    }));
    const out = renderProviderHeatmap('Codex', cells, 1);
    expect(out).not.toMatch(/×/);
    expect(out).toMatch(/Peak.*0%/);
    expect(out).toMatch(/Samples 0/);
  });
});

describe('quotaHistoryAction end-to-end', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutData: string;
  let originalCwd: string;
  let workspacePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-quota-history-cli-test-'));
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-quota-history-cli-ws-'));
    originalCwd = process.cwd();
    process.chdir(workspacePath);
    stdoutData = '';
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutData += typeof chunk === 'string' ? chunk : String(chunk);
      return true;
    });
    chalk.level = 0;
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  function makeCmd(overrideOpts: Record<string, unknown> = {}, globalOpts: Record<string, unknown> = {}) {
    return {
      opts: () => ({ weeks: '4', ...overrideOpts }),
      parent: {
        opts: () => ({ ...globalOpts }),
        parent: undefined,
      },
    } as unknown as import('commander').Command;
  }

  it('emits JSON payload mirroring the dashboard shape', async () => {
    const workspaceId = getWorkspaceIdFromPath(workspacePath);
    await appendQuotaHistorySample(
      {
        timestamp: new Date(Date.now() - 86_400_000).toISOString(),
        runtimeProvider: 'claude',
        providerId: 'claude-1',
        workspaceId,
        fiveHour: { utilization: 60, resetsAt: 'x' },
        sevenDay: { utilization: 45, resetsAt: 'x' },
        available: true,
      } satisfies QuotaHistorySample,
      { minIntervalMs: 0 },
    );

    const { quotaHistoryAction } = await import('./quotaHistory');
    await quotaHistoryAction({}, makeCmd({ weeks: '4' }, { json: true }));

    const parsed = JSON.parse(stdoutData);
    expect(parsed.workspaceId).toBe(workspaceId);
    expect(parsed.weeks).toBe(4);
    expect(parsed.providers.claude).toBeDefined();
    expect(parsed.providers.claude.cells.length).toBe(4 * 7);
    expect(parsed.providers.claude.cells.some((c: { utilization: number }) => c.utilization === 60)).toBe(true);
  });

  it('reports an empty-history hint when no samples exist for either provider', async () => {
    const { quotaHistoryAction } = await import('./quotaHistory');
    await quotaHistoryAction({}, makeCmd({ weeks: '4' }));
    expect(stdoutData).toMatch(/No quota history yet/);
  });
});
