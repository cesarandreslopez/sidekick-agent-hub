import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readSavedAccountRegistry,
  writeSavedAccountRegistry,
  listSavedAccountProfiles,
  getActiveSavedAccount,
} from './accountRegistry';
import { writeAccountRegistry } from './accounts';
import type { AccountRegistry } from './accounts';
import type { SavedAccountRegistry } from './accountRegistry';

let tmpDir: string;

vi.mock('./paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

describe('accountRegistry', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-account-registry-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('migrates a legacy Claude-only registry into the provider-aware format', () => {
    const legacyRegistry: AccountRegistry = {
      version: 1,
      activeAccountUuid: 'claude-1',
      accounts: [
        {
          uuid: 'claude-1',
          email: 'work@example.com',
          label: 'Work',
          addedAt: '2026-04-01T00:00:00Z',
        },
      ],
    };

    const accountsDir = path.join(tmpDir, 'accounts');
    fs.mkdirSync(accountsDir, { recursive: true });
    fs.writeFileSync(path.join(accountsDir, 'accounts.json'), JSON.stringify(legacyRegistry, null, 2));

    const migrated = readSavedAccountRegistry();

    expect(migrated).toEqual({
      version: 2,
      activeByProvider: {
        'claude-code': 'claude-1',
        codex: null,
      },
      accounts: [
        {
          id: 'claude-1',
          providerId: 'claude-code',
          providerAccountId: 'claude-1',
          email: 'work@example.com',
          label: 'Work',
          addedAt: '2026-04-01T00:00:00Z',
          metadata: {
            email: 'work@example.com',
          },
        },
      ],
    });
  });

  it('lists and resolves active accounts by provider', () => {
    const registry: SavedAccountRegistry = {
      version: 2,
      activeByProvider: {
        'claude-code': 'claude-1',
        codex: 'codex-2',
      },
      accounts: [
        {
          id: 'claude-1',
          providerId: 'claude-code',
          providerAccountId: 'claude-1',
          email: 'work@example.com',
          label: 'Work',
          addedAt: '2026-04-01T00:00:00Z',
        },
        {
          id: 'codex-2',
          providerId: 'codex',
          label: 'Codex Personal',
          addedAt: '2026-04-02T00:00:00Z',
          metadata: {
            authMode: 'chatgpt',
          },
        },
      ],
    };

    writeSavedAccountRegistry(registry);

    expect(listSavedAccountProfiles('claude-code')).toHaveLength(1);
    expect(listSavedAccountProfiles('codex')).toHaveLength(1);
    expect(getActiveSavedAccount('claude-code')?.id).toBe('claude-1');
    expect(getActiveSavedAccount('codex')?.id).toBe('codex-2');
  });

  it('preserves Codex profiles when the legacy Claude writer updates Claude accounts', () => {
    const existing: SavedAccountRegistry = {
      version: 2,
      activeByProvider: {
        'claude-code': null,
        codex: 'codex-1',
      },
      accounts: [
        {
          id: 'codex-1',
          providerId: 'codex',
          label: 'Codex Work',
          addedAt: '2026-04-02T00:00:00Z',
        },
      ],
    };

    writeSavedAccountRegistry(existing);

    writeAccountRegistry({
      version: 1,
      activeAccountUuid: 'claude-2',
      accounts: [
        {
          uuid: 'claude-2',
          email: 'new@example.com',
          label: 'Claude New',
          addedAt: '2026-04-03T00:00:00Z',
        },
      ],
    });

    const updated = readSavedAccountRegistry();
    expect(updated?.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'codex-1', providerId: 'codex' }),
        expect.objectContaining({ id: 'claude-2', providerId: 'claude-code' }),
      ]),
    );
    expect(updated?.activeByProvider.codex).toBe('codex-1');
    expect(updated?.activeByProvider['claude-code']).toBe('claude-2');
  });
});
