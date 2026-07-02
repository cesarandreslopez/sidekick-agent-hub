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

export const EXTRACT_EXAMPLES = `
Examples:
  $ sidekick extract                        URLs, file paths, commands, and plans
  $ sidekick extract --type url,command     Only URLs and commands
  $ sidekick extract -i                     Interactive picker with copy/open actions
`;

export const DUMP_EXAMPLES = `
Examples:
  $ sidekick dump --list                    List session IDs for this project
  $ sidekick dump --session <id>            Text timeline for a specific session
  $ sidekick dump --format markdown         Markdown report of the latest session
`;
