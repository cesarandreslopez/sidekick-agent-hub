import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

import {
  clearLastSwitch,
  finishSwitchResult,
  readLastSwitch,
  switchFailure,
  writeLastSwitch,
} from './accountSwitch';
import { lastSwitchRecordSchema, switchAccountResultSchema } from './schemas/accountManager';

describe('accountSwitch', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-switch-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips the last-switch record per provider', () => {
    expect(readLastSwitch('claude-code')).toBeNull();

    const record = writeLastSwitch('claude-code', 'from-id', 'to-id');

    expect(lastSwitchRecordSchema.parse(record)).toEqual(record);
    expect(readLastSwitch('claude-code')).toEqual(record);
    expect(readLastSwitch('codex')).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'accounts', 'claude', 'last-switch.json'))).toBe(true);

    clearLastSwitch('claude-code');
    expect(readLastSwitch('claude-code')).toBeNull();
  });

  it('builds schema-valid failures and folds consumer warnings into the legacy warning field', () => {
    const failure = switchFailure('codex', 'id', 'nope');
    expect(switchAccountResultSchema.parse(failure)).toEqual(failure);
    expect(failure).toMatchObject({ success: false, error: 'nope', verified: false });

    const finished = finishSwitchResult({
      success: true,
      provider: 'codex',
      accountId: 'id',
      previousAccountId: null,
      verified: true,
      verification: 'store',
      warnings: ['stale'],
      hints: [],
      runningConsumers: [
        { kind: 'codex-app', pids: [1], switched: true, reachability: 'restart the app' },
      ],
    });
    expect(finished.warnings).toEqual(['stale', 'restart the app']);
    expect(finished.warning).toBe('stale restart the app');
    expect(switchAccountResultSchema.parse(finished)).toEqual(finished);
  });
});
