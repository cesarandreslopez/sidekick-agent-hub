/**
 * Provider-aware cross-session search.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SessionProvider, SearchHit, ProviderId } from '../providers/types';

export interface SearchResult {
  providerId: ProviderId;
  projectPath: string;
  sessionPath: string;
  snippet: string;
  eventType: string;
  timestamp: string;
}

export async function searchSessions(
  provider: SessionProvider,
  query: string,
  opts?: { projectSlug?: string; maxResults?: number }
): Promise<SearchResult[]> {
  const maxResults = opts?.maxResults ?? 50;
  const results: SearchResult[] = [];
  const baseDir = provider.getProjectsBaseDir();

  try {
    if (!fs.existsSync(baseDir)) return results;

    // Get all project folders
    const folders = provider.getAllProjectFolders();

    for (const folder of folders) {
      if (results.length >= maxResults) break;

      // If projectSlug specified, filter by encoded name
      if (opts?.projectSlug && folder.encodedName !== opts.projectSlug) continue;

      // Get session files in this folder
      let sessionFiles: string[] = [];
      try {
        const dir = folder.dir;
        if (fs.existsSync(dir)) {
          const entries = fs.readdirSync(dir).filter(f =>
            f.endsWith('.jsonl') || f.endsWith('.json')
          );
          sessionFiles = entries.map(f => path.join(dir, f));
        }
      } catch { /* skip */ }

      // If no files found from dir scan, try findAllSessions with the folder name
      if (sessionFiles.length === 0) {
        // Use provider.findSessionFiles with the folder path as workspace
        // This handles DB-backed providers
        sessionFiles = provider.findSessionFiles(folder.name);
      }

      for (const sessionPath of sessionFiles) {
        if (results.length >= maxResults) break;
        const remaining = maxResults - results.length;
        const hits = provider.searchInSession(sessionPath, query, remaining);

        for (const hit of hits) {
          results.push({
            providerId: provider.id,
            projectPath: hit.projectPath || folder.name,
            sessionPath: hit.sessionPath,
            snippet: hit.line,
            eventType: hit.eventType,
            timestamp: hit.timestamp,
          });
        }
      }
    }
  } catch { /* skip */ }

  return results.slice(0, maxResults);
}
