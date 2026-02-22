/**
 * Factory for creating the correct session watcher by provider.
 */

import * as os from 'os';
import * as path from 'path';
import type { ProviderId, SessionProvider } from '../providers/types';
import type { SessionWatcher, SessionWatcherCallbacks } from './types';
import { JsonlSessionWatcher } from './jsonlWatcher';
import { SqliteSessionWatcher } from './sqliteWatcher';

export interface CreateWatcherOptions {
  provider: SessionProvider;
  workspacePath: string;
  sessionId?: string;
  callbacks: SessionWatcherCallbacks;
}

function getOpenCodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

export function createWatcher(options: CreateWatcherOptions): { watcher: SessionWatcher; sessionPath: string } {
  const { provider, workspacePath, sessionId, callbacks } = options;
  const sessions = provider.findAllSessions(workspacePath);

  if (sessions.length === 0) {
    throw new Error(`No sessions found for ${provider.displayName} in ${workspacePath}`);
  }

  let sessionPath: string;
  if (sessionId) {
    const match = sessions.find(s => s.includes(sessionId));
    if (!match) {
      throw new Error(`Session ${sessionId} not found. Available: ${sessions.slice(0, 5).map(s => path.basename(s)).join(', ')}`);
    }
    sessionPath = match;
  } else {
    sessionPath = sessions[0]; // most recent
  }

  const watcher = createWatcherForProvider(provider.id, sessionPath, callbacks);
  return { watcher, sessionPath };
}

function createWatcherForProvider(
  providerId: ProviderId,
  sessionPath: string,
  callbacks: SessionWatcherCallbacks,
): SessionWatcher {
  switch (providerId) {
    case 'claude-code':
    case 'codex':
      return new JsonlSessionWatcher(providerId, sessionPath, callbacks);

    case 'opencode': {
      const dataDir = getOpenCodeDataDir();
      const dbPath = path.join(dataDir, 'opencode.db');
      // Session ID is the basename without extension
      const sid = path.basename(sessionPath, '.json');
      return new SqliteSessionWatcher(dbPath, sid, callbacks);
    }

    default:
      throw new Error(`Unsupported provider: ${providerId}`);
  }
}
