/**
 * Claude Code transcript reader for asset extraction.
 * ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl  (append-only JSONL)
 *
 * Ported directly from trawl `src/sources/claude.mjs` (MIT, (c) 2026 Juan
 * Fourie). Reads the EXACT cwd slug directory — no discovery, no walking.
 *
 * @module extractors/sources/claudeAssets
 */

import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, statSync, readdirSync } from 'fs';
import {
  extractUrls,
  extractFilePaths,
  extractCommands,
  isExistingFile,
  readPlanFile,
  urlAsset,
  commandAsset,
  pathAsset,
  planAsset,
  type ExtractedAsset,
  type SourceAssets,
} from '../sessionAssets';

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);

/** Claude slugs the cwd by replacing /, . and _ with - (lossy, forward-only). */
const slugForCwd = (cwd: string): string => cwd.replace(/[/._]/g, '-');

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Newest-first list of files matching a predicate under a dir (non-recursive). */
function filesByMtimeDesc(dir: string, filter: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(filter)
    .map((n) => join(dir, n))
    .map((p) => {
      try {
        return { path: p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.path);
}

/** Read a JSONL file into parsed objects, skipping blank/unparseable lines. */
function readJsonl(file: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* ignore partial / non-JSON lines */
    }
  }
  return out;
}

/** Newest `limit` session files for the EXACT cwd. */
export function claudeSessions(cwd: string, n = 3): string[] {
  const dir = join(homedir(), '.claude', 'projects', slugForCwd(cwd));
  if (!dirExists(dir)) return [];
  return filesByMtimeDesc(dir, (name) => name.endsWith('.jsonl')).slice(0, n);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Parse one session file into the accumulator arrays. */
function accumClaude(file: string, cwd: string, acc: SourceAssets): void {
  for (const line of readJsonl(file)) {
    const ts = asString(line.timestamp);

    // Plan-mode signal: an `attachment` line carries planFilePath when a plan
    // exists — present even if ExitPlanMode wasn't called with an inline plan.
    if (line.type === 'attachment') {
      const attachment = line.attachment as Record<string, unknown> | undefined;
      const pf = asString(attachment?.planFilePath);
      if (pf && isExistingFile(pf)) {
        try {
          const text = readFileSync(pf, 'utf8');
          if (text.trim()) acc.plans.push(planAsset(text, ts));
        } catch {
          /* ignore */
        }
      }
      continue;
    }

    const message = line.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string') {
      for (const u of extractUrls(content)) acc.urls.push(urlAsset(u, ts));
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b?.type === 'text') {
        for (const u of extractUrls(b.text)) acc.urls.push(urlAsset(u, ts));
        for (const c of extractCommands(b.text)) acc.commands.push(commandAsset(c, ts));
      } else if (b?.type === 'tool_use') {
        const name = asString(b.name);
        const input = (b.input as Record<string, unknown>) || {};
        if (name === 'Bash' && input.command) {
          for (const u of extractUrls(input.command)) acc.urls.push(urlAsset(u, ts));
          for (const p of extractFilePaths(input.command, cwd)) acc.paths.push(pathAsset(p, ts));
        } else if (name && PATH_TOOLS.has(name) && asString(input.file_path) && isExistingFile(input.file_path as string)) {
          acc.paths.push(pathAsset({ file: input.file_path as string }, ts));
        } else if ((name === 'WebFetch' || name === 'WebSearch') && input.url) {
          for (const u of extractUrls(input.url)) acc.urls.push(urlAsset(u, ts));
        } else if (name === 'ExitPlanMode') {
          const inline = asString(input.plan);
          const markdown = inline && inline.trim() ? inline : readPlanFile(asString(input.planFilePath));
          if (markdown && markdown.trim()) acc.plans.push(planAsset(markdown, ts));
        }
      }
    }
  }
}

/** Extract assets from the newest `limit` Claude sessions for the exact cwd. */
export function readClaudeAssets(cwd: string, limit = 3): SourceAssets {
  const sessions = claudeSessions(cwd, limit);
  const acc: SourceAssets = { urls: [], paths: [], commands: [], plans: [], hadSession: sessions.length > 0 };
  for (const file of sessions) accumClaude(file, cwd, acc);
  return acc;
}

// Re-exported for parity with trawl's module surface.
export type { ExtractedAsset };
