/**
 * Extract actionable assets from agent session transcript text.
 *
 * Portions adapted from `trawl` by Juan Fourie (B33pBeeps), MIT licensed:
 * https://github.com/B33pBeeps/trawl
 *
 * @module extractors/sessionAssets
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const URL_RE = /(?:https?|file):\/\/[^\s"'<>)\]`\\]+/g;
const PATH_RE =
  /(?:~|\.{0,2}\/)?[A-Za-z0-9_@.-]*(?:\/[A-Za-z0-9_@.-]+)+(?::\d+){0,2}|[A-Za-z0-9_@-]+\.[A-Za-z0-9]{1,8}(?::\d+){0,2}/g;
const SHELL_TAGS = new Set([
  'sh',
  'bash',
  'shell',
  'zsh',
  'console',
  'shellscript',
  'shell-session',
]);

export type ExtractedAssetType = 'url' | 'path' | 'command' | 'plan';
export type AssetAgent = 'claude' | 'codex';

export interface ExtractedAssetProvenance {
  agent?: AssetAgent;
  sessionPath?: string;
  source?: string;
}

export interface ExtractedAsset extends ExtractedAssetProvenance {
  type: ExtractedAssetType;
  text: string;
  display: string;
  timestamp?: string;
}

export interface ExtractedAssets {
  urls: ExtractedAsset[];
  paths: ExtractedAsset[];
  commands: ExtractedAsset[];
  plans: ExtractedAsset[];
}

export interface SourceAssets extends ExtractedAssets {
  hadSession: boolean;
}

export const DEFAULT_CAPS: Record<ExtractedAssetType, number> = {
  command: 60,
  path: 60,
  url: 40,
  plan: 25,
};

export function extractUrls(text: unknown): string[] {
  if (!text) return [];
  const urls: string[] = [];
  for (const match of String(text).matchAll(URL_RE)) {
    urls.push(match[0].replace(/[.,;:!?'"`]+$/, ''));
  }
  return urls;
}

export function extractFilePaths(
  text: unknown,
  cwd?: string,
): Array<{ file: string; line?: number }> {
  if (!text) return [];

  const home = os.homedir();
  const base = cwd ? resolve(cwd) : process.cwd();
  const paths: Array<{ file: string; line?: number }> = [];

  for (const match of String(text).matchAll(PATH_RE)) {
    let token = match[0].replace(/[.,;:)>"]+$/, '');
    let line: number | undefined;
    const lineMatch = /^(.+?):(\d+)(?::\d+)?$/.exec(token);
    if (lineMatch) {
      token = lineMatch[1];
      line = Number(lineMatch[2]);
    }

    let file = token.startsWith('~') ? token.replace(/^~/, home) : token;
    if (!isAbsolute(file)) file = resolve(base, file);
    if (isExistingFile(file)) {
      paths.push(line !== undefined ? { file, line } : { file });
    }
  }

  return paths;
}

export function extractCommands(text: unknown): string[] {
  if (!text) return [];

  const commands: string[] = [];
  const source = String(text);
  const fence = /```([\w.-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  const fencedSpans: Array<[number, number]> = [];
  let match: RegExpExecArray | null;

  while ((match = fence.exec(source))) {
    fencedSpans.push([match.index, fence.lastIndex]);
    const shellTagged = SHELL_TAGS.has(match[1].toLowerCase());
    let continuation = '';

    for (const rawLine of match[2].split('\n')) {
      const promptLine = /^\s*\$\s+(.+)$/.exec(rawLine);
      if (promptLine) {
        commands.push(promptLine[1].trim());
        continue;
      }

      if (!shellTagged) continue;
      let line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      if (continuation) {
        line = `${continuation} ${line}`;
        continuation = '';
      }

      if (line.endsWith('\\')) {
        continuation = line.slice(0, -1).trim();
        continue;
      }

      commands.push(line);
    }
  }

  for (const lineMatch of source.matchAll(/^[ \t]*\$[ \t]+(.+)$/gm)) {
    const index = lineMatch.index ?? 0;
    if (fencedSpans.some(([start, end]) => index >= start && index < end)) continue;
    commands.push(lineMatch[1].trim());
  }

  return commands;
}

export function urlAsset(
  url: string,
  timestamp?: string,
  provenance: ExtractedAssetProvenance = {},
): ExtractedAsset {
  return { type: 'url', text: url, display: url, timestamp, ...provenance };
}

export function commandAsset(
  command: string,
  timestamp?: string,
  provenance: ExtractedAssetProvenance = {},
): ExtractedAsset {
  return { type: 'command', text: command, display: flat(command), timestamp, ...provenance };
}

export function pathAsset(
  path: { file: string; line?: number },
  timestamp?: string,
  provenance: ExtractedAssetProvenance = {},
): ExtractedAsset {
  const text = path.line !== undefined ? `${path.file}:${path.line}` : path.file;
  return { type: 'path', text, display: text, timestamp, ...provenance };
}

export function planAsset(
  markdown: string,
  timestamp?: string,
  provenance: ExtractedAssetProvenance = {},
): ExtractedAsset {
  return { type: 'plan', text: markdown, display: planTitle(markdown), timestamp, ...provenance };
}

export function flat(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim();
}

export function planTitle(markdown: string): string {
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim();
    if (line) return line.replace(/^#{1,6}\s*/, '');
  }
  return 'Plan';
}

export function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function readPlanFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export function byTimestampDesc(a: ExtractedAsset, b: ExtractedAsset): number {
  return (b.timestamp || '').localeCompare(a.timestamp || '');
}

export function dedupeAssets(assets: ExtractedAsset[]): ExtractedAsset[] {
  const seen = new Set<string>();
  const deduped: ExtractedAsset[] = [];

  for (const asset of assets) {
    if (!asset.text) continue;
    const key = `${asset.type}\0${asset.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(asset);
  }

  return deduped;
}

export function dedupePlansByTitle(plans: ExtractedAsset[]): ExtractedAsset[] {
  const seen = new Set<string>();
  const deduped: ExtractedAsset[] = [];

  for (const plan of plans) {
    const key = (plan.display || plan.text).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(plan);
  }

  return deduped;
}

export function capped(assets: ExtractedAsset[], cap: number): ExtractedAsset[] {
  return cap > 0 ? assets.slice(0, cap) : assets;
}
