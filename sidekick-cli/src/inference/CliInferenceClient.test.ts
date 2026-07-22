import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock, execSync: vi.fn() }));

import { spawnWithStdin } from './CliInferenceClient';

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & Record<string, any>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  proc.kill = vi.fn();
  proc.exitCode = null;
  return proc;
}

describe('spawnWithStdin', () => {
  beforeEach(() => spawnMock.mockReset());

  it('settles a stdin EPIPE as a normal inference error', async () => {
    const proc = fakeProcess();
    spawnMock.mockReturnValue(proc);
    const pending = spawnWithStdin('claude', ['--print'], 'prompt');
    const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    proc.stdin.emit('error', error);
    await expect(pending).resolves.toMatchObject({
      text: '',
      error: expect.stringContaining('EPIPE'),
    });
  });

  it('escalates a timed-out child from SIGTERM to SIGKILL', async () => {
    vi.useFakeTimers();
    const proc = fakeProcess();
    spawnMock.mockReturnValue(proc);
    const pending = spawnWithStdin('codex', ['exec'], 'prompt');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pending).resolves.toMatchObject({ error: expect.stringContaining('timed out') });
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});
