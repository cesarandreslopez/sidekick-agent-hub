import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ spawn: spawnMock, execSync: vi.fn() }));

import { CliInferenceClient, spawnWithStdin } from './CliInferenceClient';

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & Record<string, any>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  proc.kill = vi.fn();
  proc.exitCode = null;
  return proc;
}

describe('CliInferenceClient', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    spawnMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('OPENAI_API_KEY', undefined);
    vi.stubEnv('CODEX_API_KEY', undefined);
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(['OPENAI_API_KEY', 'CODEX_API_KEY'])(
    'generates a Luna summary through Chat Completions using %s',
    async (keyName) => {
      vi.stubEnv(keyName, 'test-openai-key');
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'Session summary' } }] })),
      );

      await expect(
        new CliInferenceClient('codex').complete('Summarize this session'),
      ).resolves.toEqual({
        text: 'Session summary',
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, request] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(request).toMatchObject({
        method: 'POST',
        headers: { Authorization: 'Bearer test-openai-key' },
      });
      expect(JSON.parse(request!.body as string)).toEqual({
        model: 'gpt-5.6-luna',
        max_completion_tokens: 1024,
        reasoning_effort: 'none',
        messages: [{ role: 'user', content: 'Summarize this session' }],
      });
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it('keeps the Anthropic API summary on Haiku 4.5 and its Messages request format', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'Claude summary' }] })),
    );

    await expect(
      new CliInferenceClient('opencode').complete('Summarize this session'),
    ).resolves.toEqual({
      text: 'Claude summary',
    });

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(JSON.parse(request!.body as string)).toEqual({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Summarize this session' }],
    });
  });

  it('reports model availability errors without silently selecting another model', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    fetchMock.mockResolvedValue(new Response('Model not available', { status: 404 }));

    await expect(new CliInferenceClient('codex').complete('Summarize')).resolves.toEqual({
      text: '',
      error: 'API error 404: Model not available',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['claude-code', 'claude', ['--print']],
    ['codex', 'codex', ['exec']],
  ] as const)(
    'lets %s native CLI summaries inherit the user model configuration',
    async (provider, command, args) => {
      const proc = fakeProcess();
      spawnMock.mockReturnValue(proc);
      const client = new CliInferenceClient(provider);
      await client.checkAvailability();
      const pending = client.complete('Summarize');
      proc.stdout.emit('data', Buffer.from('Native summary'));
      proc.emit('close', 0);

      await expect(pending).resolves.toEqual({ text: 'Native summary' });
      expect(spawnMock).toHaveBeenCalledWith(command, args, expect.any(Object));
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

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
