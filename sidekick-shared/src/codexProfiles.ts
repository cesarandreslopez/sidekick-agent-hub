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
import {
  identitiesMatch,
  parseAuthJson,
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
  getCodexProfilesDir,
  getDefaultSystemCodexHome,
  getExplicitCodexHome,
  getSystemCodexHome,
  readFileOrNull,
} from './codexPaths';
import {
  getAccountHealth,
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
  detectRunningAccountConsumers,
  detectRunningAccountConsumersSync,
  type RunningAccountConsumer,
} from './processDetection';
import { readQuotaSnapshot, writeQuotaSnapshot } from './quotaSnapshots';

export {
  getCodexProfilesDir,
  getCodexProfileHome,
  getSystemCodexHome,
  getCodexCredentialStoreMode,
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

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const candidate of paths) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(candidate);
  }

  return unique;
}

export function getCodexMonitoringHomes(): string[] {
  const explicitHome = getExplicitCodexHome();
  if (explicitHome) return [explicitHome];

  // The system home is the single live home; profile homes only matter for
  // sessions recorded back when they doubled as live CODEX_HOMEs.
  const homes: string[] = [getDefaultSystemCodexHome()];
  for (const profile of listCodexAccounts()) {
    const profileHome = getCodexProfileHome(profile.id);
    if (fs.existsSync(path.join(profileHome, 'sessions'))) {
      homes.push(profileHome);
    }
  }

  return dedupePaths(homes);
}

function readPendingProfile(profileId: string): PendingCodexProfile | null {
  try {
    return JSON.parse(
      fs.readFileSync(getCodexProfileStatePath(profileId), 'utf8'),
    ) as PendingCodexProfile;
  } catch {
    return null;
  }
}

function writePendingProfile(profileId: string, pending: PendingCodexProfile): void {
  ensureCodexProfileDirs(profileId);
  atomicWriteJson(getCodexProfileStatePath(profileId), pending);
}

function copyIfExists(source: string, destination: string): boolean {
  if (!fs.existsSync(source)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, destination);
  return true;
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

function importCurrentCodexAuth(sourceHome: string, targetHome: string): boolean {
  const authCopied = copyIfExists(
    path.join(sourceHome, 'auth.json'),
    path.join(targetHome, 'auth.json'),
  );
  const legacyCredsCopied = copyIfExists(
    path.join(sourceHome, '.credentials.json'),
    path.join(targetHome, '.credentials.json'),
  );
  return authCopied || legacyCredsCopied;
}

/**
 * The single chokepoint for storing a Codex credential in a profile: the raw
 * `auth.json` bytes (never re-serialized), the legacy `.credentials.json`
 * when present, and the secret-free health sidecar.
 */
export function storeCodexProfileAuth(
  profileId: string,
  authRaw: string | null,
  legacyRaw: string | null,
  source: AccountHealthSource,
): void {
  const profileHome = getCodexProfileHome(profileId);
  if (authRaw) atomicWriteFile(path.join(profileHome, 'auth.json'), authRaw);
  if (legacyRaw) atomicWriteFile(path.join(profileHome, '.credentials.json'), legacyRaw);
  if (authRaw) writeCodexHealthSidecar(profileId, authRaw, source);
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

export function parseCodexLoginStatusOutput(
  status: number | null,
  stdout: string,
): CodexLoginStatus {
  const trimmed = stdout.trim();
  if (status === 0 && /^Logged in/i.test(trimmed)) {
    if (/API key/i.test(trimmed)) {
      return { loggedIn: true, authMode: 'api-key' };
    }
    if (/ChatGPT/i.test(trimmed)) {
      return { loggedIn: true, authMode: 'chatgpt' };
    }
    return { loggedIn: true };
  }
  return { loggedIn: false };
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
    return parseCodexLoginStatusOutput(result.status, String(result.stdout ?? ''));
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
        (error, stdout) => {
          // A missing CLI, non-zero exit, or timeout all mean "not logged in".
          resolve(
            error ? { loggedIn: false } : parseCodexLoginStatusOutput(0, String(stdout ?? '')),
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
  return (
    fs.existsSync(path.join(codexHome, 'auth.json')) ||
    fs.existsSync(path.join(codexHome, '.credentials.json'))
  );
}

export function isCodexProfileAuthenticated(codexHome: string): boolean {
  return hasCodexCredentialFiles(codexHome) || getCodexLoginStatus(codexHome).loggedIn;
}

/** {@link isCodexProfileAuthenticated} without blocking the event loop on the CLI probe. */
export async function isCodexProfileAuthenticatedAsync(codexHome: string): Promise<boolean> {
  return hasCodexCredentialFiles(codexHome) || (await getCodexLoginStatusAsync(codexHome)).loggedIn;
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

export function resolveSidekickCodexHome(): string {
  // Account switching swaps auth.json inside the system home, so the system
  // home (or an explicit CODEX_HOME) is always the single live home.
  return getSystemCodexHome();
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

export function getCodexExecutionEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CODEX_HOME: resolveSidekickCodexHome(),
  };
}

// ── Prepare / finalize (add account) ─────────────────────────────────────

type CodexPrepareStep =
  | { result: CodexAccountManagerResult }
  | { finalize: { profileId: string; codexHome: string } };

type CodexFinalizeStep = { result: CodexAccountManagerResult } | { swap: SavedAccountProfile };

function keyringRefusal(mode: string): CodexAccountManagerResult {
  return {
    success: false,
    needsLogin: false,
    error: `Codex stores credentials in the OS keyring (cli_auth_credentials_store = "${mode}"); sidekick can only switch file-based logins. ${CODEX_KEYRING_FIX_HINT}`,
  };
}

function prepareCodexAccountCore(label: string): CodexPrepareStep {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return { result: { success: false, error: 'Codex accounts require a non-empty label.' } };
  }

  const labelError = ensureUniqueCodexLabel(trimmedLabel);
  if (labelError) {
    return { result: { success: false, error: labelError } };
  }

  const sourceHome = getSystemCodexHome();
  const storeMode = getCodexCredentialStoreMode(sourceHome);
  const liveAuthPresent = hasCodexCredentialFiles(sourceHome);
  if (storeMode === 'keyring' || (storeMode === 'auto' && !liveAuthPresent)) {
    return { result: keyringRefusal(storeMode) };
  }

  const profileId = randomUUID();
  const codexHome = getCodexProfileHome(profileId);
  ensureCodexProfileDirs(profileId);
  writePendingProfile(profileId, {
    label: trimmedLabel,
    addedAt: new Date().toISOString(),
  });

  copySourceCodexConfig(sourceHome, codexHome);
  const imported = importCurrentCodexAuth(sourceHome, codexHome);

  if (imported) {
    // The live login may already be saved under another profile: fold into it
    // instead of creating a duplicate seat.
    const identity = readAuthIdentityFromRaw(readFileOrNull(path.join(codexHome, 'auth.json')));
    const existing = identity
      ? findProfileForIdentity(identity, { fallbackToActive: false })
      : null;
    if (existing) {
      try {
        const liveRefresh = readLastRefresh(readFileOrNull(path.join(codexHome, 'auth.json')));
        const storedRefresh = readLastRefresh(
          readFileOrNull(path.join(getCodexProfileHome(existing.id), 'auth.json')),
        );
        const storedIsNewer =
          storedRefresh !== null && liveRefresh !== null && storedRefresh > liveRefresh;
        if (!storedIsNewer) {
          storeCodexProfileAuth(
            existing.id,
            readFileOrNull(path.join(codexHome, 'auth.json')),
            readFileOrNull(path.join(codexHome, '.credentials.json')),
            'login',
          );
        }
      } catch {
        /* the existing backup stays as it was */
      }
      fs.rmSync(getCodexProfileDir(profileId), { recursive: true, force: true });
      const relabel =
        existing.metadata?.origin === 'live-sync' && existing.label === existing.email
          ? {
              ...existing,
              label: trimmedLabel,
              metadata: { ...existing.metadata, origin: 'manual' as const },
            }
          : existing;
      if (relabel !== existing) upsertSavedAccountProfile(relabel);
      return {
        result: {
          success: true,
          profileId: existing.id,
          codexHome: getCodexProfileHome(existing.id),
          needsLogin: false,
          warning: `This Codex login is already saved as "${relabel.label ?? existing.email ?? existing.id}".`,
        },
      };
    }
    return { finalize: { profileId, codexHome } };
  }

  return { result: { success: true, profileId, codexHome, needsLogin: true } };
}

export function prepareCodexAccount(label: string): CodexAccountManagerResult {
  const step = prepareCodexAccountCore(label);
  if ('finalize' in step) {
    const finalized = finalizeCodexAccount(step.finalize.profileId);
    return { ...finalized, ...step.finalize, needsLogin: false };
  }
  return step.result;
}

/** {@link prepareCodexAccount} without blocking the event loop on CLI probes. */
export async function prepareCodexAccountAsync(label: string): Promise<CodexAccountManagerResult> {
  const step = prepareCodexAccountCore(label);
  if ('finalize' in step) {
    const finalized = await finalizeCodexAccountAsync(step.finalize.profileId);
    return { ...finalized, ...step.finalize, needsLogin: false };
  }
  return step.result;
}

function finalizeCodexAccountCore(
  profileId: string,
  opts: { activate?: boolean },
  probes: { authenticated: boolean; metadata: AccountIdentityMetadata },
): CodexFinalizeStep {
  const pending = readPendingProfile(profileId);
  if (!pending) {
    // Already finalized: `prepareCodexAccount` folds a live login that is
    // already saved into its profile and reports `needsLogin: false`, and the
    // login flow then finalizes that profile id. Activate it if asked.
    const saved = listCodexAccounts().find((profile) => profile.id === profileId);
    if (!saved) {
      return { result: { success: false, error: `Codex profile ${profileId} was not prepared.` } };
    }
    if (opts.activate === false) return { result: { success: true, profileId } };
    return { swap: saved };
  }

  const codexHome = getCodexProfileHome(profileId);
  if (!probes.authenticated) {
    return { result: { success: false, error: 'Codex profile is not authenticated yet.' } };
  }

  // A fresh isolated login for an account that is already saved: fold into the
  // existing profile rather than registering a second seat.
  const authRaw = readFileOrNull(path.join(codexHome, 'auth.json'));
  const identity = readAuthIdentityFromRaw(authRaw);
  const existing = identity ? findProfileForIdentity(identity, { fallbackToActive: false }) : null;
  if (existing && existing.id !== profileId) {
    storeCodexProfileAuth(
      existing.id,
      authRaw,
      readFileOrNull(path.join(codexHome, '.credentials.json')),
      'login',
    );
    fs.rmSync(getCodexProfileDir(profileId), { recursive: true, force: true });
    const merged: SavedAccountProfile = {
      ...existing,
      label: existing.metadata?.origin === 'live-sync' ? pending.label : existing.label,
      email: probes.metadata.email ?? existing.email,
      metadata: { ...existing.metadata, ...probes.metadata, origin: 'login' },
    };
    upsertSavedAccountProfile(merged);
    if (opts.activate === false) return { result: { success: true, profileId: existing.id } };
    return { swap: merged };
  }

  const profile: SavedAccountProfile = {
    id: profileId,
    providerId: 'codex',
    label: pending.label,
    email: probes.metadata.email,
    addedAt: pending.addedAt,
    metadata: { ...probes.metadata, origin: 'login' },
  };
  upsertSavedAccountProfile(profile);
  if (authRaw) writeCodexHealthSidecar(profileId, authRaw, 'login');
  try {
    fs.rmSync(getCodexProfileStatePath(profileId), { force: true });
  } catch {
    /* the pending marker is advisory */
  }

  if (opts.activate === false) {
    return { result: { success: true, profileId } };
  }

  if (!hasCodexCredentialFiles(codexHome)) {
    // Authenticated via the OS keyring — there are no credential files to
    // swap, so the registry pointer is all we can update.
    setActiveSavedAccount('codex', profileId);
    return {
      result: {
        success: true,
        profileId,
        warning: `Codex stores credentials in the OS keyring; sidekick cannot swap them per account, so \`codex\` keeps using the keyring credentials. ${CODEX_KEYRING_FIX_HINT}`,
      },
    };
  }

  return { swap: profile };
}

export function finalizeCodexAccount(
  profileId: string,
  opts: { activate?: boolean } = {},
): CodexAccountManagerResult {
  if (!readPendingProfile(profileId)) {
    // Already finalized: the core activates a saved profile without probing.
    const step = finalizeCodexAccountCore(profileId, opts, { authenticated: false, metadata: {} });
    return 'swap' in step ? performCodexAuthSwap(step.swap, {}) : step.result;
  }
  const codexHome = getCodexProfileHome(profileId);
  const authenticated = isCodexProfileAuthenticated(codexHome);
  const step = finalizeCodexAccountCore(profileId, opts, {
    authenticated,
    metadata: authenticated ? readCodexAccountMetadata(codexHome) : {},
  });
  return 'swap' in step ? performCodexAuthSwap(step.swap, {}) : step.result;
}

/** {@link finalizeCodexAccount} without blocking the event loop on CLI probes. */
export async function finalizeCodexAccountAsync(
  profileId: string,
  opts: { activate?: boolean } = {},
): Promise<CodexAccountManagerResult> {
  if (!readPendingProfile(profileId)) {
    // Already finalized: the core activates a saved profile without probing.
    const step = finalizeCodexAccountCore(profileId, opts, { authenticated: false, metadata: {} });
    return 'swap' in step ? performCodexAuthSwapAsync(step.swap, {}) : step.result;
  }
  const codexHome = getCodexProfileHome(profileId);
  const authenticated = await isCodexProfileAuthenticatedAsync(codexHome);
  const step = finalizeCodexAccountCore(profileId, opts, {
    authenticated,
    metadata: authenticated ? await readCodexAccountMetadataAsync(codexHome) : {},
  });
  return 'swap' in step ? performCodexAuthSwapAsync(step.swap, {}) : step.result;
}

// ── Stash / identity matching ────────────────────────────────────────────

function getCodexStashDir(): string {
  return path.join(getAccountsDir(), 'codex', 'stash');
}

function stashLiveCodexAuth(
  liveAuthRaw: string | null,
  liveLegacyRaw: string | null,
): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let stashPath: string | null = null;
    if (liveAuthRaw) {
      stashPath = path.join(getCodexStashDir(), `auth-${stamp}.json`);
      atomicWriteFile(stashPath, liveAuthRaw);
    }
    if (liveLegacyRaw) {
      const legacyStashPath = path.join(getCodexStashDir(), `credentials-${stamp}.json`);
      atomicWriteFile(legacyStashPath, liveLegacyRaw);
      stashPath = stashPath ?? legacyStashPath;
    }
    return stashPath;
  } catch {
    return null;
  }
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
      (profile) => (profile.email ?? profile.metadata?.email) === identity.email,
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

/**
 * Merge duplicate Codex profiles (same workspace, else same email). The oldest
 * profile keeps its id and label, receives the freshest `auth.json` and the
 * quota snapshot, and the active pointer; losers are stashed, never deleted.
 * Returns the removed ids. Caller holds the swap lock.
 */
export function dedupeCodexProfiles(): string[] {
  const removed: string[] = [];
  const profiles = listCodexAccounts();
  const groups = new Map<string, SavedAccountProfile[]>();
  for (const profile of profiles) {
    const key = profile.metadata?.workspaceId
      ? `ws:${profile.metadata.workspaceId}`
      : (profile.email ?? profile.metadata?.email)
        ? `email:${profile.email ?? profile.metadata?.email}`
        : `id:${profile.id}`;
    groups.set(key, [...(groups.get(key) ?? []), profile]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => Date.parse(a.addedAt) - Date.parse(b.addedAt));
    const keeper = sorted[0];
    const keeperAuthPath = path.join(getCodexProfileHome(keeper.id), 'auth.json');
    let freshestRaw = readFileOrNull(keeperAuthPath);
    let freshestAt = readLastRefresh(freshestRaw, keeperAuthPath) ?? -1;
    const activeId = getActiveSavedAccount('codex')?.id;

    for (const loser of sorted.slice(1)) {
      const loserAuthPath = path.join(getCodexProfileHome(loser.id), 'auth.json');
      const loserRaw = readFileOrNull(loserAuthPath);
      const loserAt = readLastRefresh(loserRaw, loserAuthPath) ?? -1;
      if (loserRaw && loserAt > freshestAt) {
        freshestRaw = loserRaw;
        freshestAt = loserAt;
      }
      try {
        if (!readQuotaSnapshot('codex', keeper.id)) {
          const snapshot = readQuotaSnapshot('codex', loser.id);
          if (snapshot) writeQuotaSnapshot('codex', keeper.id, snapshot);
        }
      } catch {
        /* quota re-key is best-effort */
      }
      try {
        const stashDir = path.join(
          getCodexStashDir(),
          `dup-${loser.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
        );
        fs.mkdirSync(path.dirname(stashDir), { recursive: true, mode: 0o700 });
        fs.renameSync(getCodexProfileDir(loser.id), stashDir);
      } catch {
        fs.rmSync(getCodexProfileDir(loser.id), { recursive: true, force: true });
      }
      removeSavedAccountProfile('codex', loser.id);
      removed.push(loser.id);
      if (activeId === loser.id) setActiveSavedAccount('codex', keeper.id, { silent: true });
    }

    if (freshestRaw && freshestRaw !== readFileOrNull(keeperAuthPath)) {
      storeCodexProfileAuth(keeper.id, freshestRaw, null, 'migration');
    }
    const metadata = readCodexAccountMetadataFromFiles(getCodexProfileHome(keeper.id)) ?? {};
    upsertSavedAccountProfile({
      ...keeper,
      email: metadata.email ?? keeper.email,
      metadata: { ...keeper.metadata, ...metadata },
    });
  }
  return removed;
}

/**
 * Fold the live `auth.json` into the saved profiles: register an unknown login
 * (label = email), refresh the matching profile's backup when the live file is
 * newer, and re-point the active pointer at it. Caller holds the swap lock.
 * Never throws; problems land in `warnings`.
 */
export function syncCodexLiveStateUnlocked(
  source: AccountHealthSource = 'live-sync',
  probes: { systemKeyringLoggedIn?: boolean } = {},
): ProviderSyncReport {
  const report = emptyProviderSyncReport();
  try {
    const merged = dedupeCodexProfiles();
    if (merged.length) report.merged = merged;

    const systemHome = getSystemCodexHome();
    const liveAuthPath = path.join(systemHome, 'auth.json');
    const liveAuthRaw = readFileOrNull(liveAuthPath);
    const liveLegacyRaw = readFileOrNull(path.join(systemHome, '.credentials.json'));
    if (!liveAuthRaw && !liveLegacyRaw) {
      const mode = getCodexCredentialStoreMode(systemHome);
      if (probes.systemKeyringLoggedIn || mode === 'keyring' || mode === 'auto') {
        report.skipped = 'keyring';
        report.warnings.push(
          `Codex keeps its login in the OS keyring; sidekick cannot switch it. ${CODEX_KEYRING_FIX_HINT}`,
        );
      } else {
        report.skipped = 'logged-out';
      }
      return report;
    }

    const identity = readAuthIdentityFromRaw(liveAuthRaw);
    let profile = findProfileForIdentity(identity, { fallbackToActive: false });
    if (!profile && identity && (identity.email || identity.workspaceId)) {
      const profileId = randomUUID();
      profile = {
        id: profileId,
        providerId: 'codex',
        label: identity.email ?? identity.workspaceId,
        email: identity.email,
        addedAt: new Date().toISOString(),
        metadata: {
          email: identity.email,
          workspaceId: identity.workspaceId,
          planType: identity.planType,
          authMode: identity.authMode,
          origin: 'live-sync',
        },
      };
      ensureCodexProfileDirs(profileId);
      copySourceCodexConfig(systemHome, getCodexProfileHome(profileId));
      upsertSavedAccountProfile(profile);
      report.registered = { id: profileId, email: identity.email };
    } else if (!profile) {
      // API-key auth or an unparseable token: fold into the active profile
      // only when it is itself an api-key login; otherwise stash.
      const active = getActiveCodexAccount();
      if (active && active.metadata?.authMode === 'api-key') {
        profile = active;
      } else {
        report.skipped = 'no-identity';
        return report;
      }
    }

    // Codex rotates the refresh token in place, so for the same identity the
    // live file is the freshest copy unless the profile was refreshed on its
    // own (keep-alive, isolated launch) and both files say when.
    const profileAuthPath = path.join(getCodexProfileHome(profile.id), 'auth.json');
    const storedRaw = readFileOrNull(profileAuthPath);
    const storedRefresh = readLastRefresh(storedRaw);
    const liveRefresh = readLastRefresh(liveAuthRaw);
    const storedIsNewer =
      storedRefresh !== null && liveRefresh !== null && storedRefresh > liveRefresh;
    const newer = liveAuthRaw !== storedRaw && !storedIsNewer;
    if (newer) {
      try {
        storeCodexProfileAuth(profile.id, liveAuthRaw, liveLegacyRaw, source);
        const metadata = readCodexAccountMetadataFromFiles(getCodexProfileHome(profile.id)) ?? {};
        upsertSavedAccountProfile({
          ...profile,
          email: metadata.email ?? profile.email,
          metadata: { ...profile.metadata, ...metadata },
        });
        report.folded = profile.id;
      } catch (err) {
        report.warnings.push(`Could not back up the live Codex credentials: ${err}`);
      }
    }

    const active = getActiveSavedAccount('codex');
    if (!active || active.id !== profile.id) {
      setActiveSavedAccount('codex', profile.id, { silent: true });
      report.repointed = profile.id;
    }
  } catch (err) {
    report.warnings.push(`Codex account sync failed: ${err}`);
  }
  return report;
}

/** {@link syncCodexLiveStateUnlocked} under the swap lock. */
export function syncCodexLiveState(source: AccountHealthSource = 'live-sync'): ProviderSyncReport {
  try {
    return withCodexAuthSwapLock(() => syncCodexLiveStateUnlocked(source));
  } catch (err) {
    return { warnings: [`Could not acquire the account-switch lock: ${err}`] };
  }
}

/**
 * Remove isolated login homes that never authenticated once they are older
 * than `olderThanMs`. Returns the removed profile ids.
 */
export function cleanupAbandonedCodexLogins(
  olderThanMs: number = 6 * 60 * 60 * 1000,
  now: number = Date.now(),
): string[] {
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(getCodexProfilesDir());
  } catch {
    return removed;
  }
  const registered = new Set(listCodexAccounts().map((p) => p.id));
  for (const profileId of entries) {
    if (registered.has(profileId)) continue;
    const pending = readPendingProfile(profileId);
    if (!pending) continue;
    if (hasCodexCredentialFiles(getCodexProfileHome(profileId))) continue;
    const addedAt = Date.parse(pending.addedAt);
    const age = Number.isNaN(addedAt) ? Number.POSITIVE_INFINITY : now - addedAt;
    if (age < olderThanMs) continue;
    try {
      fs.rmSync(getCodexProfileDir(profileId), { recursive: true, force: true });
      removed.push(profileId);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

// ── Switch ───────────────────────────────────────────────────────────────

interface CodexAuthSwapProbes {
  consumers: RunningAccountConsumer[];
  /** Resolved only when the system home has no credential files; false otherwise. */
  systemKeyringLoggedIn: boolean;
}

/**
 * CLI probes are resolved before the auth-swap lock is taken — never spawn a
 * child process while holding it. The keyring probe is skipped (false) when
 * live credential files exist, because the swap only consults it in their
 * absence.
 */
function resolveCodexSwapProbesSync(): CodexAuthSwapProbes {
  const systemHome = getSystemCodexHome();
  return {
    consumers: detectRunningAccountConsumersSync('codex'),
    systemKeyringLoggedIn: hasCodexCredentialFiles(systemHome)
      ? false
      : getCodexLoginStatus(systemHome).loggedIn,
  };
}

async function resolveCodexSwapProbesAsync(): Promise<CodexAuthSwapProbes> {
  const systemHome = getSystemCodexHome();
  return {
    consumers: await detectRunningAccountConsumers('codex'),
    systemKeyringLoggedIn: hasCodexCredentialFiles(systemHome)
      ? false
      : (await getCodexLoginStatusAsync(systemHome)).loggedIn,
  };
}

function performCodexAuthSwap(
  target: SavedAccountProfile,
  options: SwitchAccountOptions,
): SwitchAccountResult {
  const probes = resolveCodexSwapProbesSync();
  try {
    return withCodexAuthSwapLock(() => performCodexAuthSwapCore(target, options, probes));
  } catch (err) {
    // Keep the non-throwing result contract when the lock cannot be acquired.
    return switchFailure('codex', target.id, `Could not acquire the account-switch lock: ${err}`);
  }
}

async function performCodexAuthSwapAsync(
  target: SavedAccountProfile,
  options: SwitchAccountOptions,
): Promise<SwitchAccountResult> {
  const probes = await resolveCodexSwapProbesAsync();
  let result: SwitchAccountResult;
  try {
    // The sync lock is fine here: probes are pre-resolved, so the critical
    // section is only fast local-filesystem work.
    result = withCodexAuthSwapLock(() => performCodexAuthSwapCore(target, options, probes));
  } catch (err) {
    return switchFailure('codex', target.id, `Could not acquire the account-switch lock: ${err}`);
  }
  if (result.success && options.verifyWithCli && !result.alreadyActive) {
    const status = await getCodexLoginStatusAsync(getSystemCodexHome());
    result = status.loggedIn
      ? { ...result, verification: 'cli' }
      : finishSwitchResult({
          ...result,
          warnings: [
            ...result.warnings,
            '`codex login status` reports "Not logged in" after the switch; the stored token may have been revoked. Sign in again if codex prompts you.',
          ],
        });
  }
  return result;
}

function performCodexAuthSwapCore(
  target: SavedAccountProfile,
  options: SwitchAccountOptions,
  probes: CodexAuthSwapProbes,
): SwitchAccountResult {
  const systemHome = getSystemCodexHome();
  const liveAuthPath = path.join(systemHome, 'auth.json');
  const liveLegacyPath = path.join(systemHome, '.credentials.json');
  const targetName = target.label ?? target.email ?? target.id;
  let previousAccountId = getActiveSavedAccount('codex')?.id ?? null;
  const base: SwitchAccountResult = {
    success: true,
    provider: 'codex',
    accountId: target.id,
    previousAccountId,
    verified: false,
    verification: 'none',
    warnings: [],
    hints: [],
    runningConsumers: probes.consumers,
    email: target.email ?? target.metadata?.email,
  };

  const profilesDir = path.resolve(getCodexProfilesDir());
  const resolvedHome = path.resolve(systemHome);
  if (resolvedHome === profilesDir || resolvedHome.startsWith(profilesDir + path.sep)) {
    return finishSwitchResult({
      ...base,
      success: false,
      error: `CODEX_HOME points at a sidekick profile home (${systemHome}); unset it before switching accounts.`,
    });
  }

  const liveBefore = readFileOrNull(liveAuthPath);
  const liveLegacyBefore = readFileOrNull(liveLegacyPath);
  if (!liveBefore && !liveLegacyBefore && probes.systemKeyringLoggedIn) {
    return finishSwitchResult({
      ...base,
      success: false,
      error: `Codex stores credentials in the OS keyring; file-based account switching is not supported. ${CODEX_KEYRING_FIX_HINT}`,
    });
  }

  // Phase 1: fold the live (freshest, rotated) credentials back into their
  // profile, registering the login if sidekick has never seen it.
  const sync = syncCodexLiveStateUnlocked('switch', {
    systemKeyringLoggedIn: probes.systemKeyringLoggedIn,
  });
  base.warnings.push(...sync.warnings);
  // Only now is the "previous" account known: the sync may have re-pointed or
  // registered the login that was really live, and undo must return to it.
  previousAccountId = getActiveSavedAccount('codex')?.id ?? null;
  base.previousAccountId = previousAccountId;
  if (sync.skipped === 'no-identity' && liveBefore) {
    const stashPath = stashLiveCodexAuth(liveBefore, liveLegacyBefore);
    base.warnings.push(
      stashPath
        ? `Live Codex credentials did not match any saved account; stashed at ${stashPath}.`
        : 'Live Codex credentials did not match any saved account and could not be stashed.',
    );
  }

  // Re-read after the sync: the target may have received the live file.
  const liveAuthRaw = readFileOrNull(liveAuthPath);
  const liveLegacyRaw = readFileOrNull(liveLegacyPath);
  const profileHome = getCodexProfileHome(target.id);
  const targetAuthPath = path.join(profileHome, 'auth.json');
  const targetAuthRaw = readFileOrNull(targetAuthPath);
  const targetLegacyRaw = readFileOrNull(path.join(profileHome, '.credentials.json'));

  if (!targetAuthRaw && !targetLegacyRaw) {
    return finishSwitchResult({
      ...base,
      success: false,
      needsLogin: true,
      error: `No stored credentials for "${targetName}". Sign in again to this account.`,
    });
  }
  if (targetAuthRaw && !parseAuthJson(targetAuthRaw)) {
    return finishSwitchResult({
      ...base,
      success: false,
      needsLogin: true,
      error: `Stored credentials for "${targetName}" are corrupted. Sign in again to this account.`,
    });
  }

  // If the live file already belongs to the target account it is the freshest
  // copy (rotated refresh token included) — never replace it with a staler
  // backup, which would permanently invalidate the login.
  const liveIdentity = readAuthIdentityFromRaw(liveAuthRaw);
  const liveMatchesTarget = Boolean(
    identitiesMatch(liveIdentity, {
      ...profileIdentity(target),
      ...(readAuthIdentityFromRaw(targetAuthRaw) ?? {}),
    }) ||
    (liveAuthRaw !== null && liveAuthRaw === targetAuthRaw) ||
    (!liveAuthRaw && !targetAuthRaw && liveLegacyRaw !== null && liveLegacyRaw === targetLegacyRaw),
  );
  if (liveMatchesTarget) {
    if (previousAccountId !== target.id) setActiveSavedAccount('codex', target.id);
    return finishSwitchResult({
      ...base,
      alreadyActive: true,
      verified: true,
      verification: 'store',
      health: getAccountHealth('codex', target.id),
      hints: [`${targetName} is already the active Codex account.`],
    });
  }

  // Preflight: warn about stale backups; refuse ones known to be dead.
  const health = getAccountHealth('codex', target.id, { probe: 'store' });
  base.health = health;
  if ((health.state === 'expired' || health.state === 'missing') && !options.force) {
    return finishSwitchResult({
      ...base,
      success: false,
      needsLogin: true,
      error: `Stored credentials for "${targetName}" have expired; sign in again.`,
    });
  }
  const targetLastRefresh = readLastRefresh(targetAuthRaw, targetAuthPath);
  if (targetLastRefresh !== null && Date.now() - targetLastRefresh > STALE_AUTH_THRESHOLD_MS) {
    base.warnings.push(
      `Stored credentials for "${targetName}" have not been refreshed in over 8 days; codex may ask you to log in again.`,
    );
  }

  const restoreLiveFiles = (): void => {
    try {
      if (liveAuthRaw) atomicWriteFile(liveAuthPath, liveAuthRaw);
      else fs.rmSync(liveAuthPath, { force: true });
      if (liveLegacyRaw) atomicWriteFile(liveLegacyPath, liveLegacyRaw);
      else fs.rmSync(liveLegacyPath, { force: true });
    } catch {
      /* rollback is best-effort */
    }
    try {
      setActiveSavedAccount('codex', previousAccountId, { silent: true });
    } catch {
      /* rollback is best-effort */
    }
  };

  // Install.
  try {
    if (targetAuthRaw) {
      atomicWriteFile(liveAuthPath, targetAuthRaw);
      if (targetLegacyRaw) atomicWriteFile(liveLegacyPath, targetLegacyRaw);
      else if (liveLegacyRaw) fs.rmSync(liveLegacyPath, { force: true });
    } else {
      atomicWriteFile(liveLegacyPath, targetLegacyRaw!);
      if (liveAuthRaw) fs.rmSync(liveAuthPath, { force: true });
    }
  } catch (err) {
    restoreLiveFiles();
    return finishSwitchResult({
      ...base,
      success: false,
      error: `Failed to write Codex credentials: ${err}`,
    });
  }

  // Verify by re-reading the live file.
  const installed = readFileOrNull(targetAuthRaw ? liveAuthPath : liveLegacyPath);
  const expected = targetAuthRaw ?? targetLegacyRaw;
  const installedIdentity = targetAuthRaw ? readAuthIdentityFromRaw(installed) : null;
  const verified =
    installed === expected &&
    (!targetAuthRaw ||
      identitiesMatch(installedIdentity, {
        ...profileIdentity(target),
        ...(readAuthIdentityFromRaw(targetAuthRaw) ?? {}),
      }) ||
      installedIdentity?.authMode === 'api-key');
  if (!verified) {
    restoreLiveFiles();
    return finishSwitchResult({
      ...base,
      success: false,
      verification: 'failed',
      error: `The live Codex credential file did not reflect the switch to "${targetName}"; the previous login was restored.`,
    });
  }

  // Pointer last.
  try {
    setActiveSavedAccount('codex', target.id);
  } catch (err) {
    restoreLiveFiles();
    return finishSwitchResult({
      ...base,
      success: false,
      error: `Failed to update account registry: ${err}`,
    });
  }

  let undoToken: string | undefined;
  try {
    undoToken = writeLastSwitch('codex', previousAccountId, target.id).token;
  } catch {
    base.warnings.push('The switch succeeded but could not be recorded for undo.');
  }

  return finishSwitchResult({
    ...base,
    verified: true,
    verification: 'store',
    undoToken,
    hints: [`New codex sessions use ${target.email ?? targetName}.`],
  });
}

export function switchToCodexAccount(
  profileId: string,
  options: SwitchAccountOptions = {},
): SwitchAccountResult {
  const target = listCodexAccounts().find((account) => account.id === profileId);
  if (!target) {
    return switchFailure('codex', profileId, `Codex account ${profileId} not found.`);
  }

  return performCodexAuthSwap(target, options);
}

/** {@link switchToCodexAccount} without blocking the event loop on CLI probes. */
export async function switchToCodexAccountAsync(
  profileId: string,
  options: SwitchAccountOptions = {},
): Promise<SwitchAccountResult> {
  const target = listCodexAccounts().find((account) => account.id === profileId);
  if (!target) {
    return switchFailure('codex', profileId, `Codex account ${profileId} not found.`);
  }

  return performCodexAuthSwapAsync(target, options);
}

// ── One-time migration ───────────────────────────────────────────────────

/**
 * The reconcile flow consults the keyring probe only when the migration has
 * not run yet and the system home has no auth.json; skip the spawn otherwise.
 */
function needsReconcileKeyringProbe(): boolean {
  const markerPath = path.join(getAccountsDir(), 'codex', '.live-auth-migrated-v1');
  if (fs.existsSync(markerPath)) return false;
  return !fs.existsSync(path.join(getSystemCodexHome(), 'auth.json'));
}

// One-time migration for installs created when profile homes doubled as live
// CODEX_HOMEs: the active profile's auth.json may hold a fresher rotated
// refresh token than the system home. Best-effort: never throws.
export function reconcileCodexAuthState(): void {
  try {
    const systemKeyringLoggedIn = needsReconcileKeyringProbe()
      ? getCodexLoginStatus(getSystemCodexHome()).loggedIn
      : false;
    withCodexAuthSwapLock(() => reconcileCodexAuthStateCore({ systemKeyringLoggedIn }));
  } catch {
    // Reconciliation must never break startup — including a lock timeout.
  }
}

/** {@link reconcileCodexAuthState} without blocking the event loop on CLI probes. */
export async function reconcileCodexAuthStateAsync(): Promise<void> {
  try {
    const systemKeyringLoggedIn = needsReconcileKeyringProbe()
      ? (await getCodexLoginStatusAsync(getSystemCodexHome())).loggedIn
      : false;
    withCodexAuthSwapLock(() => reconcileCodexAuthStateCore({ systemKeyringLoggedIn }));
  } catch {
    // Reconciliation must never break startup — including a lock timeout.
  }
}

function reconcileCodexAuthStateCore(probes: { systemKeyringLoggedIn: boolean }): void {
  try {
    const markerPath = path.join(getAccountsDir(), 'codex', '.live-auth-migrated-v1');
    if (fs.existsSync(markerPath)) return;
    const writeMarker = (): void => atomicWriteFile(markerPath, new Date().toISOString() + '\n');

    const active = getActiveCodexAccount();
    if (!active) {
      writeMarker();
      return;
    }

    const profileHome = getCodexProfileHome(active.id);
    const profileAuthPath = path.join(profileHome, 'auth.json');
    const profileAuthRaw = readFileOrNull(profileAuthPath);
    if (!profileAuthRaw) {
      writeMarker();
      return;
    }

    const systemHome = getSystemCodexHome();
    const liveAuthPath = path.join(systemHome, 'auth.json');
    const liveAuthRaw = readFileOrNull(liveAuthPath);

    if (!liveAuthRaw) {
      // No live credentials (account was added via isolated login and never
      // promoted). Promote the active profile's copy unless codex is logged
      // in through the OS keyring. The probe was resolved before the swap
      // lock was taken — never spawn while holding it.
      if (!probes.systemKeyringLoggedIn) {
        atomicWriteFile(liveAuthPath, profileAuthRaw);
      }
      writeMarker();
      return;
    }

    const liveIdentity = readAuthIdentityFromRaw(liveAuthRaw);
    const profileIdentityValue = readAuthIdentityFromRaw(profileAuthRaw);
    const sameIdentity = identitiesMatch(liveIdentity, profileIdentityValue);

    if (sameIdentity) {
      const liveRefresh = readLastRefresh(liveAuthRaw, liveAuthPath);
      const profileRefresh = readLastRefresh(profileAuthRaw, profileAuthPath);
      if (profileRefresh !== null && (liveRefresh === null || profileRefresh > liveRefresh)) {
        // The profile copy was the live home under the old model and holds
        // the valid rotated refresh token — promote it.
        stashLiveCodexAuth(liveAuthRaw, null);
        atomicWriteFile(liveAuthPath, profileAuthRaw);
      } else {
        storeCodexProfileAuth(active.id, liveAuthRaw, null, 'migration');
      }
    } else {
      // The live credentials belong to a different account; the live state
      // wins — point the registry at the matching saved profile if there is
      // one, and refresh its backup.
      const matching = findProfileForIdentity(liveIdentity);
      if (matching && matching.id !== active.id) {
        storeCodexProfileAuth(matching.id, liveAuthRaw, null, 'migration');
        setActiveSavedAccount('codex', matching.id);
      }
    }

    writeMarker();
  } catch {
    // Reconciliation must never break startup.
  }
}

export function removeCodexAccount(profileId: string): AccountManagerResult {
  const removed = removeSavedAccountProfile('codex', profileId);
  if (!removed) {
    return { success: false, error: `Codex account ${profileId} not found.` };
  }

  fs.rmSync(getCodexProfileDir(profileId), { recursive: true, force: true });
  return { success: true };
}
