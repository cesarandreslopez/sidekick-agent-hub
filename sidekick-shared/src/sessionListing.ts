/**
 * One listing of the Claude Code and Codex session files under a set of
 * workspace roots, shared by every collector that would otherwise list the
 * same files again.
 *
 * `collectPromptHistory`, `collectSessionPromptHistory`,
 * `findToolCallOrigins`, `collectUsageEvents` and `listSessionPreviewsAsync`
 * accept it as `listing`; each then skips its own listing and returns what
 * it would have returned with its own. A host that runs several of them on
 * a timer lists once per tick, and passing the previous listing as
 * `previous` reuses its directory caches, so an unchanged history costs one
 * stat per directory and one per file.
 *
 * The listing is the providers' candidate superset (Claude Code project
 * directories whose name matches a root, Codex rollouts whose cwd equals,
 * contains or sits inside one); each collector still applies its own scope
 * check. Files are re-stat'ed on every walk (`revalidateAll`), so sizes and
 * mtimes are current. Codex cwd reads are cached per rollout.
 *
 * Node-only.
 *
 * @module sessionListing
 */

import * as path from 'path';
import { resolveAgentHomes, type SessionHomesOptions } from './agentHomes';
import { getClaudeProjectsDir, getLiveClaudeHome } from './claudePaths';
import { getCodexMonitoringHomes } from './codexPaths';
import { resolveMonitoredHomes } from './monitoredHomes';
import { listClaudeSessionFilesAsync, workspaceDirectoryFilter } from './providers/claudeListing';
import {
  cwdMatches,
  getSessionsDirs,
  listCodexSessionFilesAsync,
  readSessionCwdAsync,
} from './providers/codexRollouts';
import { canReadCompressedRollouts } from './providers/compressedRollouts';
import { DirectoryListingCache } from './providers/directoryListingCache';
import { mapWithConcurrency } from './mapWithConcurrency';
import { computeSessionKey } from './sessionKey';
import { resolveWorkspaceRoots } from './workspaceRoots';

/** Codex rollout heads read at once by a first listing. */
const CODEX_CWD_READ_CONCURRENCY = 16;

export type SessionListingProvider = 'claude-code' | 'codex';

const LISTING_PROVIDERS: readonly SessionListingProvider[] = ['claude-code', 'codex'];

export interface ListAgentSessionsOptions {
  /** Absolute workspace roots; realpath-normalized internally. */
  workspacePaths: string[];
  /** Add each root's main checkout and git worktrees. Default true. */
  includeWorktrees?: boolean;
  /** Default both. */
  providers?: SessionListingProvider[];
  /** Only files modified at or after this instant. */
  since?: Date;
  /** Claude Code and Codex homes to list (see `SessionHomesOptions`). */
  homes?: SessionHomesOptions;
  /** Codex: also list compressed rollouts (`….jsonl.zst`). Default false. */
  includeCompressedRollouts?: boolean;
  /** An earlier listing whose directory caches to reuse. */
  previous?: SessionListing;
}

/** One session file of a listing. */
export interface SessionListingFile {
  provider: SessionListingProvider;
  sessionId: string;
  filePath: string;
  /** Same key prompt history, usage events and tool-call origins report. */
  sessionKey: string;
  sizeBytes: number;
  mtimeMs: number;
  /** Codex: the cwd `session_meta` records. Claude Code files carry none here. */
  workspacePath?: string;
}

/** What `listAgentSessions()` found; pass it to collectors as `listing`. */
export interface SessionListing {
  readonly version: 1;
  /** Realpaths of the roots, after worktree expansion; collectors scope by these. */
  roots: string[];
  /** The roots plus their unresolved spellings, as listed. */
  listingRoots: string[];
  includeWorktrees: boolean;
  providers: SessionListingProvider[];
  /** The `since` cutoff the files were listed with, in ms since epoch. */
  sinceMs: number | null;
  /** Homes listed (Codex: profile homes included when they applied). */
  homes: { claude: string[]; codex: string[] };
  includeCompressedRollouts: boolean;
  /** Ordered by provider, session id, then key. */
  files: SessionListingFile[];
  listedAtMs: number;
}

interface ListingCaches {
  claude: DirectoryListingCache;
  codex: DirectoryListingCache;
  /** What the caches were filled with; a cache is reused only for the same. */
  signature: string;
}

const caches = new WeakMap<SessionListing, ListingCaches>();

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** List the session files of every provider once for all roots. */
export async function listAgentSessions(
  options: ListAgentSessionsOptions,
): Promise<SessionListing> {
  if (!options || !Array.isArray(options.workspacePaths)) {
    throw new TypeError('listAgentSessions: `workspacePaths` must be an array of absolute paths.');
  }
  const sinceMs = options.since === undefined ? null : options.since.getTime();
  if (sinceMs !== null && !Number.isFinite(sinceMs)) {
    throw new RangeError('listAgentSessions: `since` is not a valid date.');
  }
  const includeWorktrees = options.includeWorktrees !== false;
  const providers = LISTING_PROVIDERS.filter((provider) =>
    (options.providers ?? LISTING_PROVIDERS).includes(provider),
  );
  const includeCompressedRollouts = options.includeCompressedRollouts === true;
  const homes = options.homes
    ? {
        claude: resolveAgentHomes(options.homes).claude,
        codex: resolveMonitoredHomes(options.homes).codex,
      }
    : { claude: [getLiveClaudeHome()], codex: getCodexMonitoringHomes() };
  const { roots, listingRoots } = resolveWorkspaceRoots(options.workspacePaths, {
    includeWorktrees,
  });

  const signature = JSON.stringify([homes, includeCompressedRollouts]);
  const reused = options.previous ? caches.get(options.previous) : undefined;
  const listingCaches: ListingCaches =
    reused && reused.signature === signature
      ? reused
      : { claude: new DirectoryListingCache(), codex: new DirectoryListingCache(), signature };

  const files: SessionListingFile[] = [];
  const add = (
    provider: SessionListingProvider,
    filePath: string,
    sessionId: string,
    sizeBytes: number,
    mtimeMs: number,
    workspacePath?: string,
  ): void => {
    files.push({
      provider,
      sessionId,
      filePath,
      sessionKey: computeSessionKey(provider, sessionId, filePath),
      sizeBytes,
      mtimeMs,
      ...(workspacePath ? { workspacePath } : {}),
    });
  };
  const sinceOption = sinceMs !== null ? { since: sinceMs } : {};

  if (roots.length > 0 && providers.includes('claude-code') && homes.claude.length > 0) {
    const filters = listingRoots.map((root) => workspaceDirectoryFilter(root));
    const listed = await listClaudeSessionFilesAsync(
      undefined,
      {
        ...sinceOption,
        revalidateAll: true,
        projectsDirs: homes.claude.map((home) => getClaudeProjectsDir(home)),
        directoryFilter: (name) => filters.some((matches) => matches(name)),
      },
      listingCaches.claude,
    );
    for (const file of listed) {
      add(
        'claude-code',
        file.path,
        file.sessionId ?? path.basename(file.path, '.jsonl'),
        file.sizeBytes ?? 0,
        file.mtime.getTime(),
      );
    }
  }

  if (roots.length > 0 && providers.includes('codex') && homes.codex.length > 0) {
    const listed = await listCodexSessionFilesAsync(
      undefined,
      {
        ...sinceOption,
        revalidateAll: true,
        includeCompressed: includeCompressedRollouts && canReadCompressedRollouts(),
        sessionsDirs: getSessionsDirs(homes.codex),
      },
      listingCaches.codex,
    );
    // Cached per rollout path, so repeat listings read no content; a first
    // listing reads the heads with bounded concurrency.
    const cwds = await mapWithConcurrency(
      listed,
      (file) => readSessionCwdAsync(file.path),
      CODEX_CWD_READ_CONCURRENCY,
    );
    for (const [index, file] of listed.entries()) {
      const cwd = cwds[index];
      if (!cwd || !listingRoots.some((root) => cwdMatches(cwd, root))) continue;
      add(
        'codex',
        file.path,
        file.sessionId ?? path.basename(file.path),
        file.sizeBytes ?? 0,
        file.mtime.getTime(),
        cwd,
      );
    }
  }

  files.sort(
    (left, right) =>
      compareStrings(left.provider, right.provider) ||
      compareStrings(left.sessionId, right.sessionId) ||
      compareStrings(left.sessionKey, right.sessionKey),
  );
  const listing: SessionListing = {
    version: 1,
    roots,
    listingRoots,
    includeWorktrees,
    providers,
    sinceMs,
    homes,
    includeCompressedRollouts,
    files,
    listedAtMs: Date.now(),
  };
  caches.set(listing, listingCaches);
  return listing;
}

/**
 * Throws `TypeError` when a collector is given a `listing` together with
 * any option the listing already decided.
 * @internal
 */
export function assertListingAlone(
  caller: string,
  options: Record<string, unknown>,
  conflicting: readonly string[],
): void {
  const given = conflicting.filter((name) => options[name] !== undefined);
  if (given.length > 0) {
    throw new TypeError(
      `${caller}: \`listing\` already fixes ${given.map((name) => `\`${name}\``).join(', ')}; pass one or the other.`,
    );
  }
}

/** A value that looks like a listing from `listAgentSessions()`. @internal */
export function isSessionListing(value: unknown): value is SessionListing {
  const listing = value as SessionListing | undefined;
  return (
    typeof listing === 'object' &&
    listing !== null &&
    listing.version === 1 &&
    Array.isArray(listing.roots) &&
    Array.isArray(listing.files)
  );
}
