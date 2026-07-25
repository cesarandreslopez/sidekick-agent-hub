/**
 * Toast visibility.
 *
 * The dashboard held every live toast in state but rendered only the last one,
 * so a burst — a quota alert landing next to a context compaction — showed one
 * message and silently dropped the rest.
 */

export interface ToastLike {
  id: number;
}

/** How many toasts stack before older ones are hidden. */
export const MAX_VISIBLE_TOASTS = 3;

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
