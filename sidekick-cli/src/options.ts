/**
 * Choice-validated Option factories shared by cli.ts.
 * Invalid values fail at parse time with commander's invalid-choice error
 * instead of being silently coerced to a default. Must never import ./cli
 * (it runs program.parse() at import time).
 */

import { Option } from 'commander';

/** Root/session provider: which CLI agent's sessions to read. */
export function rootProviderOption(): Option {
  return new Option('--provider <id>', 'Session provider (default: auto)').choices([
    'claude-code',
    'opencode',
    'codex',
    'auto',
  ]);
}

/** Quota provider: adds zai, which is quota-only. */
export function quotaProviderOption(): Option {
  return new Option('--provider <id>', 'Provider to inspect (default: auto)').choices([
    'claude-code',
    'opencode',
    'codex',
    'zai',
    'auto',
  ]);
}

/** Quota-history runtime provider filter; accepts legacy aliases. */
export function quotaHistoryProviderOption(): Option {
  return new Option(
    '--provider <id>',
    'Limit to a single runtime provider: claude, codex, zai (default: all)',
  ).choices(['claude', 'claude-code', 'codex', 'zai', 'z.ai']);
}

export function reportThemeOption(): Option {
  return new Option('--theme <theme>', 'Color theme').default('dark').choices(['dark', 'light']);
}

/** `sidekick map --format`: text (default), an SVG image, or JSON. */
export function mapFormatOption(): Option {
  return new Option('--format <format>', 'Output format (default: text)').choices([
    'text',
    'svg',
    'json',
  ]);
}

/** `sidekick map --theme`: SVG colors; auto follows the viewer's light or dark setting. */
export function mapThemeOption(): Option {
  return new Option('--theme <theme>', 'SVG colors (default: auto)').choices([
    'auto',
    'dark',
    'light',
  ]);
}

/** `sidekick map --motion`: SVG animation; none draws one still frame. */
export function mapMotionOption(): Option {
  return new Option('--motion <motion>', 'SVG animation (default: none)').choices([
    'none',
    'reduced',
    'full',
  ]);
}

/** `sidekick map --labels`: how much a label may say. */
export function mapLabelsOption(): Option {
  return new Option(
    '--labels <mode>',
    "Label detail: names, descriptive (adds the agent's short descriptions), or none (default: descriptive for text, names for files)",
  ).choices(['names', 'descriptive', 'none']);
}

export function tasksStatusOption(): Option {
  return new Option('--status <status>', 'Filter by status (default: all)').choices([
    'pending',
    'completed',
    'all',
  ]);
}
