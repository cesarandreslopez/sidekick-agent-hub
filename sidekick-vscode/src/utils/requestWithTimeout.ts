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
import { cancellationError } from './errors';

/**
 * Executes an async operation with timeout and abort signal support.
 *
 * Encapsulates the timeout/abort pattern shared across all inference clients:
 * - Checks for early abort before starting work
 * - Creates an internal AbortController with a timeout
 * - Links the external signal (if provided) to the internal controller
 * - Distinguishes timeout from user cancellation by its own signals, not by
 *   the error's name: the Anthropic SDKs' abort errors keep `name === 'Error'`
 *   (and a stream that just ends may throw something else entirely), so the
 *   error a client throws on abort can't be trusted to say what happened
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
    throw cancellationError();
  }

  const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT;
  const abortController = new AbortController();
  // A caller-provided signal (notably TimeoutManager) owns the deadline unless
  // an explicit inner timeout was requested. This prevents the 30s default
  // from silently capping longer context-aware operations.
  const useInternalTimeout = options?.timeout !== undefined || !options?.signal;
  let timedOut = false;
  const timeoutId = useInternalTimeout
    ? setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs)
    : undefined;

  // Link external signal to our internal abort controller
  let externalAbortHandler: (() => void) | undefined;
  if (options?.signal) {
    externalAbortHandler = () => abortController.abort();
    options.signal.addEventListener('abort', externalAbortHandler);
  }

  try {
    return await work(abortController.signal);
  } catch (error) {
    // Our signals say what happened; whatever the client threw does not.
    if (options?.signal?.aborted) {
      throw cancellationError();
    }
    if (timedOut) {
      throw new TimeoutError(`Request timed out after ${timeoutMs}ms`, timeoutMs);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalAbortHandler && options?.signal) {
      options.signal.removeEventListener('abort', externalAbortHandler);
    }
  }
}
