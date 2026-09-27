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

vi.mock('./paths', () => ({
  getConfigDir: () => path.join(tmpDir, 'sidekick'),
}));

import {
  ClaudeCredentialWriteError,
  deleteStoredCredentials,
  readActiveCredentials,
  readClaudeCredentialStore,
  SECURITY_INTERACTIVE_LINE_LIMIT,
  SIDEKICK_KEYCHAIN_COMMENT_PREFIX,
  writeActiveCredentials,
  writeLiveClaudeCredentialStoreUnguarded,
} from './credentialIO';
import { readClaudeCredentialLedger } from './claudeCredentialLedger';

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

function defaultClaudeDir(): string {
  return path.join(tmpDir, '.claude');
}

function notFound(): Error {
  return Object.assign(new Error('The specified item could not be found in the keychain.'), {
    status: 44,
  });
}

/** Tokenize one `security -i` line: single-quoted tokens with backslash escapes. */
function tokenizeInteractive(line: string): string[] {
  const tokens: string[] = [];
  const pattern = /'((?:\\.|[^'\\])*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]);
  }
  return tokens;
}

interface FakeItem {
  account: string;
  comment?: string;
  data: string;
}

/** An in-memory stand-in for the macOS `security` tool. */
function installFakeKeychain(options: { corruptWrites?: boolean } = {}): Map<string, FakeItem> {
  const items = new Map<string, FakeItem>();
  const add = (argv: string[]): void => {
    const value = (flag: string): string | undefined => {
      const index = argv.indexOf(flag);
      return index >= 0 ? argv[index + 1] : undefined;
    };
    const hex = value('-X')!;
    let data = Buffer.from(hex, 'hex').toString('utf8');
    if (options.corruptWrites) data = data.slice(0, 20);
    items.set(value('-s')!, { account: value('-a')!, comment: value('-j'), data });
  };
  mockExecFileSync.mockImplementation(
    (command: string, argv: string[], opts?: { input?: string }) => {
      expect(command).toBe('security');
      if (argv[0] === '-i') {
        add(tokenizeInteractive(opts!.input!.trim()));
        return '';
      }
      if (argv[0] === 'add-generic-password') {
        add(argv);
        return '';
      }
      const service = argv[argv.indexOf('-s') + 1];
      const accountIndex = argv.indexOf('-a');
      const item = items.get(service);
      if (argv[0] === 'find-generic-password') {
        if (!item || (accountIndex >= 0 && item.account !== argv[accountIndex + 1]))
          throw notFound();
        return item.data + '\n';
      }
      if (argv[0] === 'delete-generic-password') {
        if (!item || (accountIndex >= 0 && item.account !== argv[accountIndex + 1]))
          throw notFound();
        items.delete(service);
        return '';
      }
      throw new Error(`unexpected security ${argv.join(' ')}`);
    },
  );
  return items;
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

  describe('reads', () => {
    it('falls back to the credentials file on macOS when the Keychain item is missing', () => {
      setPlatform('darwin');
      mockExecFileSync.mockImplementation(() => {
        throw notFound();
      });
      fs.writeFileSync(
        path.join(defaultClaudeDir(), '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }),
      );

      expect(readActiveCredentials()).toEqual({ claudeAiOauth: { accessToken: 'from-file' } });
      // Same lookup Claude Code makes: account and service.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'security',
        [
          'find-generic-password',
          '-a',
          'sidekick-test-user',
          '-s',
          'Claude Code-credentials',
          '-w',
        ],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000, killSignal: 'SIGKILL' },
      );
    });

    it('tells absent, corrupt, and unreadable apart', () => {
      setPlatform('darwin');
      mockExecFileSync.mockImplementationOnce(() => {
        throw notFound();
      });
      expect(readClaudeCredentialStore(undefined, { keychainOnly: true })).toEqual({
        status: 'absent',
      });

      mockExecFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('spawnSync timed out'), {
          code: 'ETIMEDOUT',
          signal: 'SIGKILL',
        });
      });
      expect(readClaudeCredentialStore().status).toBe('error');
      // A timeout is never mistaken for "no credential": no file fallback.
      expect(readActiveCredentials()).toBeNull();

      mockExecFileSync.mockReturnValueOnce('{"mcpOAuth":{"a":1},"claudeAiOauth":{"acc');
      expect(readClaudeCredentialStore()).toMatchObject({ status: 'corrupt', source: 'keychain' });
    });

    it('decodes hex output for items whose bytes security prints as hex', () => {
      setPlatform('darwin');
      const blob = { claudeAiOauth: { accessToken: 'hex-access' } };
      mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(blob)).toString('hex'));

      expect(readClaudeCredentialStore()).toEqual({ status: 'ok', blob, source: 'keychain' });
    });

    it('reports a corrupt credentials file instead of treating it as absent', () => {
      setPlatform('linux');
      fs.writeFileSync(path.join(defaultClaudeDir(), '.credentials.json'), '{"claudeAiOauth":');

      expect(readClaudeCredentialStore()).toMatchObject({ status: 'corrupt', source: 'file' });
      expect(readActiveCredentials()).toBeNull();
    });
  });

  describe('writes', () => {
    it('refuses to write the live store without a config directory', () => {
      setPlatform('linux');
      const before = readActiveCredentials();

      expect(() => writeActiveCredentials({ claudeAiOauth: { accessToken: 'x' } })).toThrow(
        ClaudeCredentialWriteError,
      );
      expect(readActiveCredentials()).toEqual(before);
    });

    it('round-trips file-backed credentials in the provided config dir and the live store', () => {
      setPlatform('linux');
      const liveCredentials = { claudeAiOauth: { accessToken: 'default-access' } };
      const profileCredentials = { claudeAiOauth: { accessToken: 'profile-access' } };
      const profileHome = path.join(tmpDir, 'accounts', 'claude', 'profiles', 'uuid-work', 'home');
      fs.mkdirSync(profileHome, { recursive: true });

      writeLiveClaudeCredentialStoreUnguarded(liveCredentials);
      writeActiveCredentials(profileCredentials, profileHome);

      expect(readActiveCredentials()).toEqual(liveCredentials);
      expect(readActiveCredentials(profileHome)).toEqual(profileCredentials);
      expect(
        JSON.parse(fs.readFileSync(path.join(profileHome, '.credentials.json'), 'utf8')),
      ).toEqual(profileCredentials);
    });

    it('writes hex through security -i with the account, service, and ownership tag, then verifies', () => {
      setPlatform('darwin');
      const items = installFakeKeychain();
      const profileHome = '/Users/someone/.config/sidekick/accounts/claude/profiles/p1/home';
      const credentials = { claudeAiOauth: { accessToken: 'profile-access' } };

      writeActiveCredentials(credentials, profileHome);

      const service = claudeKeychainService(profileHome);
      expect(items.get(service)).toEqual({
        account: 'sidekick-test-user',
        comment: `${SIDEKICK_KEYCHAIN_COMMENT_PREFIX}${profileHome}`,
        data: JSON.stringify(credentials),
      });
      const writeCall = mockExecFileSync.mock.calls.find((call) => call[1][0] === '-i')!;
      const input = writeCall[2].input as string;
      expect(input.startsWith('add-generic-password -U -a ')).toBe(true);
      expect(input).toContain(`-X '${Buffer.from(JSON.stringify(credentials)).toString('hex')}'`);
      // The secret never appears in plain text on argv or in the line.
      expect(JSON.stringify(writeCall[1])).not.toContain('profile-access');
      expect(input).not.toContain('profile-access');
      // Read back with the same lookup Claude Code makes.
      expect(mockExecFileSync).toHaveBeenLastCalledWith(
        'security',
        ['find-generic-password', '-a', 'sidekick-test-user', '-s', service, '-w'],
        expect.anything(),
      );
    });

    it('falls back to argv above the security -i line limit instead of truncating', () => {
      setPlatform('darwin');
      const items = installFakeKeychain();
      const profileHome = path.join(tmpDir, 'profile-home');
      const mcpOAuth: Record<string, unknown> = {};
      for (let i = 0; i < 8; i++) mcpOAuth[`server-${i}`] = { accessToken: 'x'.repeat(400) };
      const credentials = { mcpOAuth, claudeAiOauth: { accessToken: 'big-access' } };
      expect(JSON.stringify(credentials).length * 2).toBeGreaterThan(
        SECURITY_INTERACTIVE_LINE_LIMIT,
      );

      writeActiveCredentials(credentials, profileHome);

      expect(mockExecFileSync.mock.calls.some((call) => call[1][0] === '-i')).toBe(false);
      const argvCall = mockExecFileSync.mock.calls.find(
        (call) => call[1][0] === 'add-generic-password',
      )!;
      expect(argvCall[1]).toEqual(expect.arrayContaining(['-U', '-a', 'sidekick-test-user', '-X']));
      expect(JSON.parse(items.get(claudeKeychainService(profileHome))!.data)).toEqual(credentials);
    });

    it('throws when the item does not hold the credential after writing (a truncated write)', () => {
      setPlatform('darwin');
      installFakeKeychain({ corruptWrites: true });

      expect(() =>
        writeActiveCredentials({ claudeAiOauth: { accessToken: 'lost' } }, path.join(tmpDir, 'h')),
      ).toThrow(/did not hold the credential/);
    });

    it('treats an unverifiable write (read-back timeout) as not written', () => {
      setPlatform('darwin');
      mockExecFileSync.mockImplementation((_command: string, argv: string[]) => {
        if (argv[0] === 'find-generic-password') {
          throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        }
        return '';
      });

      expect(() =>
        writeActiveCredentials({ claudeAiOauth: { accessToken: 'x' } }, path.join(tmpDir, 'h')),
      ).toThrow(/could not be verified/);
    });

    it('escapes single quotes and backslashes for the security -i tokenizer', () => {
      setPlatform('darwin');
      const items = installFakeKeychain();
      const profileHome = path.join(tmpDir, String.raw`it's a \dir`);

      writeActiveCredentials({ claudeAiOauth: { accessToken: 'a' } }, profileHome);

      const input = mockExecFileSync.mock.calls.find((call) => call[1][0] === '-i')![2]
        .input as string;
      // security -i does not concatenate adjacent quoted segments, so the
      // shell-style '\'' splice must never appear.
      expect(input).not.toContain(`'\\''`);
      expect(items.get(claudeKeychainService(profileHome))?.comment).toBe(
        `${SIDEKICK_KEYCHAIN_COMMENT_PREFIX}${profileHome}`,
      );
    });
  });

  describe('ledger and deletes', () => {
    it('records every profile home it writes and forgets it once deleted', () => {
      setPlatform('darwin');
      const items = installFakeKeychain();
      const profileHome = path.join(tmpDir, 'profile-home');

      writeActiveCredentials({ claudeAiOauth: { accessToken: 'a' } }, profileHome);
      expect(readClaudeCredentialLedger()).toEqual([
        expect.objectContaining({
          configDir: profileHome,
          service: claudeKeychainService(profileHome),
          purpose: 'profile',
        }),
      ]);

      expect(deleteStoredCredentials(profileHome)).toBe(true);
      expect(items.has(claudeKeychainService(profileHome))).toBe(false);
      expect(readClaudeCredentialLedger()).toEqual([]);
    });

    it('deletes by account first and falls back to the service alone for older items', () => {
      setPlatform('darwin');
      const items = installFakeKeychain();
      const profileHome = path.join(tmpDir, 'old-home');
      items.set(claudeKeychainService(profileHome), { account: 'user', data: '{}' });

      expect(deleteStoredCredentials(profileHome)).toBe(true);

      const deletes = mockExecFileSync.mock.calls.filter(
        (call) => call[1][0] === 'delete-generic-password',
      );
      expect(deletes[0][1]).toContain('-a');
      expect(deletes[1][1]).not.toContain('-a');
      expect(items.size).toBe(0);
    });
  });
});
