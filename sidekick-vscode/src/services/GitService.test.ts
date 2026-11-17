import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
vi.mock('vscode', () => ({
  extensions: { getExtension: vi.fn() },
  window: {},
  workspace: {},
  commands: {},
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { GitService, isInsideRoot } from './GitService';

function childProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

describe('GitService process execution', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('runs diff without a shell', async () => {
    const child = childProcess();
    mockSpawn.mockReturnValue(child);
    const service = new GitService();
    const pending = service.getDiff({ rootUri: { fsPath: '/tmp/repo' } } as never, false);
    child.stdout.emit('data', Buffer.from('safe diff'));
    child.emit('close', 0);

    await expect(pending).resolves.toBe('safe diff');
    expect(mockSpawn).toHaveBeenCalledWith('git', ['diff'], { cwd: '/tmp/repo' });
  });

  it('passes a hostile ref as one literal git argument', async () => {
    const child = childProcess();
    mockSpawn.mockReturnValue(child);
    const service = new GitService();
    const hostile = 'main; touch /tmp/sidekick-pwned';
    const pending = service.execGit('/tmp/repo', ['diff', hostile, '--']);
    child.emit('close', 0);

    await expect(pending).resolves.toBe('');
    expect(mockSpawn).toHaveBeenCalledWith('git', ['diff', hostile, '--'], { cwd: '/tmp/repo' });
  });
});

describe('isInsideRoot', () => {
  it('matches the root and paths below it, not a sibling that shares a prefix', () => {
    expect(isInsideRoot('/w/app', '/w/app')).toBe(true);
    expect(isInsideRoot('/w/app/src/a.ts', '/w/app')).toBe(true);
    expect(isInsideRoot('/w/app-2/src/a.ts', '/w/app')).toBe(false);
  });
});
