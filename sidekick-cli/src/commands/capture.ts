import type { Command } from 'commander';
import { addDecision, addNote, addTask, completeTask } from 'sidekick-shared';

function projectFrom(cmd: Command): string {
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return (root.opts().project as string | undefined) || process.cwd();
}

function csv(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function taskAddAction(subject: string, cmd: Command): Promise<void> {
  const task = await addTask(projectFrom(cmd), subject, {
    description: cmd.opts().description as string | undefined,
    tags: csv(cmd.opts().tags),
  });
  process.stdout.write(`Added task ${task.taskId}: ${task.subject}\n`);
}

export async function taskDoneAction(id: string, cmd: Command): Promise<void> {
  const task = await completeTask(projectFrom(cmd), id);
  process.stdout.write(`Completed task ${task.taskId}: ${task.subject}\n`);
}

export async function noteAddAction(content: string, cmd: Command): Promise<void> {
  const opts = cmd.opts();
  const note = await addNote(projectFrom(cmd), content, {
    filePath: opts.file as string | undefined,
    title: opts.title as string | undefined,
    noteType: opts.type as 'gotcha' | 'pattern' | 'guideline' | 'tip' | undefined,
    importance: opts.importance as 'critical' | 'high' | 'medium' | 'low' | undefined,
    tags: csv(opts.tags),
  });
  process.stdout.write(`Added note ${note.id}${note.filePath ? ` for ${note.filePath}` : ''}\n`);
}

export async function decisionAddAction(description: string, cmd: Command): Promise<void> {
  const opts = cmd.opts();
  const result = await addDecision(projectFrom(cmd), description, {
    rationale: opts.rationale as string | undefined,
    chosenOption: opts.chosen as string | undefined,
    alternatives: csv(opts.alternatives),
    tags: csv(opts.tags),
  });
  process.stdout.write(
    result.added
      ? `Added decision ${result.decision.id}: ${result.decision.description}\n`
      : `Decision already exists: ${result.decision.description}\n`,
  );
}
