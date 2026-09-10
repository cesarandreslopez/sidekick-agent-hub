/**
 * `sidekick status` — Show Claude & OpenAI API status (one-shot).
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  fetchProviderServiceStatus,
  toLegacyProviderStatus,
  fetchPeakHoursStatus,
} from 'sidekick-shared';
import type { ProviderServiceStatus } from 'sidekick-shared';
import { presentProviderStatus } from '../dashboard/providerStatusPresentation';
import { printPeakHoursBlock } from './peakHoursRender';
import { resolveProviderId } from '../cli';

function printStatus(status: ProviderServiceStatus): void {
  const display = presentProviderStatus(status);
  process.stdout.write(chalk.bold(`${display.label}\n`));
  for (const line of display.lines) process.stdout.write(`  ${chalk[display.color](line)}\n`);
}

export async function statusAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;

  // Peak hours only applies to Claude session/subscription users — skip the
  // network call entirely for OpenCode/Codex so we don't ping a third-party
  // service on their behalf.
  const providerId = resolveProviderId(globalOpts);
  const wantsPeak = providerId === 'claude-code';

  const [claude, openai, peak] = await Promise.all([
    fetchProviderServiceStatus('claude-code'),
    fetchProviderServiceStatus('codex'),
    wantsPeak ? fetchPeakHoursStatus() : Promise.resolve(null),
  ]);

  if (jsonOutput) {
    process.stdout.write(
      JSON.stringify(
        {
          claude: toLegacyProviderStatus(claude),
          openai: toLegacyProviderStatus(openai),
          peak,
          serviceStatus: { claude, openai },
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  printStatus(claude);
  process.stdout.write('\n');
  printStatus(openai);
  if (peak) {
    process.stdout.write('\n');
    printPeakHoursBlock(peak);
  }
}
