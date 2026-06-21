import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeKeychainService } from './claudeProfiles';

const mockExecFileSync = vi.hoisted(() => vi.fn());
let tmpDir: string;
const originalPlatform = process.platform;
const originalUser = process.env.USER;

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

import { readActiveCredentials, writeActiveCredentials } from './credentialIO';

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function defaultClaudeDir(): string {
  return path.join(tmpDir, '.claude');
}

describe('credentialIO', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-credential-io-test-'));
    fs.mkdirSync(defaultClaudeDir(), { recursive: true });
    mockExecFileSync.mockReset();
    process.env.USER = 'sidekick-test-user';
    setPlatform(originalPlatform);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    if (originalUser === undefined) {
      delete process.env.USER;
    } else {
      process.env.USER = originalUser;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips default file-backed credentials without a config dir', () => {
    setPlatform('linux');
    const credentials = { claudeAiOauth: { accessToken: 'default-access' } };

    writeActiveCredentials(credentials);

    expect(readActiveCredentials()).toEqual(credentials);
    expect(fs.existsSync(path.join(defaultClaudeDir(), '.credentials.json'))).toBe(true);
  });

  it('round-trips file-backed credentials in the provided config dir', () => {
    setPlatform('linux');
    const defaultCredentials = { claudeAiOauth: { accessToken: 'default-access' } };
    const profileCredentials = { claudeAiOauth: { accessToken: 'profile-access' } };
    const profileHome = path.join(tmpDir, 'accounts', 'claude', 'profiles', 'uuid-work', 'home');
    fs.mkdirSync(profileHome, { recursive: true });

    writeActiveCredentials(defaultCredentials);
    writeActiveCredentials(profileCredentials, profileHome);

    expect(readActiveCredentials()).toEqual(defaultCredentials);
    expect(readActiveCredentials(profileHome)).toEqual(profileCredentials);
    expect(JSON.parse(fs.readFileSync(path.join(profileHome, '.credentials.json'), 'utf8')))
      .toEqual(profileCredentials);
  });

  it('reads macOS credentials from the default keychain service without a config dir', () => {
    setPlatform('darwin');
    mockExecFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: { accessToken: 'default-access' } }));

    expect(readActiveCredentials()).toEqual({ claudeAiOauth: { accessToken: 'default-access' } });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });

  it('uses the suffixed macOS keychain service for a provided config dir', () => {
    setPlatform('darwin');
    const profileHome = '/Users/hoangphan/.ai-switcher-logintest';
    const service = claudeKeychainService(profileHome);
    const credentials = { claudeAiOauth: { accessToken: 'profile-access' } };
    mockExecFileSync.mockReturnValue(JSON.stringify(credentials));

    expect(readActiveCredentials(profileHome)).toEqual(credentials);
    writeActiveCredentials(credentials, profileHome);

    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      1,
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    expect(mockExecFileSync).toHaveBeenNthCalledWith(
      2,
      'security',
      [
        'add-generic-password', '-U',
        '-s', service,
        '-a', 'sidekick-test-user',
        '-w', JSON.stringify(credentials),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });
});
