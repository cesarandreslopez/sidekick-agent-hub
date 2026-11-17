/**
 * Error message extraction for user-facing surfaces.
 *
 * Interpolating an unknown value into a template produces
 * "Failed to open conversation: Error: ENOENT, open '/x'" — the word "Error"
 * twice and a stack-shaped string in a toast.
 *
 * @module errors
 */

/**
 * A human-readable message for any thrown value.
 *
 * Falls back for the cases that produce useless text on their own: an `Error`
 * with an empty message, a blank string, and non-error values whose `String()`
 * form is `[object Object]`.
 */
export function toErrorMessage(err: unknown, fallback = 'Unknown error'): string {
  if (err instanceof Error) return err.message.trim() || fallback;
  if (typeof err === 'string') return err.trim() || fallback;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}

/**
 * The error every cancelled AI request rejects with: toast Cancel, an aborted
 * external signal, or a declined timeout retry.
 *
 * Cancellation is identified by `name === 'AbortError'` (the convention the
 * services already use), never by class: the Anthropic SDKs' own abort errors
 * leave `name` as `'Error'`, and `vscode.CancellationError` is absent from the
 * hand-written vscode mocks the tests use.
 */
export function cancellationError(message = 'Request was cancelled'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/** True for an error produced by {@link cancellationError} or any `AbortError`-named error. */
export function isCancellationError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
