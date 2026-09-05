declare const __CLI_VERSION__: string;

import { Command } from 'commander';
import {
  BLOCKS_EXAMPLES,
  DUMP_EXAMPLES,
  EXTRACT_EXAMPLES,
  IMPORT_EXAMPLES,
  USAGE_REPORT_EXAMPLES,
  HISTORY_EXAMPLES,
  QUOTA_EXAMPLES,
  ROOT_EXAMPLES,
} from './help';
import { firstCommandToken } from './argvScan';
import { runStartupSideEffects } from './startup';
import {
  quotaHistoryProviderOption,
  quotaProviderOption,
  reportThemeOption,
  rootProviderOption,
  tasksStatusOption,
} from './options';
import { detectProvider } from 'sidekick-shared';
import type { ProviderId, SessionProviderBase } from 'sidekick-shared';
import { ClaudeCodeProvider, OpenCodeProvider, CodexProvider } from 'sidekick-shared';
import { formatCliError } from './cliError';

const commandToken = firstCommandToken(process.argv.slice(2));

const program = new Command();

program
  .name('sidekick')
  .description('Query Sidekick project intelligence from the command line')
  .version(__CLI_VERSION__)
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path (default: cwd)')
  // Chalk already honors --no-color, NO_COLOR, and a non-TTY stdout on its own;
  // declaring it here only stops Commander rejecting the flag as unknown.
  .option('--no-color', 'Disable colored output (also honors NO_COLOR)')
  .option(
    '--offline',
    'Price from the cached catalog only; never refresh it over the network (also SIDEKICK_OFFLINE=1)',
  )
  .option('--output-file <path>', 'Write everything the command prints to stdout into this file')
  .addOption(rootProviderOption())
  .addHelpText('after', ROOT_EXAMPLES);

// preAction fires for real action handlers and not for --help, --version, or a
// bare invocation, so the network fetch and account bootstrap stay off those
// paths entirely.
program.hook('preAction', async () => {
  const outputFile = program.opts().outputFile as string | undefined;
  if (outputFile) {
    const { installOutputRedirect, REDIRECT_UNSUPPORTED_COMMANDS } =
      await import('./outputRedirect');
    if (commandToken && REDIRECT_UNSUPPORTED_COMMANDS.has(commandToken)) {
      process.stderr.write(`--output-file is ignored for '${commandToken}'.\n`);
    } else {
      installOutputRedirect(outputFile);
    }
  }
  return runStartupSideEffects(commandToken);
});

export function resolveProviderId(
  opts: { provider?: string },
  defaultProvider: ProviderId | 'auto' = 'auto',
): ProviderId {
  if (opts.provider && opts.provider !== 'auto') {
    return opts.provider as ProviderId;
  }
  if (defaultProvider !== 'auto') {
    return defaultProvider;
  }
  return detectProvider();
}

export function resolveProvider(opts: { provider?: string }): SessionProviderBase {
  const id = resolveProviderId(opts);
  switch (id) {
    case 'opencode':
      return new OpenCodeProvider();
    case 'codex':
      return new CodexProvider();
    case 'claude-code':
    default:
      return new ClaudeCodeProvider();
  }
}

// Dashboard command uses dynamic imports — lazy-load to avoid import at parse time
const dashCmd = new Command('dashboard')
  .description('Full-screen TUI dashboard with live session metrics')
  .option('--session <id>', 'Follow a specific session (default: most recent)')
  .option('--replay', 'Replay existing events before streaming new ones')
  .option('--no-mouse', 'Disable mouse capture so terminal text selection works (toggle with M)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { dashboardAction } = await import('./commands/dashboard');
    return dashboardAction(_opts, cmd);
  });
program.addCommand(dashCmd);

// Dump command — static session dump in text, JSON, or markdown format
const dumpCmd = new Command('dump')
  .description('Dump session data as text timeline, JSON metrics, or markdown report')
  .option('--list', 'List available session IDs for the current project')
  .option('--csv', 'With --list, print the session table as CSV')
  .option('--limit <n>', 'Maximum sessions listed with --list (default: 50)')
  .option('--session <id>', 'Target a specific session (default: most recent)')
  .option('--width <cols>', 'Terminal width for text output (default: auto-detect)')
  .option('--expand', 'Show all events including noise')
  .option('--format <fmt>', 'Output format: text, json, markdown (default: text)')
  .addHelpText('after', DUMP_EXAMPLES)
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { dumpAction } = await import('./commands/dump');
    return dumpAction(_opts, cmd);
  });
program.addCommand(dumpCmd);

// History command — recent user prompts across Codex sessions
const historyCmd = new Command('history')
  .description(
    'Show recent prompts across Codex sessions (prompt history — for the quota heatmap use `sidekick quota history`)',
  )
  .option('--limit <n>', 'Maximum prompts to show (default: 20)')
  .option('--path <sessionId>', 'Print the rollout transcript path for a session ID or prefix')
  .addHelpText('after', HISTORY_EXAMPLES)
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { historyAction } = await import('./commands/history');
    return historyAction(_opts, cmd);
  });
program.addCommand(historyCmd);

// Context command — composite project context (tasks + decisions + notes + handoff)
const ctxCmd = new Command('context')
  .description('Output composite project context: tasks, decisions, notes, and handoff')
  .option('--fidelity <level>', 'Detail level: full, compact, brief (default: full)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { contextAction } = await import('./commands/context');
    return contextAction(_opts, cmd);
  });
program.addCommand(ctxCmd);

// Report command — generate self-contained HTML session report
const reportCmd = new Command('report')
  .description('Generate a self-contained HTML session report and open in browser')
  .option('--session <id>', 'Target a specific session (default: most recent)')
  .option('--output <path>', 'Write report to a specific file path (default: temp file)')
  .option('--no-open', 'Do not auto-open the report in the browser')
  .addOption(reportThemeOption())
  .option('--no-thinking', 'Exclude thinking blocks from the transcript')
  .addHelpText(
    'after',
    '\nWith the global --json flag the report path is printed to stdout as {"path": ...}.\n',
  )
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { reportAction } = await import('./commands/report');
    return reportAction(_opts, cmd);
  });
program.addCommand(reportCmd);

// Search command — full-text search across sessions
const searchCmd = new Command('search')
  .description('Full-text search across all sessions')
  .argument('<query>', 'Search query string')
  .option('--limit <n>', 'Maximum number of results (default: 50)')
  .action(async (_query: string, _opts: Record<string, unknown>, cmd: Command) => {
    // Commander passes the argument as first param; store it in opts for the action handler
    cmd.opts().query = _query;
    const { searchAction } = await import('./commands/search');
    return searchAction(_opts, cmd);
  });
program.addCommand(searchCmd);

// Tasks command — list persisted tasks for the current project
const tasksCmd = new Command('tasks')
  .description('List persisted tasks for the current project')
  .addOption(tasksStatusOption())
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { tasksAction } = await import('./commands/tasks');
    return tasksAction(_opts, cmd);
  });
tasksCmd
  .command('add')
  .description('Add a task to the current project')
  .argument('<subject>', 'Task subject')
  .option('--description <text>', 'Longer task description')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (subject: string, _opts: Record<string, unknown>, cmd: Command) => {
    const { taskAddAction } = await import('./commands/capture');
    return taskAddAction(subject, cmd);
  });
tasksCmd
  .command('done')
  .description('Mark a task completed by ID or unique prefix')
  .argument('<id>', 'Task ID or unique prefix')
  .action(async (id: string, _opts: Record<string, unknown>, cmd: Command) => {
    const { taskDoneAction } = await import('./commands/capture');
    return taskDoneAction(id, cmd);
  });
program.addCommand(tasksCmd);

// Decisions command — list persisted decisions for the current project
const decisionsCmd = new Command('decisions')
  .description('List architectural decisions for the current project')
  .option('--search <query>', 'Filter decisions by keyword')
  .option('--limit <n>', 'Maximum number of decisions to show')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { decisionsAction } = await import('./commands/decisions');
    return decisionsAction(_opts, cmd);
  });
program.addCommand(decisionsCmd);

// Notes command — list knowledge notes for the current project
const notesCmd = new Command('notes')
  .description('List knowledge notes (gotchas, patterns, tips) for the current project')
  .option('--file <path>', 'Filter notes by file path')
  .option('--type <type>', 'Filter by type: gotcha, pattern, guideline, tip')
  .option('--status <status>', 'Filter by status: active, needs_review, stale, obsolete')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { notesAction } = await import('./commands/notes');
    return notesAction(_opts, cmd);
  });
program.addCommand(notesCmd);

const noteCmd = new Command('note').description('Capture project knowledge');
noteCmd
  .command('add')
  .description('Add a knowledge note')
  .argument('<content>', 'Note content')
  .option('--file <path>', 'Related project file', '.')
  .option('--title <title>', 'Short note title')
  .option('--type <type>', 'gotcha, pattern, guideline, or tip', 'tip')
  .option('--importance <level>', 'critical, high, medium, or low', 'medium')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (content: string, _opts: Record<string, unknown>, cmd: Command) => {
    const { noteAddAction } = await import('./commands/capture');
    return noteAddAction(content, cmd);
  });
program.addCommand(noteCmd);

const decisionCmd = new Command('decision').description('Capture architectural decisions');
decisionCmd
  .command('add')
  .description('Add a decision')
  .argument('<description>', 'What was decided')
  .option('--rationale <text>', 'Why this choice was made')
  .option('--chosen <text>', 'Chosen option')
  .option('--alternatives <items>', 'Comma-separated alternatives')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (description: string, _opts: Record<string, unknown>, cmd: Command) => {
    const { decisionAddAction } = await import('./commands/capture');
    return decisionAddAction(description, cmd);
  });
program.addCommand(decisionCmd);

const doctorCmd = new Command('doctor')
  .description('Diagnose project identity, sessions, accounts, providers, and dependencies')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { doctorAction } = await import('./commands/doctor');
    return doctorAction(_opts, cmd);
  });
program.addCommand(doctorCmd);

const todayCmd = new Command('today')
  .description('Show a cache-only daily brief for this project')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { todayAction } = await import('./commands/today');
    return todayAction(_opts, cmd);
  });
program.addCommand(todayCmd);

const mcpCmd = new Command('mcp')
  .description('Serve read-only Sidekick facts over MCP stdio')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { mcpAction } = await import('./commands/mcp');
    return mcpAction(_opts, cmd);
  });
program.addCommand(mcpCmd);

// Stats command — show historical stats summary
const statsCmd = new Command('stats')
  .description('Show historical usage stats (tokens, costs, models, tools)')
  .option('--csv', 'Print every recorded day as CSV (date, sessions, tokens, cost)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { statsAction } = await import('./commands/stats');
    return statsAction(_opts, cmd);
  });
program.addCommand(statsCmd);

// Blocks command — five-hour billing blocks from session logs
const blocksCmd = new Command('blocks')
  .description('Show five-hour billing blocks computed from session logs')
  .option('--active', 'Only the block that is open right now')
  .option('--recent', 'Blocks from the last three days (default)')
  .option(
    '--since <time>',
    'Blocks since an ISO date, YYYY-MM-DD, or a relative window such as 7d or 24h',
  )
  .option('--csv', 'Print blocks as CSV')
  .option('--no-cache', 'Re-read every session instead of using the usage cache')
  .addHelpText('after', BLOCKS_EXAMPLES)
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { blocksAction } = await import('./commands/blocks');
    return blocksAction(_opts, cmd);
  });
program.addCommand(blocksCmd);

// Usage reports — daily / weekly / monthly / sessions computed from session logs
function usageReportCommand(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .option(
      '--since <time>',
      'Start of the window: ISO date, YYYY-MM-DD, or a relative window such as 30d',
    )
    .option('--until <time>', 'End of the window (default: now)')
    .option('--breakdown', 'Add per-model sub-rows under every row')
    .option('--by-project', 'Group rows by project as well as provider')
    .option('--utc', 'Bucket by UTC calendar days instead of local days')
    .option('--csv', 'Print rows as CSV')
    .option('--no-cache', 'Re-read every session instead of using the usage cache')
    .addHelpText('after', USAGE_REPORT_EXAMPLES);
}
program.addCommand(
  usageReportCommand('daily', 'Daily usage from session logs (default: last 30 days)').action(
    async (_opts: Record<string, unknown>, cmd: Command) => {
      const { dailyAction } = await import('./commands/usageReports');
      return dailyAction(_opts, cmd);
    },
  ),
);
program.addCommand(
  usageReportCommand('weekly', 'Weekly usage from session logs (default: last 12 weeks)').action(
    async (_opts: Record<string, unknown>, cmd: Command) => {
      const { weeklyAction } = await import('./commands/usageReports');
      return weeklyAction(_opts, cmd);
    },
  ),
);
program.addCommand(
  usageReportCommand('monthly', 'Monthly usage from session logs (default: last 12 months)').action(
    async (_opts: Record<string, unknown>, cmd: Command) => {
      const { monthlyAction } = await import('./commands/usageReports');
      return monthlyAction(_opts, cmd);
    },
  ),
);
// Import command — fold finished sessions into historical-data.json
const importCmd = new Command('import')
  .description('Import finished sessions from every provider into the history store')
  .option(
    '--since <time>',
    'Only sessions modified after an ISO date, YYYY-MM-DD, or a relative window such as 30d',
  )
  .addHelpText('after', IMPORT_EXAMPLES)
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { importAction } = await import('./commands/import');
    return importAction(_opts, cmd);
  });
program.addCommand(importCmd);

program.addCommand(
  usageReportCommand(
    'sessions',
    'One row per session from session logs (default: last 30 days)',
  ).action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { sessionsAction } = await import('./commands/usageReports');
    return sessionsAction(_opts, cmd);
  }),
);

// Quota command — one-shot quota / rate-limit check
const quotaCmd = new Command('quota')
  .description('Show quota or rate-limit utilization (auto-detects provider)')
  .addOption(quotaProviderOption())
  .option('--all', 'Show all providers (Claude, Codex, z.ai if active)')
  .option(
    '--refresh',
    'Ask the provider API first instead of reusing a fresh local sample (status line, session logs, or cache)',
  )
  .addHelpText('after', QUOTA_EXAMPLES)
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { quotaAction } = await import('./commands/quota');
    return quotaAction(_opts, cmd);
  });

quotaCmd
  .command('history')
  .description('Render a 13-week heatmap of quota utilization for the current workspace')
  .option('--weeks <n>', 'Weeks of history to render (default: 13, clamped 1-26)', '13')
  .addOption(quotaHistoryProviderOption())
  .option('--workspace <path>', 'Workspace path used to derive the history scope (default: cwd)')
  .option(
    '--window <window>',
    'Which limit the heatmap shows: 5h (default), 7d, or max (the higher of the two)',
    '5h',
  )
  .option('--csv', 'Print the daily buckets as CSV instead of a heatmap')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { quotaHistoryAction } = await import('./commands/quotaHistory');
    return quotaHistoryAction(_opts, cmd);
  });

program.addCommand(quotaCmd);

// Status command — one-shot Claude API status check
const statusCmd = new Command('status')
  .description('Show API status (Claude and OpenAI)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { statusAction } = await import('./commands/status');
    return statusAction(_opts, cmd);
  });
program.addCommand(statusCmd);

const statuslineCmd = new Command('statusline')
  .description('Render the cache-only one-line agent status footer')
  .action(async () => {
    const { statuslineAction } = await import('./commands/statusline');
    return statuslineAction();
  });
program.addCommand(statuslineCmd);

// Peak command — one-shot Claude peak-hours check (promoclock.co)
const peakCmd = new Command('peak')
  .description('Show whether Claude is currently in peak hours (faster session-limit drain)')
  .addOption(rootProviderOption())
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { peakAction } = await import('./commands/peak');
    return peakAction(_opts, cmd);
  });
program.addCommand(peakCmd);

// Account command — manage Claude Max accounts
const accountCmd = new Command('account')
  .description('Manage saved accounts (list, add, switch, remove)')
  .option('--provider <id>', 'Provider: claude-code, codex, all, auto (default: claude-code)')
  .option('--add', 'Save the currently signed-in account')
  .option('--login', 'Sign in and save a new account')
  .option('--label <name>', 'Label for the account (required for Codex, optional for Claude)')
  .option('--switch', 'Switch to the next saved account')
  .option('--switch-to <identifier>', 'Switch to a specific account by email, label, or id')
  .option('--remove <identifier>', 'Remove a saved account by email, label, or id')
  .option('-y, --yes', 'Skip confirmation prompts for destructive actions')
  .option('--force', 'Alias for --yes')
  .option('--launcher <name>', 'Create a per-account launcher for the active account')
  .option('--auto-switch <pct|off>', 'Persist auto-switch quota threshold, or off')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { accountAction } = await import('./commands/account');
    return accountAction(_opts, cmd);
  });
program.addCommand(accountCmd);

// Extract command — pull URLs, file paths, commands, and plans from sessions
const extractCmd = new Command('extract')
  .description('Extract URLs, file paths, commands, and plans from recent sessions')
  .option('--type <types>', 'Comma list: url, path, command, plan (default: all)')
  .option('--limit <n>', 'Maximum items per type')
  .option('-i, --interactive', 'Interactive picker with copy/open actions')
  .addHelpText('after', EXTRACT_EXAMPLES)
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { extractAction } = await import('./commands/extract');
    return extractAction(_opts, cmd);
  });
program.addCommand(extractCmd);

// Handoff command — show the latest handoff document
const handoffCmd = new Command('handoff')
  .description('Show the latest session handoff document for the current project')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { handoffAction } = await import('./commands/handoff');
    return handoffAction(_opts, cmd);
  });
handoffCmd
  .command('open')
  .description('Open a configured external session-handoff target')
  .option('--url-template <template>', 'URL with {sessionId}, {provider}, and {projectPath}')
  .option('--session <id>', 'Override the active session ID')
  .option('--no-open', 'Render without opening the URL')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { externalHandoffAction } = await import('./commands/handoff');
    return externalHandoffAction(_opts, cmd);
  });
program.addCommand(handoffCmd);

// Commander's default for an unresolved subcommand is help on stderr with exit
// 1, which breaks `sidekick | less` and makes every script think the tool
// failed. outputHelp() (not helpInformation()) is what composes the
// addHelpText('after', ...) example block.
//
// This is a root action handler rather than a pre-parse short-circuit so that
// Commander still validates the global options: printing help before parsing
// turned `sidekick --provider bogus` and `sidekick --project` (missing its
// value) into silent exit 0. Registering it only when there is no subcommand
// token keeps `sidekick bogus` reporting "unknown command" instead of
// Commander's "too many arguments", which is what a root action would cause.
if (commandToken === undefined) {
  program.action(() => {
    program.outputHelp();
  });
}

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(formatCliError(error));
  process.exitCode = 1;
});
