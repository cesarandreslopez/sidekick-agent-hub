/**
 * JSON that is safe to embed in an HTML `<script type="application/json">`
 * block: `<` and `>` cannot close the element or open a comment, and the
 * line and paragraph separators cannot break a string.
 *
 * @module utils/safeJson
 */

export function safeJsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c') // Prevents </script> breaking HTML parser
    .replace(/>/g, '\\u003e') // Prevents --> breaking HTML comments
    .replace(/\u2028/g, '\\u2028') // Line separator (breaks JS strings)
    .replace(/\u2029/g, '\\u2029'); // Paragraph separator (breaks JS strings)
}
