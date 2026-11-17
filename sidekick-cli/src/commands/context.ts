/**
 * `sidekick context` — Output composite project context (tasks + decisions + notes + handoff).
 *
 * Uses composeContext() from sidekick-shared to assemble a full context document
 * suitable for piping into other tools or LLM prompts.
 */

import type { Command } from 'commander';
import { composeContext, resolveProjectIdentity, formatCost } from 'sidekick-shared';
import type { ContextResult, Fidelity } from 'sidekick-shared';
import { resolveProvider } from '../cli';
import {
  decisionAlternatives,
  formatCount,
  isOmittedPlaceholder,
  noteStatusLabel,
  taskStatusLabel,
} from '../displayLabels';

export function formatContextText(ctx: ContextResult, slug: string): string {
  const lines: string[] = [];

  lines.push('# Project Context');
  lines.push(`Provider: ${ctx.provider}`);
  lines.push(`Project: ${slug}`);
  lines.push('');

  // --- Tasks ---
  lines.push(`## Tasks (${ctx.tasks.items.length}/${ctx.tasks.total})`);
  if (ctx.tasks.items.length === 0) {
    lines.push('No tasks.');
  } else {
    for (const t of ctx.tasks.items) {
      const status = taskStatusLabel(t.status);
      const desc = t.description ? ` — ${t.description}` : '';
      lines.push(`- [${status}] ${t.subject}${desc}`);
    }
  }
  lines.push('');

  // --- Decisions ---
  lines.push(`## Decisions (${ctx.decisions.items.length}/${ctx.decisions.total})`);
  if (ctx.decisions.items.length === 0) {
    if (ctx.decisions.total > 0) {
      lines.push(`(${ctx.decisions.total} decisions recorded, omitted by fidelity filter)`);
    } else {
      lines.push('No decisions.');
    }
  } else {
    for (const d of ctx.decisions.items) {
      lines.push(`- ${d.description}`);
      lines.push(
        `  Chosen: ${isOmittedPlaceholder(d.chosenOption) ? '(not recorded)' : d.chosenOption}`,
      );
      if (d.rationale) {
        lines.push(`  Rationale: ${d.rationale}`);
      }
      const alternatives = decisionAlternatives(d.alternatives);
      if (alternatives.length > 0) {
        lines.push(`  Alternatives: ${alternatives.join(', ')}`);
      }
    }
  }
  lines.push('');

  // --- Notes ---
  lines.push(`## Notes (${ctx.notes.items.length}/${ctx.notes.total})`);
  if (ctx.notes.items.length === 0) {
    lines.push('No notes.');
  } else {
    for (const n of ctx.notes.items) {
      const label = n.title || n.content.slice(0, 80);
      const state = n.status && n.status !== 'active' ? `/${noteStatusLabel(n.status)}` : '';
      const tag = `[${n.noteType}/${n.importance}${state}]`;
      lines.push(`- ${tag} ${label}`);
      if (n.title && n.content) {
        lines.push(`  ${n.content}`);
      }
    }
  }
  lines.push('');

  // --- Handoff ---
  lines.push('## Handoff');
  if (ctx.handoff) {
    lines.push(ctx.handoff);
  } else {
    lines.push('No handoff note.');
  }
  lines.push('');

  // --- Stats (if available) ---
  // The history store is global: these totals cover every project, all time,
  // not this one, so the heading says so.
  if (ctx.stats) {
    lines.push('## Usage (all projects, all time)');
    const t = ctx.stats.tokens;
    lines.push(`Tokens: ${formatCount(t.inputTokens)} in / ${formatCount(t.outputTokens)} out`);
    lines.push(
      `Cache: ${formatCount(t.cacheReadTokens)} read / ${formatCount(t.cacheWriteTokens)} write`,
    );
    lines.push(`Cost: ${formatCost(ctx.stats.cost)}`);
    lines.push('');
  }

  // --- Sessions ---
  if (ctx.sessionSummaries.length > 0) {
    lines.push(`## Recent Sessions (${ctx.sessionSummaries.length})`);
    for (const s of ctx.sessionSummaries) {
      const label = s.label ? ` — ${s.label}` : '';
      lines.push(`- ${s.sessionId}${label} (${s.startTime})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function contextAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const opts = cmd.opts();
  const provider = resolveProvider(globalOpts);
  const workspacePath: string = globalOpts.project || process.cwd();
  const jsonOutput: boolean = !!globalOpts.json || !!opts.json;
  const fidelity: Fidelity = (opts.fidelity as Fidelity) || 'full';

  const project = resolveProjectIdentity(workspacePath);

  try {
    const ctx = await composeContext(project, fidelity, provider, workspacePath);

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
    } else {
      process.stdout.write(formatContextText(ctx, project.canonicalSlug) + '\n');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
    return;
  } finally {
    try {
      provider.dispose();
    } catch {
      /* ignore */
    }
  }
}
