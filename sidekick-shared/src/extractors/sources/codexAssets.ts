/**
 * Codex CLI rollout reader for actionable asset extraction.
 *
 * Portions adapted from `trawl` by Juan Fourie (B33pBeeps), MIT licensed:
 * https://github.com/B33pBeeps/trawl
 *
 * @module extractors/sources/codexAssets
 */

import { join, resolve } from 'node:path';
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { getCodexMonitoringHomes } from '../../codexProfiles';
import {
  commandAsset,
  extractCommands,
  extractFilePaths,
  extractUrls,
  pathAsset,
  planAsset,
  urlAsset,
  type SourceAssets,
} from '../sessionAssets';

const EXEC_NAMES = new Set(['exec_command', 'shell', 'local_shell', 'container.exec']);

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function firstJsonLine(filePath: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }

  const buffer = Buffer.alloc(65536);
  let data = '';
  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      data += buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = data.indexOf('\n');
      if (newlineIndex >= 0) {
        data = data.slice(0, newlineIndex);
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

function readJsonl(filePath: string, skip?: (rawLine: string) => boolean): Array<Record<string, unknown>> {
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
    if (skip?.(trimmed)) continue;
    try {
      lines.push(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // Ignore partial or malformed JSONL lines.
    }
  }
  return lines;
}

function rolloutFiles(limit = 150): string[] {
  const entries: Array<{ path: string; mtime: number }> = [];
  const seen = new Set<string>();

  const walk = (dir: string): void => {
    let dirEntries: import('node:fs').Dirent[];
    try {
      dirEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirEntries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          if (seen.has(fullPath)) continue;
          seen.add(fullPath);
          entries.push({ path: fullPath, mtime: statSync(fullPath).mtimeMs });
        } catch {
          // Ignore inaccessible files.
        }
      }
    }
  };

  for (const home of getCodexMonitoringHomes()) {
    const sessionsDir = join(home, 'sessions');
    if (dirExists(sessionsDir)) walk(sessionsDir);
  }

  return entries.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((entry) => entry.path);
}

export function codexSessions(cwd: string, limit = 3): string[] {
  const exactCwd = resolve(cwd);
  const sessions: string[] = [];

  for (const filePath of rolloutFiles()) {
    const meta = firstJsonLine(filePath);
    const payload = meta?.payload as Record<string, unknown> | undefined;
    if (payload?.cwd === exactCwd) {
      sessions.push(filePath);
      if (sessions.length >= limit) break;
    }
  }

  return sessions;
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function commandFromLocalShell(item: Record<string, unknown>): string | undefined {
  const action = item.action as Record<string, unknown> | undefined;
  const command = action?.command;
  if (Array.isArray(command)) return command.map(String).join(' ');
  return asString(command);
}

function patchFiles(patch: unknown, cwd: string): Array<{ file: string; line?: number }> {
  const paths: Array<{ file: string; line?: number }> = [];
  for (const match of String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    for (const filePath of extractFilePaths(match[1].trim(), cwd)) {
      paths.push(filePath);
    }
  }
  return paths;
}

function addMessageAssets(acc: SourceAssets, text: unknown, cwd: string, timestamp?: string): void {
  for (const url of extractUrls(text)) acc.urls.push(urlAsset(url, timestamp));
  for (const filePath of extractFilePaths(text, cwd)) acc.paths.push(pathAsset(filePath, timestamp));
  for (const command of extractCommands(text)) acc.commands.push(commandAsset(command, timestamp));
}

function addExecutedCommandAssets(acc: SourceAssets, command: unknown, cwd: string, timestamp?: string): void {
  for (const url of extractUrls(command)) acc.urls.push(urlAsset(url, timestamp));
  for (const filePath of extractFilePaths(command, cwd)) acc.paths.push(pathAsset(filePath, timestamp));
}

export function readCodexAssets(cwd: string, limit = 3): SourceAssets {
  const exactCwd = resolve(cwd);
  const files = codexSessions(exactCwd, limit);
  const acc: SourceAssets = { urls: [], paths: [], commands: [], plans: [], hadSession: files.length > 0 };
  const skip = (line: string): boolean =>
    line.includes('"type":"function_call_output"') ||
    line.includes('"type":"reasoning"') ||
    line.includes('"type":"token_count"');

  for (const filePath of files) {
    for (const line of readJsonl(filePath, skip)) {
      const payload = line.payload as Record<string, unknown> | undefined;
      if (!payload) continue;
      const timestamp = asString(line.timestamp);

      if (payload.type === 'function_call') {
        if (EXEC_NAMES.has(payload.name as string)) {
          const args = parseArgs(payload.arguments);
          addExecutedCommandAssets(acc, args.cmd ?? args.command, exactCwd, timestamp);
        }
      } else if (payload.type === 'local_shell_call') {
        addExecutedCommandAssets(acc, commandFromLocalShell(payload), exactCwd, timestamp);
      } else if (payload.type === 'item_completed') {
        const item = payload.item as Record<string, unknown> | undefined;
        const text = asString(item?.text);
        if (item?.type === 'Plan' && text?.trim()) acc.plans.push(planAsset(text, timestamp));
      } else if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch') {
        for (const file of patchFiles(payload.input, exactCwd)) acc.paths.push(pathAsset(file, timestamp));
      } else if (payload.type === 'message' && Array.isArray(payload.content)) {
        for (const block of payload.content) {
          const typedBlock = block as Record<string, unknown>;
          addMessageAssets(acc, typedBlock.text, exactCwd, timestamp);
        }
      } else if (payload.type === 'agent_message') {
        addMessageAssets(acc, payload.message, exactCwd, timestamp);
      }
    }
  }

  return acc;
}
