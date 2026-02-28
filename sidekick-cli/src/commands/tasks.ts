/**
 * `sidekick tasks` — List persisted tasks for the current project.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  readTasks,
  getProjectSlug,
  getProjectSlugRaw,
} from 'sidekick-shared';
import type { PersistedTask } from 'sidekick-shared';

const STATUS_COLORS: Record<string, (s: string) => string> = {
  pending: chalk.yellow,
  in_progress: chalk.blue,
  completed: chalk.green,
  deleted: chalk.gray,
};

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  in_progress: '◑',
  completed: '●',
  deleted: '✕',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function printTasksTable(tasks: PersistedTask[]): void {
  if (tasks.length === 0) {
    process.stdout.write(chalk.dim('No tasks found for this project.\n'));
    return;
  }

  process.stdout.write(chalk.bold(`Tasks (${tasks.length})\n`));
  process.stdout.write(chalk.dim('─'.repeat(80) + '\n'));

  for (const task of tasks) {
    const colorFn = STATUS_COLORS[task.status] || chalk.white;
    const icon = STATUS_ICONS[task.status] || '?';

    process.stdout.write(`${colorFn(icon)} ${chalk.bold(task.subject)}\n`);

    const meta: string[] = [];
    meta.push(colorFn(task.status));
    meta.push(chalk.dim(`updated ${formatDate(task.updatedAt)}`));
    if (task.toolCallCount > 0) {
      meta.push(chalk.dim(`${task.toolCallCount} tool calls`));
    }
    if (task.isSubagent) {
      meta.push(chalk.magenta('subagent'));
    }
    if (task.carriedOver) {
      meta.push(chalk.cyan(`age ${task.sessionAge}`));
    }
    if (task.tags && task.tags.length > 0) {
      meta.push(chalk.dim(task.tags.map(t => `#${t}`).join(' ')));
    }
    process.stdout.write(`  ${meta.join(chalk.dim(' · '))}\n`);

    if (task.description) {
      const desc = task.description.length > 120
        ? task.description.slice(0, 117) + '...'
        : task.description;
      process.stdout.write(`  ${chalk.dim(desc)}\n`);
    }

    process.stdout.write('\n');
  }
}

export async function tasksAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const workspacePath: string = globalOpts.project || process.cwd();
  const jsonOutput: boolean = !!globalOpts.json;
  const statusFilter: string = (opts.status as string) || 'all';

  try {
    // Try raw slug first (matches VS Code extension), then resolved slug
    const rawSlug = getProjectSlugRaw(workspacePath);
    const resolvedSlug = getProjectSlug(workspacePath);
    const slugs = rawSlug !== resolvedSlug ? [rawSlug, resolvedSlug] : [rawSlug];

    let tasks: PersistedTask[] = [];
    for (const slug of slugs) {
      tasks = await readTasks(slug, { status: statusFilter as 'pending' | 'completed' | 'all' });
      if (tasks.length > 0) break;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(tasks, null, 2) + '\n');
    } else {
      printTasksTable(tasks);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}
