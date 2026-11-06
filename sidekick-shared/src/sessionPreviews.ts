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
import { mapWithConcurrency } from './mapWithConcurrency';
import { readClaudeSessionCwdAsync } from './providers/claudeListing';
import { readSessionCwdAsync } from './providers/codexRollouts';
import { isCompressedRolloutPath, readRolloutHead } from './providers/compressedRollouts';
import { pathWithinRoots, resolveWorkspaceRoots } from './workspaceRoots';
import { assertListingAlone, isSessionListing, type SessionListing } from './sessionListing';
import type {
  ProviderId,
  SessionFileInfo,
  SessionProviderBase,
  SessionProviderDiagnostic,
} from './providers/types';

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
  /**
   * Byte budget for the generic prefix scan (default 16 KiB). `0` skips the
   * scan entirely for callers that ignore `firstTimestamp` and
   * `workspacePath`; both come back `null` and the file is not opened.
   */
  maxPrefixBytes?: number;
}

function emptyPrefixScan(): PrefixScan {
  return { firstTimestamp: null, workspacePath: null };
}

export interface ListSessionPreviewsOptions extends ReadSessionPreviewOptions {
  /** Maximum previews returned (default 50). Content reads happen only for the returned slice. */
  limit?: number;
  /** Restrict to one workspace (via `provider.findAllSessions`); omit for all workspaces. */
  workspacePath?: string;
  /** Skip files whose mtime is not strictly newer than this — cheap incremental refresh. */
  since?: Date | string;
}

export interface AsyncSessionPreviewOptions {
  /** Maximum concurrent stat/read units (default 4, hard-capped at 16). */
  concurrency?: number;
  /** Cooperative scheduler hook; defaults to setImmediate. */
  yieldBetweenReads?: () => Promise<void> | void;
}

export interface ReadSessionPreviewAsyncOptions
  extends ReadSessionPreviewOptions, AsyncSessionPreviewOptions {}

/**
 * How a scoped listing decides membership. `contained`: a session counts
 * only when the working directory it recorded resolves to one of the roots
 * or below one (fail closed: no cwd, or one that no longer exists, is out).
 * `listed`: whatever the providers' workspace filters return (Claude Code
 * matches project-directory names, Codex a cwd that equals, contains or
 * sits inside the root), which can include look-alike projects.
 */
export type SessionScopeMode = 'contained' | 'listed';

export interface ListSessionPreviewsAsyncOptions
  extends ListSessionPreviewsOptions, AsyncSessionPreviewOptions {
  /**
   * Restrict to the sessions of several workspaces, listed once each and
   * counted once even when roots overlap. Takes precedence over
   * `workspacePath`. Roots that do not resolve are dropped; when none
   * resolves, nothing is listed.
   */
  workspacePaths?: string[];
  /**
   * Also list each root's main checkout and git worktrees. Default true with
   * `workspacePaths`, false with `workspacePath`.
   */
  includeWorktrees?: boolean;
  /**
   * Default `contained` with `workspacePaths`, `listed` with `workspacePath`.
   * With `contained`, the check runs before `limit`, on each session's
   * recorded cwd (Codex: `session_meta`; Claude Code: the first record with
   * one, at most 1 MiB in).
   */
  scope?: SessionScopeMode;
  /**
   * A listing from `listAgentSessions()` to preview instead of enumerating
   * again: its files for the given providers (matched by id; a provider the
   * listing does not cover contributes nothing) and its roots, `contained`
   * by default. Passing `workspacePath`, `workspacePaths` or
   * `includeWorktrees` with it is a `TypeError`.
   */
  listing?: SessionListing;
}

export interface SessionPreviewListStats {
  /** Sessions a `contained` scope dropped because their cwd was missing or outside the roots. */
  sessionsOutOfScope: number;
}

export interface SessionPreviewReadResult {
  preview: SessionPreview | null;
  diagnostics: SessionProviderDiagnostic[];
}

export interface SessionPreviewListResult {
  previews: SessionPreview[];
  diagnostics: SessionProviderDiagnostic[];
  /** True when more candidates existed than `limit` allowed; the caller may offer a larger limit. */
  hasMore: boolean;
  /** Realpaths of the roots, after worktree expansion, when the listing was scoped by roots. */
  roots?: string[];
  /** Always set by `listSessionPreviewsAsync` (optional only for hand-built results). */
  stats?: SessionPreviewListStats;
}

const DEFAULT_PREFIX_BYTES = 16 * 1024;
const DEFAULT_LIMIT = 50;
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;

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
  let sizeBytes: number;
  let modifiedAt: string;
  try {
    const stats = fs.statSync(sessionPath);
    sizeBytes = stats.size;
    // Inside the try: an out-of-range mtime RangeErrors on serialization,
    // and this function's contract is to degrade, not throw.
    modifiedAt = stats.mtime.toISOString();
  } catch {
    let metadata: { mtime: Date } | null | undefined;
    try {
      metadata = provider.getSessionMetadata?.(sessionPath);
    } catch {
      return null;
    }
    if (!metadata) return null;
    sizeBytes = 0;
    try {
      modifiedAt = metadata.mtime.toISOString();
    } catch {
      return null;
    }
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

  const prefixBudget = options.maxPrefixBytes ?? DEFAULT_PREFIX_BYTES;
  const prefix = prefixBudget > 0 ? scanPrefix(sessionPath, prefixBudget) : emptyPrefixScan();

  return {
    provider: provider.id,
    sessionId,
    filePath: sessionPath,
    modifiedAt,
    sizeBytes,
    firstUserPrompt,
    firstTimestamp: prefix.firstTimestamp,
    workspacePath: prefix.workspacePath,
  };
}

/** Event-loop-safe counterpart to readSessionPreview with per-call degradation status. */
export async function readSessionPreviewAsync(
  provider: SessionProviderBase,
  sessionPath: string,
  options: ReadSessionPreviewAsyncOptions = {},
): Promise<SessionPreviewReadResult> {
  let labels: Map<string, string | null>;
  const diagnostics: SessionProviderDiagnostic[] = [];
  try {
    labels = await extractLabelsAsync(provider, [sessionPath], options);
  } catch {
    labels = new Map([[sessionPath, null]]);
    diagnostics.push({
      providerId: provider.id,
      kind: 'read_failed',
      severity: 'warning',
      phase: 'read',
      message: `${provider.id} session label was unavailable.`,
    });
  }
  const info = await statSessionFileAsync(provider, sessionPath);
  if (!info) {
    return {
      preview: null,
      diagnostics: dedupeDiagnostics([...diagnostics, ...providerDiagnostics(provider)]),
    };
  }
  const preview = await readSessionPreviewFromInfoAsync(
    provider,
    info,
    labels.get(sessionPath) ?? null,
    options,
  );
  return {
    preview,
    diagnostics: dedupeDiagnostics([...diagnostics, ...providerDiagnostics(provider)]),
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

/**
 * Lists previews without blocking the caller loop on corpus-wide synchronous
 * work. SQLite-backed providers perform at most one subprocess per call.
 */
export async function listSessionPreviewsAsync(
  providers: SessionProviderBase[],
  options: ListSessionPreviewsAsyncOptions = {},
): Promise<SessionPreviewListResult> {
  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  const sinceMs = resolveSinceMs(options.since);
  const stats: SessionPreviewListStats = { sessionsOutOfScope: 0 };
  const listing = options.listing;
  if (listing !== undefined) {
    if (!isSessionListing(listing)) {
      throw new TypeError(
        'listSessionPreviewsAsync: `listing` must come from listAgentSessions().',
      );
    }
    assertListingAlone('listSessionPreviewsAsync', options as Record<string, unknown>, [
      'workspacePath',
      'workspacePaths',
      'includeWorktrees',
    ]);
  }
  const scope = previewScope(options);
  if (scope && scope.roots.length === 0) {
    return { previews: [], diagnostics: [], hasMore: false, roots: [], stats };
  }
  const byPath = new Map<string, { provider: SessionProviderBase; info: SessionFileInfo }>();
  const operationDiagnostics: SessionProviderDiagnostic[] = [];
  const listingRoots: Array<string | undefined> = scope
    ? scope.listingRoots
    : [options.workspacePath];

  if (listing) {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    for (const file of listing.files) {
      const provider = byId.get(file.provider);
      if (!provider) continue;
      if (sinceMs !== null && file.mtimeMs <= sinceMs) continue;
      byPath.set(file.filePath, {
        provider,
        info: {
          path: file.filePath,
          mtime: new Date(file.mtimeMs),
          sizeBytes: file.sizeBytes,
          sessionId: file.sessionId,
          ...(file.workspacePath ? { workspacePath: file.workspacePath } : {}),
        },
      });
    }
  }

  await Promise.all(
    providers.map(async (provider) => {
      if (listing) return;
      for (const workspacePath of listingRoots) {
        let files: SessionFileInfo[] = [];
        try {
          // Sizes and mtimes are reported (and key the usage cache), so a reused
          // provider must re-stat files its directory cache already knows.
          files = provider.listSessionFilesAsync
            ? await provider.listSessionFilesAsync(workspacePath, { revalidateAll: true })
            : await enumerateSessionFilesAsyncFallback(provider, workspacePath, options);
        } catch {
          files = [];
          operationDiagnostics.push({
            providerId: provider.id,
            kind: 'read_failed',
            severity: 'error',
            phase: 'enumerate',
            message: `${provider.id} session enumeration failed.`,
          });
        }
        for (const info of files) {
          const mtimeMs = info.mtime.getTime();
          if (sinceMs !== null && mtimeMs <= sinceMs) continue;
          // Each root lists every provider again; keep each file once.
          if (!byPath.has(info.path)) byPath.set(info.path, { provider, info });
        }
      }
    }),
  );

  let candidates = [...byPath.values()];
  if (scope?.contained) {
    const realpaths = new Map<string, string | null>();
    const kept = await mapWithConcurrency(
      candidates,
      async (candidate) => {
        const cwd = await recordedCwd(candidate.provider, candidate.info);
        return pathWithinRoots(cwd, scope.roots, realpaths) ? candidate : null;
      },
      concurrency(options),
    );
    const inScope = kept.filter((candidate) => candidate !== null);
    stats.sessionsOutOfScope = candidates.length - inScope.length;
    candidates = inScope;
  }

  // Newest first; ties broken by provider and path so the order never
  // depends on which provider's enumeration finished first.
  candidates.sort(
    (left, right) =>
      right.info.mtime.getTime() - left.info.mtime.getTime() ||
      compareText(left.provider.id, right.provider.id) ||
      compareText(left.info.path, right.info.path),
  );
  const selected = candidates.slice(0, limit);
  const labels = new Map<SessionProviderBase, Map<string, string | null>>();
  await Promise.all(
    providers.map(async (provider) => {
      const paths = selected
        .filter((item) => item.provider === provider)
        .map((item) => item.info.path);
      if (paths.length === 0) return;
      try {
        labels.set(provider, await extractLabelsAsync(provider, paths, options));
      } catch {
        labels.set(provider, new Map(paths.map((sessionPath) => [sessionPath, null])));
        operationDiagnostics.push({
          providerId: provider.id,
          kind: 'read_failed',
          severity: 'warning',
          phase: 'read',
          message: `${provider.id} session labels were unavailable.`,
        });
      }
    }),
  );

  const previews = await mapWithConcurrency(
    selected,
    async ({ provider, info }) => {
      const preview = await readSessionPreviewFromInfoAsync(
        provider,
        info,
        labels.get(provider)?.get(info.path) ?? info.label ?? null,
        options,
      );
      await yieldControl(options);
      return preview;
    },
    concurrency(options),
  );

  return {
    previews: previews.filter((preview): preview is SessionPreview => preview !== null),
    hasMore: candidates.length > limit,
    diagnostics: dedupeDiagnostics([
      ...operationDiagnostics,
      ...providers.flatMap(providerDiagnostics),
    ]),
    ...(scope ? { roots: scope.roots } : {}),
    stats,
  };
}

interface PreviewScope {
  roots: string[];
  listingRoots: string[];
  contained: boolean;
}

/** Roots and scope mode of a listing, or undefined for an unscoped or legacy single-root one. */
function previewScope(options: ListSessionPreviewsAsyncOptions): PreviewScope | undefined {
  if (options.listing) {
    return {
      roots: options.listing.roots,
      listingRoots: options.listing.listingRoots,
      contained: (options.scope ?? 'contained') === 'contained',
    };
  }
  if (options.workspacePaths) {
    return {
      ...resolveWorkspaceRoots(options.workspacePaths, {
        includeWorktrees: options.includeWorktrees !== false,
      }),
      contained: (options.scope ?? 'contained') === 'contained',
    };
  }
  if (
    options.workspacePath &&
    (options.includeWorktrees === true || options.scope === 'contained')
  ) {
    return {
      ...resolveWorkspaceRoots([options.workspacePath], {
        includeWorktrees: options.includeWorktrees === true,
      }),
      contained: options.scope === 'contained',
    };
  }
  return undefined;
}

/** The working directory a session recorded, from its listing or a bounded read. */
async function recordedCwd(
  provider: SessionProviderBase,
  info: SessionFileInfo,
): Promise<string | null> {
  if (info.workspacePath) return info.workspacePath;
  try {
    if (provider.id === 'claude-code') return await readClaudeSessionCwdAsync(info.path);
    if (provider.id === 'codex') return await readSessionCwdAsync(info.path);
  } catch {
    // Unreadable: out of scope.
  }
  return null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveSinceMs(since: Date | string | undefined): number | null {
  if (since === undefined) return null;
  const ms = since instanceof Date ? since.getTime() : Date.parse(since);
  if (!Number.isFinite(ms)) {
    // An unparseable cutoff used to mean "no cutoff", silently returning
    // every session. Fail loudly instead so a typo cannot masquerade as a
    // full listing.
    throw new RangeError(`Invalid \`since\` value: ${String(since)}`);
  }
  return ms;
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

async function statSessionFileAsync(
  provider: SessionProviderBase,
  sessionPath: string,
): Promise<SessionFileInfo | null> {
  try {
    const stat = await fs.promises.stat(sessionPath);
    return {
      path: sessionPath,
      mtime: stat.mtime,
      sizeBytes: stat.size,
      sessionId: safeSessionId(provider, sessionPath),
    };
  } catch {
    let metadata: { mtime: Date } | null = null;
    try {
      // Async first: for DB-backed synthetic paths the sync variant can spawn
      // a blocking sqlite3 subprocess, defeating this API's event-loop safety.
      if (provider.getSessionMetadataAsync) {
        metadata = await provider.getSessionMetadataAsync(sessionPath);
      } else {
        metadata = provider.getSessionMetadata?.(sessionPath) ?? null;
      }
    } catch {
      metadata = null;
    }
    if (!metadata) return null;
    return {
      path: sessionPath,
      mtime: metadata.mtime,
      sizeBytes: 0,
      sessionId: safeSessionId(provider, sessionPath),
    };
  }
}

async function extractLabelsAsync(
  provider: SessionProviderBase,
  sessionPaths: readonly string[],
  options: AsyncSessionPreviewOptions,
): Promise<Map<string, string | null>> {
  if (provider.extractSessionLabelsAsync) {
    // Callers deliberately do not retry through the synchronous provider path
    // if this batch fails: DB-backed providers could otherwise spawn once per
    // session after their single async batch failed.
    return provider.extractSessionLabelsAsync(sessionPaths);
  }
  const values = new Map<string, string | null>();
  for (const sessionPath of sessionPaths) {
    values.set(sessionPath, await extractLabelWithYield(provider, sessionPath, options));
  }
  return values;
}

async function enumerateSessionFilesAsyncFallback(
  provider: SessionProviderBase,
  workspacePath: string | undefined,
  options: AsyncSessionPreviewOptions,
): Promise<SessionFileInfo[]> {
  await yieldControl(options);
  const paths = workspacePath
    ? provider.findAllSessions(workspacePath)
    : provider.listAllSessionFiles
      ? provider.listAllSessionFiles().map((item) => item.path)
      : provider
          .getAllProjectFolders()
          .flatMap((folder) => provider.findSessionsInDirectory(folder.dir));
  return (
    await mapWithConcurrency(
      [...new Set(paths)],
      async (sessionPath) => {
        const info = await statSessionFileAsync(provider, sessionPath);
        await yieldControl(options);
        return info;
      },
      concurrency(options),
    )
  ).filter((item): item is SessionFileInfo => item !== null);
}

async function readSessionPreviewFromInfoAsync(
  provider: SessionProviderBase,
  info: SessionFileInfo,
  firstUserPrompt: string | null,
  options: ReadSessionPreviewAsyncOptions,
): Promise<SessionPreview | null> {
  let modifiedAt: string;
  try {
    modifiedAt = info.mtime.toISOString();
  } catch {
    return null;
  }
  const prefixBudget = options.maxPrefixBytes ?? DEFAULT_PREFIX_BYTES;
  const prefix =
    prefixBudget > 0 ? await scanPrefixAsync(info.path, prefixBudget) : emptyPrefixScan();
  return {
    provider: provider.id,
    sessionId: info.sessionId ?? safeSessionId(provider, info.path),
    filePath: info.path,
    modifiedAt,
    sizeBytes: info.sizeBytes ?? 0,
    firstUserPrompt,
    firstTimestamp: prefix.firstTimestamp ?? info.createdAt?.toISOString() ?? null,
    workspacePath: prefix.workspacePath ?? info.workspacePath ?? null,
  };
}

async function extractLabelWithYield(
  provider: SessionProviderBase,
  sessionPath: string,
  options: AsyncSessionPreviewOptions,
): Promise<string | null> {
  await yieldControl(options);
  try {
    return provider.extractSessionLabel(sessionPath);
  } catch {
    return null;
  }
}

function safeSessionId(provider: SessionProviderBase, sessionPath: string): string {
  try {
    return provider.getSessionId(sessionPath);
  } catch {
    return '';
  }
}

function concurrency(options: AsyncSessionPreviewOptions): number {
  const requested = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isFinite(requested)) return DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, Math.floor(requested)));
}

async function yieldControl(options: AsyncSessionPreviewOptions): Promise<void> {
  if (options.yieldBetweenReads) {
    await options.yieldBetweenReads();
    return;
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function providerDiagnostics(provider: SessionProviderBase): SessionProviderDiagnostic[] {
  try {
    return [...(provider.getLastOperationStatus?.().diagnostics ?? [])];
  } catch {
    return [];
  }
}

function dedupeDiagnostics(
  diagnostics: readonly SessionProviderDiagnostic[],
): SessionProviderDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.providerId}\0${diagnostic.kind}\0${diagnostic.phase}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  if (isCompressedRolloutPath(sessionPath)) {
    // A compressed Codex rollout: scan its decompressed prefix.
    const head = readRolloutHead(sessionPath, Math.max(1, maxPrefixBytes) + 1);
    parsePrefixInto(
      result,
      head.subarray(0, Math.max(1, maxPrefixBytes)).toString('utf8'),
      head.length <= maxPrefixBytes,
    );
    return result;
  }
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

async function scanPrefixAsync(sessionPath: string, maxPrefixBytes: number): Promise<PrefixScan> {
  const result: PrefixScan = { firstTimestamp: null, workspacePath: null };
  if (isCompressedRolloutPath(sessionPath)) return scanPrefix(sessionPath, maxPrefixBytes);
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(sessionPath, 'r');
    const stats = await handle.stat();
    const readBytes = Math.min(stats.size, Math.max(1, maxPrefixBytes));
    const buffer = Buffer.alloc(readBytes);
    const { bytesRead } = await handle.read(buffer, 0, readBytes, 0);
    parsePrefixInto(result, buffer.toString('utf8', 0, bytesRead), bytesRead >= stats.size);
  } catch {
    return result;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return result;
}

function parsePrefixInto(result: PrefixScan, content: string, sawWholeFile: boolean): void {
  const lines = content.split('\n');
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
      if (typeof parsed.cwd === 'string' && parsed.cwd) result.workspacePath = parsed.cwd;
      else if (parsed.type === 'session_meta') {
        const payload = parsed.payload as Record<string, unknown> | undefined;
        if (payload && typeof payload.cwd === 'string' && payload.cwd) {
          result.workspacePath = payload.cwd;
        }
      }
    }
    if (result.firstTimestamp !== null && result.workspacePath !== null) break;
  }
}
