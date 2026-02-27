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
  .option('--session <id>', 'Target a specific session (default: most recent)')
  .option('--width <cols>', 'Terminal width for text output (default: auto-detect)')
  .option('--expand', 'Show all events including noise')
  .option('--format <fmt>', 'Output format: text, json, markdown (default: text)')
  .action(async (_opts: Record<string, unknown>, cmd: Command) => {
    const { dumpAction } = await import('./commands/dump');
    return dumpAction(_opts, cmd);
  });
program.addCommand(dumpCmd);

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

program.parse();
