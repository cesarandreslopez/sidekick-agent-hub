/**
 * `sidekick decisions` — List persisted decisions for the current project.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  readDecisions,
  getProjectSlug,
  getProjectSlugRaw,
} from 'sidekick-shared';
import type { DecisionEntry } from 'sidekick-shared';

const SOURCE_LABELS: Record<string, string> = {
  recovery_pattern: 'recovery',
  plan_mode: 'plan',
  user_question: 'user',
  text_pattern: 'text',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function printDecisionsList(decisions: DecisionEntry[]): void {
  if (decisions.length === 0) {
    process.stdout.write(chalk.dim('No decisions found for this project.\n'));
    return;
  }

  process.stdout.write(chalk.bold(`Decisions (${decisions.length})\n`));
  process.stdout.write(chalk.dim('─'.repeat(80) + '\n'));

  for (const d of decisions) {
    process.stdout.write(`${chalk.bold(d.description)}\n`);

    const meta: string[] = [];
    meta.push(chalk.dim(formatDate(d.timestamp)));
    meta.push(chalk.cyan(SOURCE_LABELS[d.source] || d.source));
    if (d.tags && d.tags.length > 0) {
      meta.push(chalk.dim(d.tags.map(t => `#${t}`).join(' ')));
    }
    process.stdout.write(`  ${meta.join(chalk.dim(' · '))}\n`);

    process.stdout.write(`  ${chalk.green('Chosen:')} ${d.chosenOption}\n`);

    if (d.rationale) {
      const rationale = d.rationale.length > 140
        ? d.rationale.slice(0, 137) + '...'
        : d.rationale;
      process.stdout.write(`  ${chalk.dim('Rationale:')} ${chalk.dim(rationale)}\n`);
    }

    if (d.alternatives && d.alternatives.length > 0) {
      process.stdout.write(`  ${chalk.dim('Alternatives:')} ${chalk.dim(d.alternatives.join(', '))}\n`);
    }

    process.stdout.write('\n');
  }
}

export async function decisionsAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const workspacePath: string = globalOpts.project || process.cwd();
  const jsonOutput: boolean = !!globalOpts.json;
  const search: string | undefined = opts.search as string | undefined;
  const limit: number | undefined = opts.limit ? parseInt(opts.limit as string, 10) : undefined;

  try {
    const rawSlug = getProjectSlugRaw(workspacePath);
    const resolvedSlug = getProjectSlug(workspacePath);
    const slugs = rawSlug !== resolvedSlug ? [rawSlug, resolvedSlug] : [rawSlug];

    let decisions: DecisionEntry[] = [];
    for (const slug of slugs) {
      decisions = await readDecisions(slug, { search, limit });
      if (decisions.length > 0) break;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(decisions, null, 2) + '\n');
    } else {
      printDecisionsList(decisions);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}
