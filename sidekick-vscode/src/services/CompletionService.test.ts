import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) =>
        ({
          debounceMs: 10_000,
          inlineContextLines: 30,
          multiline: false,
          inlineModel: 'auto',
          timeoutPerKb: 500,
          maxTimeout: 120_000,
        })[key],
    }),
  },
  window: {},
  Position: class {},
  Range: class {},
}));
vi.mock('./Logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { CompletionService } from './CompletionService';

function token(cancelled: boolean) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: vi.fn(),
  };
}

describe('CompletionService debounce lifecycle', () => {
  it('resolves superseded and disposed debounce waits promptly', async () => {
    const service = new CompletionService({
      getProviderId: () => 'codex',
      complete: vi.fn(),
    } as never);
    const document = { languageId: 'typescript' };
    const position = {};

    const first = service.getCompletion(
      document as never,
      position as never,
      token(false) as never,
    );
    await Promise.resolve();
    const second = service.getCompletion(
      document as never,
      position as never,
      token(true) as never,
    );

    await expect(first).resolves.toBeUndefined();
    service.dispose();
    await expect(second).resolves.toBeUndefined();
  });
});

afterEach(() => vi.useRealTimers());

function cancellableToken() {
  let listener: () => void = () => {};
  const dispose = vi.fn();
  const value = {
    isCancellationRequested: false,
    onCancellationRequested: (callback: () => void) => {
      listener = callback;
      return { dispose };
    },
  };
  return {
    value,
    dispose,
    cancel: () => {
      value.isCancellationRequested = true;
      listener();
    },
  };
}

const document = {
  languageId: 'typescript',
  fileName: '/project/example.ts',
  lineCount: 1,
  getText: () => 'const answer = ',
  lineAt: () => ({ text: 'const answer = ' }),
};

it('passes cancellation to inference and releases its listener', async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  let signal!: AbortSignal;
  const service = new CompletionService({
    getProviderId: () => 'codex',
    complete: (_prompt: string, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
  } as never);
  const cancellation = cancellableToken();
  const result = service.getCompletion(
    document as never,
    { line: 0, character: 15 } as never,
    cancellation.value as never,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(signal.aborted).toBe(false);
  cancellation.cancel();
  expect(signal.aborted).toBe(true);
  finish('42;');
  await expect(result).resolves.toBeUndefined();
  expect(cancellation.dispose).toHaveBeenCalledOnce();
  service.dispose();
});

it('keeps an old cancellation callback from aborting a newer completion', async () => {
  vi.useFakeTimers();
  const calls: Array<{ signal: AbortSignal; finish: (value: string) => void }> = [];
  const service = new CompletionService({
    getProviderId: () => 'codex',
    complete: (_prompt: string, options: { signal: AbortSignal }) =>
      new Promise<string>((finish) => {
        calls.push({ signal: options.signal, finish });
      }),
  } as never);
  const oldToken = cancellableToken();
  const newToken = cancellableToken();
  const first = service.getCompletion(
    document as never,
    { line: 0, character: 15 } as never,
    oldToken.value as never,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  const second = service.getCompletion(
    document as never,
    { line: 0, character: 15 } as never,
    newToken.value as never,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  expect(calls[0].signal.aborted).toBe(true);
  oldToken.cancel();
  expect(calls[1].signal.aborted).toBe(false);
  calls[0].finish('old');
  await expect(first).resolves.toBeUndefined();
  service.cancelPending();
  expect(calls[1].signal.aborted).toBe(true);
  calls[1].finish('new');
  await expect(second).resolves.toBeUndefined();
  expect(oldToken.dispose).toHaveBeenCalledOnce();
  expect(newToken.dispose).toHaveBeenCalledOnce();
  service.dispose();
});

it('cancels a debounced completion before it reaches inference', async () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  const service = new CompletionService({ getProviderId: () => 'codex', complete } as never);
  const result = service.getCompletion(document as never, {} as never, token(false) as never);
  service.cancelPending();
  await expect(result).resolves.toBeUndefined();
  expect(complete).not.toHaveBeenCalled();
  service.dispose();
});
