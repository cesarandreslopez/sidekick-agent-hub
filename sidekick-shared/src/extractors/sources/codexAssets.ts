/**
 * Codex CLI rollout reader for asset extraction.
 * ~/.codex/sessions/<Y>/<M>/<D>/rollout-<iso>-<uuid>.jsonl  (append-only JSONL)
 * cwd lives in line 1: session_meta.payload.cwd. arguments/input are
 * JSON-encoded strings (double-parse).
 *
 * Ported directly from trawl `src/sources/codex.mjs` (MIT, (c) 2026 Juan
 * Fourie). Matches sessions by EXACT cwd — no walking up or down.
 *
 * @module extractors/sources/codexAssets
 */

import { join } from 'path';
import { homedir } from 'os';
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'fs';
import {
  extractUrls,
  extractFilePaths,
  extractCommands,
  urlAsset,
  commandAsset,
  pathAsset,
  planAsset,
  type SourceAssets,
} from '../sessionAssets';

const EXEC_NAMES = new Set(['exec_command', 'shell', 'local_shell', 'container.exec']);

function dirExists(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Parse only the FIRST JSON line of a file (cheap cwd probe for big rollouts). */
function firstJsonLine(file: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  const buf = Buffer.alloc(65536);
  let data = '';
  try {
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      data += buf.toString('utf8', 0, n);
      const i = data.indexOf('\n');
      if (i >= 0) {
        data = data.slice(0, i);
        break;
      }
      if (data.length > 1_000_000) break;
    }
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read a JSONL file into parsed objects; `skip(rawLine)` drops heavy lines pre-parse. */
function readJsonl(file: string, skip?: (raw: string) => boolean): Array<Record<string, unknown>> {
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
    if (skip && skip(s)) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Collect rollout files newest-first by mtime (resumed sessions rank by fresh mtime). */
function rolloutFiles(limit = 150): string[] {
  const root = join(homedir(), '.codex', 'sessions');
  if (!dirExists(root)) return [];
  const out: Array<{ p: string; mtime: number }> = [];
  const walk = (dir: string): void => {
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          out.push({ p, mtime: statSync(p).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((x) => x.p);
}

/** Up to `n` newest rollout files whose session cwd matches EXACTLY (line-1 probe). */
export function codexSessions(cwd: string, n = 3): string[] {
  const out: string[] = [];
  for (const f of rolloutFiles()) {
    const meta = firstJsonLine(f);
    const payload = meta?.payload as Record<string, unknown> | undefined;
    if (payload?.cwd === cwd) {
      out.push(f);
      if (out.length >= n) break;
    }
  }
  return out;
}

function parseArgs(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Extract file paths from apply_patch headers (Update/Add/Delete File: path). */
function patchFiles(patch: unknown, cwd: string): Array<{ file: string; line?: number }> {
  const out: Array<{ file: string; line?: number }> = [];
  for (const m of String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const f = m[1].trim();
    for (const p of extractFilePaths(f, cwd)) out.push(p);
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Extract assets from the newest `limit` Codex sessions for the exact cwd. */
export function readCodexAssets(cwd: string, limit = 3): SourceAssets {
  const files = codexSessions(cwd, limit);
  const acc: SourceAssets = { urls: [], paths: [], commands: [], plans: [], hadSession: files.length > 0 };

  // Skip heavy lines (command output, encrypted reasoning, token counters)
  // before paying their JSON.parse cost.
  const skip = (l: string): boolean =>
    l.includes('"type":"function_call_output"') ||
    l.includes('"type":"reasoning"') ||
    l.includes('"type":"token_count"');

  for (const file of files) {
    for (const line of readJsonl(file, skip)) {
      const p = line.payload as Record<string, unknown> | undefined;
      if (!p) continue;
      const ts = asString(line.timestamp);
      const pt = p.type;

      if (pt === 'function_call') {
        // commands the session RAN — mine paths/urls, but don't list the command.
        if (EXEC_NAMES.has(p.name as string)) {
          const args = parseArgs(p.arguments);
          const cmd = args.cmd ?? args.command;
          if (cmd) {
            for (const u of extractUrls(cmd)) acc.urls.push(urlAsset(u, ts));
            for (const pp of extractFilePaths(cmd, cwd)) acc.paths.push(pathAsset(pp, ts));
          }
        }
      } else if (pt === 'item_completed') {
        const item = p.item as Record<string, unknown> | undefined;
        const text = asString(item?.text);
        if (item?.type === 'Plan' && text && text.trim()) {
          // A finalized PlanItem (distinct from the update_plan todo list).
          acc.plans.push(planAsset(text, ts));
        }
      } else if (pt === 'custom_tool_call' && p.name === 'apply_patch') {
        for (const pp of patchFiles(p.input, cwd)) acc.paths.push(pathAsset(pp, ts));
      } else if (pt === 'message' && Array.isArray(p.content)) {
        for (const block of p.content) {
          const b = block as Record<string, unknown>;
          for (const u of extractUrls(b?.text)) acc.urls.push(urlAsset(u, ts));
          for (const c of extractCommands(b?.text)) acc.commands.push(commandAsset(c, ts));
        }
      } else if (pt === 'agent_message' && typeof p.message === 'string') {
        for (const u of extractUrls(p.message)) acc.urls.push(urlAsset(u, ts));
        for (const c of extractCommands(p.message)) acc.commands.push(commandAsset(c, ts));
      }
    }
  }

  return acc;
}
