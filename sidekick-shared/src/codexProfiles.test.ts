import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockSpawnSync = vi.hoisted(() => vi.fn());

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

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  };
});

import {
  prepareCodexAccount,
  finalizeCodexAccount,
  listCodexAccounts,
  getActiveCodexAccount,
  switchToCodexAccount,
  removeCodexAccount,
  getCodexProfileHome,
  resolveSidekickCodexHome,
} from './codexProfiles';

function writeSourceCodexAuth(email = 'codex@example.com'): void {
  const codexHome = path.join(tmpDir, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n');
  fs.writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: makeJwt({
          email,
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
            chatgpt_account_id: 'ws-123',
          },
        }),
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        account_id: 'ws-123',
      },
    }, null, 2),
  );
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('codexProfiles', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-profiles-test-'));
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: 'Not logged in\n',
      stderr: '',
      error: undefined,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imports current Codex auth into a managed profile and makes it active', () => {
    writeSourceCodexAuth('work@example.com');

    const result = prepareCodexAccount('Work');

    expect(result.success).toBe(true);
    expect(result.needsLogin).toBe(false);
    expect(result.profileId).toBeTruthy();

    const profileHome = getCodexProfileHome(result.profileId!);
    expect(fs.existsSync(path.join(profileHome, 'auth.json'))).toBe(true);
    expect(fs.existsSync(path.join(profileHome, 'config.toml'))).toBe(true);
    expect(getActiveCodexAccount()).toEqual(
      expect.objectContaining({
        id: result.profileId,
        label: 'Work',
        providerId: 'codex',
        email: 'work@example.com',
        metadata: expect.objectContaining({
          email: 'work@example.com',
          authMode: 'chatgpt',
          planType: 'plus',
          workspaceId: 'ws-123',
        }),
      }),
    );
    expect(resolveSidekickCodexHome()).toBe(profileHome);
  });

  it('creates a pending managed profile when current auth is not importable and finalizes after login', () => {
    const prepared = prepareCodexAccount('Personal');

    expect(prepared.success).toBe(true);
    expect(prepared.needsLogin).toBe(true);
    expect(prepared.profileId).toBeTruthy();

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: 'Logged in using ChatGPT\n',
      stderr: '',
      error: undefined,
    });

    const finalized = finalizeCodexAccount(prepared.profileId!);
    expect(finalized.success).toBe(true);
    expect(getActiveCodexAccount()).toEqual(
      expect.objectContaining({
        id: prepared.profileId,
        label: 'Personal',
        providerId: 'codex',
        metadata: expect.objectContaining({
          authMode: 'chatgpt',
        }),
      }),
    );
  });

  it('switches and removes managed Codex profiles', () => {
    writeSourceCodexAuth('work@example.com');
    const work = prepareCodexAccount('Work');

    const sourceHome = path.join(tmpDir, '.codex');
    fs.rmSync(path.join(sourceHome, 'auth.json'));
    fs.writeFileSync(path.join(sourceHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: makeJwt({ email: 'personal@example.com' }),
        access_token: 'access-token-2',
        refresh_token: 'refresh-token-2',
      },
    }));
    const personal = prepareCodexAccount('Personal');

    expect(listCodexAccounts()).toHaveLength(2);

    const switched = switchToCodexAccount(work.profileId!);
    expect(switched.success).toBe(true);
    expect(getActiveCodexAccount()?.id).toBe(work.profileId);
    expect(resolveSidekickCodexHome()).toBe(getCodexProfileHome(work.profileId!));

    const removed = removeCodexAccount(work.profileId!);
    expect(removed.success).toBe(true);
    expect(fs.existsSync(getCodexProfileHome(work.profileId!))).toBe(false);
    expect(getActiveCodexAccount()?.id).toBe(personal.profileId);
  });
});
