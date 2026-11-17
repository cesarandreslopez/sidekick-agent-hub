/**
 * Words and numbers the one-shot commands print, in one place so `tasks`,
 * `today`, `context` and `notes` say the same thing.
 */

/** Task statuses as people read them ("In Progress", never `in_progress`). */
export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  deleted: 'Deleted',
};

export const NOTE_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  needs_review: 'Needs review',
  stale: 'Stale',
  obsolete: 'Obsolete',
};

/**
 * A table entry for a value read from a store file, or `undefined`. Only the
 * table's own keys count: `constructor` must not come back as a function.
 */
export function ownEntry<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

export function taskStatusLabel(status: string): string {
  return ownEntry(TASK_STATUS_LABELS, status) ?? status;
}

export function noteStatusLabel(status: string): string {
  return ownEntry(NOTE_STATUS_LABELS, status) ?? status;
}

/**
 * Stores written by older versions hold `[nested value omitted]` where a
 * bounded tool input dropped an AskUserQuestion option; it is not a choice.
 */
export function isOmittedPlaceholder(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('[nested value');
}

/** The real alternatives of a decision, without placeholders. */
export function decisionAlternatives(alternatives: readonly unknown[] | undefined): string[] {
  return (alternatives ?? []).filter(
    (value): value is string =>
      typeof value === 'string' && value.trim() !== '' && !isOmittedPlaceholder(value),
  );
}

/** A count with thousands separators, the same in every locale (`1,494,051`). */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** `1 call`, `2 calls`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}
