/**
 * Keyword-based semantic syntax highlighting for session event text.
 *
 * Applies cascading word-by-word colorization based on keyword categories:
 * errors=red, success=green, warnings=yellow, actions=cyan, numbers=blue,
 * URLs/paths=magenta, HTTP status codes and methods colored by semantics.
 *
 * Supports blessed (CLI), ANSI (terminal), and HTML (VS Code webview) output formats.
 *
 * @module formatters/eventHighlighter
 */

export type HighlightFormat = 'blessed' | 'ansi' | 'html';

// ── Color definitions per format ──

interface ColorSet {
  red: [string, string];
  green: [string, string];
  yellow: [string, string];
  cyan: [string, string];
  blue: [string, string];
  magenta: [string, string];
  grey: [string, string];
  white: [string, string];
}

const BLESSED_COLORS: ColorSet = {
  red: ['{red-fg}', '{/red-fg}'],
  green: ['{green-fg}', '{/green-fg}'],
  yellow: ['{yellow-fg}', '{/yellow-fg}'],
  cyan: ['{cyan-fg}', '{/cyan-fg}'],
  blue: ['{blue-fg}', '{/blue-fg}'],
  magenta: ['{magenta-fg}', '{/magenta-fg}'],
  grey: ['{grey-fg}', '{/grey-fg}'],
  white: ['{white-fg}', '{/white-fg}'],
};

const ANSI_COLORS: ColorSet = {
  red: ['\x1b[31m', '\x1b[0m'],
  green: ['\x1b[32m', '\x1b[0m'],
  yellow: ['\x1b[33m', '\x1b[0m'],
  cyan: ['\x1b[36m', '\x1b[0m'],
  blue: ['\x1b[34m', '\x1b[0m'],
  magenta: ['\x1b[35m', '\x1b[0m'],
  grey: ['\x1b[90m', '\x1b[0m'],
  white: ['\x1b[37m', '\x1b[0m'],
};

const HTML_COLORS: ColorSet = {
  red: ['<span class="sk-hl-error">', '</span>'],
  green: ['<span class="sk-hl-success">', '</span>'],
  yellow: ['<span class="sk-hl-warning">', '</span>'],
  cyan: ['<span class="sk-hl-action">', '</span>'],
  blue: ['<span class="sk-hl-number">', '</span>'],
  magenta: ['<span class="sk-hl-path">', '</span>'],
  grey: ['<span class="sk-hl-muted">', '</span>'],
  white: ['<span class="sk-hl-default">', '</span>'],
};

function getColors(format: HighlightFormat): ColorSet {
  switch (format) {
    case 'blessed': return BLESSED_COLORS;
    case 'ansi': return ANSI_COLORS;
    case 'html': return HTML_COLORS;
  }
}

// ── Keyword categories ──

type ColorName = keyof ColorSet;

const ERROR_KEYWORDS = new Set([
  'error', 'errors', 'err', 'fail', 'failed', 'failure', 'failures',
  'fatal', 'panic', 'crash', 'crashed', 'exception', 'exceptions',
  'critical', 'alert', 'abort', 'aborted', 'denied', 'forbidden',
  'rejected', 'invalid', 'illegal', 'corrupt', 'corrupted',
  'broken', 'bug', 'segfault', 'timeout', 'timedout', 'timed-out',
  'deadlock', 'overflow', 'underflow', 'null', 'undefined', 'nan',
  'unhandled', 'uncaught', 'unreachable', 'missing', 'notfound',
  'not-found', 'unavailable', 'disconnected', 'dropped',
]);

const SUCCESS_KEYWORDS = new Set([
  'success', 'successful', 'succeeded', 'ok', 'done', 'complete',
  'completed', 'passed', 'pass', 'resolved', 'fixed', 'ready',
  'active', 'running', 'started', 'created', 'connected',
  'established', 'accepted', 'approved', 'merged', 'deployed',
  'installed', 'loaded', 'enabled', 'healthy', 'valid', 'verified',
]);

const WARNING_KEYWORDS = new Set([
  'warn', 'warning', 'warnings', 'caution', 'deprecated',
  'slow', 'retry', 'retrying', 'retries', 'pending', 'waiting',
  'queued', 'stale', 'expired', 'expiring', 'limited',
  'throttled', 'throttling', 'degraded', 'unstable', 'flaky',
  'skipped', 'skip', 'ignored', 'unknown', 'unrecognized',
]);

const ACTION_KEYWORDS = new Set([
  'read', 'write', 'edit', 'delete', 'create', 'update', 'insert',
  'remove', 'add', 'modify', 'patch', 'merge', 'push', 'pull',
  'fetch', 'send', 'receive', 'request', 'response', 'query',
  'search', 'find', 'list', 'get', 'set', 'put', 'post',
  'build', 'compile', 'test', 'deploy', 'install', 'run',
  'execute', 'start', 'stop', 'restart', 'init', 'initialize',
  'configure', 'spawn', 'call', 'invoke',
]);

const HTTP_METHODS = new Map<string, ColorName>([
  ['GET', 'green'],
  ['HEAD', 'green'],
  ['OPTIONS', 'green'],
  ['POST', 'yellow'],
  ['PUT', 'yellow'],
  ['PATCH', 'yellow'],
  ['DELETE', 'red'],
]);

// ── Patterns ──

const NUMBER_PATTERN = /^-?\d+(\.\d+)?(%|ms|s|m|h|d|k|K|M|G|T|B)?$/;
const PATH_PATTERN = /^[.~]?\/[\w./-]+|^[\w-]+\/[\w./-]+|^[\w-]+\.[\w.]+$/;
const URL_PATTERN = /^https?:\/\//;

/**
 * Classify an HTTP status code by color.
 * Returns null if the word is not a status code.
 */
function httpStatusColor(word: string): ColorName | null {
  if (!/^\d{3}$/.test(word)) return null;
  const code = parseInt(word, 10);
  if (code >= 200 && code < 300) return 'green';
  if (code >= 300 && code < 400) return 'yellow';
  if (code >= 400) return 'red';
  return null;
}

/**
 * Determine the color for a single word based on keyword categories.
 * Priority: errors > warnings > success > HTTP > actions > paths > numbers
 */
function classifyWord(word: string): ColorName | null {
  const lower = word.toLowerCase();

  // Strip common punctuation for keyword matching
  const stripped = lower.replace(/[.,;:!?()\[\]{}'"]+$/g, '').replace(/^['"([\]{}]+/, '');

  if (ERROR_KEYWORDS.has(stripped)) return 'red';
  if (WARNING_KEYWORDS.has(stripped)) return 'yellow';
  if (SUCCESS_KEYWORDS.has(stripped)) return 'green';

  // HTTP methods
  const httpMethod = HTTP_METHODS.get(word.toUpperCase());
  if (httpMethod) return httpMethod;

  // HTTP status codes
  const statusColor = httpStatusColor(stripped);
  if (statusColor) return statusColor;

  if (ACTION_KEYWORDS.has(stripped)) return 'cyan';

  // Paths and URLs
  if (URL_PATTERN.test(word) || PATH_PATTERN.test(word)) return 'magenta';

  // Numbers
  if (NUMBER_PATTERN.test(stripped)) return 'blue';

  return null;
}

// ── LRU cache for highlighted results ──

const CACHE_MAX = 500;
const highlightCache = new Map<string, string>();

function cacheKey(text: string, format: HighlightFormat): string {
  return `${format}:${text}`;
}

/**
 * Apply keyword-based semantic highlighting to text.
 *
 * Splits text on whitespace and colors each word based on keyword category.
 * Words not matching any category pass through uncolored.
 *
 * @param text - The text to highlight.
 * @param format - Output format: 'blessed' (CLI), 'ansi' (terminal), or 'html' (webview).
 * @returns The highlighted text with format-appropriate tags.
 */
export function highlight(text: string, format: HighlightFormat): string {
  if (!text) return text;

  const key = cacheKey(text, format);
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;

  const colors = getColors(format);
  const words = text.split(/(\s+)/); // Split preserving whitespace
  const parts: string[] = [];

  for (const segment of words) {
    // Preserve whitespace segments as-is
    if (/^\s+$/.test(segment)) {
      parts.push(segment);
      continue;
    }

    const color = classifyWord(segment);
    if (color) {
      const [open, close] = colors[color];
      parts.push(`${open}${segment}${close}`);
    } else {
      parts.push(segment);
    }
  }

  const result = parts.join('');

  // LRU cache: evict oldest if full
  if (highlightCache.size >= CACHE_MAX) {
    const first = highlightCache.keys().next().value;
    if (first !== undefined) highlightCache.delete(first);
  }
  highlightCache.set(key, result);

  return result;
}

/**
 * CSS class definitions for HTML highlight format.
 * Include this in webview stylesheets.
 */
export const HIGHLIGHT_CSS = `
.sk-hl-error { color: var(--vscode-charts-red, #f44747); }
.sk-hl-success { color: var(--vscode-charts-green, #89d185); }
.sk-hl-warning { color: var(--vscode-charts-yellow, #cca700); }
.sk-hl-action { color: var(--vscode-charts-blue, #4fc1ff); }
.sk-hl-number { color: var(--vscode-charts-purple, #b180d7); }
.sk-hl-path { color: var(--vscode-charts-orange, #cca700); }
.sk-hl-muted { opacity: 0.6; }
.sk-hl-default { }
.sk-search-match { background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33)); }
`;

/** Clear the highlight cache (for testing or memory pressure). */
export function clearHighlightCache(): void {
  highlightCache.clear();
}
