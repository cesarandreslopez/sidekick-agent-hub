/**
 * Filesystem-based provider auto-detection.
 * Ported from sidekick-vscode/src/services/providers/ProviderDetector.ts
 * without VS Code dependency (no vscode.workspace.getConfiguration).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProviderId } from './types';

function getOpenCodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, 'opencode');
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

function getCodexHome(): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome) return envHome;
  return path.join(os.homedir(), '.codex');
}

function getMostRecentMtime(dir: string): number {
  try {
    if (!fs.existsSync(dir)) return 0;
    let latest = 0;
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      try {
        const stats = fs.statSync(path.join(dir, entry));
        if (stats.mtime.getTime() > latest) {
          latest = stats.mtime.getTime();
        }
      } catch { /* skip */ }
    }
    return latest;
  } catch {
    return 0;
  }
}

function getOpenCodeActivityMtime(): number {
  const dataDir = getOpenCodeDataDir();
  const dbPath = path.join(dataDir, 'opencode.db');
  try {
    const dbMtime = fs.statSync(dbPath).mtime.getTime();
    if (dbMtime > 0) return dbMtime;
  } catch { /* no DB */ }
  const storageDir = path.join(dataDir, 'storage');
  const sessionMtime = getMostRecentMtime(path.join(storageDir, 'session'));
  const messageMtime = getMostRecentMtime(path.join(storageDir, 'message'));
  const partMtime = getMostRecentMtime(path.join(storageDir, 'part'));
  return Math.max(sessionMtime, messageMtime, partMtime);
}

function getCodexActivityMtime(): number {
  const codexHome = getCodexHome();
  const dbPath = path.join(codexHome, 'state.sqlite');
  try {
    const dbMtime = fs.statSync(dbPath).mtime.getTime();
    if (dbMtime > 0) return dbMtime;
  } catch { /* no DB */ }
  return getMostRecentMtime(path.join(codexHome, 'sessions'));
}

/**
 * Returns all provider IDs whose data directories exist on the filesystem.
 * Ordered by most-recent activity first.
 */
export function getAllDetectedProviders(): ProviderId[] {
  const claudeBase = path.join(os.homedir(), '.claude', 'projects');
  const openCodeDataDir = getOpenCodeDataDir();
  const openCodeDbPath = path.join(openCodeDataDir, 'opencode.db');
  const openCodeStorageDir = path.join(openCodeDataDir, 'storage');
  const codexHome = getCodexHome();
  const codexSessionsDir = path.join(codexHome, 'sessions');
  const codexDbPath = path.join(codexHome, 'state.sqlite');

  const hasClaude = fs.existsSync(claudeBase);
  const hasOpenCode = fs.existsSync(openCodeStorageDir) || fs.existsSync(openCodeDbPath);
  const hasCodex = fs.existsSync(codexSessionsDir) || fs.existsSync(codexDbPath);

  const available: Array<{ id: ProviderId; mtime: number }> = [];
  if (hasClaude) available.push({ id: 'claude-code', mtime: getMostRecentMtime(claudeBase) });
  if (hasOpenCode) available.push({ id: 'opencode', mtime: getOpenCodeActivityMtime() });
  if (hasCodex) available.push({ id: 'codex', mtime: getCodexActivityMtime() });

  available.sort((a, b) => b.mtime - a.mtime);
  return available.map(a => a.id);
}

/**
 * Detects the most appropriate provider based on filesystem presence and recency.
 * Pass an explicit provider ID to override auto-detection.
 */
export function detectProvider(override?: ProviderId | 'auto'): ProviderId {
  if (override && override !== 'auto') return override;

  const claudeBase = path.join(os.homedir(), '.claude', 'projects');
  const openCodeDataDir = getOpenCodeDataDir();
  const openCodeDbPath = path.join(openCodeDataDir, 'opencode.db');
  const openCodeStorageDir = path.join(openCodeDataDir, 'storage');
  const codexHome = getCodexHome();
  const codexSessionsDir = path.join(codexHome, 'sessions');
  const codexDbPath = path.join(codexHome, 'state.sqlite');

  const hasClaude = fs.existsSync(claudeBase);
  const hasOpenCode = fs.existsSync(openCodeStorageDir) || fs.existsSync(openCodeDbPath);
  const hasCodex = fs.existsSync(codexSessionsDir) || fs.existsSync(codexDbPath);

  const available: Array<{ id: ProviderId; mtime: number }> = [];

  if (hasClaude) {
    available.push({ id: 'claude-code', mtime: getMostRecentMtime(claudeBase) });
  }
  if (hasOpenCode) {
    available.push({ id: 'opencode', mtime: getOpenCodeActivityMtime() });
  }
  if (hasCodex) {
    available.push({ id: 'codex', mtime: getCodexActivityMtime() });
  }

  if (available.length === 0) return 'claude-code';
  if (available.length === 1) return available[0].id;

  available.sort((a, b) => b.mtime - a.mtime);
  return available[0].id;
}
