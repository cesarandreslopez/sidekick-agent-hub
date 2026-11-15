/**
 * @fileoverview Content Security Policy for the HTML session report webview.
 *
 * The shared report generator emits a few inline event handlers (`onclick`,
 * `onchange`) and `style=` attributes. Under a nonce-only policy VS Code's
 * webview blocked all of them, so the filter checkboxes, Expand/Collapse All,
 * Copy buttons and back-to-top did nothing and inline styles were dropped.
 *
 * The policy allows exactly the known handler strings by hash
 * (`'unsafe-hashes'`), never arbitrary inline script, and allows inline
 * `style=` attributes through `style-src-attr` while `<style>` blocks still
 * need the nonce.
 *
 * @module utils/reportCsp
 */

import { createHash } from 'crypto';

/**
 * The fixed inline handler strings the shared HTML report emits
 * (`sidekick-shared/src/report/htmlHelpers.ts` and `htmlReportGenerator.ts`).
 * Only these exact strings are allowed; transcript text is never hashed.
 */
export const REPORT_INLINE_HANDLERS = [
  'copyCode(this)',
  'filterMessages()',
  'toggleAllDetails(true)',
  'toggleAllDetails(false)',
  "window.scrollTo({top:0,behavior:'smooth'})",
] as const;

/** CSP source expression for the SHA-256 hash of a script or handler string. */
export function cspSha256(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

/**
 * Builds the report webview's Content-Security-Policy value.
 *
 * @param cspSource - The webview's `cspSource`
 * @param nonce - Nonce added to the report's `<style>` and `<script>` tags
 */
export function buildReportCsp(cspSource: string, nonce: string): string {
  const handlerHashes = REPORT_INLINE_HANDLERS.map(cspSha256).join(' ');
  return [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `script-src 'nonce-${nonce}' 'unsafe-hashes' ${handlerHashes}`,
    `img-src ${cspSource} data:`,
  ].join('; ');
}
