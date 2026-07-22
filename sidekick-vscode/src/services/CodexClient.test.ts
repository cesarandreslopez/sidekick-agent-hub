import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
vi.mock('../utils/cliPathResolver', () => ({ findCli: () => '/usr/bin/codex' }));
vi.mock('sidekick-shared', () => ({
  getCodexExecutionEnv: () => ({}),
  resolveSidekickCodexHome: () => '/tmp/.codex',
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { CodexClient } from './CodexClient';

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: PassThrough;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.stdout = new PassThrough();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

describe('CodexClient', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('handles stdin EPIPE as a rejected completion', async () => {
    const child = makeChild();
    child.stdin.write.mockImplementation(() => {
      queueMicrotask(() =>
        child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })),
      );
      return true;
    });
    mockSpawn.mockReturnValue(child);

    await expect(new CodexClient().complete('prompt', { timeout: 1_000 })).rejects.toMatchObject({
      code: 'EPIPE',
    });
  });

  it('rejects an aborted child as cancellation instead of empty success', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const controller = new AbortController();
    const pending = new CodexClient().complete('prompt', { signal: controller.signal });

    controller.abort();
    child.emit('close', 0);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
