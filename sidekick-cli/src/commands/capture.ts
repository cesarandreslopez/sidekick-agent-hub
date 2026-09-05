import type { Command } from 'commander';
import { addDecision, addNote, addTask, completeTask } from 'sidekick-shared';

function rootCommand(cmd: Command): Command {
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return root;
}

function projectFrom(cmd: Command): string {
  return (rootCommand(cmd).opts().project as string | undefined) || process.cwd();
}

/** The global `--json` flag lives on the root command, not the subcommand. */
function wantsJson(cmd: Command): boolean {
  return !!rootCommand(cmd).opts().json;
}

function emit(cmd: Command, text: string, payload: Record<string, unknown>): void {
  process.stdout.write(wantsJson(cmd) ? `${JSON.stringify(payload)}\n` : `${text}\n`);
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
  emit(cmd, `Added task ${task.taskId}: ${task.subject}`, { ok: true, action: 'added', task });
}

export async function taskDoneAction(id: string, cmd: Command): Promise<void> {
  const task = await completeTask(projectFrom(cmd), id);
  emit(cmd, `Completed task ${task.taskId}: ${task.subject}`, {
    ok: true,
    action: 'completed',
    task,
  });
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
  emit(cmd, `Added note ${note.id}${note.filePath ? ` for ${note.filePath}` : ''}`, {
    ok: true,
    action: 'added',
    note,
  });
}

export async function decisionAddAction(description: string, cmd: Command): Promise<void> {
  const opts = cmd.opts();
  const result = await addDecision(projectFrom(cmd), description, {
    rationale: opts.rationale as string | undefined,
    chosenOption: opts.chosen as string | undefined,
    alternatives: csv(opts.alternatives),
    tags: csv(opts.tags),
  });
  emit(
    cmd,
    result.added
      ? `Added decision ${result.decision.id}: ${result.decision.description}`
      : `Decision already exists: ${result.decision.description}`,
    { ok: true, action: result.added ? 'added' : 'exists', decision: result.decision },
  );
}
