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
});
