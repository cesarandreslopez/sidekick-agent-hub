/**
 * @fileoverview QuickPick ordering for "edit" flows.
 * @module utils/pickerOrder
 */

/**
 * Moves the item matching `current` to the top and marks it "(current)".
 *
 * A QuickPick preselects its first item, so in an edit flow Enter should keep
 * what the user already has rather than silently change it to whatever
 * happens to be listed first.
 */
export function currentFirst<T extends { value: string; label: string; description?: string }>(
  items: readonly T[],
  current: string | undefined,
): T[] {
  const index = items.findIndex((item) => item.value === current);
  if (index === -1) return [...items];
  const match = items[index];
  const marked = {
    ...match,
    description: match.description ? `(current) ${match.description}` : '(current)',
  };
  return [marked, ...items.slice(0, index), ...items.slice(index + 1)];
}
