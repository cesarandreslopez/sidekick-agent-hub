import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
const mockExecFileSync = vi.hoisted(() => ({ fn: null as null | ((...a: unknown[]) => unknown) }));

vi.mock('./paths', () => ({
  getConfigDir: () => path.join(tmpDir, 'sidekick'),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => {
      if (mockExecFileSync.fn) return mockExecFileSync.fn(...args);
      return (actual.execFileSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import {
  inspectClaudeCredentialStores,
  parseKeychainDump,
  repairClaudeCredentialStores,
} from './claudeCredentialDoctor';
import { readClaudeCredentialLedger, recordClaudeCredentialHome } from './claudeCredentialLedger';
import { writeSavedAccountRegistry } from './accountRegistry';
import { claudeKeychainService, getClaudeProfileHome, getClaudeProfileDir } from './claudeProfiles';
import { SIDEKICK_KEYCHAIN_COMMENT_PREFIX } from './credentialIO';

const originalPlatform = process.platform;
const NOW = Date.parse('2026-09-26T12:00:00Z');

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function register(ids: string[]): void {
  writeSavedAccountRegistry({
    version: 2,
    activeByProvider: { 'claude-code': ids[0] ?? null, codex: null },
    accounts: ids.map((id) => ({
      id,
      providerId: 'claude-code' as const,
      providerAccountId: id,
      email: `${id}@example.com`,
      addedAt: '2026-01-01T00:00:00Z',
    })),
  });
}

function writeStore(home: string, content: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.credentials.json'), content);
}

const login = (token: string, expiresAt = NOW + 3_600_000): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt } });

function setLive(uuid: string, token: string, expiresAt = NOW + 5 * 3_600_000): void {
  const live = path.join(tmpDir, '.claude');
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(
    path.join(live, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: `${uuid}@example.com`, accountUuid: uuid } }),
  );
  fs.writeFileSync(path.join(live, '.credentials.json'), login(token, expiresAt));
}

describe('parseKeychainDump', () => {
  it('reads service and comment attributes (quoted, hex, and NULL)', () => {
    const hexComment = Buffer.from('sidekick-agent-hub:/tmp/x').toString('hex').toUpperCase();
    const dump = [
      'keychain: "/Users/u/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "acct"<blob>="u"',
      '    "icmt"<blob>="sidekick-agent-hub:/tmp/a"',
      '    "svce"<blob>="Claude Code-credentials-aaaa0000"',
      'keychain: "/Users/u/Library/Keychains/login.keychain-db"',
      'class: "genp"',
      'attributes:',
      '    "icmt"<blob>=<NULL>',
      '    "svce"<blob>="Claude Code-credentials-bbbb1111"',
      'keychain: "/Users/u/Library/Keychains/login.keychain-db"',
      'attributes:',
      `    "icmt"<blob>=0x${hexComment}  "sidekick-agent-hub:/tmp/x"`,
      '    "svce"<blob>="Claude Code-credentials-cccc2222"',
    ].join('\n');

    expect(parseKeychainDump(dump)).toEqual([
      { service: 'Claude Code-credentials-aaaa0000', comment: 'sidekick-agent-hub:/tmp/a' },
      { service: 'Claude Code-credentials-bbbb1111', comment: undefined },
      { service: 'Claude Code-credentials-cccc2222', comment: 'sidekick-agent-hub:/tmp/x' },
    ]);
  });
});

describe('Claude credential doctor (file stores)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-credential-doctor-'));
    setPlatform('linux');
    mockExecFileSync.fn = null;
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedEverything(): Record<string, string> {
    register(['live', 'inactive', 'broken']);
    setLive('live', 'tok-live');
    const homes = {
      live: getClaudeProfileHome('live'),
      inactive: getClaudeProfileHome('inactive'),
      broken: getClaudeProfileHome('broken'),
      abandoned: getClaudeProfileHome('login-abandoned'),
      pending: getClaudeProfileHome('login-pending'),
      gone: path.join(tmpDir, 'sidekick', 'accounts', 'claude', 'profiles', 'gone', 'home'),
    };
    writeStore(homes.live, login('tok-live-old', NOW));
    writeStore(homes.inactive, login('tok-inactive'));
    writeStore(homes.broken, '{"mcpOAuth":{"x":1},"claudeAiOauth":{"acc');
    writeStore(homes.abandoned, login('tok-abandoned'));
    writeStore(homes.pending, login('tok-pending'));
    fs.writeFileSync(
      path.join(getClaudeProfileDir('login-pending'), 'profile.json'),
      JSON.stringify({ label: 'p', addedAt: new Date(Date.now() - 60_000).toISOString() }),
    );
    recordClaudeCredentialHome(homes.gone, 'login');
    return homes;
  }

  it('classifies only stores Sidekick owns', () => {
    const homes = seedEverything();

    const { findings } = inspectClaudeCredentialStores({ listKeychainItems: () => [] });
    const byDir = Object.fromEntries(findings.map((f) => [f.configDir, f.kind]));

    expect(byDir).toEqual({
      [path.resolve(homes.live)]: 'live-duplicate',
      [path.resolve(homes.broken)]: 'corrupt',
      [path.resolve(homes.abandoned)]: 'orphan',
      [path.resolve(homes.gone)]: 'stale-entry',
    });
  });

  it('is a dry run by default and repairs everything with dryRun: false', () => {
    const homes = seedEverything();

    const dry = repairClaudeCredentialStores({ listKeychainItems: () => [] });
    expect(dry.dryRun).toBe(true);
    expect(dry.repaired).toEqual([]);
    expect(fs.existsSync(path.join(homes.abandoned, '.credentials.json'))).toBe(true);

    const fixed = repairClaudeCredentialStores({ dryRun: false, listKeychainItems: () => [] });

    expect(fixed.repaired.every((outcome) => outcome.ok)).toBe(true);
    expect(fixed.sync?.demoted).toBe('live');
    expect(fs.existsSync(path.join(homes.live, '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.join(homes.broken, '.credentials.json'))).toBe(false);
    expect(fs.existsSync(path.dirname(homes.abandoned))).toBe(false);
    expect(readClaudeCredentialLedger().map((e) => e.configDir)).not.toContain(
      path.resolve(homes.gone),
    );
    // Untouched: the inactive account's single copy and the recent pending login.
    expect(fs.existsSync(path.join(homes.inactive, '.credentials.json'))).toBe(true);
    expect(fs.existsSync(path.join(homes.pending, '.credentials.json'))).toBe(true);
    expect(inspectClaudeCredentialStores({ listKeychainItems: () => [] }).findings).toEqual([]);
  });
});

describe('Claude credential doctor (macOS Keychain)', () => {
  let items: Map<string, { comment?: string; data: string }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-credential-doctor-kc-'));
    setPlatform('darwin');
    items = new Map();
    mockExecFileSync.fn = (command: unknown, args: unknown) => {
      expect(command).toBe('security');
      const argv = args as string[];
      const service = argv[argv.indexOf('-s') + 1];
      if (argv[0] === 'find-generic-password') {
        const item = items.get(service);
        if (!item) throw Object.assign(new Error('not found'), { status: 44 });
        return item.data;
      }
      if (argv[0] === 'delete-generic-password') {
        if (!items.delete(service)) throw Object.assign(new Error('not found'), { status: 44 });
        return '';
      }
      throw new Error(`unexpected security ${argv.join(' ')}`);
    };
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    mockExecFileSync.fn = null;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes tagged orphans from deleted directories and never touches foreign items', () => {
    register([]);
    const deletedDir = path.join(tmpDir, 'throwaway-root', 'profiles', 'p', 'home');
    const tagged = claudeKeychainService(deletedDir);
    const foreign = 'Claude Code-credentials-deadbeef';
    const mislabeled = claudeKeychainService(path.join(tmpDir, 'other'));
    items.set(tagged, {
      comment: `${SIDEKICK_KEYCHAIN_COMMENT_PREFIX}${deletedDir}`,
      data: login('t'),
    });
    items.set(foreign, { data: login('foreign') });
    // A tag that does not hash to its own service proves nothing.
    items.set(mislabeled, {
      comment: `${SIDEKICK_KEYCHAIN_COMMENT_PREFIX}${deletedDir}-elsewhere`,
      data: login('m'),
    });
    const listKeychainItems = () =>
      [...items.entries()].map(([service, item]) => ({ service, comment: item.comment }));

    const inspection = inspectClaudeCredentialStores({ listKeychainItems });
    expect(inspection.findings).toEqual([
      expect.objectContaining({ kind: 'orphan', service: tagged, ownership: 'keychain-tag' }),
    ]);

    repairClaudeCredentialStores({ dryRun: false, listKeychainItems });

    expect(items.has(tagged)).toBe(false);
    expect(items.has(foreign)).toBe(true);
    expect(items.has(mislabeled)).toBe(true);
  });
});
