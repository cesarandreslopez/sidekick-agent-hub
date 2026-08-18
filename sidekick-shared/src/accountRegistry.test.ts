import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
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
    fs.writeFileSync(
      path.join(accountsDir, 'accounts.json'),
      JSON.stringify(legacyRegistry, null, 2),
    );

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

  it('preserves every profile across concurrent multi-process upserts', async () => {
    // Without the registry lock each process reads the same base registry and
    // the last write silently drops every other process's profile.
    const workerScript = `
      // require() resolves to dist/index.js via package.json main; the
      // package's "pretest": "npm run build" rebuilds dist before vitest runs.
      const pkg = require(${JSON.stringify(process.cwd())});
      // Under \`node -e\`, positional arguments start at argv[1].
      pkg.upsertSavedAccountProfile({
        id: 'acct-' + process.argv[1],
        providerId: 'codex',
        addedAt: new Date().toISOString(),
        label: 'Account ' + process.argv[1],
      });
    `;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        runWorker(process.execPath, ['-e', workerScript, String(index)], {
          ...process.env,
          SIDEKICK_CONFIG_DIR: tmpDir,
        }),
      ),
    );

    expect(results.filter((result) => result.status !== 0).map((result) => result.stderr)).toEqual(
      [],
    );
    const registry = readSavedAccountRegistry();
    expect(registry?.accounts.map((account) => account.id).sort()).toEqual(
      Array.from({ length: 10 }, (_, index) => `acct-${index}`).sort(),
    );
    expect(fs.existsSync(path.join(tmpDir, 'accounts', 'accounts.json.lock'))).toBe(false);
  }, 20_000);
});

function runWorker(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), env });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}
