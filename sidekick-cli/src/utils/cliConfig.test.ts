/**
 * Tests for the typed cli-config.json accessor.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({ getConfigDir: vi.fn() }));

vi.mock('sidekick-shared', () => ({
  getConfigDir: mocks.getConfigDir,
}));

import {
  cliConfigPath,
  readCliConfig,
  writeCliConfig,
  readDashboardConfig,
  updateDashboardConfig,
} from './cliConfig';

describe('cliConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-cliconfig-'));
    mocks.getConfigDir.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads {} when the file is missing or malformed', () => {
    expect(readCliConfig()).toEqual({});
    fs.writeFileSync(cliConfigPath(), 'not json');
    expect(readCliConfig()).toEqual({});
  });

  it('round-trips a config object', () => {
    writeCliConfig({ accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } } });
    expect(readCliConfig()).toEqual({
      accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } },
    });
  });

  it('writes with owner-only permissions', () => {
    writeCliConfig({});
    const mode = fs.statSync(cliConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('updateDashboardConfig merges without clobbering other sections', () => {
    writeCliConfig({ accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } } });
    updateDashboardConfig({ mouseEnabled: false });
    expect(readCliConfig()).toEqual({
      accounts: { autoSwitch: { enabled: true, thresholdPct: 80 } },
      dashboard: { mouseEnabled: false },
    });
    updateDashboardConfig({ mouseEnabled: true });
    expect(readDashboardConfig()).toEqual({ mouseEnabled: true });
  });

  it('readDashboardConfig defaults to {}', () => {
    expect(readDashboardConfig()).toEqual({});
  });
});
