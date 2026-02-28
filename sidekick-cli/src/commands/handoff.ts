/**
 * `sidekick handoff` — Show the latest handoff document for the current project.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  readLatestHandoff,
  getProjectSlug,
  getProjectSlugRaw,
} from 'sidekick-shared';

export async function handoffAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const workspacePath: string = globalOpts.project || process.cwd();
  const jsonOutput: boolean = !!globalOpts.json;

  try {
    const rawSlug = getProjectSlugRaw(workspacePath);
    const resolvedSlug = getProjectSlug(workspacePath);
    const slugs = rawSlug !== resolvedSlug ? [rawSlug, resolvedSlug] : [rawSlug];

    let content: string | null = null;
    for (const slug of slugs) {
      content = await readLatestHandoff(slug);
      if (content) break;
    }

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
