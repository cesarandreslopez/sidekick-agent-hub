declare const __CLI_VERSION__: string;

import { Command } from 'commander';
import { detectProvider } from 'sidekick-shared';
import type { ProviderId, SessionProvider } from 'sidekick-shared';
import { ClaudeCodeProvider, OpenCodeProvider, CodexProvider } from 'sidekick-shared';

const program = new Command();

program
  .name('sidekick')
  .description('Query Sidekick project intelligence from the command line')
  .version(__CLI_VERSION__)
  .option('--json', 'Output as JSON')
  .option('--project <path>', 'Override project path (default: cwd)')
  .option('--provider <id>', 'Provider: claude-code, opencode, codex, auto (default: auto)');

export function resolveProvider(opts: { provider?: string }): SessionProvider {
  const override = opts.provider && opts.provider !== 'auto'
    ? opts.provider as ProviderId
    : undefined;
  const id = override || detectProvider(override);
  switch (id) {
    case 'opencode': return new OpenCodeProvider();
    case 'codex': return new CodexProvider();
    case 'claude-code':
    default: return new ClaudeCodeProvider();
  }
}

// Dashboard command uses dynamic imports — lazy-load to avoid import at parse time
const dashCmd = new Command('dashboard')
  .description('Full-screen TUI dashboard with live session metrics')
  .option('--session <id>', 'Follow a specific session (default: most recent)')
  .option('--replay', 'Replay existing events before streaming new ones')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { dashboardAction } = await import('./commands/dashboard');
    return dashboardAction(_opts, cmd);
  });
program.addCommand(dashCmd);

// Dump command — static session dump in text, JSON, or markdown format
const dumpCmd = new Command('dump')
  .description('Dump session data as text timeline, JSON metrics, or markdown report')
  .option('--list', 'List available session IDs for the current project')
  .option('--session <id>', 'Target a specific session (default: most recent)')
  .option('--width <cols>', 'Terminal width for text output (default: auto-detect)')
  .option('--expand', 'Show all events including noise')
  .option('--format <fmt>', 'Output format: text, json, markdown (default: text)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { dumpAction } = await import('./commands/dump');
    return dumpAction(_opts, cmd);
  });
program.addCommand(dumpCmd);

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
  .option('--theme <theme>', 'Color theme: dark, light (default: dark)')
  .option('--no-thinking', 'Exclude thinking blocks from the transcript')
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
  .option('--status <status>', 'Filter by status: pending, completed, all (default: all)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { tasksAction } = await import('./commands/tasks');
    return tasksAction(_opts, cmd);
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

// Stats command — show historical stats summary
const statsCmd = new Command('stats')
  .description('Show historical usage stats (tokens, costs, models, tools)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { statsAction } = await import('./commands/stats');
    return statsAction(_opts, cmd);
  });
program.addCommand(statsCmd);

// Handoff command — show the latest handoff document
const handoffCmd = new Command('handoff')
  .description('Show the latest session handoff document for the current project')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { handoffAction } = await import('./commands/handoff');
    return handoffAction(_opts, cmd);
  });
program.addCommand(handoffCmd);

program.parse();
