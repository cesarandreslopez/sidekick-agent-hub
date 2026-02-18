/**
 * @fileoverview Auto-detection of installed CLI coding agents.
 *
 * Determines which SessionProvider to use based on user configuration
 * or auto-detection of installed tools (Claude Code vs OpenCode vs Codex).
 *
 * @module services/providers/ProviderDetector
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeCodeSessionProvider } from './ClaudeCodeSessionProvider';
import { OpenCodeSessionProvider } from './OpenCodeSessionProvider';
import { CodexSessionProvider } from './CodexSessionProvider';
import type { SessionProvider } from '../../types/sessionProvider';
import type { InferenceProviderId } from '../../types/inferenceProvider';
import { log } from '../Logger';

/**
 * Gets the OpenCode data directory path for detection.
 */
function getOpenCodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) {
    return path.join(xdg, 'opencode');
  }
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

function getOpenCodeStorageDir(): string {
  return path.join(getOpenCodeDataDir(), 'storage');
}

/**
 * Gets the Codex home directory path for detection.
 * Respects CODEX_HOME env var, defaults to ~/.codex/
 */
function getCodexHome(): string {
  const envHome = process.env.CODEX_HOME;
  if (envHome) return envHome;
  return path.join(os.homedir(), '.codex');
}

/**
 * Gets the most recent file modification time in a directory tree (shallow).
 * Returns 0 if directory doesn't exist or has no files.
 */
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
      } catch {
        // Skip inaccessible entries
      }
    }
    return latest;
  } catch {
    return 0;
  }
}

/**
 * Gets the most recent OpenCode activity timestamp.
 * Checks opencode.db mtime first (more accurate), then falls back to storage dirs.
 */
function getOpenCodeActivityMtime(storageDir: string): number {
  // Check DB file mtime — more accurate than scanning subdirs
  const dbPath = path.join(path.dirname(storageDir), 'opencode.db');
  try {
    const dbMtime = fs.statSync(dbPath).mtime.getTime();
    if (dbMtime > 0) return dbMtime;
  } catch {
    // DB doesn't exist, fall back to storage dirs
  }

  const sessionMtime = getMostRecentMtime(path.join(storageDir, 'session'));
  const messageMtime = getMostRecentMtime(path.join(storageDir, 'message'));
  const partMtime = getMostRecentMtime(path.join(storageDir, 'part'));
  return Math.max(sessionMtime, messageMtime, partMtime);
}

/**
 * Gets the most recent Codex activity timestamp.
 * Checks state.sqlite mtime first, then falls back to sessions dir.
 */
function getCodexActivityMtime(codexHome: string): number {
  const dbPath = path.join(codexHome, 'state.sqlite');
  try {
    const dbMtime = fs.statSync(dbPath).mtime.getTime();
    if (dbMtime > 0) return dbMtime;
  } catch {
    // DB doesn't exist
  }

  return getMostRecentMtime(path.join(codexHome, 'sessions'));
}

/**
 * Detects which SessionProvider to use.
 *
 * Priority:
 * 1. User's explicit `sidekick.sessionProvider` setting
 * 2. Auto-detect based on which CLI agent has more recent session data
 * 3. Default to Claude Code (original provider)
 *
 * @returns The appropriate SessionProvider instance
 */
export function detectProvider(): SessionProvider {
  const config = vscode.workspace.getConfiguration('sidekick');
  const preference = config.get<string>('sessionProvider', 'auto');

  if (preference === 'claude-code') {
    log('Session provider: Claude Code (configured)');
    return new ClaudeCodeSessionProvider();
  }

  if (preference === 'opencode') {
    log('Session provider: OpenCode (configured)');
    return new OpenCodeSessionProvider();
  }

  if (preference === 'codex') {
    log('Session provider: Codex CLI (configured)');
    return new CodexSessionProvider();
  }

  // Auto-detect: check for session directories and databases
  const openCodeStorage = getOpenCodeStorageDir();
  const openCodeDbPath = path.join(getOpenCodeDataDir(), 'opencode.db');
  const claudeBase = path.join(os.homedir(), '.claude', 'projects');
  const codexHome = getCodexHome();
  const codexSessionsDir = path.join(codexHome, 'sessions');
  const codexDbPath = path.join(codexHome, 'state.sqlite');

  const hasOpenCode = fs.existsSync(openCodeStorage) || fs.existsSync(openCodeDbPath);
  const hasClaude = fs.existsSync(claudeBase);
  const hasCodex = fs.existsSync(codexSessionsDir) || fs.existsSync(codexDbPath);

  log(`Auto-detecting session provider: Claude Code=${hasClaude}, OpenCode=${hasOpenCode}, Codex=${hasCodex}`);

  // Count how many providers are available
  const available: Array<{ name: string; mtime: number; create: () => SessionProvider }> = [];

  if (hasClaude) {
    available.push({
      name: 'Claude Code',
      mtime: getMostRecentMtime(claudeBase),
      create: () => new ClaudeCodeSessionProvider(),
    });
  }

  if (hasOpenCode) {
    available.push({
      name: 'OpenCode',
      mtime: getOpenCodeActivityMtime(openCodeStorage),
      create: () => new OpenCodeSessionProvider(),
    });
  }

  if (hasCodex) {
    available.push({
      name: 'Codex CLI',
      mtime: getCodexActivityMtime(codexHome),
      create: () => new CodexSessionProvider(),
    });
  }

  if (available.length === 0) {
    log('Session provider: Claude Code (default, no agents detected)');
    return new ClaudeCodeSessionProvider();
  }

  if (available.length === 1) {
    log(`Session provider: ${available[0].name} (auto-detected)`);
    return available[0].create();
  }

  // Multiple providers — pick the one with most recent activity
  available.sort((a, b) => b.mtime - a.mtime);
  log(`Session provider: ${available[0].name} (auto-detected, most recent activity)`);
  return available[0].create();
}

/**
 * Auto-detects which inference provider to use based on filesystem presence.
 *
 * Reuses the same directory/mtime heuristics as session provider detection.
 * Returns the most recently active provider, defaulting to claude-max.
 */
export function detectInferenceProvider(): InferenceProviderId {
  const openCodeStorage = getOpenCodeStorageDir();
  const openCodeDbPath = path.join(getOpenCodeDataDir(), 'opencode.db');
  const claudeBase = path.join(os.homedir(), '.claude', 'projects');
  const codexHome = getCodexHome();
  const codexSessionsDir = path.join(codexHome, 'sessions');
  const codexDbPath = path.join(codexHome, 'state.sqlite');

  const hasOpenCode = fs.existsSync(openCodeStorage) || fs.existsSync(openCodeDbPath);
  const hasClaude = fs.existsSync(claudeBase);
  const hasCodex = fs.existsSync(codexSessionsDir) || fs.existsSync(codexDbPath);

  const available: Array<{ id: InferenceProviderId; mtime: number }> = [];

  if (hasClaude) {
    available.push({ id: 'claude-max', mtime: getMostRecentMtime(claudeBase) });
  }
  if (hasOpenCode) {
    available.push({ id: 'opencode', mtime: getOpenCodeActivityMtime(openCodeStorage) });
  }
  if (hasCodex) {
    available.push({ id: 'codex', mtime: getCodexActivityMtime(codexHome) });
  }

  if (available.length === 0) {
    log('Inference provider auto-detect: defaulting to claude-max');
    return 'claude-max';
  }

  available.sort((a, b) => b.mtime - a.mtime);
  log(`Inference provider auto-detect: ${available[0].id} (most recent activity)`);
  return available[0].id;
}
