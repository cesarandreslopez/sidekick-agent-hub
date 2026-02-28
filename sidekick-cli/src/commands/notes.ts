/**
 * `sidekick notes` — List knowledge notes for the current project.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  readNotes,
  getProjectSlug,
  getProjectSlugRaw,
} from 'sidekick-shared';
import type { KnowledgeNote, KnowledgeNoteType, KnowledgeNoteStatus } from 'sidekick-shared';

const TYPE_COLORS: Record<string, (s: string) => string> = {
  gotcha: chalk.red,
  pattern: chalk.blue,
  guideline: chalk.green,
  tip: chalk.yellow,
};

const IMPORTANCE_COLORS: Record<string, (s: string) => string> = {
  critical: chalk.red.bold,
  high: chalk.yellow,
  medium: chalk.white,
  low: chalk.dim,
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function printNotesList(notes: KnowledgeNote[]): void {
  if (notes.length === 0) {
    process.stdout.write(chalk.dim('No knowledge notes found for this project.\n'));
    return;
  }

  process.stdout.write(chalk.bold(`Knowledge Notes (${notes.length})\n`));
  process.stdout.write(chalk.dim('─'.repeat(80) + '\n'));

  for (const note of notes) {
    const typeFn = TYPE_COLORS[note.noteType] || chalk.white;
    const impFn = IMPORTANCE_COLORS[note.importance] || chalk.white;

    const title = note.title || note.content.split('\n')[0].slice(0, 80);
    process.stdout.write(`${typeFn(`[${note.noteType}]`)} ${chalk.bold(title)}\n`);

    const meta: string[] = [];
    meta.push(impFn(note.importance));
    meta.push(chalk.dim(note.status));
    meta.push(chalk.dim(formatDate(note.updatedAt)));
    if (note.filePath) {
      meta.push(chalk.cyan(note.filePath));
    }
    if (note.tags && note.tags.length > 0) {
      meta.push(chalk.dim(note.tags.map(t => `#${t}`).join(' ')));
    }
    process.stdout.write(`  ${meta.join(chalk.dim(' · '))}\n`);

    if (note.content && note.content !== title) {
      const content = note.content.length > 140
        ? note.content.slice(0, 137) + '...'
        : note.content;
      process.stdout.write(`  ${chalk.dim(content)}\n`);
    }

    process.stdout.write('\n');
  }
}

export async function notesAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const workspacePath: string = globalOpts.project || process.cwd();
  const jsonOutput: boolean = !!globalOpts.json;
  const file: string | undefined = opts.file as string | undefined;
  const type: KnowledgeNoteType | undefined = opts.type as KnowledgeNoteType | undefined;
  const status: KnowledgeNoteStatus | undefined = opts.status as KnowledgeNoteStatus | undefined;

  try {
    const rawSlug = getProjectSlugRaw(workspacePath);
    const resolvedSlug = getProjectSlug(workspacePath);
    const slugs = rawSlug !== resolvedSlug ? [rawSlug, resolvedSlug] : [rawSlug];

    let notes: KnowledgeNote[] = [];
    for (const slug of slugs) {
      notes = await readNotes(slug, { file, type, status });
      if (notes.length > 0) break;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(notes, null, 2) + '\n');
    } else {
      printNotesList(notes);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  }
}
