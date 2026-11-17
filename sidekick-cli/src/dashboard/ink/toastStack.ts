/**
 * Toast visibility and layout.
 *
 * The dashboard held every live toast in state but rendered only the last one,
 * so a burst — a quota alert landing next to a context compaction — showed one
 * message and silently dropped the rest.
 */

import { wrapPlainTextLimited } from '../plainWrap';

export interface ToastLike {
  id: number;
}

/** How many toasts stack before older ones are hidden. */
export const MAX_VISIBLE_TOASTS = 3;

/** Rows of message text a toast may take before it is cut with an ellipsis. */
export const TOAST_MAX_ROWS = 3;

/**
 * The newest `max` toasts, oldest first, so rendering order matches stacking
 * order and a new toast appears below its predecessors rather than shifting
 * them.
 */
export function visibleToasts<T extends ToastLike>(
  toasts: readonly T[],
  max: number = MAX_VISIBLE_TOASTS,
): T[] {
  if (max <= 0) return [];
  return toasts.slice(Math.max(0, toasts.length - max));
}

/** Columns a toast's message may use on a `columns`-wide terminal. */
export function toastMessageWidth(columns: number): number {
  return Math.max(16, Math.min(56, columns - 10));
}

/** A toast's message wrapped into its rows (at most `TOAST_MAX_ROWS`). */
export function toastLines(message: string, columns: number): string[] {
  return wrapPlainTextLimited(message, toastMessageWidth(columns), TOAST_MAX_ROWS);
}

/**
 * The top row of each toast in a stack: each one sits below the previous
 * one's height (its rows plus two border rows), so a wrapped toast never
 * overlaps the next.
 */
export function toastOffsets(messages: readonly string[], columns: number): number[] {
  const offsets: number[] = [];
  let top = 0;
  for (const message of messages) {
    offsets.push(top);
    top += toastLines(message, columns).length + 2;
  }
  return offsets;
}

/** How long a toast stays up, unless the notice asks for longer. */
export const TOAST_DURATIONS_MS = { error: 4000, warning: 3000, info: 2000 } as const;
