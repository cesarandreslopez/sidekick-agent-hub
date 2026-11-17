/**
 * `sidekick tasks` — List persisted tasks for the current project.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { readTasks, resolveProjectIdentity } from 'sidekick-shared';
import type { PersistedTask } from 'sidekick-shared';
import { taskStatusLabel } from '../displayLabels';
import { parseLimit } from '../utils/parseLimit';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What to pass to `sidekick tasks done`. A task added here has a UUID, so its
 * first 8 characters do; a session task keeps the agent's short id (`5`,
 * `plan-0`), which repeats across sessions, so it is named with its session:
 * `<session8>:<id>`, the same form the store files collisions under.
 */
export function taskReference(task: Pick<PersistedTask, 'taskId' | 'sessionOrigin'>): string {
  if (UUID.test(task.taskId)) return task.taskId.slice(0, 8);
  return `${(task.sessionOrigin ?? '').slice(0, 8)}:${task.taskId}`;
}

const STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  deleted: 3,
};

/** Open work first (In Progress, then Pending), each group still newest first. */
export function openTasksFirst(tasks: readonly PersistedTask[]): PersistedTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (a, b) =>
        (STATUS_RANK[a.task.status] ?? 4) - (STATUS_RANK[b.task.status] ?? 4) || a.index - b.index,
    )
    .map(({ task }) => task);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function printTasksTable(tasks: PersistedTask[], total = tasks.length): void {
  if (tasks.length === 0) {
    process.stdout.write(chalk.dim('No tasks found for this project.\n'));
    return;
  }

  const count = total > tasks.length ? `${tasks.length} of ${total}` : String(tasks.length);
  process.stdout.write(chalk.bold(`Tasks (${count})\n`));
  process.stdout.write(chalk.dim('─'.repeat(80) + '\n'));

  for (const task of tasks) {
    const colorFn = STATUS_COLORS[task.status] || chalk.white;
    const icon = STATUS_ICONS[task.status] || '?';

    process.stdout.write(
      `${colorFn(icon)} ${chalk.dim(taskReference(task))}  ${chalk.bold(task.subject)}\n`,
    );

    const meta: string[] = [];
    meta.push(colorFn(taskStatusLabel(task.status)));
    meta.push(chalk.dim(`updated ${formatDate(task.updatedAt)}`));
    if (task.toolCallCount > 0) {
      meta.push(chalk.dim(`${task.toolCallCount} tool call${task.toolCallCount === 1 ? '' : 's'}`));
    }
    if (task.isSubagent) {
      meta.push(chalk.magenta('subagent'));
    }
    if (task.carriedOver) {
      meta.push(chalk.cyan(`age ${task.sessionAge}`));
    }
    if (task.tags && task.tags.length > 0) {
      meta.push(chalk.dim(task.tags.map((t) => `#${t}`).join(' ')));
    }
    process.stdout.write(`  ${meta.join(chalk.dim(' · '))}\n`);

    if (task.description) {
      const desc =
        task.description.length > 120 ? task.description.slice(0, 117) + '...' : task.description;
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
    // in_progress is filtered here: the shared reader's option names the
    // statuses it was written for.
    const tasks = (
      await readTasks(resolveProjectIdentity(workspacePath), {
        status:
          statusFilter === 'in_progress'
            ? 'all'
            : (statusFilter as 'pending' | 'completed' | 'all'),
      })
    ).filter((task) => statusFilter !== 'in_progress' || task.status === 'in_progress');

    const limit = parseLimit(opts.limit as string | undefined);
    if (jsonOutput) {
      // JSON keeps the reader's newest-first order.
      process.stdout.write(JSON.stringify(tasks.slice(0, limit), null, 2) + '\n');
    } else {
      printTasksTable(openTasksFirst(tasks).slice(0, limit), tasks.length);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
    return;
  }
}
