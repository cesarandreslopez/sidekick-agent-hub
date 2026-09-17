/**
 * Multi-account management for Claude Code logins.
 *
 * Handles saving, listing, switching, syncing, and removing Claude accounts.
 * Both the VS Code extension and CLI consume this module.
 *
 * Model: the live home (`CLAUDE_CONFIG_DIR` or `~/.claude`) is the source of
 * truth for whichever account is logged in right now; every saved profile is a
 * backup that the sync core keeps fresh, because Claude Code rotates the
 * refresh token on every refresh and a stale snapshot is a dead login.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readActiveCredentials,
  writeActiveCredentials,
  deleteStoredCredentials,
} from './credentialIO';
import { atomicWriteJsonSync as atomicWriteJson, withFileLockSync } from './writers/atomic';
import {
  getAccountsDir,
  getActiveSavedAccount,
  listSavedAccountProfiles,
  readSavedAccountRegistry,
  removeSavedAccountProfileUnlocked,
  replaceSavedAccountProfiles,
  setActiveSavedAccount,
  setActiveSavedAccountUnlocked,
  upsertSavedAccountProfile,
  upsertSavedAccountProfileUnlocked,
  withSavedAccountRegistryLock,
  type ResolvedActiveAccount,
  type SavedAccountProfile,
} from './accountRegistry';
import {
  getClaudeConfigPath,
  getClaudeProfileDir,
  getClaudeProfileHome,
  getClaudeProfilesDir,
  getLiveClaudeHome,
  isClaudeProfileAuthenticated,
  readLiveClaudeIdentity,
} from './claudeProfiles';
import { parseClaudeCredentialBlob, claudeCredentialFreshness } from './claudeCredentials';
import {
  getAccountHealth,
  readHealthSidecar,
  writeClaudeHealthSidecar,
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

// ── Types ────────────────────────────────────────────────────────────────

export interface AccountEntry {
  uuid: string;
  email: string;
  label?: string;
  addedAt: string;
}

export interface AccountRegistry {
  version: 1;
  activeAccountUuid: string | null;
  accounts: AccountEntry[];
}

export interface ActiveAccountInfo {
  email: string;
  uuid: string;
}

export interface AccountManagerResult {
  success: boolean;
  error?: string;
  warning?: string;
  needsLogin?: boolean;
  profileId?: string;
  codexHome?: string;
}

// ── Paths ────────────────────────────────────────────────────────────────

function getCredentialsDir(): string {
  return path.join(getAccountsDir(), 'credentials');
}

function getConfigsDir(): string {
  return path.join(getAccountsDir(), 'configs');
}

function getClaudeMigrationMarkerPath(): string {
  return path.join(getAccountsDir(), 'claude', '.profiles-migrated-v1');
}

// ── Directory bootstrap ──────────────────────────────────────────────────

function ensureDirs(): void {
  for (const dir of [getAccountsDir(), getCredentialsDir(), getConfigsDir()]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function readJsonOrNull(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readOauthAccountFromConfigPath(filePath: string): unknown | null {
  const parsed = readJsonOrNull(filePath) as { oauthAccount?: unknown } | null;
  return parsed?.oauthAccount ?? null;
}

/** Store a profile's identity (`oauthAccount`) in its home and the flat backup. */
export function storeClaudeProfileIdentity(uuid: string, oauthAccount: unknown): void {
  atomicWriteJson(path.join(getClaudeProfileHome(uuid), '.claude.json'), { oauthAccount });
  try {
    atomicWriteJson(path.join(getConfigsDir(), `${uuid}.config.json`), oauthAccount);
  } catch {
    /* the profile home is canonical; the flat copy is a fallback */
  }
}

/**
 * The single chokepoint for storing a Claude credential in a profile: profile
 * home store (suffixed Keychain item on macOS, file elsewhere), the flat
 * backup, and the secret-free health sidecar.
 */
export function storeClaudeProfileCredentials(
  uuid: string,
  credentials: unknown,
  source: AccountHealthSource,
): void {
  writeActiveCredentials(credentials, getClaudeProfileHome(uuid));
  try {
    atomicWriteJson(path.join(getCredentialsDir(), `${uuid}.credentials.json`), credentials);
  } catch {
    /* the profile home is canonical; the flat copy is a fallback */
  }
  writeClaudeHealthSidecar(uuid, credentials, source);
}

function writeClaudeProfileMirror(
  uuid: string,
  credentials: unknown,
  oauthAccount: unknown,
  source: AccountHealthSource,
): void {
  storeClaudeProfileIdentity(uuid, oauthAccount);
  storeClaudeProfileCredentials(uuid, credentials, source);
}

function readFlatClaudeCredentials(uuid: string): unknown | null {
  return readJsonOrNull(path.join(getCredentialsDir(), `${uuid}.credentials.json`));
}

function readFlatClaudeOauthAccount(uuid: string): unknown | null {
  return readJsonOrNull(path.join(getConfigsDir(), `${uuid}.config.json`));
}

function readProfileClaudeOauthAccount(uuid: string): unknown | null {
  return readOauthAccountFromConfigPath(path.join(getClaudeProfileHome(uuid), '.claude.json'));
}

export function readStoredClaudeAccount(
  uuid: string,
): { credentials: unknown; oauthAccount: unknown } | null {
  const profileCredentials = readActiveCredentials(getClaudeProfileHome(uuid));
  const profileOauthAccount = readProfileClaudeOauthAccount(uuid);
  if (profileCredentials && profileOauthAccount) {
    return { credentials: profileCredentials, oauthAccount: profileOauthAccount };
  }

  const flatCredentials = readFlatClaudeCredentials(uuid);
  const flatOauthAccount = readFlatClaudeOauthAccount(uuid);
  if (flatCredentials && flatOauthAccount) {
    try {
      writeClaudeProfileMirror(uuid, flatCredentials, flatOauthAccount, 'migration');
    } catch {
      // Flat backups remain the fallback when profile materialization fails.
    }
    return { credentials: flatCredentials, oauthAccount: flatOauthAccount };
  }

  return null;
}

function readCurrentLiveOauthAccount(): unknown | null {
  return readOauthAccountFromConfigPath(getClaudeConfigPath());
}

function mergeOauthAccountIntoLiveConfig(oauthAccount: unknown): void {
  let configObj: Record<string, unknown> = {};
  const configPath = getClaudeConfigPath();
  try {
    configObj = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // File may not exist yet.
  }
  configObj.oauthAccount = oauthAccount;
  atomicWriteJson(configPath, configObj);
}

// ── Registry operations (legacy v1 view over the shared v2 registry) ───────

export function readAccountRegistry(): AccountRegistry | null {
  const registry = readSavedAccountRegistry();
  if (!registry) return null;

  const claudeAccounts = registry.accounts
    .filter((account) => account.providerId === 'claude-code')
    .map((account) => ({
      uuid: account.providerAccountId ?? account.id,
      email: account.email ?? account.metadata?.email ?? 'unknown',
      label: account.label,
      addedAt: account.addedAt,
    }));

  return {
    version: 1,
    activeAccountUuid: registry.activeByProvider['claude-code'],
    accounts: claudeAccounts,
  };
}

export function writeAccountRegistry(registry: AccountRegistry): void {
  replaceSavedAccountProfiles(
    'claude-code',
    mapClaudeProfiles(registry),
    registry.activeAccountUuid,
  );
}

function mapClaudeProfiles(registry: AccountRegistry): SavedAccountProfile[] {
  const existing = new Map(
    listSavedAccountProfiles('claude-code').map((profile) => [
      profile.providerAccountId ?? profile.id,
      profile,
    ]),
  );
  return registry.accounts.map((account) => ({
    id: account.uuid,
    providerId: 'claude-code',
    providerAccountId: account.uuid,
    email: account.email,
    label: account.label,
    addedAt: account.addedAt,
    metadata: {
      ...existing.get(account.uuid)?.metadata,
      email: account.email,
    },
  }));
}

// ── Read active Claude account ───────────────────────────────────────────

export function readActiveClaudeAccount(): ActiveAccountInfo | null {
  return readLiveClaudeIdentity();
}

function findClaudeProfile(uuid: string): SavedAccountProfile | null {
  return (
    listSavedAccountProfiles('claude-code').find(
      (profile) => (profile.providerAccountId ?? profile.id) === uuid,
    ) ?? null
  );
}

function findClaudeProfileForIdentity(identity: ActiveAccountInfo): SavedAccountProfile | null {
  const profiles = listSavedAccountProfiles('claude-code');
  return (
    profiles.find((p) => (p.providerAccountId ?? p.id) === identity.uuid) ??
    profiles.find((p) => (p.email ?? p.metadata?.email) === identity.email) ??
    null
  );
}

// ── Add current account ──────────────────────────────────────────────────

export function addCurrentAccount(label?: string): AccountManagerResult {
  const active = readActiveClaudeAccount();
  if (!active) {
    return {
      success: false,
      error: 'No active Claude account found. Sign in with `claude` first.',
    };
  }

  const credBlob = readActiveCredentials();
  if (!credBlob) {
    return { success: false, error: 'Could not read Claude credentials.' };
  }

  const configBlob = readCurrentLiveOauthAccount();
  if (!configBlob) {
    return { success: false, error: 'Could not read Claude config file.' };
  }

  ensureDirs();

  try {
    writeClaudeProfileMirror(active.uuid, credBlob, configBlob, 'login');
  } catch (err) {
    return { success: false, error: `Failed to back up Claude credentials: ${err}` };
  }

  // One read-modify-write of the registry under the lock so a concurrent add
  // from another process is never dropped.
  return withSavedAccountRegistryLock(() => {
    const existing = findClaudeProfile(active.uuid);
    const id = existing?.id ?? active.uuid;
    upsertSavedAccountProfileUnlocked({
      id,
      providerId: 'claude-code',
      providerAccountId: active.uuid,
      email: active.email,
      label: label !== undefined ? label || undefined : existing?.label,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      metadata: {
        ...existing?.metadata,
        email: active.email,
        origin: existing?.metadata?.origin ?? 'manual',
      },
    });
    setActiveSavedAccountUnlocked('claude-code', id);
    return { success: true };
  });
}

// ── Live-state sync ──────────────────────────────────────────────────────

/**
 * Serializes live Claude credential swaps across processes so two concurrent
 * switchers cannot interleave their backup/write/rollback sequences. It cannot
 * exclude Claude Code's own writes to the live home — only our switchers. Lock
 * ordering: this lock first, the registry lock (inside setActiveSavedAccount)
 * inside it — never the reverse. Never spawn a child process while holding it.
 */
export function withClaudeAuthSwapLock<T>(operation: () => T): T {
  const lockDir = path.join(getAccountsDir(), 'claude');
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(path.join(lockDir, 'auth-swap.lock'), operation);
}

/**
 * Fold the live login into the saved profiles: register an unknown login
 * (label = email), refresh the matching profile's backup when the live
 * credential is newer, and re-point the active pointer at it. Caller holds the
 * swap lock. Never throws; problems land in `warnings`.
 */
export function syncClaudeLiveStateUnlocked(
  source: AccountHealthSource = 'live-sync',
): ProviderSyncReport {
  const report = emptyProviderSyncReport();
  try {
    const identity = readActiveClaudeAccount();
    if (!identity) {
      report.skipped = 'logged-out';
      return report;
    }

    let profile = findClaudeProfileForIdentity(identity);
    if (!profile) {
      profile = {
        id: identity.uuid,
        providerId: 'claude-code',
        providerAccountId: identity.uuid,
        email: identity.email,
        label: identity.email,
        addedAt: new Date().toISOString(),
        metadata: { email: identity.email, origin: 'live-sync' },
      };
      ensureDirs();
      upsertSavedAccountProfile(profile);
      report.registered = { id: profile.id, email: identity.email };
    } else if (profile.email !== identity.email && identity.email) {
      profile = {
        ...profile,
        email: identity.email,
        metadata: { ...profile.metadata, email: identity.email },
      };
      upsertSavedAccountProfile(profile);
    }
    const uuid = profile.providerAccountId ?? profile.id;

    const liveBlob = readActiveCredentials();
    const live = parseClaudeCredentialBlob(liveBlob);
    if (live) {
      const sidecar = readHealthSidecar('claude-code', uuid);
      const storedFreshness = sidecar?.accessExpiresAt ?? sidecar?.refreshExpiresAt ?? 0;
      const liveFreshness = claudeCredentialFreshness(live);
      const needsFold =
        !sidecar ||
        liveFreshness > storedFreshness ||
        (liveFreshness === storedFreshness &&
          !fs.existsSync(path.join(getClaudeProfileHome(uuid), '.claude.json')));
      if (needsFold) {
        try {
          writeClaudeProfileMirror(
            uuid,
            liveBlob,
            readCurrentLiveOauthAccount() ?? {
              emailAddress: identity.email,
              accountUuid: identity.uuid,
            },
            source,
          );
          report.folded = profile.id;
        } catch (err) {
          report.warnings.push(`Could not back up the live Claude credentials: ${err}`);
        }
      }
    } else if (liveBlob === null) {
      report.warnings.push('The live Claude credential store could not be read.');
    }

    const active = getActiveSavedAccount('claude-code');
    if (!active || active.id !== profile.id) {
      setActiveSavedAccount('claude-code', profile.id, { silent: true });
      report.repointed = profile.id;
    }
  } catch (err) {
    report.warnings.push(`Claude account sync failed: ${err}`);
  }
  return report;
}

/** {@link syncClaudeLiveStateUnlocked} under the swap lock. */
export function syncClaudeLiveState(source: AccountHealthSource = 'live-sync'): ProviderSyncReport {
  try {
    return withClaudeAuthSwapLock(() => syncClaudeLiveStateUnlocked(source));
  } catch (err) {
    return { warnings: [`Could not acquire the account-switch lock: ${err}`] };
  }
}

/**
 * Remove isolated login homes that never authenticated (the user closed the
 * browser, the login timed out) once they are older than `olderThanMs`.
 * Returns the removed login ids.
 */
export function cleanupAbandonedClaudeLogins(
  olderThanMs: number = 6 * 60 * 60 * 1000,
  now: number = Date.now(),
): string[] {
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(getClaudeProfilesDir());
  } catch {
    return removed;
  }
  const registered = new Set(listSavedAccountProfiles('claude-code').map((p) => p.id));
  for (const loginId of entries) {
    if (registered.has(loginId)) continue;
    const dir = getClaudeProfileDir(loginId);
    const pendingPath = path.join(dir, 'profile.json');
    const pending = readJsonOrNull(pendingPath) as { addedAt?: string } | null;
    if (!pending) continue;
    const home = getClaudeProfileHome(loginId);
    if (isClaudeProfileAuthenticated(home)) continue;
    const addedAt = pending.addedAt ? Date.parse(pending.addedAt) : NaN;
    const age = Number.isNaN(addedAt) ? Number.POSITIVE_INFINITY : now - addedAt;
    if (age < olderThanMs) continue;
    try {
      deleteStoredCredentials(home);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(loginId);
    } catch {
      /* best effort */
    }
  }
  return removed;
}

// ── Switch to account ────────────────────────────────────────────────────

export function switchToAccount(
  uuid: string,
  options: SwitchAccountOptions = {},
): SwitchAccountResult {
  const consumers = detectRunningAccountConsumersSync('claude-code');
  return runClaudeSwitch(uuid, options, consumers);
}

/** {@link switchToAccount} with the process probe off the event loop. */
export async function switchToAccountAsync(
  uuid: string,
  options: SwitchAccountOptions = {},
): Promise<SwitchAccountResult> {
  const consumers = await detectRunningAccountConsumers('claude-code');
  return runClaudeSwitch(uuid, options, consumers);
}

function runClaudeSwitch(
  uuid: string,
  options: SwitchAccountOptions,
  consumers: RunningAccountConsumer[],
): SwitchAccountResult {
  try {
    // Keep the non-throwing result contract when the lock cannot be acquired.
    return withClaudeAuthSwapLock(() => switchToAccountUnlocked(uuid, options, consumers));
  } catch (err) {
    return switchFailure('claude-code', uuid, `Could not acquire the account-switch lock: ${err}`);
  }
}

function switchToAccountUnlocked(
  uuid: string,
  options: SwitchAccountOptions,
  consumers: RunningAccountConsumer[],
): SwitchAccountResult {
  const target = findClaudeProfile(uuid);
  if (!target) {
    return switchFailure('claude-code', uuid, `Account ${uuid} not found in registry.`);
  }
  const targetName = target.label ?? target.email ?? uuid;

  // Phase 1: capture the outgoing login (rotated refresh token included) and
  // register it if sidekick has never seen it. Only then is the "previous"
  // account known: it is whatever was really live, not the stale pointer.
  const sync = syncClaudeLiveStateUnlocked('switch');
  const previousAccountId = getActiveSavedAccount('claude-code')?.id ?? null;
  const base: SwitchAccountResult = {
    success: true,
    provider: 'claude-code',
    accountId: target.id,
    previousAccountId,
    verified: false,
    verification: 'none',
    warnings: [...sync.warnings],
    hints: [],
    runningConsumers: consumers,
    email: target.email,
  };

  if (readActiveClaudeAccount()?.uuid === uuid) {
    if (previousAccountId !== target.id) setActiveSavedAccount('claude-code', target.id);
    return finishSwitchResult({
      ...base,
      alreadyActive: true,
      verified: true,
      verification: 'store',
      health: getAccountHealth('claude-code', target.id),
      hints: [`${targetName} is already the active Claude account.`],
    });
  }

  // Materialise pre-migration flat backups into the profile home first so the
  // health probe (and the install) read one canonical store.
  const stored = readStoredClaudeAccount(uuid);
  if (!stored) {
    return finishSwitchResult({
      ...base,
      success: false,
      needsLogin: true,
      error: `Stored credentials for "${targetName}" not found; sign in again.`,
    });
  }

  // Preflight: never install a credential we already know is dead.
  const health = getAccountHealth('claude-code', target.id, { probe: 'store' });
  base.health = health;
  if ((health.state === 'expired' || health.state === 'missing') && !options.force) {
    return finishSwitchResult({
      ...base,
      success: false,
      needsLogin: true,
      error: `Stored credentials for "${targetName}" have ${health.state === 'missing' ? 'not been saved' : 'expired'}; sign in again.`,
    });
  }
  if (health.state === 'expiring' && health.reason) {
    base.warnings.push(`"${targetName}": ${health.reason}`);
  }

  // Snapshot the live state for rollback.
  const originalCreds = readActiveCredentials();
  let originalConfig: string | null = null;
  try {
    originalConfig = fs.readFileSync(getClaudeConfigPath(), 'utf8');
  } catch {
    /* no existing config to back up */
  }
  const rollback = (): void => {
    if (originalCreds) {
      try {
        writeActiveCredentials(originalCreds);
      } catch {
        /* rollback failed */
      }
    }
    if (originalConfig !== null) {
      try {
        fs.writeFileSync(getClaudeConfigPath(), originalConfig);
      } catch {
        /* rollback failed */
      }
    }
    try {
      setActiveSavedAccount('claude-code', previousAccountId, { silent: true });
    } catch {
      /* rollback failed */
    }
  };

  // Install.
  try {
    writeActiveCredentials(stored.credentials);
    mergeOauthAccountIntoLiveConfig(stored.oauthAccount);
  } catch (err) {
    rollback();
    return finishSwitchResult({
      ...base,
      success: false,
      error: `Failed to write Claude credentials: ${err}`,
    });
  }

  // Verify by re-reading the live store.
  const installed = parseClaudeCredentialBlob(readActiveCredentials());
  const expected = parseClaudeCredentialBlob(stored.credentials);
  const liveIdentity = readActiveClaudeAccount();
  const verified =
    installed !== null &&
    expected !== null &&
    installed.accessToken === expected.accessToken &&
    liveIdentity?.uuid === uuid;
  if (!verified) {
    rollback();
    return finishSwitchResult({
      ...base,
      success: false,
      verification: 'failed',
      error: `The live Claude credential store did not reflect the switch to "${targetName}"; the previous login was restored.`,
    });
  }

  // Pointer last: a crash before this line leaves the registry pointing at the
  // previous account, which the next sync repairs from the live identity.
  try {
    setActiveSavedAccount('claude-code', target.id);
  } catch (err) {
    rollback();
    return finishSwitchResult({
      ...base,
      success: false,
      error: `Failed to update account registry: ${err}`,
    });
  }

  let undoToken: string | undefined;
  try {
    undoToken = writeLastSwitch('claude-code', previousAccountId, target.id).token;
  } catch {
    base.warnings.push('The switch succeeded but could not be recorded for undo.');
  }

  return finishSwitchResult({
    ...base,
    verified: true,
    verification: 'store',
    undoToken,
    hints: [`New claude sessions use ${target.email ?? targetName}.`],
  });
}

/**
 * Install a saved profile's credentials into the live home without changing
 * which account is active: used right after a re-login of the live account,
 * whose freshly minted token must replace the (possibly dead) live one.
 */
export function applyClaudeProfileToLiveHome(uuid: string): AccountManagerResult {
  try {
    return withClaudeAuthSwapLock(() => {
      const stored = readStoredClaudeAccount(uuid);
      if (!stored) {
        return { success: false, error: `Stored credentials for ${uuid} not found.` };
      }
      writeActiveCredentials(stored.credentials);
      mergeOauthAccountIntoLiveConfig(stored.oauthAccount);
      return { success: true };
    });
  } catch (err) {
    return { success: false, error: `Could not install the refreshed credentials: ${err}` };
  }
}

export function resolveActiveClaudeHome(): string {
  const active = getActiveSavedAccount('claude-code');
  if (!active) return getLiveClaudeHome();
  return getClaudeProfileHome(active.providerAccountId ?? active.id);
}

export function applyActiveClaudeToLiveHome(): AccountManagerResult {
  try {
    // Keep the non-throwing result contract when the lock cannot be acquired.
    return withClaudeAuthSwapLock(applyActiveClaudeToLiveHomeUnlocked);
  } catch (err) {
    return { success: false, error: `Could not acquire the account-switch lock: ${err}` };
  }
}

function applyActiveClaudeToLiveHomeUnlocked(): AccountManagerResult {
  const active = getActiveSavedAccount('claude-code');
  if (!active) {
    return { success: false, error: 'No active Claude account found.' };
  }

  const uuid = active.providerAccountId ?? active.id;
  const stored = readStoredClaudeAccount(uuid);
  if (!stored) {
    return { success: false, error: `Stored credentials for ${active.email ?? uuid} not found.` };
  }

  const originalCreds = readActiveCredentials();
  let originalConfig: string | null = null;
  try {
    originalConfig = fs.readFileSync(getClaudeConfigPath(), 'utf8');
  } catch {
    /* no existing config to back up */
  }

  try {
    writeActiveCredentials(stored.credentials);
  } catch (err) {
    if (originalCreds) {
      try {
        writeActiveCredentials(originalCreds);
      } catch {
        /* rollback failed */
      }
    }
    return { success: false, error: `Failed to write credentials: ${err}` };
  }

  try {
    mergeOauthAccountIntoLiveConfig(stored.oauthAccount);
  } catch (err) {
    if (originalCreds) {
      try {
        writeActiveCredentials(originalCreds);
      } catch {
        /* rollback failed */
      }
    }
    if (originalConfig) {
      try {
        fs.writeFileSync(getClaudeConfigPath(), originalConfig);
      } catch {
        /* rollback failed */
      }
    }
    return { success: false, error: `Failed to write config: ${err}` };
  }

  return { success: true };
}

export function reconcileClaudeAuthState(): void {
  try {
    const markerPath = getClaudeMigrationMarkerPath();
    if (fs.existsSync(markerPath)) return;

    const registry = readSavedAccountRegistry();
    if (registry) {
      for (const profile of registry.accounts.filter(
        (account) => account.providerId === 'claude-code',
      )) {
        try {
          const uuid = profile.providerAccountId ?? profile.id;
          if (
            readActiveCredentials(getClaudeProfileHome(uuid)) &&
            readProfileClaudeOauthAccount(uuid)
          ) {
            continue;
          }

          const credentials = readFlatClaudeCredentials(uuid);
          const oauthAccount = readFlatClaudeOauthAccount(uuid);
          if (!credentials || !oauthAccount) continue;

          writeClaudeProfileMirror(uuid, credentials, oauthAccount, 'migration');
        } catch {
          // Migration is best-effort per account.
        }
      }
    }

    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, new Date().toISOString() + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch {
    // Reconciliation must never break startup.
  }
}

// ── Remove account ───────────────────────────────────────────────────────

export function removeAccount(uuid: string): AccountManagerResult {
  // One read-modify-write of the registry under the lock (see addCurrentAccount).
  return withSavedAccountRegistryLock(() => {
    const profile = findClaudeProfile(uuid);
    if (!profile) {
      return { success: false, error: `Account ${uuid} not found.` };
    }

    // Remove backed-up files and the profile home (credential store included).
    for (const filePath of [
      path.join(getCredentialsDir(), `${uuid}.credentials.json`),
      path.join(getConfigsDir(), `${uuid}.config.json`),
    ]) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ok */
      }
    }
    try {
      deleteStoredCredentials(getClaudeProfileHome(uuid));
      fs.rmSync(getClaudeProfileDir(profile.id), { recursive: true, force: true });
    } catch {
      /* ok */
    }

    removeSavedAccountProfileUnlocked('claude-code', profile.id);
    return { success: true };
  });
}

// ── Query helpers ────────────────────────────────────────────────────────

export function listAccounts(): AccountEntry[] {
  return listSavedAccountProfiles('claude-code').map((account) => ({
    uuid: account.providerAccountId ?? account.id,
    email: account.email ?? account.metadata?.email ?? 'unknown',
    label: account.label,
    addedAt: account.addedAt,
  }));
}

export function getActiveAccount(): AccountEntry | null {
  const active = getActiveSavedAccount('claude-code');
  if (!active) return null;
  return {
    uuid: active.providerAccountId ?? active.id,
    email: active.email ?? active.metadata?.email ?? 'unknown',
    label: active.label,
    addedAt: active.addedAt,
  };
}

/**
 * Resolves the *currently logged-in* Claude account for display, preferring the
 * live `.claude.json` identity over the saved registry pointer (which only
 * sidekick's own switch flow updates and therefore goes stale after a native
 * `claude /login`).
 *
 * Safe self-heal: when the live account matches a saved profile (by account UUID,
 * email as fallback) that isn't the current active pointer, the pointer is
 * re-pointed so registry-keyed data tracks reality too. Never creates or deletes
 * profiles; an unknown live account is shown as-is with no label and no write
 * (the sync engine registers it on the next startup or watch event).
 */
export function resolveActiveClaudeAccount(
  options: { selfHeal?: boolean } = {},
): ResolvedActiveAccount {
  const selfHeal = options.selfHeal ?? true;
  const live = readActiveClaudeAccount();
  if (live) {
    const match = findClaudeProfileForIdentity(live);
    if (match) {
      const active = getActiveSavedAccount('claude-code');
      // Hot paths (the status line runs on every prompt) pass selfHeal: false
      // so a persistently failing registry write never becomes a write per
      // prompt; the next ordinary command repairs the pointer instead.
      if (selfHeal && (!active || active.id !== match.id)) {
        // Self-heal is best-effort: a registry write failure (read-only/full
        // disk) must never break display or extension activation. We still
        // return the correct live identity below.
        // Silent: this is a read path repairing a pointer to the profile that
        // already matches the live login, so subscribers have nothing new to see.
        try {
          setActiveSavedAccount('claude-code', match.id, { silent: true });
        } catch {
          /* keep going with the live identity */
        }
      }
    }
    return {
      email: live.email,
      label: match?.label,
      providerAccountId: live.uuid,
      registryAccountId: match?.id,
      source: 'live',
    };
  }

  const active = getActiveAccount();
  if (active) {
    return {
      email: active.email,
      label: active.label,
      providerAccountId: active.uuid,
      registryAccountId: active.uuid,
      source: 'registry',
    };
  }
  return { source: 'none' };
}

export function isMultiAccountEnabled(): boolean {
  return listSavedAccountProfiles('claude-code').length >= 1;
}
