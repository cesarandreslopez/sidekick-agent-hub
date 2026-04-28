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

  it('does not use the legacy shared temp path when writing snapshots', () => {
    const legacyTempPath = path.join(tmpDir, 'quota-snapshots.json.tmp');
    fs.writeFileSync(legacyTempPath, 'legacy temp content', 'utf8');

    writeQuotaSnapshot('codex', 'codex-1', makeQuotaState(41));

    expect(fs.readFileSync(legacyTempPath, 'utf8')).toBe('legacy temp content');
    expect(
      fs
        .readdirSync(tmpDir)
        .filter(
          file =>
            file !== 'quota-snapshots.json.tmp' &&
            file.includes('quota-snapshots.json.') &&
            file.endsWith('.tmp'),
        ),
    ).toEqual([]);
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
      // Under \`node -e\`, argv[1] is '[eval]' and the positional worker index lands at argv[2].
      for (let i = 0; i < 10; i++) {
        writeQuotaSnapshot('codex', 'codex-worker-' + process.argv[2], {
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

    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      runWorker(process.execPath, ['-e', workerScript, String(index)], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tmpDir,
          APPDATA: path.join(tmpDir, 'AppData'),
        },
      }),
    ));

    const failures = results.filter(result => result.status !== 0);

    expect(failures.map(result => result.stderr)).toEqual([]);
  }, 10_000);
});

function runWorker(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('exit', status => {
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
