import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  getAccountsDir,
  getActiveSavedAccount,
  listSavedAccountProfiles,
  removeSavedAccountProfile,
  setActiveSavedAccount,
  upsertSavedAccountProfile,
} from './accountRegistry';
// auth.json must be copied byte-for-byte (atomicWriteFile, not atomicWriteJson):
// re-serializing would drop fields added by newer codex versions, and the
// rotated refresh token inside is only valid in its freshest form.
import {
  atomicWriteFileSync as atomicWriteFile,
  atomicWriteJsonSync as atomicWriteJson,
  withFileLockSync,
} from './writers/atomic';
import type {
  AccountIdentityMetadata,
  ResolvedActiveAccount,
  SavedAccountProfile,
} from './accountRegistry';
import type { AccountManagerResult } from './accounts';
import { parseCodexLoginStatus } from './authStatus';
import {
  identitiesMatch,
  codexRefreshFingerprint,
  compareCodexAuthFreshness,
  readAuthIdentityFromRaw,
  readLastRefresh,
  STALE_AUTH_THRESHOLD_MS,
  type CodexAuthIdentity,
} from './codexAuth';
import {
  ensureCodexProfileDirs,
  forceFileCredentialStore,
  getCodexCredentialStoreMode,
  getCodexProfileDir,
  getCodexProfileHome,
  getCodexProfileStatePath,
  getCodexBackupPath,
  getCodexLoginDir,
  getCodexLoginsDir,
  getCodexLoginHome,
  getCodexLoginStatePath,
  getCodexProfilesDir,
  getSystemCodexHome,
  readFileOrNull,
  resolveSidekickCodexHome,
} from './codexPaths';
import {
  getAccountHealth,
  readHealthSidecar,
  writeCodexHealthSidecar,
  type AccountHealthSource,
} from './accountHealth';
import {
  finishSwitchResult,
  switchFailure,
  writeLastSwitch,
  type SwitchAccountOptions,
  type SwitchAccountResult,
} from './accountSwitch';
import { emptyProviderSyncReport, type ProviderSyncReport } from './accountSyncTypes';
import {
  inspectRunningAccountConsumers,
  inspectRunningAccountConsumersSync,
  type AccountConsumerScan,
} from './processDetection';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';
import { acquireAccountLease, isAccountLeaseHeld, releaseAccountLease } from './accountLease';
import { decideLiveCredentialWrite, type LiveCredentialWriteIntent } from './liveCredentialGuard';
import {
  readCodexCredentialStore,
  readCodexBackup,
  writeCodexBackup,
  codexLoginOnly,
  codexSnapshotFingerprint,
  codexStoreMatches,
  codexInstalledSnapshot,
  isCodexLogin,
  isLegacyCodexLogin,
  isSidekickCodexHome,
  writeInactiveCodexCredentialStore,
  removeCodexProfileCredentials,
  writeLiveCodexCredentialStoreUnguarded,
  type CodexAuthSnapshot,
  type CodexCredentialStoreRead,
} from './codexCredentialStore';

export {
  getCodexProfilesDir,
  getCodexProfileHome,
  getSystemCodexHome,
  getCodexCredentialStoreMode,
  getCodexMonitoringHomes,
  resolveSidekickCodexHome,
  getCodexExecutionEnv,
} from './codexPaths';
export type { CodexCredentialStoreMode } from './codexPaths';

interface PendingCodexProfile {
  label: string;
  addedAt: string;
}

export interface CodexAccountManagerResult extends AccountManagerResult {
  needsLogin?: boolean;
  profileId?: string;
  codexHome?: string;
}

export const CODEX_KEYRING_FIX_HINT =
  'Set `cli_auth_credentials_store = "file"` in ~/.codex/config.toml and run `codex login` again.';

function readPendingProfile(profileId: string): PendingCodexProfile | null {
  try {
    return JSON.parse(
      fs.readFileSync(getCodexLoginStatePath(profileId), 'utf8'),
    ) as PendingCodexProfile;
  } catch {
    return null;
  }
}

function writePendingProfile(profileId: string, pending: PendingCodexProfile): void {
  const dir = getCodexLoginDir(profileId);
  fs.mkdirSync(path.join(dir, 'codex-home'), { recursive: true, mode: 0o700 });
  atomicWriteJson(path.join(dir, 'profile.json'), pending);
}

/**
 * Copy the live `config.toml` into a profile home, forcing file-based
 * credential storage so an isolated `codex login` writes `auth.json` (a
 * keyring entry keyed to the profile home could never be swapped).
 */
function copySourceCodexConfig(sourceHome: string, targetHome: string): void {
  const source = readFileOrNull(path.join(sourceHome, 'config.toml')) ?? '';
  atomicWriteFile(path.join(targetHome, 'config.toml'), forceFileCredentialStore(source));
}

/** Read the freshest saved login without creating a CLI-usable copy. */
export function readStoredCodexAccount(profileId: string): CodexAuthSnapshot | null {
  const home = readCodexCredentialStore(getCodexProfileHome(profileId));
  const backup = readCodexBackup(profileId);
  if (home.status === 'ok' && backup.status === 'ok') {
    return codexLoginOnly(
      compareCodexAuthFreshness(backup.snapshot.authRaw, home.snapshot.authRaw) > 0
        ? backup.snapshot
        : home.snapshot,
    );
  }
  return home.status === 'ok'
    ? codexLoginOnly(home.snapshot)
    : backup.status === 'ok'
      ? backup.snapshot
      : null;
}

function profileMatchesSnapshot(
  profile: SavedAccountProfile,
  snapshot: CodexAuthSnapshot,
): boolean {
  const identity = readAuthIdentityFromRaw(snapshot.authRaw);
  if (identitiesMatch(identity, profileIdentity(profile))) return true;
  // API keys have no account claims. Match their complete credential bytes, never the active pointer.
  if (
    identity?.authMode === 'api-key' ||
    (!snapshot.authRaw && isLegacyCodexLogin(snapshot.legacyRaw))
  ) {
    const saved = readStoredCodexAccount(profile.id);
    return (
      saved !== null &&
      codexSnapshotFingerprint(codexLoginOnly(snapshot)) === codexSnapshotFingerprint(saved)
    );
  }
  return false;
}

export function isLiveCodexProfile(profile: SavedAccountProfile): boolean {
  const live = readCodexCredentialStore();
  return live.status === 'ok' && profileMatchesSnapshot(profile, live.snapshot);
}

/** Caller holds the swap lock. Live-account credentials only enter private storage. */
export function storeCodexProfileAuthUnlocked(
  profileId: string,
  authRaw: string | null,
  legacyRaw: string | null,
  source: AccountHealthSource,
): void {
  const candidate = codexLoginOnly({ authRaw, legacyRaw });
  const profile = listCodexAccounts().find((p) => p.id === profileId);
  const identity = readAuthIdentityFromRaw(authRaw);
  if (
    profile &&
    identity?.authMode === 'chatgpt' &&
    (identity.email || identity.workspaceId) &&
    (profile.email || profile.metadata?.workspaceId) &&
    !identitiesMatch(identity, profileIdentity(profile))
  ) {
    throw new Error('The Codex credential belongs to a different saved account.');
  }
  const old = readCodexBackup(profileId);
  const chosen =
    old.status === 'ok' && compareCodexAuthFreshness(old.snapshot.authRaw, authRaw) > 0
      ? old.snapshot
      : candidate;
  writeCodexBackup(profileId, chosen);
  const live = readCodexCredentialStore();
  const sameLink =
    live.status === 'ok' &&
    codexRefreshFingerprint(chosen.authRaw) !== null &&
    codexRefreshFingerprint(chosen.authRaw) === codexRefreshFingerprint(live.snapshot.authRaw);
  const isLive =
    live.status === 'ok' &&
    (profile
      ? profileMatchesSnapshot(profile, live.snapshot)
      : identitiesMatch(
          readAuthIdentityFromRaw(chosen.authRaw),
          readAuthIdentityFromRaw(live.snapshot.authRaw),
        ));
  if (
    !isSidekickCodexHome(getSystemCodexHome()) &&
    live.status !== 'error' &&
    live.status !== 'corrupt' &&
    !isLive &&
    !sameLink
  ) {
    writeInactiveCodexCredentialStore(getCodexProfileHome(profileId), chosen);
  }
  if (chosen.authRaw) writeCodexHealthSidecar(profileId, chosen.authRaw, source);
}

export function storeCodexProfileAuth(
  profileId: string,
  authRaw: string | null,
  legacyRaw: string | null,
  source: AccountHealthSource,
): void {
  withCodexAuthSwapLock(() => storeCodexProfileAuthUnlocked(profileId, authRaw, legacyRaw, source));
}

function consumerBlocker(scan?: AccountConsumerScan): string | null {
  if (!scan?.ok)
    return 'Could not verify that Codex consumers are stopped; retry after closing Codex.';
  if (scan.consumers.length)
    return 'Close running Codex CLI, app, and IDE sessions before changing credentials. --force cannot bypass this check.';
  return null;
}

/** The sole installer of live Codex credentials, including rollback and repair. */
function installIntoLiveCodexStore(
  candidate: CodexAuthSnapshot,
  accountId: string,
  intent: LiveCredentialWriteIntent,
  context: {
    before: CodexCredentialStoreRead;
    liveAccountId: string | null;
    capturedOutgoing?: boolean;
    written?: CodexAuthSnapshot;
    scan?: AccountConsumerScan;
  },
):
  | { ok: true; installed: CodexAuthSnapshot }
  | { ok: false; reason: string; attempted?: CodexAuthSnapshot } {
  if (isAccountLeaseHeld('codex', accountId))
    return { ok: false, reason: 'Keep-alive holds this account; retry when it finishes.' };
  const blocker = consumerBlocker(context.scan);
  if (blocker) return { ok: false, reason: blocker };
  const mode = getCodexCredentialStoreMode();
  if (mode !== 'file' && mode !== 'unknown') return { ok: false, reason: CODEX_KEYRING_FIX_HINT };
  if (isSidekickCodexHome(getSystemCodexHome()))
    return { ok: false, reason: 'Unset CODEX_HOME; it points at a Sidekick-owned home.' };
  const current = readCodexCredentialStore();
  if (context.before.status === 'error' || !codexStoreMatches(current, context.before.snapshot)) {
    return { ok: false, reason: 'The live Codex credential changed; nothing was overwritten.' };
  }
  const raw = current.status === 'ok' ? current.snapshot.authRaw : null;
  const fp = codexRefreshFingerprint(raw);
  const candidateIdentity = readAuthIdentityFromRaw(candidate.authRaw);
  const candidateProfile = listCodexAccounts().find((p) => p.id === accountId);
  const validIdentity =
    candidateIdentity?.authMode !== 'chatgpt' ||
    (candidateProfile !== undefined &&
      identitiesMatch(candidateIdentity, profileIdentity(candidateProfile)));
  const decision = decideLiveCredentialWrite({
    provider: 'Codex',
    intent,
    liveStatus: current.status,
    candidateValid:
      validIdentity && (isCodexLogin(candidate.authRaw) || isLegacyCodexLogin(candidate.legacyRaw)),
    liveHasCredential: current.status === 'ok',
    liveAccountId: context.liveAccountId,
    candidateAccountId: accountId,
    sameLink: fp !== null && fp === codexRefreshFingerprint(candidate.authRaw),
    strictlyNewer: compareCodexAuthFreshness(candidate.authRaw, raw) > 0,
    capturedOutgoing: context.capturedOutgoing,
    matchesWritten: context.written !== undefined && codexStoreMatches(current, context.written),
    rejectCorrupt: true,
  });
  if (!decision.allow) return { ok: false, reason: decision.reason };
  if (current.status === 'error')
    return { ok: false, reason: 'The live Codex login could not be read.' };
  let expected: CodexAuthSnapshot;
  try {
    expected = codexInstalledSnapshot(current.snapshot, candidate);
  } catch {
    return {
      ok: false,
      reason: 'Legacy credentials would replace unrelated MCP data; sign in again.',
    };
  }
  try {
    writeLiveCodexCredentialStoreUnguarded(expected);
    if (!codexStoreMatches(readCodexCredentialStore(), expected))
      throw new Error('verification failed');
    return { ok: true, installed: expected };
  } catch {
    return { ok: false, reason: 'The live Codex write did not verify.', attempted: expected };
  }
}

function readMetadataFromAuthJson(codexHome: string): AccountIdentityMetadata {
  const identity = readAuthIdentityFromRaw(readFileOrNull(path.join(codexHome, 'auth.json')));
  if (!identity) return {};
  return {
    email: identity.email,
    workspaceId: identity.workspaceId,
    planType: identity.planType,
    authMode: identity.authMode,
  };
}

function readMetadataFromLegacyCredentials(codexHome: string): AccountIdentityMetadata {
  const legacyPath = path.join(codexHome, '.credentials.json');
  if (!fs.existsSync(legacyPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.OPENAI_API_KEY === 'string' || typeof parsed.CODEX_API_KEY === 'string') {
      return { authMode: 'api-key' };
    }
  } catch {
    // Ignore malformed legacy credentials.
  }

  return {};
}

interface CodexLoginStatus {
  loggedIn: boolean;
  authMode?: 'chatgpt' | 'api-key';
}

const PROBE_TIMEOUT_MS = 4000;

/** `codex login status` counts only on exit 0; the text is read by {@link parseCodexLoginStatus}. */
export function parseCodexLoginStatusOutput(
  status: number | null,
  stdout: string,
): CodexLoginStatus {
  if (status !== 0) return { loggedIn: false };
  const parsed = parseCodexLoginStatus(stdout);
  if (!parsed.loggedIn) return { loggedIn: false };
  return parsed.method ? { loggedIn: true, authMode: parsed.method } : { loggedIn: true };
}

/**
 * Blocks the caller's event loop for up to {@link PROBE_TIMEOUT_MS}. Async code
 * paths must use {@link getCodexLoginStatusAsync} instead — external consumers
 * embed this package in processes where a blocked event loop freezes all IPC.
 */
export function getCodexLoginStatus(codexHome: string): CodexLoginStatus {
  try {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const result = spawnSync('codex', ['login', 'status'], {
      encoding: 'utf8',
      env,
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return parseCodexLoginStatusOutput(
      result.status,
      `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`,
    );
  } catch {
    // Ignore missing CLI or spawn errors.
  }
  return { loggedIn: false };
}

export function getCodexLoginStatusAsync(codexHome: string): Promise<CodexLoginStatus> {
  return new Promise((resolve) => {
    try {
      const env = { ...process.env, CODEX_HOME: codexHome };
      execFile(
        'codex',
        ['login', 'status'],
        { encoding: 'utf8', env, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          // A missing CLI, non-zero exit, or timeout all mean "not logged in".
          resolve(
            error
              ? { loggedIn: false }
              : parseCodexLoginStatusOutput(0, `${String(stdout ?? '')}\n${String(stderr ?? '')}`),
          );
        },
      );
    } catch {
      resolve({ loggedIn: false });
    }
  });
}

/** File-based metadata only — never spawns the codex CLI. */
function readCodexAccountMetadataFromFiles(codexHome: string): AccountIdentityMetadata | null {
  const fromAuth = readMetadataFromAuthJson(codexHome);
  if (fromAuth.email || fromAuth.workspaceId || fromAuth.planType || fromAuth.authMode) {
    return fromAuth;
  }

  const fromLegacy = readMetadataFromLegacyCredentials(codexHome);
  if (fromLegacy.authMode) {
    return fromLegacy;
  }

  return null;
}

function metadataFromLoginStatus(status: CodexLoginStatus): AccountIdentityMetadata {
  return status.loggedIn ? { authMode: status.authMode ?? 'unknown' } : {};
}

export function readCodexAccountMetadata(codexHome: string): AccountIdentityMetadata {
  return (
    readCodexAccountMetadataFromFiles(codexHome) ??
    metadataFromLoginStatus(getCodexLoginStatus(codexHome))
  );
}

/** {@link readCodexAccountMetadata} without blocking the event loop on the CLI probe. */
export async function readCodexAccountMetadataAsync(
  codexHome: string,
): Promise<AccountIdentityMetadata> {
  return (
    readCodexAccountMetadataFromFiles(codexHome) ??
    metadataFromLoginStatus(await getCodexLoginStatusAsync(codexHome))
  );
}

function hasCodexCredentialFiles(codexHome: string): boolean {
  return readCodexCredentialStore(codexHome).status === 'ok';
}
export function isCodexProfileAuthenticated(codexHome: string): boolean {
  return hasCodexCredentialFiles(codexHome);
}
export async function isCodexProfileAuthenticatedAsync(codexHome: string): Promise<boolean> {
  return isCodexProfileAuthenticated(codexHome);
}

function ensureUniqueCodexLabel(label: string, excludeId?: string): string | null {
  const normalized = label.trim().toLowerCase();
  const conflict = listCodexAccounts().find(
    (account) =>
      account.id !== excludeId && (account.label ?? '').trim().toLowerCase() === normalized,
  );
  return conflict ? `A Codex account named "${label}" already exists.` : null;
}

export function listCodexAccounts(): SavedAccountProfile[] {
  return listSavedAccountProfiles('codex');
}

export function getActiveCodexAccount(): SavedAccountProfile | null {
  return getActiveSavedAccount('codex');
}

function profileIdentity(profile: SavedAccountProfile): {
  email?: string;
  workspaceId?: string;
} {
  return {
    email: profile.email ?? profile.metadata?.email,
    workspaceId: profile.metadata?.workspaceId,
  };
}

/**
 * Resolves the *currently logged-in* Codex account for display, preferring the
 * live `auth.json` identity over the saved registry pointer (which only sidekick's
 * own switch flow updates and therefore goes stale after a native `codex login`).
 *
 * Uses the cheap JWT decode from `auth.json` directly — NOT `readCodexAccountMetadata`,
 * whose fallback spawns `codex login status` (a multi-second subprocess) unsuitable
 * for a render path.
 *
 * Safe self-heal: when the live identity unambiguously matches a saved profile that
 * isn't the current active pointer, the pointer is re-pointed so registry-keyed data
 * (quota history, auto-switch) tracks reality too. Never creates or deletes profiles.
 */
export function resolveActiveCodexAccount(
  options: { selfHeal?: boolean } = {},
): ResolvedActiveAccount {
  const selfHeal = options.selfHeal ?? true;
  const identity = readAuthIdentityFromRaw(
    readFileOrNull(path.join(resolveSidekickCodexHome(), 'auth.json')),
  );

  if (identity && (identity.email || identity.workspaceId)) {
    const match = findProfileForIdentity(identity);
    if (match) {
      const active = getActiveSavedAccount('codex');
      // See resolveActiveClaudeAccount: hot paths opt out of the repair write.
      if (selfHeal && (!active || active.id !== match.id)) {
        // Self-heal is best-effort: a registry write failure (read-only/full
        // disk) must never break display, extension activation, or the quota
        // watcher's hot path. We still return the correct live identity below.
        try {
          setActiveSavedAccount('codex', match.id, { silent: true });
        } catch {
          /* keep going with the live identity */
        }
      }
    }
    return {
      email: identity.email ?? match?.email ?? match?.metadata?.email,
      label: match?.label,
      providerAccountId: match?.providerAccountId ?? identity.workspaceId,
      registryAccountId: match?.id,
      source: 'live',
    };
  }

  // api-key auth, unparseable token, or logged out → fall back to the registry.
  const active = getActiveCodexAccount();
  if (active) {
    return {
      email: active.email ?? active.metadata?.email,
      label: active.label,
      providerAccountId: active.providerAccountId,
      registryAccountId: active.id,
      source: 'registry',
    };
  }
  return { source: 'none' };
}

// ── Prepare / finalize (add account) ─────────────────────────────────────

function keyringRefusal(mode: string): CodexAccountManagerResult {
  return {
    success: false,
    needsLogin: false,
    error: `Codex credential storage (${mode}) is not file-based. ${CODEX_KEYRING_FIX_HINT}`,
  };
}

function prepareCodexAccountCore(
  label: string,
  importCurrent: boolean,
  scan?: AccountConsumerScan,
): CodexAccountManagerResult {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) return { success: false, error: 'Codex accounts require a non-empty label.' };
  const labelError = ensureUniqueCodexLabel(trimmedLabel);
  if (labelError) return { success: false, error: labelError };
  const sourceHome = getSystemCodexHome();
  const mode = getCodexCredentialStoreMode(sourceHome);
  if (mode !== 'file' && mode !== 'unknown') return keyringRefusal(mode);
  if (isSidekickCodexHome(sourceHome))
    return {
      success: false,
      error: 'Unset CODEX_HOME before adding an account; it names a Sidekick-owned home.',
    };
  const live = readCodexCredentialStore();
  if (importCurrent && live.status === 'ok') {
    const sync = syncCodexLiveStateUnlocked('live-sync', { scan });
    const profile = listCodexAccounts().find((p) => profileMatchesSnapshot(p, live.snapshot));
    if (!profile)
      return {
        success: false,
        error: sync.warnings[0] ?? 'The live Codex login has no identifiable account.',
      };
    const manual = profile.metadata?.origin === 'live-sync' || profile.label === profile.email;
    if (manual)
      upsertSavedAccountProfile({
        ...profile,
        label: trimmedLabel,
        metadata: { ...profile.metadata, origin: 'manual' },
      });
    return {
      success: true,
      profileId: profile.id,
      codexHome: sourceHome,
      needsLogin: false,
      warning:
        sync.warnings.join(' ') ||
        (!sync.registered
          ? `This Codex login is already saved as ${profile.label ?? profile.id}.`
          : undefined),
    };
  }
  if (importCurrent && (live.status === 'corrupt' || live.status === 'error')) {
    return {
      success: false,
      error: 'The live Codex credential could not be read; retry after Codex finishes writing it.',
    };
  }
  const profileId = randomUUID();
  try {
    writePendingProfile(profileId, { label: trimmedLabel, addedAt: new Date().toISOString() });
    const codexHome = getCodexLoginHome(profileId);
    copySourceCodexConfig(sourceHome, codexHome);
    return { success: true, profileId, codexHome, needsLogin: true };
  } catch {
    discardCodexLogin(profileId);
    return { success: false, error: 'Could not prepare the isolated Codex login.' };
  }
}

/** Legacy callers can import current; explicit sign-in passes importCurrent: false. */
export function prepareCodexAccount(
  label: string,
  options: { importCurrent?: boolean } = {},
): CodexAccountManagerResult {
  const scan =
    options.importCurrent === false ? undefined : inspectRunningAccountConsumersSync('codex');
  try {
    return withCodexAuthSwapLock(() =>
      prepareCodexAccountCore(label, options.importCurrent ?? true, scan),
    );
  } catch {
    return { success: false, error: 'Could not acquire the Codex account-switch lock.' };
  }
}
export async function prepareCodexAccountAsync(
  label: string,
  options: { importCurrent?: boolean } = {},
): Promise<CodexAccountManagerResult> {
  const scan =
    options.importCurrent === false ? undefined : await inspectRunningAccountConsumers('codex');
  try {
    return withCodexAuthSwapLock(() =>
      prepareCodexAccountCore(label, options.importCurrent ?? true, scan),
    );
  } catch {
    return { success: false, error: 'Could not acquire the Codex account-switch lock.' };
  }
}

/** Removes only a pending login, never a registered canonical profile. */
export function discardCodexLogin(id: string): void {
  fs.rmSync(getCodexLoginDir(id), { recursive: true, force: true });
  if (
    !listCodexAccounts().some((p) => p.id === id) &&
    fs.existsSync(getCodexProfileStatePath(id))
  ) {
    fs.rmSync(getCodexProfileDir(id), { recursive: true, force: true });
  }
}

function finalizeCodexAccountCore(
  profileId: string,
  opts: { activate?: boolean },
  scan: AccountConsumerScan,
): CodexAccountManagerResult {
  const pending = readPendingProfile(profileId);
  if (!pending) {
    const saved = listCodexAccounts().find((p) => p.id === profileId);
    if (!saved) return { success: false, error: `Codex profile ${profileId} was not prepared.` };
    return opts.activate === false
      ? { success: true, profileId }
      : performCodexAuthSwapCore(saved, {}, { scan });
  }
  const home = getCodexLoginHome(profileId);
  const read = readCodexCredentialStore(home);
  if (read.status !== 'ok')
    return {
      success: false,
      error: 'Codex profile is not authenticated with readable file credentials yet.',
    };
  const identity = readAuthIdentityFromRaw(read.snapshot.authRaw);
  const metadata = readCodexAccountMetadataFromFiles(home) ?? {};
  const existing = identity ? findProfileForIdentity(identity, { fallbackToActive: false }) : null;
  // Legacy pending homes must not become a saved profile before their credential is moved out.
  const id = existing?.id ?? (home === getCodexProfileHome(profileId) ? randomUUID() : profileId);
  const profile: SavedAccountProfile = {
    ...existing,
    id,
    providerId: 'codex',
    label: existing?.label ?? pending.label,
    email: metadata.email ?? existing?.email,
    addedAt: existing?.addedAt ?? pending.addedAt,
    metadata: { ...existing?.metadata, ...metadata, origin: 'login' },
  };
  try {
    // Preserve first. No successful sign-in is lost if activation is blocked.
    const previous = readCodexBackup(id);
    writeCodexBackup(
      id,
      previous.status === 'ok' &&
        compareCodexAuthFreshness(previous.snapshot.authRaw, read.snapshot.authRaw) > 0
        ? previous.snapshot
        : read.snapshot,
    );
    removeCodexProfileCredentials(home, read.snapshot);
    upsertSavedAccountProfile(profile);
    ensureCodexProfileDirs(id);
    copySourceCodexConfig(home, getCodexProfileHome(id));
    storeCodexProfileAuthUnlocked(id, read.snapshot.authRaw, read.snapshot.legacyRaw, 'login');
  } catch {
    return {
      success: false,
      profileId: id,
      error: 'Could not finish saving the Codex login; any verified private backup was kept.',
    };
  } finally {
    discardCodexLogin(profileId);
  }
  if (opts.activate === false) return { success: true, profileId: id };
  const result = performCodexAuthSwapCore(profile, {}, { scan });
  return result.success
    ? { ...result, profileId: id }
    : {
        ...result,
        profileId: id,
        needsLogin: false,
        error: `The login was saved, but could not be activated: ${result.error}`,
      };
}

export function finalizeCodexAccount(
  profileId: string,
  opts: { activate?: boolean } = {},
): CodexAccountManagerResult {
  const scan = inspectRunningAccountConsumersSync('codex');
  try {
    return withCodexAuthSwapLock(() => finalizeCodexAccountCore(profileId, opts, scan));
  } catch {
    return { success: false, error: 'Could not finalize the Codex login.' };
  }
}
export async function finalizeCodexAccountAsync(
  profileId: string,
  opts: { activate?: boolean } = {},
): Promise<CodexAccountManagerResult> {
  const scan = await inspectRunningAccountConsumers('codex');
  try {
    return withCodexAuthSwapLock(() => finalizeCodexAccountCore(profileId, opts, scan));
  } catch {
    return { success: false, error: 'Could not finalize the Codex login.' };
  }
}

// ── Stash / identity matching ────────────────────────────────────────────

function getCodexStashDir(): string {
  return path.join(getAccountsDir(), 'codex', 'stash');
}

function findProfileForIdentity(
  identity: CodexAuthIdentity | null,
  options: { fallbackToActive?: boolean } = {},
): SavedAccountProfile | null {
  const profiles = listCodexAccounts();
  if (identity?.workspaceId) {
    const byWorkspace = profiles.find(
      (profile) => profile.metadata?.workspaceId === identity.workspaceId,
    );
    if (byWorkspace) return byWorkspace;
  }
  if (identity?.email) {
    const byEmail = profiles.find(
      (profile) =>
        (profile.email ?? profile.metadata?.email) === identity.email &&
        (!identity.workspaceId || !profile.metadata?.workspaceId),
    );
    if (byEmail) return byEmail;
  }
  if (!identity?.workspaceId && !identity?.email && options.fallbackToActive !== false) {
    // API-key auth or unparseable tokens carry no identity; assume the live
    // file belongs to whichever account the registry says is active.
    return getActiveCodexAccount();
  }
  return null;
}

// ── Live-state sync ──────────────────────────────────────────────────────

/**
 * Serializes live-auth mutations across processes. Codex rotates refresh
 * tokens, so two interleaved swaps stashing and restoring auth.json can
 * resurrect a stale token and permanently invalidate the login. Lock ordering:
 * this lock is taken first and the registry lock (inside setActiveSavedAccount
 * / upsertSavedAccountProfile) inside it — never the reverse. Never spawn a
 * child process while holding it.
 */
export function withCodexAuthSwapLock<T>(operation: () => T): T {
  const lockDir = path.join(getAccountsDir(), 'codex');
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(path.join(lockDir, 'auth-swap.lock'), operation);
}

/** Merge owned profiles only after preserving their newest login in a verified backup. */
export function dedupeCodexProfiles(scan?: AccountConsumerScan): string[] {
  if (consumerBlocker(scan)) return [];
  const removed: string[] = [];
  const groups = new Map<string, SavedAccountProfile[]>();
  for (const profile of listCodexAccounts()) {
    const key = profile.metadata?.workspaceId
      ? `ws:${profile.metadata.workspaceId}`
      : profile.email
        ? `email:${profile.email}`
        : `id:${profile.id}`;
    groups.set(key, [...(groups.get(key) ?? []), profile]);
  }
  for (const group of groups.values()) {
    if (group.length < 2 || group.some((p) => isAccountLeaseHeld('codex', p.id))) continue;
    const sorted = [...group].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
    const keeper = sorted[0];
    let freshest = readStoredCodexAccount(keeper.id);
    for (const p of sorted.slice(1)) {
      const candidate = readStoredCodexAccount(p.id);
      if (
        candidate &&
        (!freshest || compareCodexAuthFreshness(candidate.authRaw, freshest.authRaw) > 0)
      )
        freshest = candidate;
    }
    if (!freshest) continue;
    writeCodexBackup(keeper.id, freshest);
    for (const loser of sorted.slice(1)) {
      const store = readCodexCredentialStore(getCodexProfileHome(loser.id));
      if (store.status === 'error' || store.status === 'corrupt') continue;
      if (store.status === 'ok')
        removeCodexProfileCredentials(getCodexProfileHome(loser.id), store.snapshot);
      const snapshot = readQuotaSnapshot('codex', loser.id);
      if (snapshot && !readQuotaSnapshot('codex', keeper.id))
        writeQuotaSnapshot('codex', keeper.id, snapshot);
      const archive = path.join(getCodexStashDir(), `dup-${loser.id}`);
      fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
      if (fs.existsSync(getCodexProfileDir(loser.id)))
        fs.renameSync(getCodexProfileDir(loser.id), archive);
      if (getActiveSavedAccount('codex')?.id === loser.id)
        setActiveSavedAccount('codex', keeper.id, { silent: true });
      removeSavedAccountProfile('codex', loser.id);
      fs.rmSync(getCodexBackupPath(loser.id), { force: true });
      fs.rmSync(getCodexBackupPath(loser.id, true), { force: true });
      removed.push(loser.id);
    }
    storeCodexProfileAuthUnlocked(keeper.id, freshest.authRaw, freshest.legacyRaw, 'migration');
  }
  return removed;
}

interface CodexSwitchJournal {
  from: string | null;
  to: string;
  fromHash: string;
  toHash: string;
  at: string;
}
function codexJournalPath(): string {
  return path.join(getAccountsDir(), 'codex', 'switch-journal.json');
}
function loginHash(snapshot: CodexAuthSnapshot): string {
  return codexSnapshotFingerprint(codexLoginOnly(snapshot));
}
function clearCodexJournal(): void {
  fs.rmSync(codexJournalPath(), { force: true });
}
export function hasPendingCodexRepair(): boolean {
  if (fs.existsSync(codexJournalPath())) return true;
  const live = readCodexCredentialStore();
  if (live.status === 'error' || live.status === 'corrupt') return true;
  if (live.status !== 'ok') return false;
  return listCodexAccounts().some((p) => {
    if (!profileMatchesSnapshot(p, live.snapshot)) return false;
    const home = readCodexCredentialStore(getCodexProfileHome(p.id));
    const backup = readCodexBackup(p.id);
    return (
      home.status !== 'absent' ||
      (backup.status === 'ok' &&
        compareCodexAuthFreshness(backup.snapshot.authRaw, live.snapshot.authRaw) > 0)
    );
  });
}

function resolveCodexJournal(report: ProviderSyncReport, scan?: AccountConsumerScan): void {
  if (!fs.existsSync(codexJournalPath())) return;
  let journal: CodexSwitchJournal;
  try {
    journal = JSON.parse(fs.readFileSync(codexJournalPath(), 'utf8')) as CodexSwitchJournal;
    if (!journal.to || !journal.fromHash || !journal.toHash) throw new Error();
  } catch {
    report.warnings.push('The Codex switch journal is unreadable; run accounts doctor.');
    return;
  }
  const live = readCodexCredentialStore();
  if (live.status === 'error' || live.status === 'corrupt') {
    report.warnings.push(
      'An interrupted Codex switch is pending; the live login could not be read.',
    );
    return;
  }
  const blocker = consumerBlocker(scan);
  if (blocker) {
    report.warnings.push(blocker);
    return;
  }
  const hash = loginHash(live.snapshot);
  const to = listCodexAccounts().find((p) => p.id === journal.to);
  if (
    hash === journal.toHash ||
    (live.status === 'ok' && to && profileMatchesSnapshot(to, live.snapshot))
  ) {
    if (live.status !== 'ok') return;
    writeCodexBackup(journal.to, live.snapshot);
    const target = readCodexCredentialStore(getCodexProfileHome(journal.to));
    if (target.status === 'error' || target.status === 'corrupt')
      throw new Error('The interrupted switch target is unreadable.');
    if (target.status === 'ok')
      removeCodexProfileCredentials(getCodexProfileHome(journal.to), target.snapshot);
    if (journal.from) {
      const backup = readCodexBackup(journal.from);
      if (backup.status === 'ok' && loginHash(backup.snapshot) === journal.fromHash) {
        if (readCodexCredentialStore(getCodexProfileHome(journal.from)).status === 'absent')
          writeInactiveCodexCredentialStore(getCodexProfileHome(journal.from), backup.snapshot);
        writeCodexHealthSidecar(journal.from, backup.snapshot.authRaw, 'switch');
      }
    }
    setActiveSavedAccount('codex', journal.to, { silent: true });
    report.journal = 'finished';
  } else if (hash === journal.fromHash) {
    const target = readCodexBackup(journal.to);
    if (target.status === 'ok' && loginHash(target.snapshot) === journal.toHash) {
      if (readCodexCredentialStore(getCodexProfileHome(journal.to)).status === 'absent')
        writeInactiveCodexCredentialStore(getCodexProfileHome(journal.to), target.snapshot);
    }
    if (journal.from) {
      const outgoing = readCodexCredentialStore(getCodexProfileHome(journal.from));
      if (outgoing.status === 'ok')
        removeCodexProfileCredentials(getCodexProfileHome(journal.from), outgoing.snapshot);
    }
    setActiveSavedAccount('codex', journal.from, { silent: true });
    report.journal = 'rolled-back';
  } else {
    report.journal = 'cleared';
    report.warnings.push(
      'The live Codex login matches neither side of the interrupted switch; it was kept. Private backups are available for inspection.',
    );
  }
  clearCodexJournal();
}

/** No subprocesses inside this function: hosts resolve process scans before taking the lock. */
export function syncCodexLiveStateUnlocked(
  source: AccountHealthSource = 'live-sync',
  probes: { scan?: AccountConsumerScan; systemKeyringLoggedIn?: boolean } = {},
): ProviderSyncReport {
  const report = emptyProviderSyncReport();
  try {
    const mode = getCodexCredentialStoreMode();
    if (mode !== 'file' && mode !== 'unknown') {
      report.skipped = 'keyring';
      report.warnings.push(CODEX_KEYRING_FIX_HINT);
      return report;
    }
    if (isSidekickCodexHome(getSystemCodexHome())) {
      report.skipped = 'managed-home';
      report.warnings.push('Unset CODEX_HOME before syncing; it points at a Sidekick-owned home.');
      return report;
    }
    resolveCodexJournal(report, probes.scan);
    let live = readCodexCredentialStore();
    if (live.status === 'error' || live.status === 'corrupt') {
      report.skipped = 'unreadable';
      report.warnings.push('The live Codex login could not be read; nothing was replaced.');
      return report;
    }
    if (live.status === 'absent') {
      report.skipped = 'logged-out';
      return report;
    }
    const merged = dedupeCodexProfiles(probes.scan);
    if (merged.length) report.merged = merged;
    const identity = readAuthIdentityFromRaw(live.snapshot.authRaw);
    const initialSnapshot = live.snapshot;
    let profile = listCodexAccounts().find((p) => profileMatchesSnapshot(p, initialSnapshot));
    if (!profile) {
      if (
        !identity?.email &&
        !identity?.workspaceId &&
        identity?.authMode !== 'api-key' &&
        !isLegacyCodexLogin(live.snapshot.legacyRaw)
      ) {
        report.skipped = 'no-identity';
        return report;
      }
      profile = {
        id: randomUUID(),
        providerId: 'codex',
        label: identity?.email ?? identity?.workspaceId ?? 'Codex API key',
        email: identity?.email,
        addedAt: new Date().toISOString(),
        metadata: { ...identity, authMode: identity?.authMode ?? 'api-key', origin: 'live-sync' },
      };
      // API-key identities require their verified bytes before registry matching can work.
      writeCodexBackup(profile.id, live.snapshot);
      upsertSavedAccountProfile(profile);
      report.registered = { id: profile.id, email: profile.email };
    }
    const home = getCodexProfileHome(profile.id);
    ensureCodexProfileDirs(profile.id);
    if (!fs.existsSync(path.join(home, 'config.toml')))
      copySourceCodexConfig(getSystemCodexHome(), home);
    const duplicate = readCodexCredentialStore(home);
    const stored = readStoredCodexAccount(profile.id);
    if (stored && compareCodexAuthFreshness(stored.authRaw, live.snapshot.authRaw) > 0) {
      const install = installIntoLiveCodexStore(stored, profile.id, 'repair', {
        before: live,
        liveAccountId: profile.id,
        scan: probes.scan,
      });
      if (install.ok) {
        live = { status: 'ok', snapshot: install.installed };
        report.repaired = profile.id;
      } else {
        report.warnings.push(
          `A newer Codex login is saved privately; repair is pending. ${install.reason}`,
        );
      }
    }
    const backup = readCodexBackup(profile.id);
    if (
      backup.status !== 'ok' ||
      compareCodexAuthFreshness(backup.snapshot.authRaw, live.snapshot.authRaw) <= 0
    ) {
      writeCodexBackup(profile.id, live.snapshot);
      report.folded = profile.id;
    }
    writeCodexHealthSidecar(profile.id, live.snapshot.authRaw, source);
    if (duplicate.status === 'ok') {
      const blocker = consumerBlocker(probes.scan);
      // Preserve a newer copy even when its promotion must wait.
      if (compareCodexAuthFreshness(duplicate.snapshot.authRaw, live.snapshot.authRaw) > 0)
        writeCodexBackup(profile.id, duplicate.snapshot);
      if (blocker || isAccountLeaseHeld('codex', profile.id))
        report.warnings.push(blocker ?? 'The profile is leased; duplicate cleanup is pending.');
      else {
        removeCodexProfileCredentials(home, duplicate.snapshot);
        report.demoted = profile.id;
      }
    } else if (duplicate.status === 'corrupt' || duplicate.status === 'error') {
      report.warnings.push(
        'The live account has an unreadable profile credential; run accounts doctor.',
      );
    }
    if (getActiveSavedAccount('codex')?.id !== profile.id) {
      setActiveSavedAccount('codex', profile.id, { silent: true });
      report.repointed = profile.id;
    }
  } catch {
    report.warnings.push(
      'Codex account sync could not finish; verified credentials were preserved for the next retry.',
    );
  }
  return report;
}

export function syncCodexLiveState(source: AccountHealthSource = 'live-sync'): ProviderSyncReport {
  const scan = inspectRunningAccountConsumersSync('codex');
  try {
    return withCodexAuthSwapLock(() => syncCodexLiveStateUnlocked(source, { scan }));
  } catch {
    return { warnings: ['Could not acquire the Codex account-switch lock.'] };
  }
}
export async function syncCodexLiveStateAsync(
  source: AccountHealthSource = 'live-sync',
): Promise<ProviderSyncReport> {
  const scan = await inspectRunningAccountConsumers('codex');
  try {
    return withCodexAuthSwapLock(() => syncCodexLiveStateUnlocked(source, { scan }));
  } catch {
    return { warnings: ['Could not acquire the Codex account-switch lock.'] };
  }
}

/** Only abandoned Sidekick-owned login homes; authenticated copies are preserved privately first. */
export function cleanupAbandonedCodexLogins(
  olderThanMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
  scan?: AccountConsumerScan,
): string[] {
  const removed: string[] = [];
  if (consumerBlocker(scan ?? inspectRunningAccountConsumersSync('codex'))) return removed;
  withCodexAuthSwapLock(() => {
    for (const root of [getCodexLoginsDir(), getCodexProfilesDir()]) {
      if (!fs.existsSync(root)) continue;
      for (const id of fs.readdirSync(root)) {
        if (listCodexAccounts().some((p) => p.id === id)) continue;
        const pending = readPendingProfile(id);
        if (!pending || now - Date.parse(pending.addedAt) < olderThanMs) continue;
        const home = getCodexLoginHome(id);
        const read = readCodexCredentialStore(home);
        if (read.status === 'error' || read.status === 'corrupt') continue;
        if (read.status === 'ok') {
          const identity = readAuthIdentityFromRaw(read.snapshot.authRaw);
          const owner = identity
            ? findProfileForIdentity(identity, { fallbackToActive: false })
            : null;
          if (!owner) continue; // An unregistered authenticated login needs a human decision.
          const saved = readStoredCodexAccount(owner.id);
          writeCodexBackup(
            owner.id,
            saved && compareCodexAuthFreshness(saved.authRaw, read.snapshot.authRaw) >= 0
              ? saved
              : read.snapshot,
          );
        }
        discardCodexLogin(id);
        removed.push(id);
      }
    }
  });
  return removed;
}

// ── Switch ───────────────────────────────────────────────────────────────

interface CodexAuthSwapProbes {
  scan: AccountConsumerScan;
}

function performCodexAuthSwapCore(
  target: SavedAccountProfile,
  options: SwitchAccountOptions,
  probes: CodexAuthSwapProbes,
): SwitchAccountResult {
  const base: SwitchAccountResult = {
    success: true,
    provider: 'codex',
    accountId: target.id,
    previousAccountId: getActiveSavedAccount('codex')?.id ?? null,
    verified: false,
    verification: 'none',
    warnings: [],
    hints: [],
    runningConsumers: probes.scan.consumers,
    email: target.email ?? target.metadata?.email,
  };
  const fail = (error: string, extra: Partial<SwitchAccountResult> = {}): SwitchAccountResult =>
    finishSwitchResult({ ...base, success: false, error, ...extra });
  const mode = getCodexCredentialStoreMode();
  if (mode !== 'file' && mode !== 'unknown') return fail(CODEX_KEYRING_FIX_HINT);
  if (isSidekickCodexHome(getSystemCodexHome()))
    return fail('CODEX_HOME points at a Sidekick-owned home; unset it before switching.');
  let before = readCodexCredentialStore();
  if (before.status === 'error' || before.status === 'corrupt')
    return fail('The live Codex login could not be read; it was left untouched.');
  const saved = readStoredCodexAccount(target.id);
  if (before.status === 'ok' && profileMatchesSnapshot(target, before.snapshot)) {
    if (saved && compareCodexAuthFreshness(saved.authRaw, before.snapshot.authRaw) > 0) {
      const result = installIntoLiveCodexStore(saved, target.id, 'relogin', {
        before,
        liveAccountId: target.id,
        scan: probes.scan,
      });
      if (!result.ok) return fail(result.reason);
    }
    const sync = syncCodexLiveStateUnlocked('switch', probes);
    return finishSwitchResult({
      ...base,
      alreadyActive: true,
      verified: true,
      verification: 'store',
      warnings: sync.warnings,
      health: getAccountHealth('codex', target.id),
      hints: ['That account is already the live Codex login.'],
    });
  }
  const blocker = consumerBlocker(probes.scan);
  if (blocker) return fail(blocker);
  if (isAccountLeaseHeld('codex', target.id))
    return fail('Keep-alive is refreshing this account; retry after it finishes.');
  const sync = syncCodexLiveStateUnlocked('switch', probes);
  base.warnings.push(...sync.warnings);
  if (fs.existsSync(codexJournalPath()))
    return fail('An interrupted Codex switch still needs recovery; run accounts doctor.');
  before = readCodexCredentialStore();
  if (before.status === 'error' || before.status === 'corrupt')
    return fail('The live Codex credential could not be read.');
  const beforeSnapshot = before.snapshot;
  const outgoing =
    before.status === 'ok'
      ? listCodexAccounts().find((p) => profileMatchesSnapshot(p, beforeSnapshot))
      : null;
  if (before.status === 'ok' && !outgoing)
    return fail(
      'The live login has no unambiguous account identity to save it under; sign in with Codex and retry.',
    );
  base.previousAccountId = outgoing?.id ?? null;
  if (outgoing?.id === target.id) return fail('The live account changed during the switch; retry.');
  const targetHome = getCodexProfileHome(target.id);
  const targetBefore = readCodexCredentialStore(targetHome);
  if (targetBefore.status === 'error' || targetBefore.status === 'corrupt')
    return fail('The target profile is unreadable; the switch was deferred.');
  const candidate = readStoredCodexAccount(target.id);
  if (!candidate)
    return fail('No readable stored credentials for this account; sign in again.', {
      needsLogin: true,
    });
  const candidateIdentity = readAuthIdentityFromRaw(candidate.authRaw);
  if (
    candidateIdentity?.authMode === 'chatgpt' &&
    !identitiesMatch(candidateIdentity, profileIdentity(target))
  ) {
    return fail('The saved Codex credential does not belong to the selected account.');
  }
  const liveFp = codexRefreshFingerprint(beforeSnapshot.authRaw);
  if (liveFp && liveFp === codexRefreshFingerprint(candidate.authRaw))
    return fail('The target is another copy of the live refresh token; sign in again.');
  const health = getAccountHealth('codex', target.id, { probe: 'store' });
  base.health = health;
  if ((health.state === 'expired' || health.state === 'missing') && !options.force)
    return fail('Stored credentials have expired or are missing; sign in again.', {
      needsLogin: true,
    });
  const refreshed = readLastRefresh(candidate.authRaw);
  if (refreshed !== null && Date.now() - refreshed > STALE_AUTH_THRESHOLD_MS)
    base.warnings.push('The stored Codex login has not been refreshed in over 8 days.');

  // Capture and verify both sides before removing either usable copy. Mandatory even with force.
  try {
    if (outgoing) writeCodexBackup(outgoing.id, beforeSnapshot);
    writeCodexBackup(target.id, candidate);
    atomicWriteJson(codexJournalPath(), {
      from: outgoing?.id ?? null,
      to: target.id,
      fromHash: loginHash(beforeSnapshot),
      toHash: loginHash(candidate),
      at: new Date().toISOString(),
    } satisfies CodexSwitchJournal);
  } catch {
    return fail(
      'The outgoing login or switch journal could not be saved and verified; live was left untouched.',
    );
  }
  if (!codexStoreMatches(readCodexCredentialStore(), beforeSnapshot))
    return fail('The live login changed after capture; the switch was deferred.');
  const profileStore = readCodexCredentialStore(targetHome);
  if (!codexStoreMatches(profileStore, targetBefore.snapshot))
    return fail('The target credential changed after selection; the switch was deferred.');
  if (profileStore.status === 'error' || profileStore.status === 'corrupt')
    return fail('The target profile is unreadable; the switch was deferred.');
  try {
    if (profileStore.status === 'ok')
      removeCodexProfileCredentials(targetHome, profileStore.snapshot);
  } catch {
    return fail('The target copy could not be removed safely; the switch was deferred.');
  }

  const install = installIntoLiveCodexStore(candidate, target.id, 'switch', {
    before,
    liveAccountId: outgoing?.id ?? null,
    capturedOutgoing: Boolean(outgoing),
    scan: probes.scan,
  });
  const recover = (written?: CodexAuthSnapshot): void => {
    if (written) {
      installIntoLiveCodexStore(beforeSnapshot, outgoing?.id ?? target.id, 'rollback', {
        before: readCodexCredentialStore(),
        liveAccountId: target.id,
        written,
        scan: probes.scan,
      });
    }
    // Journal reconciliation never overwrites live and never restores a copy of its identity.
    resolveCodexJournal(emptyProviderSyncReport(), probes.scan);
  };
  if (!install.ok) {
    try {
      recover(install.attempted);
    } catch {
      /* journal and private backups survive */
    }
    return fail(
      `${install.reason} Verified private backups were kept; run accounts doctor if recovery is pending.`,
      { verification: 'failed' },
    );
  }
  try {
    setActiveSavedAccount('codex', target.id);
  } catch {
    try {
      recover(install.installed);
    } catch {
      /* journal survives */
    }
    return fail(
      'The account registry could not be updated; recovery retained the verified backups.',
    );
  }
  try {
    if (outgoing)
      storeCodexProfileAuthUnlocked(
        outgoing.id,
        beforeSnapshot.authRaw,
        beforeSnapshot.legacyRaw,
        'switch',
      );
    writeCodexHealthSidecar(target.id, candidate.authRaw, 'switch');
    clearCodexJournal();
  } catch {
    base.warnings.push(
      'The live switch succeeded; profile cleanup is pending and will retry on sync.',
    );
  }
  let undoToken: string | undefined;
  try {
    undoToken = writeLastSwitch('codex', outgoing?.id ?? null, target.id).token;
  } catch {
    base.warnings.push('The switch succeeded but could not be recorded for undo.');
  }
  return finishSwitchResult({
    ...base,
    verified: true,
    verification: 'store',
    undoToken,
    hints: [`New Codex sessions use ${target.label ?? target.email ?? target.id}.`],
  });
}

export function switchToCodexAccount(
  profileId: string,
  options: SwitchAccountOptions = {},
): SwitchAccountResult {
  const target = listCodexAccounts().find((p) => p.id === profileId);
  if (!target) return switchFailure('codex', profileId, `Codex account ${profileId} not found.`);
  const scan = inspectRunningAccountConsumersSync('codex');
  try {
    return withCodexAuthSwapLock(() => performCodexAuthSwapCore(target, options, { scan }));
  } catch {
    return switchFailure(
      'codex',
      profileId,
      'The Codex switch could not finish; private backups and any pending journal were kept.',
    );
  }
}
export async function switchToCodexAccountAsync(
  profileId: string,
  options: SwitchAccountOptions = {},
): Promise<SwitchAccountResult> {
  const target = listCodexAccounts().find((p) => p.id === profileId);
  if (!target) return switchFailure('codex', profileId, `Codex account ${profileId} not found.`);
  const scan = await inspectRunningAccountConsumers('codex');
  let result: SwitchAccountResult;
  try {
    result = withCodexAuthSwapLock(() => performCodexAuthSwapCore(target, options, { scan }));
  } catch {
    return switchFailure(
      'codex',
      profileId,
      'The Codex switch could not finish; private backups and any pending journal were kept.',
    );
  }
  if (result.success && options.verifyWithCli && !result.alreadyActive) {
    const status = await getCodexLoginStatusAsync(getSystemCodexHome());
    if (status.loggedIn) result.verification = 'cli';
    else
      result = finishSwitchResult({
        ...result,
        warnings: [
          ...result.warnings,
          'Codex could not read the installed login; sign in again if prompted.',
        ],
      });
  }
  return result;
}

/** Legacy migration entry points now use the same guarded reconciliation as ordinary sync. */
export function reconcileCodexAuthState(): void {
  syncCodexLiveState('migration');
}
export async function reconcileCodexAuthStateAsync(): Promise<void> {
  await syncCodexLiveStateAsync('migration');
}

function codexKeepAliveBlockerUnlocked(id: string): string | null {
  if (isSidekickCodexHome(getSystemCodexHome()))
    return 'unset CODEX_HOME before managing accounts; it names a Sidekick-owned home';
  const mode = getCodexCredentialStoreMode();
  if (mode !== 'file' && mode !== 'unknown')
    return 'live credential storage is not readable file mode';
  const profile = listCodexAccounts().find((p) => p.id === id);
  if (!profile) return 'account not found';
  const live = readCodexCredentialStore();
  if (live.status === 'error' || live.status === 'corrupt')
    return 'the live login could not be read';
  if (live.status === 'ok' && profileMatchesSnapshot(profile, live.snapshot))
    return 'live account; the CLI refreshes it in normal use';
  const store = readCodexCredentialStore(getCodexProfileHome(id));
  if (store.status !== 'ok')
    return 'no readable profile copy to refresh (keep-alive never restores backups)';
  const fp = codexRefreshFingerprint(store.snapshot.authRaw);
  if (!fp) return 'no refreshable ChatGPT login';
  if (live.status === 'ok' && fp === codexRefreshFingerprint(live.snapshot.authRaw))
    return 'same refresh token as the live login';
  if (readHealthSidecar('codex', id)?.source === 'live-sync')
    return 'copied from the live login; waits for a switch away from it';
  const backup = readCodexBackup(id);
  if (backup.status === 'error' || backup.status === 'corrupt')
    return 'its private backup could not be read';
  if (
    backup.status === 'ok' &&
    compareCodexAuthFreshness(backup.snapshot.authRaw, store.snapshot.authRaw) > 0
  )
    return 'its saved backup is newer than the profile copy';
  return null;
}
export function getCodexKeepAliveBlocker(id: string): string | null {
  try {
    return withCodexAuthSwapLock(() => codexKeepAliveBlockerUnlocked(id));
  } catch {
    return 'could not acquire the account-switch lock';
  }
}
export function beginCodexKeepAlive(
  id: string,
  leaseMs: number,
): { ok: true } | { ok: false; reason: string } {
  try {
    return withCodexAuthSwapLock(() => {
      const reason = codexKeepAliveBlockerUnlocked(id);
      if (reason) return { ok: false as const, reason };
      return acquireAccountLease('codex', id, leaseMs)
        ? { ok: true as const }
        : { ok: false as const, reason: 'another keep-alive run holds this account' };
    });
  } catch {
    return { ok: false, reason: 'could not acquire the account-switch lock' };
  }
}
export function finishCodexKeepAlive(id: string): void {
  try {
    withCodexAuthSwapLock(() => {
      const profile = listCodexAccounts().find((p) => p.id === id);
      const store = readCodexCredentialStore(getCodexProfileHome(id));
      if (!profile || isLiveCodexProfile(profile) || store.status !== 'ok') return;
      if (
        !identitiesMatch(readAuthIdentityFromRaw(store.snapshot.authRaw), profileIdentity(profile))
      )
        return;
      const backup = readCodexBackup(id);
      if (
        backup.status === 'ok' &&
        compareCodexAuthFreshness(backup.snapshot.authRaw, store.snapshot.authRaw) > 0
      )
        return;
      writeCodexBackup(id, store.snapshot);
      writeCodexHealthSidecar(id, store.snapshot.authRaw, 'keepalive');
    });
  } finally {
    releaseAccountLease('codex', id);
  }
}
export function restoreCodexProfileFromBackup(
  id: string,
  options: { restore?: boolean } = {},
): 'restored' | 'present' | 'live' | 'none' {
  try {
    return withCodexAuthSwapLock(() => {
      if (isSidekickCodexHome(getSystemCodexHome())) return 'none';
      const profile = listCodexAccounts().find((p) => p.id === id);
      if (!profile) return 'none';
      const live = readCodexCredentialStore();
      if (live.status === 'error' || live.status === 'corrupt') return 'none';
      if (isLiveCodexProfile(profile)) return 'live';
      const home = getCodexProfileHome(id);
      const store = readCodexCredentialStore(home);
      if (store.status === 'ok') {
        const fp = codexRefreshFingerprint(store.snapshot.authRaw);
        if (fp && live.status === 'ok' && fp === codexRefreshFingerprint(live.snapshot.authRaw))
          return 'none';
        if (
          !identitiesMatch(
            readAuthIdentityFromRaw(store.snapshot.authRaw),
            profileIdentity(profile),
          ) &&
          readAuthIdentityFromRaw(store.snapshot.authRaw)?.authMode !== 'api-key' &&
          !isLegacyCodexLogin(store.snapshot.legacyRaw)
        )
          return 'none';
        const backup = readCodexBackup(id);
        if (
          backup.status === 'ok' &&
          compareCodexAuthFreshness(backup.snapshot.authRaw, store.snapshot.authRaw) > 0
        )
          return 'none';
        return 'present';
      }
      if (store.status !== 'absent' || options.restore === false) return 'none';
      const backup = readCodexBackup(id);
      if (backup.status !== 'ok') return 'none';
      const fp = codexRefreshFingerprint(backup.snapshot.authRaw);
      if (fp && live.status === 'ok' && fp === codexRefreshFingerprint(live.snapshot.authRaw))
        return 'none';
      writeInactiveCodexCredentialStore(home, backup.snapshot);
      return 'restored';
    });
  } catch {
    return 'none';
  }
}

export function removeCodexAccount(profileId: string): AccountManagerResult {
  const removed = removeSavedAccountProfile('codex', profileId);
  if (!removed) {
    return { success: false, error: `Codex account ${profileId} not found.` };
  }

  fs.rmSync(getCodexProfileDir(profileId), { recursive: true, force: true });
  fs.rmSync(getCodexBackupPath(profileId), { force: true });
  fs.rmSync(getCodexBackupPath(profileId, true), { force: true });
  return { success: true };
}

export async function cleanupAbandonedCodexLoginsAsync(
  olderThanMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
): Promise<string[]> {
  return cleanupAbandonedCodexLogins(
    olderThanMs,
    now,
    await inspectRunningAccountConsumers('codex'),
  );
}
