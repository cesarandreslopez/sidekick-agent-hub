/**
 * `sidekick peak` — Show whether Claude is currently in peak hours.
 *
 * Data source: https://promoclock.co/api/status (third-party, unaffiliated
 * with Anthropic). Peak window (weekdays 13:00–19:00 UTC) is when Claude
 * session limits drain faster on Free / Pro / Max / Team subscriptions.
 */

import type { Command } from 'commander';
import { fetchPeakHoursStatus } from 'sidekick-shared';
import { printPeakHoursBlock } from './peakHoursRender';

export async function peakAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;

  const state = await fetchPeakHoursStatus();

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    return;
  }

  printPeakHoursBlock(state);
}
