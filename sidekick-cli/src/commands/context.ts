/**
 * `sidekick context` — Output composite project context (tasks + decisions + notes + handoff).
 *
 * Uses composeContext() from sidekick-shared to assemble a full context document
 * suitable for piping into other tools or LLM prompts.
 */

import type { Command } from 'commander';
import {
  composeContext,
  getProjectSlug,
  getProjectSlugRaw,
} from 'sidekick-shared';
import type { ContextResult, Fidelity } from 'sidekick-shared';
import { resolveProvider } from '../cli';

function formatContextText(ctx: ContextResult, slug: string): string {
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
      const status = t.status.toUpperCase();
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
      lines.push(`  Chosen: ${d.chosenOption}`);
      if (d.rationale) {
        lines.push(`  Rationale: ${d.rationale}`);
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
      const tag = `[${n.noteType}/${n.importance}]`;
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
  if (ctx.stats) {
    lines.push('## Stats');
    const t = ctx.stats.tokens;
    lines.push(`Tokens: ${t.inputTokens.toLocaleString()} in / ${t.outputTokens.toLocaleString()} out`);
    lines.push(`Cache: ${t.cacheReadTokens.toLocaleString()} read / ${t.cacheWriteTokens.toLocaleString()} write`);
    lines.push(`Cost: $${ctx.stats.cost.toFixed(2)}`);
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

  // Derive the project slug — try both symlink-resolved and raw to match persisted data
  const slug = getProjectSlug(workspacePath);
  const slugRaw = getProjectSlugRaw(workspacePath);
  const effectiveSlug = slug !== slugRaw ? slugRaw : slug;

  try {
    const ctx = await composeContext(effectiveSlug, fidelity, provider, workspacePath);

    if (jsonOutput) {
      process.stdout.write(JSON.stringify(ctx, null, 2) + '\n');
    } else {
      process.stdout.write(formatContextText(ctx, effectiveSlug) + '\n');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exit(1);
  } finally {
    try { provider.dispose(); } catch { /* ignore */ }
  }
}
