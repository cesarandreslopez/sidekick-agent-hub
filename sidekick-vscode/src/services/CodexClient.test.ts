import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn<(path: unknown) => boolean>(() => false));

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => mockSpawn(...args) }));
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: (path: unknown) => mockExistsSync(path),
}));
vi.mock('../utils/cliPathResolver', () => ({ findCli: () => '/usr/bin/codex' }));
vi.mock('sidekick-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sidekick-shared')>();
  return {
    getCodexExecutionEnv: () => ({}),
    resolveSidekickCodexHome: () => '/tmp/.codex',
    parseCodexLoginStatus: actual.parseCodexLoginStatus,
  };
});
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { diagnoseProviderFailure } from 'sidekick-shared/providerFailure';
import { CodexClient } from './CodexClient';

function makeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
  };
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
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

  it('continues through non-fatal reconnect items and returns the successful reply', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const pending = new CodexClient().complete('prompt');
    child.stdout.write(
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'error',
          message:
            'Reconnecting... 2/5 (unexpected status 503 Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: connection termination)',
        },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) +
        '\n',
    );
    child.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
    child.emit('close', 0);
    await expect(pending).resolves.toBe('ok');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('retains structured terminal request errors', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const pending = new CodexClient().complete('prompt');
    child.stdout.write(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Rejected', code: 'invalid_thread_id', status: 404 },
      }) + '\n',
    );
    child.emit('close', 1);
    await expect(pending).rejects.toMatchObject({
      cause: { code: 'invalid_thread_id', status: 404 },
    });
  });

  it('forwards error events and codexErrorInfo as the cause', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const pending = new CodexClient().complete('prompt');
    child.stdout.write(
      JSON.stringify({
        type: 'error',
        message: 'stream disconnected',
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      }) + '\n',
    );
    child.stdout.write(
      JSON.stringify({
        type: 'turn.failed',
        error: { message: 'Overloaded', codexErrorInfo: 'serverOverloaded' },
      }) + '\n',
    );
    child.emit('close', 1);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: 'Codex error: Overloaded',
      cause: {
        message: 'Overloaded',
        codexErrorInfo: 'serverOverloaded',
        errors: [
          {
            message: 'stream disconnected',
            codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
          },
        ],
      },
    });
    expect((error as { cause: Record<string, unknown> }).cause.errors).not.toContainEqual(
      expect.objectContaining({ type: 'error' }),
    );
    expect(
      diagnoseProviderFailure({ provider: 'codex', credentialKind: 'oauth', error }),
    ).toMatchObject({ diagnosis: 'overloaded', retryable: true });
  });

  it('fails on error events alone when the CLI exits non-zero', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const pending = new CodexClient().complete('prompt');
    child.stdout.write(
      JSON.stringify({
        type: 'error',
        message: 'usage limit reached',
        codexErrorInfo: 'usageLimitExceeded',
      }) + '\n',
    );
    child.emit('close', 1);
    const error = await pending.catch((e: unknown) => e);
    expect(error).toMatchObject({
      message: 'Codex error: usage limit reached',
      cause: { codexErrorInfo: 'usageLimitExceeded' },
    });
    expect(
      diagnoseProviderFailure({ provider: 'codex', credentialKind: 'oauth', error }),
    ).toMatchObject({ diagnosis: 'rate_limited', retryable: false });
  });

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

describe('CodexClient.isAvailable', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockExistsSync.mockReset().mockReturnValue(false);
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('CODEX_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function statusChild(output: { stdout?: string; stderr?: string }, code = 0) {
    const child = makeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        if (output.stdout) child.stdout.write(output.stdout);
        if (output.stderr) child.stderr.write(output.stderr);
        child.emit('close', code);
      });
      return child;
    });
    return child;
  }

  it('reports ready when codex login status says logged in, without a shell', async () => {
    statusChild({ stderr: 'Logged in using ChatGPT\n' });
    await expect(new CodexClient().isAvailable()).resolves.toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/codex',
      ['login', 'status'],
      expect.objectContaining({ shell: false }),
    );
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('reports not signed in even when an auth file is present', async () => {
    statusChild({ stderr: 'Not logged in\n' }, 1);
    mockExistsSync.mockReturnValue(true);
    await expect(new CodexClient().isAvailable()).rejects.toMatchObject({
      code: 'missing_credentials',
    });
  });

  it('falls back to the auth file when the status command cannot run', async () => {
    const child = makeChild();
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })),
      );
      return child;
    });
    mockExistsSync.mockImplementation((path) => String(path).endsWith('auth.json'));
    await expect(new CodexClient().isAvailable()).resolves.toBe(true);

    mockExistsSync.mockReturnValue(false);
    await expect(new CodexClient().isAvailable()).rejects.toMatchObject({
      code: 'missing_credentials',
    });
  });

  it('falls back to the auth file when the status output is unrecognised', async () => {
    statusChild({ stderr: "error: unrecognized subcommand 'status'\n" }, 2);
    mockExistsSync.mockReturnValue(true);
    await expect(new CodexClient().isAvailable()).resolves.toBe(true);
  });

  it('falls back to the auth file when the status command times out', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    mockExistsSync.mockReturnValue(true);
    const pending = new CodexClient().isAvailable();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('skips the status command when an API key is in the environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    await expect(new CodexClient().isAvailable()).resolves.toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
