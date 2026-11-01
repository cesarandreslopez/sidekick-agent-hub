import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import type { QuotaState } from './quota';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

describe('quotaSnapshots', { timeout: 30_000 }, () => {
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

  it('preserves Codex reset credits when a local session snapshot omits them', () => {
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(20),
      source: 'api',
      capturedAt: '2026-05-19T10:00:00Z',
      resetCredits: {
        availableCount: 2,
        totalEarnedCount: 3,
        source: 'api',
        capturedAt: '2026-05-19T10:00:00Z',
        credits: [
          {
            title: 'Full reset (Weekly + 5 hr)',
            status: 'available',
            resetType: 'codex_rate_limits',
            expiresAt: '2026-07-26T23:06:33.770323Z',
            grantedAt: '2026-06-26T23:06:33.770323Z',
          },
        ],
      },
    });
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(21),
      source: 'session',
      capturedAt: '2026-05-19T10:15:00Z',
    });

    const cached = readQuotaSnapshot('codex', 'codex-1');

    expect(cached).toMatchObject({
      fiveHour: { utilization: 21 },
      resetCredits: {
        availableCount: 2,
        credits: [
          {
            expiresAt: '2026-07-26T23:06:33.770323Z',
          },
        ],
      },
    });
  });

  it('does not use the legacy shared temp path when writing snapshots', () => {
    const legacyTempPath = path.join(tmpDir, 'quota-snapshots.json.tmp');
    fs.writeFileSync(legacyTempPath, 'legacy temp content', 'utf8');

    writeQuotaSnapshot('codex', 'codex-1', makeQuotaState(41));

    expect(fs.readFileSync(legacyTempPath, 'utf8')).toBe('legacy temp content');
    expect(
      fs
        .readdirSync(tmpDir)
        .filter(
          (file) =>
            file !== 'quota-snapshots.json.tmp' &&
            file.includes('quota-snapshots.json.') &&
            file.endsWith('.tmp'),
        ),
    ).toEqual([]);
  });

  it('does not replace a newer account snapshot with an older sample', () => {
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(49),
      capturedAt: '2026-05-19T10:15:00Z',
    });
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(8),
      capturedAt: '2026-05-19T10:00:00Z',
    });

    const cached = readQuotaSnapshot('codex', 'codex-1');

    expect(cached).toMatchObject({
      capturedAt: '2026-05-19T10:15:00Z',
      fiveHour: { utilization: 49 },
    });
  });

  it('does not replace a higher same-window snapshot with a lower newer sample', () => {
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(52),
      sevenDay: { utilization: 45, resetsAt: '2026-04-18T20:00:00Z' },
      capturedAt: '2026-05-19T10:10:00Z',
    });
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(50),
      sevenDay: { utilization: 44, resetsAt: '2026-04-18T20:00:00Z' },
      capturedAt: '2026-05-19T10:15:00Z',
    });

    const cached = readQuotaSnapshot('codex', 'codex-1');

    expect(cached).toMatchObject({
      capturedAt: '2026-05-19T10:10:00Z',
      fiveHour: { utilization: 52 },
      sevenDay: { utilization: 45 },
    });
  });

  it('replaces a pre-change Claude sample once the five-hour window disappears', () => {
    // The real freeze: an Ultra account's last pre-rollout sample (5h reset in
    // the past) outranked every later sample, whose five-hour window is gone.
    writeQuotaSnapshot('claude-code', 'claude-1', {
      fiveHour: { utilization: 3, resetsAt: '2026-10-31T15:50:00.132852+00:00' },
      sevenDay: { utilization: 1, resetsAt: '2026-11-07T06:00:00.132877+00:00' },
      available: true,
      providerId: 'claude-code',
      source: 'api',
      capturedAt: '2026-10-31T13:51:33.774Z',
    });
    writeQuotaSnapshot('claude-code', 'claude-1', {
      fiveHour: { utilization: 0, resetsAt: '', absent: true },
      sevenDay: { utilization: 17, resetsAt: '2026-11-07T06:00:00.212680+00:00' },
      available: true,
      providerId: 'claude-code',
      source: 'api',
      capturedAt: '2026-11-01T03:10:06.000Z',
    });

    expect(readQuotaSnapshot('claude-code', 'claude-1')).toMatchObject({
      capturedAt: '2026-11-01T03:10:06.000Z',
      fiveHour: { absent: true },
      sevenDay: { utilization: 17 },
    });
  });

  it('lets a newer sample replace one whose window had already reset', () => {
    writeQuotaSnapshot('claude-code', 'claude-1', {
      fiveHour: { utilization: 60, resetsAt: '2026-10-30T15:00:00Z' },
      sevenDay: { utilization: 40, resetsAt: '2026-11-03T00:00:00Z' },
      available: true,
      providerId: 'claude-code',
      source: 'api',
      capturedAt: '2026-10-30T14:00:00Z',
    });
    // The five-hour window closed and no new one has started yet.
    writeQuotaSnapshot('claude-code', 'claude-1', {
      fiveHour: { utilization: 0, resetsAt: '' },
      sevenDay: { utilization: 40, resetsAt: '2026-11-03T00:00:00Z' },
      available: true,
      providerId: 'claude-code',
      source: 'api',
      capturedAt: '2026-10-30T16:00:00Z',
    });

    expect(readQuotaSnapshot('claude-code', 'claude-1')).toMatchObject({
      capturedAt: '2026-10-30T16:00:00Z',
      fiveHour: { utilization: 0, resetsAt: '' },
    });
  });

  it('keeps the plan label and running extra meters when a status-line sample replaces an API one', () => {
    writeQuotaSnapshot('claude-code', 'claude-1', {
      fiveHour: { utilization: 0, resetsAt: '', absent: true },
      sevenDay: { utilization: 17, resetsAt: '2026-11-07T06:00:00Z' },
      available: true,
      providerId: 'claude-code',
      source: 'api',
      capturedAt: '2026-11-01T03:00:00Z',
      planType: 'max',
      planLabel: 'Ultra',
      extraUsage: { enabled: false, monthlyLimit: 20000, usedCredits: 0, utilization: 0 },
      limits: [
        {
          kind: 'weekly_all',
          group: 'weekly',
          label: '7-Day',
          utilization: 17,
          resetsAt: '2026-11-07T06:00:00Z',
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          label: '7-Day (Fable)',
          utilization: 2,
          resetsAt: '2026-11-07T06:00:00Z',
          scopeModel: 'Fable',
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          label: '7-Day (Old)',
          utilization: 9,
          resetsAt: '2026-10-31T00:00:00Z',
        },
      ],
    });
    writeQuotaSnapshot('claude-code', 'claude-1', {
      fiveHour: { utilization: 0, resetsAt: '', absent: true },
      sevenDay: { utilization: 18, resetsAt: '2026-11-07T06:00:00Z' },
      available: true,
      providerId: 'claude-code',
      source: 'statusline',
      capturedAt: '2026-11-01T03:05:00Z',
    });

    const cached = readQuotaSnapshot('claude-code', 'claude-1');
    expect(cached).toMatchObject({
      capturedAt: '2026-11-01T03:05:00Z',
      sevenDay: { utilization: 18 },
      planLabel: 'Ultra',
      planType: 'max',
      extraUsage: { monthlyLimit: 20000 },
    });
    // Only the still-running extra meter is carried; the headline row is not.
    expect(cached?.limits?.map((row) => row.label)).toEqual(['7-Day (Fable)']);
  });

  it('lets an aggregate codex snapshot replace a model-specific one with a later window', () => {
    // A per-model family at 0% whose window resets later would normally be "kept".
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(0),
      limitId: 'codex_bengalfox',
      fiveHour: { utilization: 0, resetsAt: '2026-04-20T20:00:00Z' },
      sevenDay: { utilization: 0, resetsAt: '2026-04-27T20:00:00Z' },
      capturedAt: '2026-05-19T10:15:00Z',
    });
    // The aggregate plan quota (earlier window) must still replace it.
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(17),
      limitId: 'codex',
      capturedAt: '2026-05-19T10:10:00Z',
    });

    const cached = readQuotaSnapshot('codex', 'codex-1');

    expect(cached).toMatchObject({
      limitId: 'codex',
      fiveHour: { utilization: 17 },
    });
  });

  it('does not let a model-specific snapshot overwrite an aggregate codex snapshot', () => {
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(17),
      limitId: 'codex',
      capturedAt: '2026-05-19T10:10:00Z',
    });
    // A later-resetting per-model family at 0% must not mask the aggregate.
    writeQuotaSnapshot('codex', 'codex-1', {
      ...makeQuotaState(0),
      limitId: 'codex_bengalfox',
      fiveHour: { utilization: 0, resetsAt: '2026-04-20T20:00:00Z' },
      sevenDay: { utilization: 0, resetsAt: '2026-04-27T20:00:00Z' },
      capturedAt: '2026-05-19T10:15:00Z',
    });

    const cached = readQuotaSnapshot('codex', 'codex-1');

    expect(cached).toMatchObject({
      limitId: 'codex',
      fiveHour: { utilization: 17 },
    });
  });

  it('supports concurrent quota snapshot writes from multiple processes', async () => {
    const workerScript = `
      const fs = require('fs');
      const sleepBuffer = new SharedArrayBuffer(4);
      const sleepView = new Int32Array(sleepBuffer);
      const renameSync = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (String(source).includes('quota-snapshots.json') && String(source).endsWith('.tmp')) {
          Atomics.wait(sleepView, 0, 0, 50);
        }
        return renameSync(source, destination);
      };
      // require() resolves to dist/index.js via package.json main; the
      // package's "pretest": "npm run build" rebuilds dist before vitest runs.
      const { writeQuotaSnapshot } = require(${JSON.stringify(process.cwd())});
      // Under \`node -e\`, the first positional argument lands at argv[1].
      for (let i = 0; i < 10; i++) {
        writeQuotaSnapshot('codex', 'codex-worker-' + process.argv[1], {
          fiveHour: { utilization: i % 100, resetsAt: '2026-04-13T20:00:00Z' },
          sevenDay: { utilization: i % 100, resetsAt: '2026-04-18T20:00:00Z' },
          available: true,
          providerId: 'codex',
          source: 'session',
          capturedAt: '2026-04-13T12:00:00Z',
          fiveHourLabel: 'Primary',
          sevenDayLabel: 'Secondary'
        });
      }
    `;

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        runWorker(process.execPath, ['-e', workerScript, String(index)], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: tmpDir,
            APPDATA: path.join(tmpDir, 'AppData'),
          },
        }),
      ),
    );

    const failures = results.filter((result) => result.status !== 0);

    expect(failures.map((result) => result.stderr)).toEqual([]);
    const workerStore = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.config', 'sidekick', 'quota-snapshots.json'), 'utf8'),
    ) as { snapshots: Array<{ accountId: string }> };
    expect(new Set(workerStore.snapshots.map((snapshot) => snapshot.accountId)).size).toBe(12);
  }, 60_000);

  it('times out on a wedged lock holder in the no-progress budget, not the old flat 15s', () => {
    // A live owner (this process) with a fresh mtime: not reclaimable as stale,
    // and the token never changes, so no progress is ever observed. The old
    // flat budget made every waiter block the full 15s in this state.
    const lockPath = path.join(tmpDir, 'quota-snapshots.json.lock');
    fs.writeFileSync(lockPath, `${process.pid}:wedged`, { mode: 0o600 });

    const started = Date.now();
    expect(() => writeQuotaSnapshot('codex', 'codex-1', makeQuotaState(41))).toThrow(/no progress/);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it('reclaims an abandoned lock even when its recorded PID is live', () => {
    // process.pid keeps the liveness probe passing, so only the frozen
    // heartbeat mtime can justify the reclaim — the path a recycled PID hits.
    const lockPath = path.join(tmpDir, 'quota-snapshots.json.lock');
    fs.writeFileSync(lockPath, `${process.pid}:departed-owner`, { mode: 0o600 });
    const past = new Date(Date.now() - 180_000);
    fs.utimesSync(lockPath, past, past);

    writeQuotaSnapshot('codex', 'codex-1', makeQuotaState(41));

    expect(readQuotaSnapshot('codex', 'codex-1')).toMatchObject({
      fiveHour: { utilization: 41 },
    });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

function runWorker(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (status) => {
      resolve({ status, stderr });
    });
  });
}

function makeQuotaState(utilization: number): QuotaState {
  return {
    fiveHour: { utilization, resetsAt: '2026-04-13T20:00:00Z' },
    sevenDay: { utilization, resetsAt: '2026-04-18T20:00:00Z' },
    available: true,
    providerId: 'codex',
    source: 'session',
    capturedAt: '2026-04-13T12:00:00Z',
    fiveHourLabel: 'Primary',
    sevenDayLabel: 'Secondary',
  };
}

describe('readQuotaSnapshot freshness', { timeout: 30_000 }, () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-quota-freshness-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the sample age and tier alongside the cached flag', () => {
    writeQuotaSnapshot('claude-code', 'acct-1', {
      fiveHour: { utilization: 10, resetsAt: '2026-04-13T20:00:00Z' },
      sevenDay: { utilization: 5, resetsAt: '2026-04-18T20:00:00Z' },
      available: true,
      source: 'statusline',
      capturedAt: '2026-04-13T12:00:00Z',
    });

    const fresh = readQuotaSnapshot('claude-code', 'acct-1', new Date('2026-04-13T12:01:00Z'));
    expect(fresh).toMatchObject({
      source: 'cache',
      stale: true,
      ageMs: 60_000,
      freshness: 'fresh',
    });

    const aging = readQuotaSnapshot('claude-code', 'acct-1', new Date('2026-04-13T12:30:00Z'));
    expect(aging?.freshness).toBe('aging');

    const stale = readQuotaSnapshot('claude-code', 'acct-1', new Date('2026-04-14T12:00:00Z'));
    expect(stale?.freshness).toBe('stale');
    expect(stale?.ageMs).toBe(86_400_000);
  });
});
