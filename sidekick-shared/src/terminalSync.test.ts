import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
const originalPath = process.env.PATH;
const originalShell = process.env.SHELL;

vi.mock('./paths', () => ({
  getConfigDir: () => path.join(tmpDir, '.config', 'sidekick'),
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: () => tmpDir,
  };
});

import { removeLauncher, writeLauncher } from './terminalSync';

function localBin(name: string): string {
  return path.join(tmpDir, '.local', 'bin', name);
}

describe('terminalSync', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-terminal-sync-test-'));
    process.env.PATH = '';
    process.env.SHELL = '/bin/zsh';
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.SHELL = originalShell;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and removes sidekick-owned launchers', () => {
    const profileHome = path.join(tmpDir, 'accounts', 'claude', 'profiles', 'uuid-a', 'home');

    writeLauncher('claude-work', 'claude-code', profileHome);

    const launcherPath = localBin('claude-work');
    const script = fs.readFileSync(launcherPath, 'utf8');
    expect(script).toContain('# sidekick-launcher v1');
    expect(script).toContain(`export CLAUDE_CONFIG_DIR=${JSON.stringify(profileHome)}`);
    expect(script).toContain('unset CLAUDE_SECURESTORAGE_CONFIG_DIR');
    expect(script).toContain('exec claude "$@"');
    expect(fs.statSync(launcherPath).mode & 0o777).toBe(0o755);

    removeLauncher('claude-work');

    expect(fs.existsSync(launcherPath)).toBe(false);
  });

  it('rejects invalid launcher names and command collisions', () => {
    expect(() => writeLauncher('../bad', 'claude-code', '/tmp/profile')).toThrow(/invalid/i);

    fs.mkdirSync(path.dirname(localBin('codex-work')), { recursive: true });
    fs.writeFileSync(localBin('codex-work'), '#!/bin/sh\necho not sidekick\n');
    expect(() => writeLauncher('codex-work', 'codex', '/tmp/codex')).toThrow(/exists/i);

    const pathDir = path.join(tmpDir, 'path-bin');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(path.join(pathDir, 'taken'), '#!/bin/sh\n');
    process.env.PATH = pathDir;
    expect(() => writeLauncher('taken', 'claude-code', '/tmp/profile')).toThrow(/PATH/i);
  });

  it('does not remove launchers it did not create', () => {
    fs.mkdirSync(path.dirname(localBin('manual')), { recursive: true });
    fs.writeFileSync(localBin('manual'), '#!/bin/sh\necho manual\n');

    removeLauncher('manual');

    expect(fs.existsSync(localBin('manual'))).toBe(true);
  });
});
