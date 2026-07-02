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

export function tasksStatusOption(): Option {
  return new Option('--status <status>', 'Filter by status (default: all)').choices([
    'pending',
    'completed',
    'all',
  ]);
}

export function zaiTierOption(): Option {
  return new Option('--tier <id>', 'z.ai plan tier')
    .default('auto')
    .choices(['lite', 'pro', 'max', 'auto']);
}
