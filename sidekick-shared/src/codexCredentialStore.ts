/** Raw credential I/O. Backups are never Codex homes and never launchable. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { getAccountsDir } from './accountRegistry';
import { getCodexBackupPath, getSystemCodexHome } from './codexPaths';
import { parseAuthJson } from './codexAuth';
import { atomicWriteFileSync } from './writers/atomic';

export interface CodexAuthSnapshot {
  authRaw: string | null;
  /** Includes unrelated MCP data when reading a home; writers preserve it. */
  legacyRaw: string | null;
}
export type CodexCredentialStoreRead =
  | { status: 'ok' | 'absent' | 'corrupt'; snapshot: CodexAuthSnapshot }
  | { status: 'error' };

export function isLegacyCodexLogin(raw: string | null): boolean {
  const value = parseAuthJson(raw) as Record<string, unknown> | null;
  return Boolean(
    value &&
    ['OPENAI_API_KEY', 'CODEX_API_KEY'].some(
      (key) => typeof value[key] === 'string' && (value[key] as string).length > 0,
    ),
  );
}

export function isCodexLogin(raw: string | null): boolean {
  const parsed = parseAuthJson(raw);
  if (!parsed || Array.isArray(parsed)) return false;
  if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY) return true;
  return Boolean(
    typeof parsed.tokens?.access_token === 'string' &&
    parsed.tokens.access_token &&
    typeof parsed.tokens.refresh_token === 'string' &&
    parsed.tokens.refresh_token,
  );
}

export function codexLoginOnly(snapshot: CodexAuthSnapshot): CodexAuthSnapshot {
  return {
    authRaw: snapshot.authRaw,
    legacyRaw: isLegacyCodexLogin(snapshot.legacyRaw) ? snapshot.legacyRaw : null,
  };
}

function readRaw(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readFiles(auth: string, legacy: string): CodexCredentialStoreRead {
  try {
    const snapshot = { authRaw: readRaw(auth), legacyRaw: readRaw(legacy) };
    const status =
      snapshot.authRaw !== null
        ? isCodexLogin(snapshot.authRaw)
          ? 'ok'
          : 'corrupt'
        : isLegacyCodexLogin(snapshot.legacyRaw)
          ? 'ok'
          : 'absent';
    return { status, snapshot };
  } catch {
    return { status: 'error' };
  }
}

export function readCodexCredentialStore(home = getSystemCodexHome()): CodexCredentialStoreRead {
  return readFiles(path.join(home, 'auth.json'), path.join(home, '.credentials.json'));
}

export function readCodexBackup(id: string): CodexCredentialStoreRead {
  return readFiles(getCodexBackupPath(id), getCodexBackupPath(id, true));
}

export function codexSnapshotFingerprint(snapshot: CodexAuthSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/** The whole snapshot, including absence, must agree before destructive operations. */
export function codexStoreMatches(
  read: CodexCredentialStoreRead,
  snapshot: CodexAuthSnapshot,
): boolean {
  return (
    read.status !== 'error' &&
    codexSnapshotFingerprint(read.snapshot) === codexSnapshotFingerprint(snapshot)
  );
}

export function writeCodexBackup(id: string, snapshot: CodexAuthSnapshot): void {
  const login = codexLoginOnly(snapshot);
  if (!isCodexLogin(login.authRaw) && !isLegacyCodexLogin(login.legacyRaw)) {
    throw new Error('Refusing to back up an invalid Codex login.');
  }
  for (const [file, raw] of [
    [getCodexBackupPath(id), login.authRaw],
    [getCodexBackupPath(id, true), login.legacyRaw],
  ] as const) {
    if (raw !== null) atomicWriteFileSync(file, raw);
    else fs.rmSync(file, { force: true });
  }
  if (!codexStoreMatches(readCodexBackup(id), login))
    throw new Error('The private Codex backup did not verify.');
}

/** Resolve existing parents too, so nonexistent children of a symlink cannot bypass ownership. */
export function canonicalCodexPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    return parent === resolved
      ? resolved
      : path.join(canonicalCodexPath(parent), path.basename(resolved));
  }
}

export function isSidekickCodexHome(home: string): boolean {
  const root = canonicalCodexPath(path.join(getAccountsDir(), 'codex'));
  const resolved = canonicalCodexPath(home);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Install only account data; an unrelated MCP credential file is never copied or deleted. */
export function codexInstalledSnapshot(
  before: CodexAuthSnapshot,
  candidate: CodexAuthSnapshot,
): CodexAuthSnapshot {
  const login = codexLoginOnly(candidate);
  if (login.legacyRaw && before.legacyRaw && !isLegacyCodexLogin(before.legacyRaw)) {
    throw new Error('Legacy Codex credentials would replace MCP data; sign in with Codex again.');
  }
  return {
    authRaw: login.authRaw,
    legacyRaw:
      before.legacyRaw && !isLegacyCodexLogin(before.legacyRaw)
        ? before.legacyRaw
        : login.legacyRaw,
  };
}

function writeFiles(home: string, snapshot: CodexAuthSnapshot): void {
  for (const [name, raw] of [
    ['auth.json', snapshot.authRaw],
    ['.credentials.json', snapshot.legacyRaw],
  ] as const) {
    const file = path.join(home, name);
    // Do not rewrite even identical MCP data; its own refresh writer owns it.
    if (readRaw(file) === raw) continue;
    if (raw === null) fs.rmSync(file, { force: true });
    else atomicWriteFileSync(file, raw);
  }
}

export function writeInactiveCodexCredentialStore(
  home: string,
  candidate: CodexAuthSnapshot,
): void {
  if (canonicalCodexPath(home) === canonicalCodexPath(getSystemCodexHome())) {
    throw new Error('A profile credential writer cannot write the live Codex home.');
  }
  const before = readCodexCredentialStore(home);
  if (before.status === 'error') throw new Error('The Codex profile could not be read.');
  const expected = codexInstalledSnapshot(before.snapshot, candidate);
  writeFiles(home, expected);
  if (!codexStoreMatches(readCodexCredentialStore(home), expected))
    throw new Error('The Codex profile write did not verify.');
}

/** Internal capability: only the guarded installer in codexProfiles may call this. */
export function writeLiveCodexCredentialStoreUnguarded(snapshot: CodexAuthSnapshot): void {
  const home = getSystemCodexHome();
  if (isSidekickCodexHome(home))
    throw new Error(
      'Unset CODEX_HOME before changing the live login; it names a Sidekick-owned home.',
    );
  writeFiles(home, snapshot);
}

export function removeCodexProfileCredentials(home: string, expected: CodexAuthSnapshot): void {
  if (canonicalCodexPath(home) === canonicalCodexPath(getSystemCodexHome()))
    throw new Error('Refusing to remove live Codex credentials.');
  if (!codexStoreMatches(readCodexCredentialStore(home), expected))
    throw new Error('The Codex profile changed; its credential was kept.');
  if (expected.authRaw !== null) fs.rmSync(path.join(home, 'auth.json'), { force: true });
  if (isLegacyCodexLogin(expected.legacyRaw))
    fs.rmSync(path.join(home, '.credentials.json'), { force: true });
  if (readCodexCredentialStore(home).status !== 'absent')
    throw new Error('The Codex profile credential could not be removed.');
}
