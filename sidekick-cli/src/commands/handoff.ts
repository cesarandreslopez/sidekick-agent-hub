/**
 * `sidekick handoff` — Show the latest handoff document for the current project.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  readLatestHandoff,
  renderHandoffUrlTemplate,
  resolveProjectIdentity,
} from 'sidekick-shared';
import { resolveProvider } from '../cli';
import { openUrl } from '../utils/openUrl';

export async function handoffAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const workspacePath: string = globalOpts.project || process.cwd();
  const jsonOutput: boolean = !!globalOpts.json;

  try {
    const content = await readLatestHandoff(resolveProjectIdentity(workspacePath));

    if (!content) {
      if (jsonOutput) {
        process.stdout.write(JSON.stringify(null) + '\n');
      } else {
        process.stdout.write(chalk.dim('No handoff document found for this project.\n'));
      }
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ content }) + '\n');
    } else {
      process.stdout.write(chalk.bold('Latest Handoff\n'));
      process.stdout.write(chalk.dim('─'.repeat(80) + '\n'));
      process.stdout.write(content + '\n');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}

export async function externalHandoffAction(
  _opts: Record<string, unknown>,
  cmd: Command,
): Promise<void> {
  const globalOpts = cmd.parent!.parent!.opts();
  const opts = cmd.opts();
  const workspacePath = (globalOpts.project as string | undefined) || process.cwd();
  const template =
    (opts.urlTemplate as string | undefined) || process.env.SIDEKICK_HANDOFF_URL_TEMPLATE || '';
  const provider = resolveProvider(globalOpts);
  try {
    const sessionPath = provider.findActiveSession(workspacePath);
    const sessionId =
      (opts.session as string | undefined) ||
      (sessionPath ? provider.getSessionId(sessionPath) : 'unknown');
    const url = renderHandoffUrlTemplate(template, {
      sessionId,
      provider: provider.id,
      projectPath: workspacePath,
    });
    const shouldOpen = opts.open !== false && !globalOpts.json;
    const opened = shouldOpen ? openUrl(url) : false;
    if (globalOpts.json) process.stdout.write(`${JSON.stringify({ url, opened })}\n`);
    else process.stdout.write(`${opened ? 'Opened' : 'Handoff URL'}: ${url}\n`);
  } finally {
    provider.dispose();
  }
}
