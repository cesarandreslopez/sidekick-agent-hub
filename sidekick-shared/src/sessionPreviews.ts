/**
 * Cheap, bounded previews of provider-native session files (Node-only).
 *
 * `listRecentSessions` answers "what happened in this workspace" but labels
 * every discovered session before applying its limit, so its cost scales with
 * total session count. This module inverts the order of operations: enumerate
 * with stats only, sort by mtime, apply `since`/`limit`, and only then do
 * bounded content reads for the survivors. That keeps a "recent sessions"
 * surface cheap even against a machine with thousands of accumulated sessions.
 *
 * Prompt extraction delegates to each provider's `extractSessionLabel` (Claude
 * Code reads only the first 8 KiB; Codex prefers the sqlite thread title, else
 * a bounded first-user-message scan that skips injected context). The first
 * timestamp and workspace path come from one generic prefix parse in this
 * module. A session whose opening events are larger than the prefix budget
 * yields `null` fields rather than an error.
 *
 * @module sessionPreviews
 */

import * as fs from 'fs';
import type { ProviderId, SessionFileInfo, SessionProviderBase } from './providers/types';

export interface SessionPreview {
  provider: ProviderId;
  sessionId: string;
  filePath: string;
  /** ISO mtime of the session file. */
  modifiedAt: string;
  sizeBytes: number;
  /**
   * First real user prompt, as truncated by the provider (~60 chars). Codex
   * may substitute the sqlite thread title when the database is reachable.
   */
  firstUserPrompt: string | null;
  /** ISO timestamp of the first event found in the bounded prefix, if any. */
  firstTimestamp: string | null;
  /** Workspace/cwd recorded in the prefix (Claude `cwd`, Codex `session_meta.payload.cwd`), if any. */
  workspacePath: string | null;
}

export interface ReadSessionPreviewOptions {
  /** Byte budget for the generic prefix scan (default 16 KiB). */
  maxPrefixBytes?: number;
}

export interface ListSessionPreviewsOptions extends ReadSessionPreviewOptions {
  /** Maximum previews returned (default 50). Content reads happen only for the returned slice. */
  limit?: number;
  /** Restrict to one workspace (via `provider.findAllSessions`); omit for all workspaces. */
  workspacePath?: string;
  /** Skip files whose mtime is not strictly newer than this — cheap incremental refresh. */
  since?: Date | string;
}

const DEFAULT_PREFIX_BYTES = 16 * 1024;
const DEFAULT_LIMIT = 50;

/**
 * Reads a bounded preview of one session file. Returns `null` when the file is
 * missing or unreadable; malformed content degrades to `null` fields instead
 * of throwing.
 */
export function readSessionPreview(
  provider: SessionProviderBase,
  sessionPath: string,
  options: ReadSessionPreviewOptions = {},
): SessionPreview | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(sessionPath);
  } catch {
    return null;
  }

  let firstUserPrompt: string | null = null;
  try {
    firstUserPrompt = provider.extractSessionLabel(sessionPath);
  } catch {
    // Label extraction is best-effort.
  }

  let sessionId = '';
  try {
    sessionId = provider.getSessionId(sessionPath);
  } catch {
    // A provider that cannot identify the file still yields a usable preview.
  }

  const prefix = scanPrefix(sessionPath, options.maxPrefixBytes ?? DEFAULT_PREFIX_BYTES);

  return {
    provider: provider.id,
    sessionId,
    filePath: sessionPath,
    modifiedAt: stats.mtime.toISOString(),
    sizeBytes: stats.size,
    firstUserPrompt,
    firstTimestamp: prefix.firstTimestamp,
    workspacePath: prefix.workspacePath,
  };
}

/**
 * Lists previews across providers, newest first. Enumeration is stat-only;
 * content is read only for the post-`limit` survivors.
 */
export function listSessionPreviews(
  providers: SessionProviderBase[],
  options: ListSessionPreviewsOptions = {},
): SessionPreview[] {
  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  const sinceMs = resolveSinceMs(options.since);

  const candidates: Array<{ provider: SessionProviderBase; path: string; mtimeMs: number }> = [];
  for (const provider of providers) {
    for (const file of enumerateSessionFiles(provider, options.workspacePath)) {
      const mtimeMs = file.mtime.getTime();
      if (sinceMs !== null && mtimeMs <= sinceMs) continue;
      candidates.push({ provider, path: file.path, mtimeMs });
    }
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const previews: SessionPreview[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    const preview = readSessionPreview(candidate.provider, candidate.path, options);
    if (preview) previews.push(preview);
  }
  return previews;
}

function resolveSinceMs(since: Date | string | undefined): number | null {
  if (since === undefined) return null;
  const ms = since instanceof Date ? since.getTime() : Date.parse(since);
  return Number.isFinite(ms) ? ms : null;
}

function enumerateSessionFiles(
  provider: SessionProviderBase,
  workspacePath: string | undefined,
): SessionFileInfo[] {
  try {
    if (workspacePath) {
      return provider
        .findAllSessions(workspacePath)
        .map(statSessionFile)
        .filter((info): info is SessionFileInfo => info !== null);
    }

    if (provider.listAllSessionFiles) return provider.listAllSessionFiles();

    // Best-effort global fallback for providers without listAllSessionFiles:
    // correct for project-folder-shaped providers, empty otherwise.
    const results: SessionFileInfo[] = [];
    const seen = new Set<string>();
    for (const folder of provider.getAllProjectFolders()) {
      for (const sessionPath of provider.findSessionsInDirectory(folder.dir)) {
        if (seen.has(sessionPath)) continue;
        seen.add(sessionPath);
        const info = statSessionFile(sessionPath);
        if (info) results.push(info);
      }
    }
    return results;
  } catch {
    return [];
  }
}

function statSessionFile(sessionPath: string): SessionFileInfo | null {
  try {
    return { path: sessionPath, mtime: fs.statSync(sessionPath).mtime };
  } catch {
    return null;
  }
}

interface PrefixScan {
  firstTimestamp: string | null;
  workspacePath: string | null;
}

/**
 * Parses complete JSONL lines out of the first `maxPrefixBytes` of a file,
 * taking the first top-level `timestamp` string and the first workspace path
 * (top-level `cwd`, or `payload.cwd` on a Codex `session_meta` row). Partial
 * trailing lines and malformed rows are skipped; never throws.
 */
function scanPrefix(sessionPath: string, maxPrefixBytes: number): PrefixScan {
  const result: PrefixScan = { firstTimestamp: null, workspacePath: null };

  let content: string;
  let sawWholeFile: boolean;
  try {
    const descriptor = fs.openSync(sessionPath, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      const readBytes = Math.min(size, Math.max(1, maxPrefixBytes));
      const buffer = Buffer.alloc(readBytes);
      fs.readSync(descriptor, buffer, 0, readBytes, 0);
      content = buffer.toString('utf8');
      sawWholeFile = readBytes >= size;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return result;
  }

  const lines = content.split('\n');
  // The final chunk after the last newline is a partial line unless the whole
  // file fit in the prefix.
  const completeLines = sawWholeFile ? lines : lines.slice(0, -1);

  for (const line of completeLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;

    if (result.firstTimestamp === null && typeof parsed.timestamp === 'string') {
      result.firstTimestamp = parsed.timestamp;
    }
    if (result.workspacePath === null) {
      if (typeof parsed.cwd === 'string' && parsed.cwd) {
        result.workspacePath = parsed.cwd;
      } else if (parsed.type === 'session_meta') {
        const payload = parsed.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload.cwd === 'string' && payload.cwd) {
          result.workspacePath = payload.cwd;
        }
      }
    }
    if (result.firstTimestamp !== null && result.workspacePath !== null) break;
  }

  return result;
}
