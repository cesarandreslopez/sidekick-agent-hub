/**
 * `sidekick peak` — Show whether Claude is currently in peak hours.
 *
 * Data source: https://promoclock.co/api/status (third-party, unaffiliated
 * with Anthropic). Peak window (weekdays 13:00–19:00 UTC) is when Claude
 * session limits drain faster on Free / Pro / Max / Team subscriptions.
 */

import type { Command } from 'commander';
import {
  createPeakHoursNotApplicableState,
  fetchPeakHoursStatus,
  isClaudeCodeSessionProvider,
} from 'sidekick-shared';
import type { ProviderId } from 'sidekick-shared';
import { printPeakHoursBlock } from './peakHoursRender';
import { resolveProviderId } from '../cli';

export async function peakAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const localOpts = cmd.opts();
  const jsonOutput: boolean = !!globalOpts.json;
  const providerOpts = localOpts.provider ? { provider: localOpts.provider as string } : globalOpts;
  const providerId = resolveProviderId(providerOpts) as ProviderId;

  const state = isClaudeCodeSessionProvider(providerId)
    ? await fetchPeakHoursStatus()
    : createPeakHoursNotApplicableState(providerId);

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
    return;
  }

  printPeakHoursBlock(state);
}
