/**
 * `sidekick status` — Show Claude & OpenAI API status (one-shot).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { fetchProviderStatus, fetchOpenAIStatus } from 'sidekick-shared';
import type { ProviderStatusState } from 'sidekick-shared';

function printStatus(label: string, statusPageHost: string, status: ProviderStatusState): void {
  const indicatorColor = status.indicator === 'none' ? chalk.green
    : status.indicator === 'minor' ? chalk.yellow
    : chalk.red;

  const indicatorLabel = status.indicator === 'none' ? '●' : status.indicator === 'minor' ? '◐' : '●';

  process.stdout.write(chalk.bold(`${label}\n`));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  process.stdout.write(`  ${indicatorColor(indicatorLabel)} ${indicatorColor(status.description || status.indicator)}\n`);

  if (status.description === 'Status unavailable') {
    process.stdout.write(chalk.dim(`  Could not reach ${statusPageHost}\n`));
    return;
  }

  if (status.affectedComponents.length > 0) {
    process.stdout.write('\n' + chalk.bold('  Affected Components:\n'));
    for (const c of status.affectedComponents) {
      const statusColor = c.status.includes('major') ? chalk.red
        : c.status.includes('partial') || c.status.includes('degraded') ? chalk.yellow
        : chalk.dim;
      process.stdout.write(`    ${statusColor('•')} ${c.name} ${chalk.dim('—')} ${statusColor(c.status.replace(/_/g, ' '))}\n`);
    }
  }

  if (status.activeIncident) {
    const inc = status.activeIncident;
    const impactColor = inc.impact === 'critical' || inc.impact === 'major' ? chalk.red : chalk.yellow;
    process.stdout.write('\n' + chalk.bold('  Active Incident:\n'));
    process.stdout.write(`    ${impactColor(inc.name)}\n`);
    process.stdout.write(`    Impact: ${impactColor(inc.impact)}  Updated: ${chalk.dim(inc.updatedAt)}\n`);
    if (inc.shortlink) {
      process.stdout.write(`    ${chalk.dim(inc.shortlink)}\n`);
    }
  }
}

export async function statusAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;

  const [claude, openai] = await Promise.all([
    fetchProviderStatus(),
    fetchOpenAIStatus(),
  ]);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ claude, openai }, null, 2) + '\n');
    return;
  }

  printStatus('Claude API Status', 'status.claude.com', claude);
  process.stdout.write('\n');
  printStatus('OpenAI API Status', 'status.openai.com', openai);
}
