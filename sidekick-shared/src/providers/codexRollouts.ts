/**
 * Codex rollout-file helpers shared by the provider and by callers that only
 * list rollouts: bounded first-line reads, session_meta and cwd lookups, and
 * the async session-file listing. Kept apart from the provider class so a
 * listing does not bundle the provider's stats, context and reader code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { getCodexSessionsDirs } from '../codexPaths';
import { CODEX_SESSIONS_SUBDIR, codexRolloutDayCandidates } from '../codexLayout';
import type { CodexRolloutLine, CodexSessionMeta } from '../types/codex';
import { DirectoryListingCache } from './directoryListingCache';
import { walkRolloutFiles, walkRolloutFilesAsync } from './rolloutWalker';
import {
  isCompressedRolloutPath,
  readRolloutFirstLines,
  readRolloutHead,
} from './compressedRollouts';
import type { ListSessionFilesOptions, SessionFileInfo } from './types';
import { openRolloutReadHandle } from './compressedRollouts';
import {
  codexInheritedHistoryBoundary,
  withCodexStartMarker,
  type CodexInheritedHistoryBoundary,
} from '../parsers/codexInheritedHistory';

/**
 * Every directory across the monitored homes (or `homes`) that may hold
 * rollouts, archived ones included.
 */
export function getSessionsDirs(homes?: readonly string[]): string[] {
  return homes ? getCodexSessionsDirs(homes) : getCodexSessionsDirs();
}

/**
 * Read the first N complete lines from a file using chunked reads.
 * Handles arbitrarily long lines (Codex session_meta can be 10KB+), and
 * compressed rollouts (`.jsonl.zst`, decompressed when the runtime can).
 */
export function readFirstLines(
  filePath: string,
  maxLines: number,
  maxBytes = 256 * 1024,
): string[] {
  if (isCompressedRolloutPath(filePath)) {
    if (maxBytes === Infinity) {
      let limit = 64 * 1024;
      let head = readRolloutHead(filePath, limit);
      while (!head.includes(0x0a) && head.length === limit) {
        limit *= 2;
        head = readRolloutHead(filePath, limit);
      }
      return head.toString('utf8').split('\n').slice(0, maxLines);
    }
    return readRolloutFirstLines(filePath, maxLines, maxBytes);
  }
  const lines: string[] = [];
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }

  let pending = '';
  const decoder = new StringDecoder('utf8');
  let totalRead = 0;
  const chunkSize = 16384;

  try {
    while (totalRead < maxBytes && lines.length < maxLines) {
      const buf = Buffer.alloc(Math.min(chunkSize, maxBytes - totalRead));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, totalRead);
      if (bytesRead === 0) break;

      totalRead += bytesRead;
      pending += decoder.write(buf.subarray(0, bytesRead));

      let nlIdx: number;
      while ((nlIdx = pending.indexOf('\n')) !== -1 && lines.length < maxLines) {
        lines.push(pending.substring(0, nlIdx));
        pending = pending.substring(nlIdx + 1);
      }
    }

    if (pending.trim() && lines.length < maxLines) {
      lines.push(pending);
    }
  } finally {
    fs.closeSync(fd);
  }

  return lines;
}

/** Read session_meta from the beginning of a rollout file. */
export function readSessionMeta(rolloutPath: string): CodexSessionMeta | null {
  try {
    const lines = readFirstLines(rolloutPath, 1, Infinity);
    const firstLine = lines[0]?.trim();
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine) as CodexRolloutLine;
    if (parsed.type === 'session_meta') {
      return parsed.payload as CodexSessionMeta;
    }
  } catch {
    // Skip
  }
  return null;
}

/**
 * First line of a rollout, chunk-read without a fixed size cap. `complete` is false while the line has no newline yet
 * (a rollout that was just created) or the file could not be read, so
 * callers know not to cache the answer.
 */
export async function readFirstLineAsync(
  rolloutPath: string,
): Promise<{ line: string | null; complete: boolean }> {
  // Mirrors readSessionMeta()/readFirstLines(): chunk-read until the first
  // line is complete — session_meta carries
  // `instructions` and can far exceed a single chunk.
  const maxBytes = Infinity;
  const chunkSize = 64 * 1024;
  if (isCompressedRolloutPath(rolloutPath)) {
    // Compressed rollouts are complete: their first line is final.
    let limit = 64 * 1024;
    let head = readRolloutHead(rolloutPath, limit);
    while (!head.includes(0x0a) && head.length === limit) {
      limit *= 2;
      head = readRolloutHead(rolloutPath, limit);
    }
    if (head.length === 0) return { line: null, complete: false };
    const firstLine = head.toString('utf8').split('\n', 1)[0]?.trim();
    return { line: firstLine || null, complete: true };
  }
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(rolloutPath, 'r');
    const chunks: Buffer[] = [];
    let totalRead = 0;
    let newlineFound = false;
    while (totalRead < maxBytes && !newlineFound) {
      const buffer = Buffer.alloc(Math.min(chunkSize, maxBytes - totalRead));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalRead);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      totalRead += bytesRead;
      newlineFound = chunk.includes(0x0a);
    }
    const firstLine = Buffer.concat(chunks).toString('utf8').split('\n', 1)[0]?.trim();
    return { line: firstLine || null, complete: newlineFound };
  } catch {
    return { line: null, complete: false };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function parseSessionMetaLine(line: string | null): CodexSessionMeta | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as CodexRolloutLine;
    return parsed.type === 'session_meta' ? (parsed.payload as CodexSessionMeta) : null;
  } catch {
    return null;
  }
}

/**
 * Read the CWD from a rollout file's session_meta. Cached per path, bounded
 * so a long-lived host watching a large history cannot grow it without limit
 * (insertion order doubles as an eviction order).
 */
const CWD_CACHE_LIMIT = 5000;
const cwdCache = new Map<string, string | null>();
function rememberCwd(rolloutPath: string, cwd: string | null): void {
  if (!cwdCache.has(rolloutPath) && cwdCache.size >= CWD_CACHE_LIMIT) {
    const oldest = cwdCache.keys().next().value;
    if (oldest !== undefined) cwdCache.delete(oldest);
  }
  cwdCache.set(rolloutPath, cwd);
}

export function readSessionCwd(rolloutPath: string): string | null {
  const cached = cwdCache.get(rolloutPath);
  if (cached !== undefined) return cached;

  const meta = readSessionMeta(rolloutPath);
  const cwd = meta?.cwd || null;
  if (cwd !== null) rememberCwd(rolloutPath, cwd);
  return cwd;
}

/** Async twin of readSessionCwd, sharing its cache so repeat listings do no content reads. */
export async function readSessionCwdAsync(rolloutPath: string): Promise<string | null> {
  const cached = cwdCache.get(rolloutPath);
  if (cached !== undefined) return cached;

  const { line, complete } = await readFirstLineAsync(rolloutPath);
  const cwd = parseSessionMetaLine(line)?.cwd || null;
  // A rollout observed before its session_meta line is flushed has no cwd
  // yet; caching that null would hide the session from its workspace until
  // the entry aged out, so only conclusive answers are remembered.
  if (cwd !== null || complete) rememberCwd(rolloutPath, cwd);
  return cwd;
}

/** Built-in enumerators report explicit zeros rather than leaving a counter unset. */
export function initializeCounters(stats: ListSessionFilesOptions['stats']): void {
  if (!stats) return;
  stats.directoriesListed ??= 0;
  stats.directoriesStatted ??= 0;
  stats.filesStatted ??= 0;
}

/** Check if a session's CWD matches a workspace path. */
export function cwdMatches(sessionCwd: string, workspacePath: string): boolean {
  const normalizedSession = normalizePath(sessionCwd);
  const normalizedWorkspace = normalizePath(workspacePath);

  return (
    normalizedSession === normalizedWorkspace ||
    normalizedWorkspace.startsWith(normalizedSession + path.sep) ||
    normalizedSession.startsWith(normalizedWorkspace + path.sep)
  );
}

/** Normalize a path using realpathSync. */
export function normalizePath(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

/** Options for {@link listCodexSessionFilesAsync}. */
export interface ListCodexSessionFilesOptions extends ListSessionFilesOptions {
  /**
   * Also list compressed rollouts (`.jsonl.zst`; default false). Do not
   * reuse one `cache` across calls that differ in this option.
   */
  includeCompressed?: boolean;
  /**
   * Rollout directories to walk (default every monitored home's
   * `sessions/` and `archived_sessions/`; see `getCodexSessionsDirs()`).
   */
  sessionsDirs?: readonly string[];
}

/**
 * List rollout files across the monitored Codex homes, newest first. With
 * `workspacePath`, keeps rollouts whose session_meta cwd equals, contains, or
 * sits inside it.
 */
export async function listCodexSessionFilesAsync(
  workspacePath?: string,
  options: ListCodexSessionFilesOptions = {},
  cache: DirectoryListingCache = new DirectoryListingCache(),
): Promise<SessionFileInfo[]> {
  const results: SessionFileInfo[] = [];
  initializeCounters(options.stats);
  // One capped walk across the homes (deduplicated, newest first) through
  // the directory cache. With a workspace filter the limit applies after
  // filtering, so the walk itself is bounded only by its file cap.
  const files = await walkRolloutFilesAsync(options.sessionsDirs ?? getSessionsDirs(), {
    limit: workspacePath ? undefined : options.limit,
    since: options.since,
    cache,
    revalidateRecent: options.revalidateRecent,
    revalidateAll: options.revalidateAll,
    stats: options.stats,
    includeCompressed: options.includeCompressed,
  });
  for (const file of files) {
    if (options.limit !== undefined && results.length >= options.limit) break;
    const info: SessionFileInfo = { ...file };
    if (workspacePath) {
      const cwd = await readSessionCwdAsync(file.path);
      if (!cwd || !cwdMatches(cwd, workspacePath)) continue;
      info.workspacePath = cwd;
    }
    results.push(info);
  }
  return results;
}

export interface FindCodexRolloutFileOptions {
  /**
   * Codex home whose `sessions/` subtree to search. Defaults to every
   * monitored home: `$CODEX_HOME` if set, else `~/.codex`, plus managed
   * profile homes that recorded sessions.
   */
  codexHome?: string;
  /**
   * Codex homes to search, in order (ignored when `codexHome` is set).
   * Defaults to every monitored home.
   */
  codexHomes?: readonly string[];
  /**
   * Also match a compressed rollout (`.jsonl.zst`) when no `.jsonl` for the
   * id exists (default false).
   */
  includeCompressed?: boolean;
}

/**
 * Locates the rollout file for a Codex session id by walking
 * `<home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`, then
 * `<home>/archived_sessions/`, where Codex moves the rollouts of archived
 * threads.
 *
 * Filename-only match, case-insensitive on the id — no file contents are read
 * and files are only stat'ed once their name matches, so the walk stays cheap
 * even over a large history. When the same id exists in more than one home,
 * the most recently modified copy wins, and a live `.jsonl` beats a
 * compressed copy. Returns `null` for an unknown, empty, or whitespace id.
 * Consumers who want the database's answer instead can query the
 * already-public `CodexDatabase` (requires the external `sqlite3` binary).
 *
 * For a UUIDv7 id (every current Codex thread), the dated folders its
 * creation time points to ({@link codexRolloutDayCandidates}) and the
 * archive folders are searched first, across every home; the full walk runs
 * only when they hold no copy. A copy moved by hand into another dated
 * folder is therefore found only when no copy sits where Codex files it.
 */
export function findCodexRolloutFile(
  sessionId: string,
  options: FindCodexRolloutFileOptions = {},
): string | null {
  const normalizedId = sessionId.trim().toLowerCase();
  if (!normalizedId) return null;

  const sessionsDirs = options.codexHome
    ? getCodexSessionsDirs([options.codexHome])
    : getSessionsDirs(options.codexHomes);
  const walkOptions = { sessionId: normalizedId, includeCompressed: options.includeCompressed };
  // A live `.jsonl` wins over a compressed copy found in another home; the
  // walker returns newest modification first.
  const pick = (matches: { path: string }[]): string | null =>
    (matches.find((file) => !isCompressedRolloutPath(file.path)) ?? matches[0])?.path ?? null;

  const days = codexRolloutDayCandidates(normalizedId);
  if (days.length > 0) {
    // Dated folders of each `sessions/` root; archive roots are searched whole.
    const hinted = sessionsDirs.flatMap((dir) =>
      path.basename(dir) === CODEX_SESSIONS_SUBDIR ? days.map((day) => path.join(dir, day)) : [dir],
    );
    const found = pick(walkRolloutFiles(hinted, walkOptions));
    if (found) return found;
  }

  // Name-only filter, one walk across the homes, newest modification first.
  return pick(walkRolloutFiles(sessionsDirs, walkOptions));
}

// ── Inherited-history boundary of one rollout file ──

/** Options for {@link readCodexInheritedHistoryBoundary}. */
export interface ReadCodexInheritedHistoryBoundaryOptions {
  /**
   * For a proven fork, also read on to its first own record (ordinal
   * `ownFromOrdinal`, the end of the embedded parent history) to report
   * `startMarker` and `ownStartOffset`. Lines in between are counted, not
   * parsed. Default false: only the first two records are read.
   */
  locateOwnStart?: boolean;
  /**
   * Bytes read past the first line, which is always read whole (Codex's
   * `session_meta` carries its instructions). Default 16 MiB. A read that
   * stops here before deciding reports `pending` with reason `scan-limit`.
   */
  maxScanBytes?: number;
}

/** {@link CodexInheritedHistoryBoundary} as read from a file. */
export interface CodexInheritedHistoryRead extends CodexInheritedHistoryBoundary {
  /**
   * With `locateOwnStart`, for a proven fork whose first own record was
   * found: the byte offset of its line (in the decompressed content of a
   * `.jsonl.zst`).
   */
  ownStartOffset?: number;
}

const DEFAULT_BOUNDARY_SCAN_BYTES = 16 * 1024 * 1024;
const BOUNDARY_READ_CHUNK_BYTES = 64 * 1024;

function parseRolloutLine(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * The inherited-history boundary of a Codex rollout file (see
 * `codexInheritedHistoryBoundary()`): whether it embeds a parent's history
 * and, when proven, the ordinal its own records start at. Reads the first
 * line whole and the next within `maxScanBytes`; a `.jsonl.zst` is
 * decompressed. A plain `.jsonl` is never taken as complete, since Codex may
 * still be writing it, so a fresh child rollout stays `pending` until its
 * second record lands; a compressed rollout is complete. Never rejects: an
 * unreadable file reports `pending` (`awaiting-records`).
 */
export async function readCodexInheritedHistoryBoundary(
  rolloutPath: string,
  options: ReadCodexInheritedHistoryBoundaryOptions = {},
): Promise<CodexInheritedHistoryRead> {
  const maxScanBytes =
    typeof options.maxScanBytes === 'number' && options.maxScanBytes >= 0
      ? options.maxScanBytes
      : DEFAULT_BOUNDARY_SCAN_BYTES;
  const complete = isCompressedRolloutPath(rolloutPath);
  let handle: Awaited<ReturnType<typeof openRolloutReadHandle>>['handle'];
  try {
    ({ handle } = await openRolloutReadHandle(rolloutPath));
  } catch {
    return codexInheritedHistoryBoundary([], { complete: false });
  }

  const records: unknown[] = [];
  let boundary = codexInheritedHistoryBoundary(records, { complete: false });
  let ownStart: { row: unknown; offset: number } | undefined;
  let scanLimited = false;
  let lineIndex = 0;
  // Line k holds ordinal k: Codex numbers every record it writes.
  const needed = (index: number): boolean =>
    index <= 1 ||
    (options.locateOwnStart === true &&
      boundary.status === 'proven' &&
      index === boundary.ownFromOrdinal);
  const settled = (): boolean => {
    if (lineIndex < 1 || boundary.status === 'pending') return false;
    if (!options.locateOwnStart || boundary.status !== 'proven') return true;
    return ownStart !== undefined || lineIndex > (boundary.ownFromOrdinal ?? 0);
  };
  const accept = (line: Buffer, offset: number): void => {
    if (lineIndex <= 1) {
      records.push(parseRolloutLine(line));
      boundary = codexInheritedHistoryBoundary(records, { complete: false });
    } else {
      ownStart = { row: parseRolloutLine(line), offset };
    }
  };

  try {
    const chunk = Buffer.alloc(BOUNDARY_READ_CHUNK_BYTES);
    let position = 0;
    let lineStart = 0;
    let firstLineEnd: number | null = null;
    let pieces: Buffer[] = [];
    reading: while (!settled()) {
      const budgetEnd = firstLineEnd === null ? Infinity : firstLineEnd + maxScanBytes;
      if (position >= budgetEnd) {
        scanLimited = true;
        break;
      }
      const want = Math.min(chunk.length, budgetEnd - position);
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let index = 0;
      while (index < bytesRead) {
        const newline = view.indexOf(0x0a, index);
        const end = newline === -1 ? bytesRead : newline;
        // Only the lines that decide anything are buffered.
        if (needed(lineIndex)) pieces.push(Buffer.from(view.subarray(index, end)));
        if (newline === -1) break;
        if (firstLineEnd !== null && position + newline + 1 > firstLineEnd + maxScanBytes) {
          scanLimited = true;
          break reading;
        }
        if (needed(lineIndex)) accept(Buffer.concat(pieces), lineStart);
        pieces = [];
        lineStart = position + newline + 1;
        if (lineIndex === 0) firstLineEnd = lineStart;
        lineIndex++;
        index = newline + 1;
        if (settled()) break reading;
      }
      position += bytesRead;
    }
    // A compressed rollout's last line needs no newline to be complete.
    if (complete && !scanLimited && !settled() && pieces.length > 0 && needed(lineIndex)) {
      accept(Buffer.concat(pieces), lineStart);
      lineIndex++;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  let result: CodexInheritedHistoryRead =
    boundary.status === 'pending'
      ? codexInheritedHistoryBoundary(records, { complete: complete && !scanLimited })
      : boundary;
  if (scanLimited && result.status === 'pending') result = { ...result, reason: 'scan-limit' };
  if (ownStart && result.status === 'proven') {
    const marked = withCodexStartMarker(result, ownStart.row);
    if (marked !== result) result = { ...marked, ownStartOffset: ownStart.offset };
  }
  return result;
}
