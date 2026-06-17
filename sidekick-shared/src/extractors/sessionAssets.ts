/**
 * Extraction of actionable assets (URLs, file paths, shell commands, plans)
 * from agent session transcripts.
 *
 * Ported directly from `trawl` (https://github.com/B33pBeeps/trawl) — MIT,
 * (c) 2026 Juan Fourie. This module holds the text extractors and shared
 * helpers; the per-agent transcript readers live in `./sources/*` and the
 * cross-agent merge in `./gatherAssets`, mirroring trawl's
 * `extract.mjs` / `sources/*` / `catches.mjs` split.
 *
 * @module extractors/sessionAssets
 */

import * as fs from 'fs';
import * as os from 'os';
import { resolve, isAbsolute } from 'path';

// ── Regexes (ported from trawl src/extract.mjs) ──

/** URL: http(s)/file scheme, stop at whitespace/quote/bracket/backtick/backslash. */
const URL_RE = /(?:https?|file):\/\/[^\s"'<>)\]`\\]+/g;

/** path[:line[:col]] — a slash path OR a bare filename.ext, optional line/col. */
const PATH_RE =
  /(?:~|\.{0,2}\/)?[A-Za-z0-9_@.-]*(?:\/[A-Za-z0-9_@.-]+)+(?::\d+){0,2}|[A-Za-z0-9_@-]+\.[A-Za-z0-9]{1,8}(?::\d+){0,2}/g;

/** Shell language tags recognised inside fenced code blocks. */
const SHELL_TAGS = new Set(['sh', 'bash', 'shell', 'zsh', 'console', 'shellscript', 'shell-session']);

// ── Types ──

export type ExtractedAssetType = 'url' | 'path' | 'command' | 'plan';

export interface ExtractedAsset {
  /** Asset category. */
  type: ExtractedAssetType;
  /** Actionable payload (URL / `path[:line]` / command / plan markdown). */
  text: string;
  /** Single-line label for UI rows (defaults to `text` when omitted). */
  display: string;
  /** ISO 8601 timestamp of the source event, when known. */
  timestamp?: string;
}

export interface ExtractedAssets {
  urls: ExtractedAsset[];
  paths: ExtractedAsset[];
  commands: ExtractedAsset[];
  plans: ExtractedAsset[];
}

/** Per-agent extraction result, before cross-agent merge. */
export interface SourceAssets {
  urls: ExtractedAsset[];
  paths: ExtractedAsset[];
  commands: ExtractedAsset[];
  plans: ExtractedAsset[];
  /** Whether the agent had at least one session for this cwd. */
  hadSession: boolean;
}

export const DEFAULT_CAPS: Record<ExtractedAssetType, number> = {
  command: 60,
  path: 60,
  url: 40,
  plan: 25,
};

// ── Pure text extractors (ported from trawl urlsFrom / pathsFrom / commandsFromText) ──

/** Extracts http(s)/file URLs from text, stripping trailing punctuation. */
export function extractUrls(text: unknown): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of String(text).matchAll(URL_RE)) {
    out.push(m[0].replace(/[.,;:!?'"`]+$/, ''));
  }
  return out;
}

/**
 * Extracts `{file, line?}` candidates that exist on disk, resolved against
 * `cwd`. Bare tokens that don't resolve to a real file are dropped.
 */
export function extractFilePaths(
  text: unknown,
  cwd?: string,
): Array<{ file: string; line?: number }> {
  if (!text) return [];
  const home = os.homedir();
  const base = cwd || process.cwd();
  const out: Array<{ file: string; line?: number }> = [];
  for (const m of String(text).matchAll(PATH_RE)) {
    let tok = m[0].replace(/[.,;:)>"]+$/, '');
    let line: number | undefined;
    const mm = tok.match(/^(.+?):(\d+)(?::\d+)?$/);
    if (mm) {
      tok = mm[1];
      line = Number(mm[2]);
    }
    let file = tok.startsWith('~') ? tok.replace(/^~/, home) : tok;
    if (!isAbsolute(file)) file = resolve(base, file);
    if (isExistingFile(file)) out.push(line !== undefined ? { file, line } : { file });
  }
  return out;
}

/**
 * Extracts shell commands the agent PRESENTED for the user to run — from its
 * prose, not the tool calls it executed itself. Sources: shell-tagged fenced
 * code blocks and any `$ `-prefixed line (inside or outside a block).
 */
export function extractCommands(text: unknown): string[] {
  if (!text) return [];
  const out: string[] = [];
  const src = String(text);
  const fence = /```([\w.-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  const seenSpans: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = fence.exec(src))) {
    seenSpans.push([m.index, fence.lastIndex]);
    const shellTag = SHELL_TAGS.has(m[1].toLowerCase());
    let cont = '';
    for (const raw of m[2].split('\n')) {
      const dollar = /^\s*\$\s+(.+)$/.exec(raw);
      if (dollar) {
        out.push(dollar[1].trim());
        continue;
      }
      if (!shellTag) continue; // untagged block: only explicit `$ ` lines count
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (cont) {
        line = `${cont} ${line}`;
        cont = '';
      }
      if (line.endsWith('\\')) {
        cont = line.slice(0, -1).trim();
        continue;
      }
      out.push(line);
    }
  }
  // `$ ` lines in prose (outside any fenced block)
  for (const lm of src.matchAll(/^[ \t]*\$[ \t]+(.+)$/gm)) {
    const at = lm.index ?? 0;
    if (seenSpans.some(([a, b]) => at >= a && at < b)) continue;
    out.push(lm[1].trim());
  }
  return out;
}

// ── Asset builders (used by the per-agent source readers) ──

export function urlAsset(url: string, timestamp?: string): ExtractedAsset {
  return { type: 'url', text: url, display: url, timestamp };
}

export function commandAsset(command: string, timestamp?: string): ExtractedAsset {
  return { type: 'command', text: command, display: flat(command), timestamp };
}

export function pathAsset(p: { file: string; line?: number }, timestamp?: string): ExtractedAsset {
  const text = p.line !== undefined ? `${p.file}:${p.line}` : p.file;
  return { type: 'path', text, display: text, timestamp };
}

export function planAsset(markdown: string, timestamp?: string): ExtractedAsset {
  return { type: 'plan', text: markdown, display: planTitle(markdown), timestamp };
}

// ── Shared helpers ──

/** Flatten newlines so a value renders as a single row. */
export function flat(s: string): string {
  return String(s).replace(/\s*\n\s*/g, ' ').trim();
}

/** Derive a plan title from its markdown (first non-empty line, heading stripped). */
export function planTitle(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (line) return line.replace(/^#{1,6}\s*/, '');
  }
  return 'Plan';
}

export function isExistingFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Read a plan markdown file from disk, returning undefined if unreadable. */
export function readPlanFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/** Newest-first comparator on ISO timestamps (missing sorts last). */
export function byTimestampDesc(a: ExtractedAsset, b: ExtractedAsset): number {
  return (b.timestamp || '').localeCompare(a.timestamp || '');
}

/** Dedupe by `type+text`, keeping first occurrence (most recent). */
export function dedupeAssets(assets: ExtractedAsset[]): ExtractedAsset[] {
  const seen = new Set<string>();
  const out: ExtractedAsset[] = [];
  for (const a of assets) {
    if (!a || !a.text) continue;
    const key = `${a.type}\0${a.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Dedupe plans by case-insensitive title so re-plans don't flood. */
export function dedupePlansByTitle(plans: ExtractedAsset[]): ExtractedAsset[] {
  const seen = new Set<string>();
  const out: ExtractedAsset[] = [];
  for (const p of plans) {
    const key = (p.display || p.text).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

export function capped(assets: ExtractedAsset[], cap: number): ExtractedAsset[] {
  return cap > 0 ? assets.slice(0, cap) : assets;
}
