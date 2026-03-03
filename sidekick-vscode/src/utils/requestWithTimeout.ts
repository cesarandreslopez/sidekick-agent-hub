/**
 * @fileoverview Shared timeout and abort handling for inference clients.
 *
 * Provides a unified wrapper that handles:
 * - Early abort detection
 * - Internal AbortController for timeout
 * - External signal linking
 * - Timeout vs user-cancellation distinction
 * - Proper cleanup in all code paths
 *
 * @module utils/requestWithTimeout
 */

import { CompletionOptions, TimeoutError } from '../types';
import { DEFAULT_REQUEST_TIMEOUT } from '../constants';

/**
 * Executes an async operation with timeout and abort signal support.
 *
 * Encapsulates the timeout/abort pattern shared across all inference clients:
 * - Checks for early abort before starting work
 * - Creates an internal AbortController with a timeout
 * - Links the external signal (if provided) to the internal controller
 * - Distinguishes between timeout and user cancellation on AbortError
 * - Cleans up all listeners in a finally block
 *
 * @param options - Completion options containing timeout and signal
 * @param work - The async operation to execute, receives the internal AbortSignal
 * @returns The result of the work function
 * @throws TimeoutError if the timeout fires before work completes
 * @throws Error with name 'AbortError' if the external signal aborts
 */
export async function requestWithTimeout<T>(
  options: CompletionOptions | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  // Early abort check
  if (options?.signal?.aborted) {
    const err = new Error('Request was cancelled');
    err.name = 'AbortError';
    throw err;
  }

  const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);

  // Link external signal to our internal abort controller
  let externalAbortHandler: (() => void) | undefined;
  if (options?.signal) {
    externalAbortHandler = () => abortController.abort();
    options.signal.addEventListener('abort', externalAbortHandler);
  }

  try {
    return await work(abortController.signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (options?.signal?.aborted) {
        const abortError = new Error('Request was cancelled');
        abortError.name = 'AbortError';
        throw abortError;
      }
      throw new TimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalAbortHandler && options?.signal) {
      options.signal.removeEventListener('abort', externalAbortHandler);
    }
  }
}
