/**
 * Text helpers for webview HTML strings.
 *
 * @module webview/dashboard/text
 */

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * HTML for `text` with every case-insensitive match of `query` wrapped in
 * `<mark>`. The raw text is split first and each piece escaped, so a query
 * such as `q` or `gt` never lands inside an entity (`&quot;`, `&gt;`).
 */
export function highlightMatches(text: string | null | undefined, query: string): string {
  const raw = String(text ?? '');
  const needle = query.trim();
  if (!needle) return escapeHtml(raw);
  const pattern = new RegExp(`(${needle.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')})`, 'gi');
  return raw
    .split(pattern)
    .map((piece, index) =>
      index % 2 === 1 ? `<mark>${escapeHtml(piece)}</mark>` : escapeHtml(piece),
    )
    .join('');
}
