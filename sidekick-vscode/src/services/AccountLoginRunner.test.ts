import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockBegin,
  mockStatus,
  mockFinalize,
  mockDiscard,
  terminals,
  closeListeners,
  progressRuns,
} = vi.hoisted(() => ({
  mockBegin: vi.fn(),
  mockStatus: vi.fn(),
  mockFinalize: vi.fn(),
  mockDiscard: vi.fn(),
  terminals: [] as Array<{
    name: string;
    env: Record<string, string | null>;
    sent: string[];
    show: () => void;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  closeListeners: [] as Array<(terminal: unknown) => void>,
  progressRuns: [] as Array<{ cancel: () => void }>,
}));

vi.mock('sidekick-shared', () => ({
  beginAccountLogin: (...args: unknown[]) => mockBegin(...args),
  getAccountLoginStatusAsync: (...args: unknown[]) => mockStatus(...args),
  finalizeAccountLoginAsync: (...args: unknown[]) => mockFinalize(...args),
  discardAccountLogin: (...args: unknown[]) => mockDiscard(...args),
}));

vi.mock('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  env: { shell: '/bin/zsh' },
  window: {
    createTerminal: vi.fn((options: { name: string; env: Record<string, string | null> }) => {
      const terminal = {
        name: options.name,
        env: options.env,
        sent: [] as string[],
        show: vi.fn(),
        dispose: vi.fn(),
        sendText: (text: string) => terminal.sent.push(text),
      };
      terminals.push(terminal);
      return terminal;
    }),
    onDidCloseTerminal: vi.fn((listener: (terminal: unknown) => void) => {
      closeListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    withProgress: vi.fn(
      async (
        _options: unknown,
        task: (
          progress: { report: () => void },
          token: { onCancellationRequested: (cb: () => void) => { dispose: () => void } },
        ) => Promise<unknown>,
      ) => {
        let cancel: () => void = () => undefined;
        const token = {
          onCancellationRequested: (cb: () => void) => {
            cancel = cb;
            return { dispose: vi.fn() };
          },
        };
        progressRuns.push({ cancel: () => cancel() });
        return task({ report: vi.fn() }, token);
      },
    ),
  },
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { AccountLoginRunner, quoteCommandLine } from './AccountLoginRunner';

describe('AccountLoginRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminals.length = 0;
    closeListeners.length = 0;
    progressRuns.length = 0;
    mockBegin.mockReset();
    mockStatus.mockReset();
    mockFinalize.mockReset();
    mockDiscard.mockReset();
    mockBegin.mockReturnValue({
      success: true,
      loginId: 'login-1',
      command: 'claude',
      args: ['auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: '/home' },
      envUnset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'],
      configDir: '/home',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a terminal with the isolated env, polls, and finalizes when authenticated', async () => {
    mockStatus
      .mockResolvedValueOnce({ state: 'pending' })
      .mockResolvedValue({ state: 'authenticated', email: 'a@example.com' });
    mockFinalize.mockResolvedValue({ success: true, profileId: 'uuid-a' });
    const runner = new AccountLoginRunner();

    const promise = runner.run('claude-code', 'Work', {
      pollIntervalMs: 10,
      existingAccountId: 'uuid-a',
      activate: false,
    });
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result).toEqual({ outcome: 'saved', result: { success: true, profileId: 'uuid-a' } });
    expect(mockBegin).toHaveBeenCalledWith('claude-code', 'Work', { existingAccountId: 'uuid-a' });
    expect(terminals[0].name).toBe('Sidekick Claude Login (Work)');
    expect(terminals[0].env).toEqual({
      CLAUDE_CONFIG_DIR: '/home',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: null,
    });
    expect(terminals[0].sent[0]).toContain("'claude' 'auth' 'login'");
    expect(mockFinalize).toHaveBeenCalledWith('claude-code', 'login-1', { activate: false });
    // A saved login keeps nothing to discard.
    expect(mockDiscard).not.toHaveBeenCalled();
    expect(terminals[0].dispose).not.toHaveBeenCalled();
  });

  it('reports cancellation from the progress notification or a closed terminal, and timeouts', async () => {
    mockStatus.mockResolvedValue({ state: 'pending' });
    const runner = new AccountLoginRunner();

    const cancelled = runner.run('codex', 'X', { pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(15);
    progressRuns[0].cancel();
    expect(await cancelled).toEqual({ outcome: 'cancelled' });

    const closed = runner.run('codex', 'Y', { pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(15);
    closeListeners.at(-1)!(terminals.at(-1));
    expect(await closed).toEqual({ outcome: 'cancelled' });

    const timedOut = runner.run('codex', 'Z', { pollIntervalMs: 10, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await timedOut).toEqual({ outcome: 'timeout' });
    expect(mockFinalize).not.toHaveBeenCalled();
    // Every abandoned run closed its terminal and discarded its login home (I4).
    expect(mockDiscard).toHaveBeenCalledTimes(3);
    expect(terminals.every((terminal) => terminal.dispose.mock.calls.length === 1)).toBe(true);
  });

  it('discards the Claude login home when the window closes mid-login (I4)', async () => {
    mockStatus.mockResolvedValue({ state: 'pending' });
    const runner = new AccountLoginRunner();

    const run = runner.run('claude-code', 'Work', { pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(15);
    runner.dispose();

    expect(await run).toEqual({ outcome: 'cancelled' });
    expect(mockDiscard).toHaveBeenCalledWith('claude-code', 'login-1');
    expect(terminals[0].dispose).toHaveBeenCalled();
  });

  it('quotes command lines per shell family and reports begin failures', async () => {
    expect(quoteCommandLine('claude', ['auth', 'login'], 'darwin')).toBe("'claude' 'auth' 'login'");
    expect(quoteCommandLine('codex', ['login'], 'win32')).toBe("& 'codex' 'login'");
    expect(
      quoteCommandLine(
        'codex',
        ['login'],
        'win32',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ),
    ).toBe("& 'codex' 'login'");
    expect(
      quoteCommandLine('codex', ['login'], 'win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    ).toBe("& 'codex' 'login'");
    expect(quoteCommandLine('codex', ['login'], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toBe(
      '"codex" "login"',
    );
    expect(
      quoteCommandLine(
        'claude',
        ['auth', 'login'],
        'win32',
        'C:\\Program Files\\Git\\bin\\bash.exe',
      ),
    ).toBe("'claude' 'auth' 'login'");
    expect(quoteCommandLine('claude', ["it's"], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toBe(
      '"claude" "it\'s"',
    );
    mockBegin.mockReturnValue({ success: false, error: 'nope' });
    expect(await new AccountLoginRunner().run('codex', 'X')).toEqual({
      outcome: 'failed',
      error: 'nope',
    });
  });
});
