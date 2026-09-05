/**
 * Factory for creating the correct session watcher by provider.
 */

import * as os from 'os';
import * as path from 'path';
import type { SessionProviderBase } from '../providers/types';
import type { SessionWatcher, SessionWatcherCallbacks } from './types';
import { JsonlSessionWatcher } from './jsonlWatcher';
import { ProviderReaderSessionWatcher } from './providerReaderWatcher';
import { SqliteSessionWatcher } from './sqliteWatcher';

export interface CreateWatcherOptions {
  provider: SessionProviderBase;
  workspacePath: string;
  sessionId?: string;
  callbacks: SessionWatcherCallbacks;
}

function getOpenCodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

/**
 * Resolve the session a command should act on: an exact or unique-prefix
 * match of `sessionId` among the workspace's sessions, or the most recent
 * session when no id is given. Throws with the available ids on a miss.
 */
export function resolveSessionPath(
  provider: SessionProviderBase,
  workspacePath: string,
  sessionId?: string,
): string {
  const sessions = provider.findAllSessions(workspacePath);

  if (sessions.length === 0) {
    throw new Error(`No sessions found for ${provider.displayName} in ${workspacePath}`);
  }

  if (!sessionId) return sessions[0]; // most recent

  const matches = sessions.map((sessionPath) => ({
    sessionPath,
    id: provider.getSessionId(sessionPath),
  }));
  const exact = matches.filter((candidate) => candidate.id === sessionId);
  const candidates =
    exact.length > 0 ? exact : matches.filter((candidate) => candidate.id.startsWith(sessionId));
  if (candidates.length === 0) {
    throw new Error(
      `Session ${sessionId} not found. Available: ${sessions
        .slice(0, 5)
        .map((s) => path.basename(s))
        .join(', ')}`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Session ${sessionId} is ambiguous. Matches: ${candidates
        .slice(0, 5)
        .map((candidate) => candidate.id)
        .join(', ')}`,
    );
  }
  return candidates[0].sessionPath;
}

export function createWatcher(options: CreateWatcherOptions): {
  watcher: SessionWatcher;
  sessionPath: string;
} {
  const { provider, workspacePath, sessionId, callbacks } = options;
  const sessionPath = resolveSessionPath(provider, workspacePath, sessionId);
  const watcher = createWatcherForProvider(provider, sessionPath, callbacks);
  return { watcher, sessionPath };
}

function createWatcherForProvider(
  provider: SessionProviderBase,
  sessionPath: string,
  callbacks: SessionWatcherCallbacks,
): SessionWatcher {
  switch (provider.id) {
    case 'claude-code':
      return new JsonlSessionWatcher(provider.id, sessionPath, callbacks);

    case 'codex':
      return new ProviderReaderSessionWatcher(provider, sessionPath, callbacks);

    case 'opencode': {
      const dataDir = getOpenCodeDataDir();
      const dbPath = path.join(dataDir, 'opencode.db');
      // Session ID is the basename without extension
      const sid = path.basename(sessionPath, '.json');
      return new SqliteSessionWatcher(dbPath, sid, callbacks);
    }

    default:
      throw new Error(`Unsupported provider: ${provider.id}`);
  }
}
