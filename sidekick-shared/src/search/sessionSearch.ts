/** Provider-aware cross-session search. */

import { resolveProjectIdentity } from '../paths';
import type { SessionProviderBase, ProviderId, SessionFileInfo } from '../providers/types';

export interface SearchResult {
  providerId: ProviderId;
  projectPath: string;
  sessionPath: string;
  snippet: string;
  eventType: string;
  timestamp: string;
}

export interface SessionSearchOptions {
  /** Workspace path, resolved canonically. Takes precedence over projectSlug. */
  projectPath?: string;
  /** Legacy provider-encoded project identifier. */
  projectSlug?: string;
  maxResults?: number;
  /** Stop obsolete interactive searches between session reads. */
  signal?: AbortSignal;
}

async function enumerateSessions(
  provider: SessionProviderBase,
  options: SessionSearchOptions,
): Promise<SessionFileInfo[]> {
  const workspace = options.projectPath
    ? resolveProjectIdentity(options.projectPath).resolvedCwd
    : undefined;
  if (!options.projectSlug || workspace) {
    if (provider.listSessionFilesAsync) return provider.listSessionFilesAsync(workspace);
    if (workspace) {
      return provider
        .findAllSessions(workspace)
        .map((path) => ({ path, mtime: new Date(0), workspacePath: workspace }));
    }
    if (provider.listAllSessionFiles) return provider.listAllSessionFiles();
  }

  // Older/custom providers can expose virtual project directories. Let the
  // provider enumerate them instead of assuming a particular on-disk layout.
  const files: SessionFileInfo[] = [];
  for (const folder of provider.getAllProjectFolders()) {
    if (options.signal?.aborted) break;
    if (options.projectSlug && folder.encodedName !== options.projectSlug) continue;
    const paths =
      provider.id === 'codex'
        ? provider.findAllSessions(folder.name)
        : provider.findSessionsInDirectory(folder.dir);
    files.push(
      ...paths.map((path) => ({ path, mtime: folder.lastModified, workspacePath: folder.name })),
    );
  }
  return files;
}

export async function searchSessions(
  provider: SessionProviderBase,
  query: string,
  options: SessionSearchOptions = {},
): Promise<SearchResult[]> {
  const maxResults = options.maxResults ?? 50;
  const results: SearchResult[] = [];
  if (maxResults <= 0 || !query.trim() || options.signal?.aborted) return results;
  const files = await enumerateSessions(provider, options);
  const seen = new Set<string>();
  files.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  for (const file of files) {
    if (results.length >= maxResults || options.signal?.aborted) break;
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    try {
      const hits = provider.searchInSession(file.path, query, maxResults - results.length);
      for (const hit of hits.slice(0, maxResults - results.length)) {
        results.push({
          providerId: provider.id,
          projectPath: hit.projectPath || file.workspacePath || '',
          sessionPath: hit.sessionPath,
          snippet: hit.line,
          eventType: hit.eventType,
          timestamp: hit.timestamp,
        });
      }
    } catch {
      // An unreadable session must not hide matches in the remaining sessions.
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return results;
}
