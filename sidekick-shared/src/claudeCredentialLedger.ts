/**
 * Ledger of the Claude credential homes Sidekick created.
 *
 * Claude Code names a config directory's Keychain item after a hash of the
 * directory, so once the directory is gone nothing ties the item back to it.
 * Every home Sidekick writes a credential into (a saved profile) or points a
 * `claude` login at is recorded here first, which is how `accounts doctor`
 * proves an item is Sidekick's before it deletes anything. Items are never
 * matched by name pattern: other tools legitimately use `CLAUDE_CONFIG_DIR`.
 *
 * Best effort by design: a ledger write failure must never fail the credential
 * operation it describes. The lock is a leaf lock (callers may hold the swap
 * or registry lock; nothing is acquired inside it).
 */
import * as fs from 'fs';
import * as path from 'path';
import { getAccountsDir } from './accountRegistry';
import { claudeKeychainService } from './claudeProfiles';
import { updateJsonStoreAtomicSync } from './writers/atomic';

export type ClaudeCredentialHomePurpose = 'profile' | 'login';

export interface ClaudeCredentialLedgerEntry {
  configDir: string;
  /** The Keychain service Claude Code derives for this directory (used on macOS). */
  service: string;
  purpose: ClaudeCredentialHomePurpose;
  createdAt: string;
  lastWrittenAt: string;
}

interface ClaudeCredentialLedgerFile {
  version: 1;
  entries: ClaudeCredentialLedgerEntry[];
}

function emptyLedger(): ClaudeCredentialLedgerFile {
  return { version: 1, entries: [] };
}

function normalizeLedger(raw: unknown): ClaudeCredentialLedgerFile {
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return emptyLedger();
  return {
    version: 1,
    entries: entries.filter(
      (entry): entry is ClaudeCredentialLedgerEntry =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as ClaudeCredentialLedgerEntry).configDir === 'string' &&
        typeof (entry as ClaudeCredentialLedgerEntry).service === 'string',
    ),
  };
}

export function getClaudeCredentialLedgerPath(): string {
  return path.join(getAccountsDir(), 'claude', 'credential-homes.json');
}

export function readClaudeCredentialLedger(): ClaudeCredentialLedgerEntry[] {
  try {
    return normalizeLedger(JSON.parse(fs.readFileSync(getClaudeCredentialLedgerPath(), 'utf8')))
      .entries;
  } catch {
    return [];
  }
}

/** Record (or refresh) a home Sidekick is about to hold a Claude credential in. */
export function recordClaudeCredentialHome(
  configDir: string,
  purpose: ClaudeCredentialHomePurpose,
  now: Date = new Date(),
): void {
  const resolved = path.resolve(configDir);
  const stamp = now.toISOString();
  try {
    updateJsonStoreAtomicSync(getClaudeCredentialLedgerPath(), emptyLedger, (latest) => {
      const ledger = normalizeLedger(latest);
      const existing = ledger.entries.find((entry) => entry.configDir === resolved);
      if (existing) {
        existing.lastWrittenAt = stamp;
        // A login home that became a profile keeps the stronger purpose.
        if (purpose === 'profile') existing.purpose = 'profile';
        return ledger;
      }
      ledger.entries.push({
        configDir: resolved,
        service: claudeKeychainService(resolved),
        purpose,
        createdAt: stamp,
        lastWrittenAt: stamp,
      });
      return ledger;
    });
  } catch {
    /* best effort: the doctor still scans the profile homes on disk */
  }
}

/** Drop a home whose credential store has been deleted. */
export function forgetClaudeCredentialHome(configDir: string): void {
  const resolved = path.resolve(configDir);
  try {
    if (!fs.existsSync(getClaudeCredentialLedgerPath())) return;
    updateJsonStoreAtomicSync(getClaudeCredentialLedgerPath(), emptyLedger, (latest) => {
      const ledger = normalizeLedger(latest);
      ledger.entries = ledger.entries.filter((entry) => entry.configDir !== resolved);
      return ledger;
    });
  } catch {
    /* best effort */
  }
}
