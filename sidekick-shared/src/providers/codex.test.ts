import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', () => ({
  getConfigDir: () => tmpDir,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

vi.mock('./codexDatabase', () => ({
  CodexDatabase: class {
    isAvailable(): boolean {
      return false;
    }

    open(): boolean {
      return false;
    }

    close(): void {}
  },
}));

function writeRolloutSession(sessionPath: string, cwd: string): void {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(
    sessionPath,
    JSON.stringify({
      timestamp: '2026-04-13T11:54:30.705Z',
      type: 'session_meta',
      payload: {
        id: '019d86b0-b20c-7b02-a3b2-efe5c1ed7122',
        timestamp: '2026-04-13T11:53:40.113Z',
        cwd,
        originator: 'codex-tui',
        source: 'cli',
      },
    }) + '\n',
  );
}

describe('CodexProvider', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-codex-provider-test-'));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to the system ~/.codex sessions when the active managed profile home is empty', async () => {
    const workspacePath = path.join(tmpDir, 'workspace', 'project');
    fs.mkdirSync(workspacePath, { recursive: true });

    const { getCodexProfileHome } = await import('../codexProfiles');
    const { upsertSavedAccountProfile, setActiveSavedAccount } = await import('../accountRegistry');

    const profileId = 'profile-1';
    fs.mkdirSync(getCodexProfileHome(profileId), { recursive: true });
    upsertSavedAccountProfile({
      id: profileId,
      providerId: 'codex',
      addedAt: '2026-04-13T11:48:16.244Z',
      label: 'cal',
      email: 'user@example.com',
    });
    setActiveSavedAccount('codex', profileId);

    const systemSessionPath = path.join(
      tmpDir,
      '.codex',
      'sessions',
      '2026',
      '04',
      '13',
      'rollout-2026-04-13T14-53-40-019d86b0-b20c-7b02-a3b2-efe5c1ed7122.jsonl',
    );
    writeRolloutSession(systemSessionPath, workspacePath);

    const { CodexProvider } = await import('./codex');
    const provider = new CodexProvider();

    expect(provider.findActiveSession(workspacePath)).toBe(systemSessionPath);
    expect(provider.findAllSessions(workspacePath)).toEqual([systemSessionPath]);
    expect(provider.discoverSessionDirectory(workspacePath)).toBe(path.dirname(systemSessionPath));
  });
});
