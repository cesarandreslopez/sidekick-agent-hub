/**
 * Privacy-safe label helpers. Every label the activity map shows is built
 * here or from the fixed vocabulary: names, never content.
 *
 * - A file: the last two parts of its path.
 * - A web address: its host alone, never a login, password, path or query;
 *   an address that reads two ways gives its scheme only.
 * - Anything else: an identifier that matches a strict pattern, or nothing.
 *
 * Control, bidi and zero-width characters are removed from every label, so
 * a terminal or a page never acts on them.
 *
 * Pure.
 *
 * @module activity/labels
 */

// C0 and C1 controls, bidi marks and isolates, zero-width characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]+/g;

/** Strips control, bidi and zero-width characters, collapses spaces, trims, and cuts to `max` with `…`. */
export function cleanActivityLabel(text: string, max = 60): string {
  if (typeof text !== 'string') return '';
  const clean = text
    .replace(UNSAFE_CHARS, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (max <= 0) return '';
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : clean;
}

/** The last two non-empty parts of a path (`src/index.ts`), separators normalized. */
export function activityPathLabel(path: string): string {
  if (typeof path !== 'string' || !path) return '';
  const normalized = path
    .replace(/^file:\/\/+/i, '/')
    .replace(/\\/g, '/')
    .replace(/^[A-Za-z]:(?=\/)/, '');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  return cleanActivityLabel(parts.slice(-2).join('/'), 80);
}

const HOST = /^(?:[\p{L}\p{N}.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/iu;

/**
 * The host of a URL only (at most 40 characters), else its scheme, else `''`;
 * never userinfo, path or query.
 *
 * A password may hold `/`, `?` or `#` unencoded, so the first of them is not
 * always where the host ends: `user:pa/ss@host` reads as the host `host`, and
 * an address that can be read both ways gives its scheme alone.
 */
export function activityHostLabel(url: string): string {
  if (typeof url !== 'string' || !url) return '';
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(.*)$/is.exec(url.trim());
  const scheme = match?.[1] ?? '';
  const rest = match?.[2] ?? '';
  const end = rest.search(/[/?#]/);
  const first = end < 0 ? rest : rest.slice(0, end);
  const beyond = end < 0 ? '' : rest.slice(end);
  let host = first.split('@').pop() ?? '';
  if (!first.includes('@') && first.includes(':') && beyond.includes('@')) {
    // `name:word` before an `@` further on: a port if the word is a number,
    // or else a login and a password.
    host = /:\d+$/.test(first)
      ? ''
      : (rest.slice(rest.lastIndexOf('@') + 1).split(/[/?#]/)[0] ?? '');
  }
  if (host && HOST.test(host)) return cleanActivityLabel(host.slice(0, 40), 40);
  return /^[a-z][a-z0-9+.-]{0,15}$/i.test(scheme) ? scheme.toLowerCase() : '';
}

/**
 * `value` when it is a short identifier (letters, digits and `_ : . @ / -`),
 * else `undefined`: a longer or freer string could be content.
 */
export function identifierLabel(value: unknown, pattern = /^[\w:.@/-]{1,64}$/): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : undefined;
}

/** A tool or MCP name made readable: underscores become spaces, cleaned and short. */
export function readableName(name: string, max = 40): string {
  return cleanActivityLabel(name.replace(/_+/g, ' '), max);
}
