/**
 * Choice-validated Option factories shared by cli.ts.
 * Invalid values fail at parse time with commander's invalid-choice error
 * instead of being silently coerced to a default. Must never import ./cli
 * (it runs program.parse() at import time).
 */

import { Option } from 'commander';

/** The session providers a reading command accepts for `--provider`. */
export const SESSION_PROVIDER_CHOICES = ['claude-code', 'opencode', 'codex', 'auto'] as const;
export type SessionProviderChoice = (typeof SESSION_PROVIDER_CHOICES)[number];

/**
 * Every `--provider` value some command accepts: the session providers, plus
 * `zai` (quota), the `claude` / `z.ai` aliases (quota history), and `all`
 * (accounts). Commander parses the root option wherever it appears on the
 * line, so a subcommand's own `--provider` choices are never consulted; the
 * root list has to admit them all, and each command then checks the value it
 * received (`sessionProviderChoice()` for the session readers).
 */
export const ROOT_PROVIDER_CHOICES = [
  ...SESSION_PROVIDER_CHOICES,
  'zai',
  'z.ai',
  'claude',
  'all',
] as const;

/** Root provider option; the per-command checks narrow it. */
export function rootProviderOption(): Option {
  return new Option(
    '--provider <id>',
    'Session provider: claude-code, opencode, codex, or auto (default); quota, quota history, and accounts accept more',
  ).choices([...ROOT_PROVIDER_CHOICES]);
}

/**
 * The session provider a reading command was given, or a thrown error naming
 * the accepted values when it was given one only another command accepts
 * (`zai`, `all`, …). `undefined` and `auto` mean "detect".
 */
export function sessionProviderChoice(value: unknown): SessionProviderChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value === 'string' &&
    (SESSION_PROVIDER_CHOICES as readonly string[]).includes(value)
  ) {
    return value as SessionProviderChoice;
  }
  throw new Error(
    `--provider ${String(value)} is not a session provider for this command. Use claude-code, opencode, codex, or auto.`,
  );
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
    "Label detail: names, descriptive (adds the agent's short descriptions), or none (default: descriptive for text and --follow, names for SVG and JSON)",
  ).choices(['names', 'descriptive', 'none']);
}

export function tasksStatusOption(): Option {
  return new Option('--status <status>', 'Filter by status (default: all)').choices([
    'pending',
    'completed',
    'all',
  ]);
}
