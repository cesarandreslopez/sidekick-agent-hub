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
    `--provider ${String(value)} is not a session provider for this command. Use ${listChoices(SESSION_PROVIDER_CHOICES)}.`,
  );
}

/** `a, b, c, or d`. */
export function listChoices(values: readonly string[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`;
}

/** Providers `sidekick quota` reports on: the session providers plus quota-only zai. */
export const QUOTA_PROVIDER_CHOICES = ['claude-code', 'opencode', 'codex', 'zai', 'auto'] as const;

/** The value `sidekick quota --provider` was given, or an error naming what it accepts. */
export function quotaProviderChoice(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && (QUOTA_PROVIDER_CHOICES as readonly string[]).includes(value)) {
    return value;
  }
  throw new Error(
    `--provider ${String(value)} is not a quota provider. Use ${listChoices(QUOTA_PROVIDER_CHOICES)}${value === 'all' ? ', or --all for every provider' : ' (--all shows every provider)'}.`,
  );
}

/** `sidekick peak --provider`: session providers only (help text; the root option parses it). */
export function sessionProviderOption(): Option {
  return new Option(
    '--provider <id>',
    `Session provider: ${listChoices(SESSION_PROVIDER_CHOICES)} (default: auto)`,
  ).choices([...SESSION_PROVIDER_CHOICES]);
}

/** Quota provider: adds zai, which is quota-only. */
export function quotaProviderOption(): Option {
  return new Option('--provider <id>', 'Provider to inspect (default: auto)').choices([
    ...QUOTA_PROVIDER_CHOICES,
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
    'in_progress',
    'completed',
    'all',
  ]);
}

/** `sidekick context --fidelity`. */
export function contextFidelityOption(): Option {
  return new Option('--fidelity <level>', 'Detail level')
    .choices(['full', 'compact', 'brief'])
    .default('full');
}

export const NOTE_TYPES = ['gotcha', 'pattern', 'guideline', 'tip'] as const;
export const NOTE_IMPORTANCE = ['critical', 'high', 'medium', 'low'] as const;
export const NOTE_STATUSES = ['active', 'needs_review', 'stale', 'obsolete'] as const;

/** Knowledge-note type, for filtering (`notes`) or for a new note (`note add`, default tip). */
export function noteTypeOption(defaultValue?: string): Option {
  const option = new Option('--type <type>', defaultValue ? 'Note type' : 'Filter by type').choices(
    [...NOTE_TYPES],
  );
  return defaultValue ? option.default(defaultValue) : option;
}

export function noteImportanceOption(): Option {
  return new Option('--importance <level>', 'How much the note matters')
    .choices([...NOTE_IMPORTANCE])
    .default('medium');
}

export function noteStatusOption(): Option {
  return new Option('--status <status>', 'Filter by status').choices([...NOTE_STATUSES]);
}

/** `sidekick dump --format`; jsonl is only valid with --prompts (checked by the command). */
export function dumpFormatOption(): Option {
  return new Option(
    '--format <fmt>',
    'Output format (default: text); jsonl only with --prompts',
  ).choices(['text', 'json', 'markdown', 'jsonl']);
}
