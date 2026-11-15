/**
 * @fileoverview User-facing timeout formatting.
 * @module utils/formatTimeout
 */

/**
 * Formats a timeout for messages, e.g. `60s` rather than `60000ms`.
 */
export function formatTimeoutSeconds(timeoutMs: number): string {
  return `${Math.max(1, Math.round(timeoutMs / 1000))}s`;
}
