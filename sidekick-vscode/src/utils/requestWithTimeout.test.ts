import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError } from '../types';
import { requestWithTimeout } from './requestWithTimeout';

function abortableWork(signal: AbortSignal): Promise<string> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      },
      { once: true },
    );
  });
}

describe('requestWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not apply the 30s default when an outer signal owns the deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = requestWithTimeout({ signal: controller.signal }, abortableWork);

    await vi.advanceTimersByTimeAsync(30_001);
    expect(controller.signal.aborted).toBe(false);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('still enforces an explicitly requested inner timeout', async () => {
    vi.useFakeTimers();
    const pending = requestWithTimeout({ timeout: 50 }, abortableWork);
    const rejection = expect(pending).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(50);

    await rejection;
  });

  // The Anthropic SDKs reject an aborted request with an error whose name is
  // plain 'Error', so the classification must come from our own signals.
  function sdkStyleWork(signal: AbortSignal): Promise<string> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error('Claude Code process aborted by user')),
        {
          once: true,
        },
      );
    });
  }

  it('reports a user cancel as AbortError even when the client throws a plain Error', async () => {
    const controller = new AbortController();
    const pending = requestWithTimeout({ signal: controller.signal }, sdkStyleWork);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Request was cancelled',
    });
  });

  it('reports its own deadline as TimeoutError even when the client throws a plain Error', async () => {
    vi.useFakeTimers();
    const pending = requestWithTimeout({ timeout: 50 }, sdkStyleWork);
    const rejection = expect(pending).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('passes a genuine failure through unchanged', async () => {
    const failure = new Error('rate limited');
    await expect(requestWithTimeout({}, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('does not turn an AbortError-named failure into a timeout when neither signal fired', async () => {
    const odd = new Error('stream aborted upstream');
    odd.name = 'AbortError';
    await expect(requestWithTimeout({}, () => Promise.reject(odd))).rejects.toBe(odd);
  });
});
