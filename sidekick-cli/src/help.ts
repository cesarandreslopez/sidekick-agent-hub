/**
 * Examples blocks appended to --help output via commander's addHelpText.
 * Must never import ./cli (it runs program.parse() at import time).
 */

export const ROOT_EXAMPLES = `
Examples:
  $ sidekick dashboard                      Live TUI dashboard for this project
  $ sidekick quota --all                    Quota for every detected provider
  $ sidekick quota history --weeks 8        Utilization heatmap for this workspace
  $ sidekick search "database migration"    Full-text search across sessions
  $ sidekick extract -i                     Interactive picker for URLs, paths, commands
  $ sidekick handoff                        Latest session handoff document
  $ sidekick history                        Recent prompts across Codex sessions
  $ sidekick dump --list                    List session IDs available for dumping
  $ sidekick tasks --status pending --json  Pending tasks as JSON (global --json works everywhere)
`;

export const QUOTA_EXAMPLES = `
Examples:
  $ sidekick quota                          Auto-detected provider utilization
  $ sidekick quota --all                    Claude, Codex, and z.ai side by side
  $ sidekick quota --provider zai           z.ai 5-hour and weekly windows
  $ sidekick quota history --weeks 8        Utilization heatmap for this workspace
`;

export const BLOCKS_EXAMPLES = `
Examples:
  $ sidekick blocks                         Five-hour blocks from the last three days
  $ sidekick blocks --active                Only the block that is open right now
  $ sidekick blocks --since 7d --csv        A week of blocks as CSV
  $ sidekick blocks --active --json         Burn rate and projection for scripts
`;

export const USAGE_REPORT_EXAMPLES = `
Examples:
  $ sidekick daily                          Last 30 days, one row per day and provider
  $ sidekick daily --breakdown              Per-model sub-rows under each day
  $ sidekick weekly --since 2026-06-01      Weeks (Monday start) since a date
  $ sidekick monthly --csv                  Twelve months as CSV
  $ sidekick sessions --since 7d --json     One row per session, for scripts
  $ sidekick --provider codex daily --utc   Codex only, keyed by UTC day
`;

export const EXTRACT_EXAMPLES = `
Examples:
  $ sidekick extract                        URLs, file paths, commands, and plans
  $ sidekick extract --type url,command     Only URLs and commands
  $ sidekick extract -i                     Interactive picker with copy/open actions
`;

export const DUMP_EXAMPLES = `
Examples:
  $ sidekick dump --list                    List session IDs for this project
  $ sidekick dump --list --limit 10         Only the ten most recent sessions
  $ sidekick dump --session <id>            Text timeline for a specific session
  $ sidekick dump --format markdown         Markdown report of the latest session
`;

export const HISTORY_EXAMPLES = `
Examples:
  $ sidekick history                        Recent prompts across Codex sessions
  $ sidekick history --limit 5              Only the five most recent prompts
  $ sidekick history --path 0198a3c2        Rollout transcript path for a session
  $ sidekick history --json                 Machine-readable prompt entries
`;
