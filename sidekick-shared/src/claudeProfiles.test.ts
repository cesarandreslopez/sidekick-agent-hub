import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
const originalPlatform = process.platform;
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  };
});

import {
  claudeKeychainService,
  claudeKeychainSuffix,
  ensureClaudeProfileDirs,
  getClaudeProfileHome,
  getClaudeProfilesDir,
  isClaudeProfileAuthenticated,
  readClaudeProfileIdentity,
} from './claudeProfiles';

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
  });
}

function writeClaudeProfileIdentity(
  home: string,
  email = 'work@example.com',
  uuid = 'uuid-work',
): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: uuid } }),
  );
}

function writeClaudeProfileCredentials(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'access-token', refreshToken: 'refresh-token' },
    }),
  );
}

describe('claudeProfiles', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-claude-profiles-test-'));
    mockExecFileSync.mockReset();
    setPlatform(originalPlatform);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves managed Claude profile paths under the Sidekick accounts dir', () => {
    expect(getClaudeProfilesDir()).toBe(path.join(tmpDir, 'accounts', 'claude', 'profiles'));
    expect(getClaudeProfileHome('uuid-work')).toBe(
      path.join(tmpDir, 'accounts', 'claude', 'profiles', 'uuid-work', 'home'),
    );
  });

  it('matches the verified Claude Code keychain suffix vectors', () => {
    expect(
      claudeKeychainSuffix(
        '/Users/hoangphan/Library/Application Support/dev.hoangphan.AI-Account-Switcher/accounts/claude/53d79dfb-fbe4-41fb-9827-e8afd2e128bb',
      ),
    ).toBe('e3c60653');
    expect(claudeKeychainSuffix('/Users/hoangphan/.ai-switcher-logintest')).toBe('8244da8e');
  });

  it('derives the default and isolated Claude Code keychain service names', () => {
    expect(claudeKeychainService()).toBe('Claude Code-credentials');
    expect(claudeKeychainService('/Users/hoangphan/.ai-switcher-logintest')).toBe(
      'Claude Code-credentials-8244da8e',
    );
  });

  it('reads profile identity from the profile home config', () => {
    const home = getClaudeProfileHome('uuid-work');
    writeClaudeProfileIdentity(home);

    expect(readClaudeProfileIdentity(home)).toEqual({
      email: 'work@example.com',
      uuid: 'uuid-work',
    });
  });

  it('returns null when profile identity is missing or invalid', () => {
    const home = getClaudeProfileHome('uuid-work');

    expect(readClaudeProfileIdentity(home)).toBeNull();

    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ other: true }));

    expect(readClaudeProfileIdentity(home)).toBeNull();
  });

  it('requires credentials and identity for non-Darwin profile authentication', () => {
    setPlatform('linux');
    const home = getClaudeProfileHome('uuid-work');

    expect(isClaudeProfileAuthenticated(home)).toBe(false);

    writeClaudeProfileCredentials(home);
    expect(isClaudeProfileAuthenticated(home)).toBe(false);

    writeClaudeProfileIdentity(home);
    expect(isClaudeProfileAuthenticated(home)).toBe(true);

    fs.rmSync(path.join(home, '.credentials.json'));
    expect(isClaudeProfileAuthenticated(home)).toBe(false);
  });

  it('bounds macOS keychain checks and treats killed checks as unauthenticated', () => {
    setPlatform('darwin');
    const home = getClaudeProfileHome('uuid-work');
    writeClaudeProfileIdentity(home);
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync timed out'), {
        code: 'ETIMEDOUT',
        signal: 'SIGKILL',
      });
    });

    expect(isClaudeProfileAuthenticated(home)).toBe(false);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', claudeKeychainService(home)],
      expect.objectContaining({
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 4000,
        killSignal: 'SIGKILL',
      }),
    );
  });

  it('bootstraps the profile home directory with owner-only permissions', () => {
    const home = getClaudeProfileHome('uuid-work');

    ensureClaudeProfileDirs('uuid-work');

    expect(fs.existsSync(home)).toBe(true);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  });
});
