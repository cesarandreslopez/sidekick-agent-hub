import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
const spawn = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ spawn }));
import { runCodexKeepAlive } from './codexKeepAlive';

function server(mode: 'success' | 'unsupported' | 'malformed' | 'hang' | 'eof' = 'success') {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return true;
    }),
  });
  const requests: Array<{ method: string; id?: number; params?: { refreshToken?: boolean } }> = [];
  child.stdin.on('data', (data: Buffer) => {
    const message = JSON.parse(data.toString());
    requests.push(message);
    if (mode === 'hang') return;
    if (mode === 'eof') {
      queueMicrotask(() => child.emit('close', 1));
      return;
    }
    if (mode === 'malformed') {
      child.stdout.write('invalid json\n');
      return;
    }
    if (message.method === 'initialize')
      child.stdout.write(JSON.stringify({ id: 0, result: {} }) + '\n');
    if (message.method === 'account/read') {
      child.stdout.write(
        JSON.stringify(
          mode === 'unsupported'
            ? { id: 1, error: { code: -32601 } }
            : { id: 1, result: { account: { type: 'chatgpt' } } },
        ) + '\n',
      );
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
  spawn.mockReturnValue(child);
  return { child, requests };
}
afterEach(() => {
  vi.useRealTimers();
  spawn.mockReset();
});
describe('official Codex refresh protocol (I3)', () => {
  it('handshakes, requests refresh without inference, and waits for child shutdown', async () => {
    const { requests, child } = server();
    const result = await runCodexKeepAlive(
      'codex',
      ['app-server'],
      { CODEX_HOME: '/temporary-profile' },
      20000,
    );
    expect(result.status).toBe(0);
    expect(requests.map((r) => r.method)).toEqual(['initialize', 'initialized', 'account/read']);
    expect(requests[2].params?.refreshToken).toBe(true);
    expect(child.stdin.writableEnded).toBe(true);
    expect(result.stdout).toBe('');
  });
  it.each(['unsupported', 'malformed', 'eof'] as const)(
    'fails safely on %s without forwarding server diagnostics',
    async (mode) => {
      server(mode);
      const result = await runCodexKeepAlive('codex', ['app-server'], {}, 100);
      expect(result.status === 0).toBe(false);
      expect(result.stdout).toBe('');
    },
  );
  it('kills a timed-out child before returning and releases timers', async () => {
    vi.useFakeTimers();
    const { child } = server('hang');
    const pending = runCodexKeepAlive('codex', ['app-server'], {}, 20);
    await vi.advanceTimersByTimeAsync(25);
    expect((await pending).status).toBeNull();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports a spawn failure without including potentially sensitive error text', async () => {
    spawn.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(await runCodexKeepAlive('codex', ['app-server'], {}, 20)).toEqual({
      status: null,
      stdout: '',
    });
  });
});
