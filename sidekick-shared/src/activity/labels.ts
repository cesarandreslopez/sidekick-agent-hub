/**
 * Privacy-safe label helpers. Every label the activity map shows is built
 * here or from the fixed vocabulary: names, never content.
 *
 * Pure.
 *
 * @module activity/labels
 */

/** Strips control, bidi and zero-width characters, collapses spaces, trims, and cuts to `max` with `…`. */
export function cleanActivityLabel(_text: string, _max = 60): string {
  throw new Error('activity/labels: not implemented');
}

/** The last two non-empty parts of a path (`src/index.ts`), separators normalized. */
export function activityPathLabel(_path: string): string {
  throw new Error('activity/labels: not implemented');
}

/** The host of a URL only (at most 40 characters), else its scheme, else `''`; never userinfo, path or query. */
export function activityHostLabel(_url: string): string {
  throw new Error('activity/labels: not implemented');
}
