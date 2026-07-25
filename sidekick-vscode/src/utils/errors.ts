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
