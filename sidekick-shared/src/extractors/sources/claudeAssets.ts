/**
 * Claude Code transcript reader for actionable asset extraction.
 *
 * Portions adapted from `trawl` by Juan Fourie (B33pBeeps), MIT licensed:
 * https://github.com/B33pBeeps/trawl
 *
 * @module extractors/sources/claudeAssets
 */

import { join } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { getSessionDirectory } from '../../parsers/sessionPathResolver';
import {
  commandAsset,
  extractCommands,
  extractFilePaths,
  extractUrls,
  isExistingFile,
  pathAsset,
  planAsset,
  readPlanFile,
  urlAsset,
  type SourceAssets,
} from '../sessionAssets';

const PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function filesByMtimeDesc(dir: string, filter: (name: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter(filter)
    .map((name) => join(dir, name))
    .map((filePath) => {
      try {
        return { path: filePath, mtime: statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { path: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.path);
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  const lines: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Ignore partial or malformed JSONL lines.
    }
  }
  return lines;
}

export function claudeSessions(cwd: string, limit = 3): string[] {
  const dir = getSessionDirectory(cwd);
  if (!dirExists(dir)) return [];
  return filesByMtimeDesc(dir, (name) => name.endsWith('.jsonl')).slice(0, limit);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function addTextAssets(acc: SourceAssets, text: unknown, cwd: string, timestamp?: string): void {
  for (const url of extractUrls(text)) acc.urls.push(urlAsset(url, timestamp));
  for (const filePath of extractFilePaths(text, cwd)) acc.paths.push(pathAsset(filePath, timestamp));
  for (const command of extractCommands(text)) acc.commands.push(commandAsset(command, timestamp));
}

function addToolPathAssets(acc: SourceAssets, value: unknown, cwd: string, timestamp?: string): void {
  for (const filePath of extractFilePaths(value, cwd)) {
    acc.paths.push(pathAsset(filePath, timestamp));
  }
}

function accumClaude(filePath: string, cwd: string, acc: SourceAssets): void {
  for (const line of readJsonl(filePath)) {
    const timestamp = asString(line.timestamp);

    if (line.type === 'attachment') {
      const attachment = line.attachment as Record<string, unknown> | undefined;
      const planFilePath = asString(attachment?.planFilePath);
      if (planFilePath && isExistingFile(planFilePath)) {
        const text = readPlanFile(planFilePath);
        if (text?.trim()) acc.plans.push(planAsset(text, timestamp));
      }
      continue;
    }

    const message = line.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string') {
      addTextAssets(acc, content, cwd, timestamp);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === 'text') {
        addTextAssets(acc, typedBlock.text, cwd, timestamp);
        continue;
      }
      if (typedBlock.type !== 'tool_use') continue;

      const name = asString(typedBlock.name);
      const input = (typedBlock.input as Record<string, unknown>) || {};

      if (name === 'Bash') {
        for (const url of extractUrls(input.command)) acc.urls.push(urlAsset(url, timestamp));
        addToolPathAssets(acc, input.command, cwd, timestamp);
      } else if (name && PATH_TOOLS.has(name)) {
        addToolPathAssets(acc, input.file_path, cwd, timestamp);
      } else if (name === 'WebFetch' || name === 'WebSearch') {
        for (const url of extractUrls(JSON.stringify(input))) acc.urls.push(urlAsset(url, timestamp));
      } else if (name === 'ExitPlanMode') {
        const inline = asString(input.plan);
        const markdown = inline?.trim() ? inline : readPlanFile(asString(input.planFilePath));
        if (markdown?.trim()) acc.plans.push(planAsset(markdown, timestamp));
      }
    }
  }
}

export function readClaudeAssets(cwd: string, limit = 3): SourceAssets {
  const sessions = claudeSessions(cwd, limit);
  const acc: SourceAssets = { urls: [], paths: [], commands: [], plans: [], hadSession: sessions.length > 0 };
  for (const session of sessions) accumClaude(session, cwd, acc);
  return acc;
}
