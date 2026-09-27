/**
 * Multi-account management for Claude Code logins.
 *
 * Handles saving, listing, switching, syncing, and removing Claude accounts.
 * Both the VS Code extension and CLI consume this module.
 *
 * Model: Claude Code rotates the refresh token on every refresh, so every
 * refresh-token chain may have exactly one copy a `claude` process can use.
 *
 * - The live home (`CLAUDE_CONFIG_DIR` or `~/.claude`) is the only CLI-usable
 *   copy of the account that is logged in right now. Its profile home holds
 *   identity and health metadata but never a credential; Sidekick mirrors the
 *   live credential into a private backup Claude Code never reads.
 * - An inactive account's profile home holds its single CLI-usable copy (the
 *   Claude login only; MCP tokens follow the live store).
 * - Writes into the live store go through one guarded installer that refuses
 *   downgrades, and a switch saves the outgoing login before replacing it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  readActiveCredentials,
  readClaudeCredentialStore,
  writeActiveCredentials,
  writeLiveClaudeCredentialStoreUnguarded,
  deleteStoredCredentials,
  type ClaudeCredentialStoreRead,
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
  getClaudeCredentialBackupPath,
  getClaudeProfileDir,
  getClaudeProfileHome,
  getClaudeProfilesDir,
  getLiveClaudeHome,
  isClaudeProfileAuthenticated,
  isLiveClaudeHomeSidekickProfile,
  readLiveClaudeIdentity,
} from './claudeProfiles';
import {
  claudeCredentialFreshness,
  claudeLoginOnly,
  claudeRefreshFingerprint,
  mergeClaudeLoginIntoLive,
  parseClaudeCredentialBlob,
} from './claudeCredentials';
import {
  decideLiveClaudeWrite,
  type LiveClaudeStoreState,
  type LiveClaudeWriteIntent,
  type LiveClaudeWriteRefusal,
} from './claudeLiveGuard';
import { ClaudeRefreshLockBusyError, withClaudeRefreshLocksSync } from './claudeRefreshLock';
import { acquireAccountLease, isAccountLeaseHeld, releaseAccountLease } from './accountLease';
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

function getSwitchJournalPath(): string {
  return path.join(getAccountsDir(), 'claude', 'switch-journal.json');
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

function isLiveClaudeAccount(uuid: string): boolean {
  return readLiveClaudeIdentity()?.uuid === uuid;
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

// ── Private credential backups ───────────────────────────────────────────

function readClaudeBackup(uuid: string): unknown | null {
  return readJsonOrNull(getClaudeCredentialBackupPath(uuid));
}

/** Write and verify the private backup. Throws: for the live account it is the only saved copy. */
function writeClaudeBackup(uuid: string, credentials: unknown): void {
  const target = getClaudeCredentialBackupPath(uuid);
  atomicWriteJson(target, credentials);
  if (JSON.stringify(readJsonOrNull(target)) !== JSON.stringify(credentials)) {
    throw new Error(`The credential backup for ${uuid} did not verify after writing.`);
  }
}

function fresherOf(a: unknown, b: unknown): unknown {
  const aCreds = parseClaudeCredentialBlob(a);
  const bCreds = parseClaudeCredentialBlob(b);
  if (!aCreds) return bCreds ? b : null;
  if (!bCreds) return a;
  return claudeCredentialFreshness(bCreds) > claudeCredentialFreshness(aCreds) ? b : a;
}

/**
 * The single chokepoint for storing a Claude credential in a profile. Always
 * writes the private backup and the secret-free health sidecar. Writes the
 * profile-home store (suffixed Keychain item on macOS, file elsewhere) only
 * when the account is NOT the live login: the live store is that account's one
 * CLI-usable copy, and a second one would fight it over the refresh token.
 * Caller holds the swap lock.
 */
export function storeClaudeProfileCredentialsUnlocked(
  uuid: string,
  credentials: unknown,
  source: AccountHealthSource,
): void {
  const login = claudeLoginOnly(credentials);
  if (!login || !parseClaudeCredentialBlob(login)) {
    throw new Error('Refusing to store something that is not a Claude login.');
  }
  writeClaudeBackup(uuid, credentials);
  if (!isLiveClaudeAccount(uuid)) {
    writeActiveCredentials(login, getClaudeProfileHome(uuid));
  }
  writeClaudeHealthSidecar(uuid, credentials, source);
}

/** {@link storeClaudeProfileCredentialsUnlocked} under the swap lock. */
export function storeClaudeProfileCredentials(
  uuid: string,
  credentials: unknown,
  source: AccountHealthSource,
): void {
  withClaudeAuthSwapLock(() => storeClaudeProfileCredentialsUnlocked(uuid, credentials, source));
}

function writeClaudeProfileMirrorUnlocked(
  uuid: string,
  credentials: unknown,
  oauthAccount: unknown,
  source: AccountHealthSource,
): void {
  storeClaudeProfileIdentity(uuid, oauthAccount);
  storeClaudeProfileCredentialsUnlocked(uuid, credentials, source);
}

function readFlatClaudeOauthAccount(uuid: string): unknown | null {
  return readJsonOrNull(path.join(getConfigsDir(), `${uuid}.config.json`));
}

function readProfileClaudeOauthAccount(uuid: string): unknown | null {
  return readOauthAccountFromConfigPath(path.join(getClaudeProfileHome(uuid), '.claude.json'));
}

/**
 * The saved credential and identity of a profile: the fresher of its
 * profile-home store and its private backup. Read-only — it never
 * re-materialises a backup into a CLI-visible place.
 */
export function readStoredClaudeAccount(
  uuid: string,
): { credentials: unknown; oauthAccount: unknown } | null {
  const store = readClaudeCredentialStore(getClaudeProfileHome(uuid));
  const credentials = fresherOf(store.status === 'ok' ? store.blob : null, readClaudeBackup(uuid));
  const oauthAccount = readProfileClaudeOauthAccount(uuid) ?? readFlatClaudeOauthAccount(uuid);
  return credentials && oauthAccount ? { credentials, oauthAccount } : null;
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

// ── The guarded live installer ───────────────────────────────────────────

function liveStateFrom(read: ClaudeCredentialStoreRead): LiveClaudeStoreState {
  return read.status === 'ok' ? { status: 'ok', blob: read.blob } : { status: read.status };
}

type LiveInstallResult =
  | { ok: true; installed: unknown }
  | {
      ok: false;
      code: LiveClaudeWriteRefusal | 'write-failed';
      reason: string;
      /** The store may have changed: a write was attempted (this blob). */
      wrote: boolean;
      attempted?: unknown;
    };

/**
 * The only writer of the live Claude credential store. Asks the guard, merges
 * (the live MCP tokens stay; the candidate's Claude login replaces live's),
 * writes, and verifies. `rollback` restores `candidate` verbatim.
 */
function installIntoLiveClaudeStore(
  candidate: unknown,
  candidateAccountUuid: string,
  intent: LiveClaudeWriteIntent,
  context: {
    live: ClaudeCredentialStoreRead;
    liveAccountUuid: string | null;
    capturedOutgoing?: boolean;
    written?: unknown;
  },
): LiveInstallResult {
  const live = liveStateFrom(context.live);
  const decision = decideLiveClaudeWrite({
    intent,
    live,
    liveAccountUuid: context.liveAccountUuid,
    candidate,
    candidateAccountUuid,
    capturedOutgoing: context.capturedOutgoing,
    written: context.written,
  });
  if (!decision.allow) {
    return { ok: false, code: decision.code, reason: decision.reason, wrote: false };
  }
  const blob =
    intent === 'rollback'
      ? candidate
      : mergeClaudeLoginIntoLive(live.status === 'ok' ? live.blob : null, candidate);
  try {
    writeLiveClaudeCredentialStoreUnguarded(blob);
  } catch (err) {
    return { ok: false, code: 'write-failed', reason: `${err}`, wrote: true, attempted: blob };
  }
  return { ok: true, installed: blob };
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

function profileKey(profile: SavedAccountProfile): string {
  return profile.providerAccountId ?? profile.id;
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
    // The live account: backup and metadata only (see the chokepoint).
    withClaudeAuthSwapLock(() =>
      writeClaudeProfileMirrorUnlocked(active.uuid, credBlob, configBlob, 'login'),
    );
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
 * switchers cannot interleave their backup/write/rollback sequences. Claude
 * Code's own refreshes are kept out separately by borrowing its refresh lock
 * (claudeRefreshLock.ts). Lock ordering: this lock first, then the refresh
 * locks, the registry lock (inside setActiveSavedAccount), and the ledger
 * lock — never the reverse. Never spawn a `claude` process while holding it.
 */
export function withClaudeAuthSwapLock<T>(operation: () => T): T {
  const lockDir = path.join(getAccountsDir(), 'claude');
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(path.join(lockDir, 'auth-swap.lock'), operation);
}

interface SwitchJournal {
  from: string | null;
  to: string;
  fromFp: string | null;
  toFp: string | null;
  at: string;
}

function readSwitchJournal(): SwitchJournal | null {
  const raw = readJsonOrNull(getSwitchJournalPath()) as SwitchJournal | null;
  return raw && typeof raw.to === 'string' ? raw : null;
}

function writeSwitchJournal(journal: SwitchJournal): void {
  atomicWriteJson(getSwitchJournalPath(), journal);
}

function clearSwitchJournal(): void {
  try {
    fs.rmSync(getSwitchJournalPath(), { force: true });
  } catch {
    /* the next sync clears it */
  }
}

/** Give a switched-away account its single CLI-usable copy (it is inactive now). */
function materializeInactiveProfile(uuid: string, credentials: unknown): void {
  const login = claudeLoginOnly(credentials);
  if (!login || isLiveClaudeAccount(uuid)) return;
  writeActiveCredentials(login, getClaudeProfileHome(uuid));
}

/**
 * A switch that died mid-way left its journal behind (sync runs under the swap
 * lock, so a journal it can see belongs to no running switch). Finish or roll
 * back from the live fingerprint — never from `.claude.json` alone, which may
 * still name the other account.
 */
function resolveSwitchJournalUnlocked(report: ProviderSyncReport): void {
  const journal = readSwitchJournal();
  if (!journal) return;
  const live = readClaudeCredentialStore();
  if (live.status === 'error') {
    report.warnings.push(
      'An interrupted account switch is pending; the live login could not be read yet.',
    );
    return;
  }
  const liveFp =
    live.status === 'ok' ? claudeRefreshFingerprint(parseClaudeCredentialBlob(live.blob)) : null;

  if (liveFp !== null && liveFp === journal.toFp) {
    // The target was installed: finish the commit.
    const toOauth =
      readProfileClaudeOauthAccount(journal.to) ?? readFlatClaudeOauthAccount(journal.to);
    try {
      if (toOauth && readLiveClaudeIdentity()?.uuid !== journal.to) {
        mergeOauthAccountIntoLiveConfig(toOauth);
      }
      if (journal.from) {
        const backup = readClaudeBackup(journal.from);
        if (claudeRefreshFingerprint(parseClaudeCredentialBlob(backup)) === journal.fromFp) {
          materializeInactiveProfile(journal.from, backup);
        }
      }
      deleteStoredCredentials(getClaudeProfileHome(journal.to));
      const target = findClaudeProfile(journal.to);
      if (target) setActiveSavedAccount('claude-code', target.id, { silent: true });
      report.journal = 'finished';
    } catch (err) {
      report.warnings.push(`Could not finish an interrupted account switch: ${err}`);
      return;
    }
  } else if (liveFp === journal.fromFp) {
    // Nothing was installed (or it was rolled back): the outgoing login is live.
    report.journal = 'rolled-back';
  } else {
    report.journal = 'cleared';
    report.warnings.push(
      'An interrupted account switch was found, but the live login matches neither side; it was left as is.',
    );
  }
  clearSwitchJournal();
}

/** The profile whose recorded refresh-token fingerprint is `fp`, other than `exceptUuid`. */
function findProfileHoldingFingerprint(fp: string, exceptUuid: string): SavedAccountProfile | null {
  return (
    listSavedAccountProfiles('claude-code').find((profile) => {
      const uuid = profileKey(profile);
      return uuid !== exceptUuid && readHealthSidecar('claude-code', profile.id)?.refreshFp === fp;
    }) ?? null
  );
}

/**
 * Enforce "the live account keeps no CLI-usable copy": if its profile home
 * still holds a credential (older builds mirrored every fold there), remove
 * it. When that copy is strictly newer than live, live is the dying link of
 * the chain, so the copy is installed first (guarded `repair`). The fresher
 * of the two stays in the private backup.
 */
function demoteLiveDuplicateUnlocked(uuid: string, report: ProviderSyncReport): void {
  const home = getClaudeProfileHome(uuid);
  const probe = readClaudeCredentialStore(home);
  if (probe.status === 'absent') return;
  if (probe.status === 'error') {
    report.warnings.push(
      "The live account's profile copy could not be read; it was left in place.",
    );
    return;
  }
  try {
    withClaudeRefreshLocksSync([getLiveClaudeHome(), home], () => {
      const live = readClaudeCredentialStore();
      const duplicate = readClaudeCredentialStore(home);
      if (live.status === 'error' || duplicate.status === 'error') {
        report.warnings.push(
          'A credential store could not be read; the profile copy was left in place.',
        );
        return;
      }
      if (duplicate.status === 'absent') return;
      const liveCreds = live.status === 'ok' ? parseClaudeCredentialBlob(live.blob) : null;
      const dupBlob = duplicate.status === 'ok' ? duplicate.blob : null;
      const dupCreds = parseClaudeCredentialBlob(dupBlob);

      if (
        dupCreds &&
        claudeRefreshFingerprint(dupCreds) !== claudeRefreshFingerprint(liveCreds) &&
        claudeCredentialFreshness(dupCreds) > claudeCredentialFreshness(liveCreds)
      ) {
        const install = installIntoLiveClaudeStore(dupBlob, uuid, 'repair', {
          live,
          liveAccountUuid: uuid,
        });
        if (install.ok) {
          writeClaudeBackup(uuid, install.installed);
          writeClaudeHealthSidecar(uuid, install.installed, 'live-sync');
          report.repaired = uuid;
        } else {
          // Keep the newer copy somewhere Claude Code cannot use it.
          writeClaudeBackup(uuid, fresherOf(readClaudeBackup(uuid), dupBlob));
          report.warnings.push(
            `The live Claude login looks older than its saved copy and could not be repaired (${install.reason}).`,
          );
          if (install.wrote) return;
        }
      } else if (liveCreds && live.status === 'ok') {
        writeClaudeBackup(uuid, fresherOf(readClaudeBackup(uuid), live.blob));
      }

      if (deleteStoredCredentials(home)) report.demoted = uuid;
      else report.warnings.push("The live account's profile copy could not be removed.");
    });
  } catch (err) {
    if (err instanceof ClaudeRefreshLockBusyError) {
      report.warnings.push(
        "Claude Code was refreshing; the live account's profile copy is removed on the next sync.",
      );
    } else {
      report.warnings.push(`Could not remove the live account's profile copy: ${err}`);
    }
  }
}

/**
 * Reconcile the live login with the saved profiles: finish an interrupted
 * switch, register an unknown login (label = email), refresh the matching
 * profile's backup when the live credential is newer, remove any CLI-usable
 * copy of the live account from its profile home, and re-point the active
 * pointer. Caller holds the swap lock. Never throws; problems land in
 * `warnings`.
 */
export function syncClaudeLiveStateUnlocked(
  source: AccountHealthSource = 'live-sync',
): ProviderSyncReport {
  const report = emptyProviderSyncReport();
  if (isLiveClaudeHomeSidekickProfile()) {
    report.skipped = 'managed-home';
    report.warnings.push(
      'Unset CLAUDE_CONFIG_DIR before syncing; it points at a sidekick profile home.',
    );
    return report;
  }
  try {
    resolveSwitchJournalUnlocked(report);

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
    const uuid = profileKey(profile);

    const live = readClaudeCredentialStore();
    if (live.status === 'error') {
      report.warnings.push('The live Claude credential store could not be read.');
    } else if (live.status === 'corrupt') {
      report.warnings.push(
        'The live Claude credential store is unreadable (not valid JSON); sign in again with `claude`.',
      );
    } else if (live.status === 'ok') {
      const liveCreds = parseClaudeCredentialBlob(live.blob);
      const liveFp = claudeRefreshFingerprint(liveCreds);
      const owner = liveFp ? findProfileHoldingFingerprint(liveFp, uuid) : null;
      if (owner) {
        // `.claude.json` names one account but the credential is another's
        // (a switch or login mid-way): folding would file the chain under
        // the wrong account, and demoting could delete the right one.
        report.warnings.push(
          `The live credential belongs to ${owner.label ?? owner.email ?? owner.id}, not ${identity.email}; nothing was folded.`,
        );
      } else if (liveCreds) {
        const backupCreds = parseClaudeCredentialBlob(readClaudeBackup(uuid));
        const liveFreshness = claudeCredentialFreshness(liveCreds);
        const backupFreshness = claudeCredentialFreshness(backupCreds);
        const needsFold =
          !backupCreds ||
          liveFreshness > backupFreshness ||
          (liveFreshness === backupFreshness &&
            (claudeRefreshFingerprint(backupCreds) !== liveFp ||
              !fs.existsSync(path.join(getClaudeProfileHome(uuid), '.claude.json'))));
        if (needsFold) {
          try {
            writeClaudeProfileMirrorUnlocked(
              uuid,
              live.blob,
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
        demoteLiveDuplicateUnlocked(uuid, report);
      }
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

/** Unregistered login homes that authenticated are kept this long for a late finalize. */
const AUTHENTICATED_PENDING_LOGIN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Remove isolated login homes that never finished: ones that never
 * authenticated (the user closed the browser, the login timed out) once they
 * are older than `olderThanMs`, and ones that authenticated but were never
 * finalized (the host quit) after a day. Their Keychain item goes with them.
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
    const threshold = isClaudeProfileAuthenticated(home)
      ? Math.max(olderThanMs, AUTHENTICATED_PENDING_LOGIN_TTL_MS)
      : olderThanMs;
    const addedAt = pending.addedAt ? Date.parse(pending.addedAt) : NaN;
    const age = Number.isNaN(addedAt) ? Number.POSITIVE_INFINITY : now - addedAt;
    if (age < threshold) continue;
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

// ── Keep-alive and launch support ────────────────────────────────────────

/**
 * Why keep-alive must not run the CLI for this Claude profile, or null when it
 * may. A refresh inside a profile home rotates that home's refresh token, so
 * the home must hold the only live copy of its chain. Caller holds the swap lock.
 */
function claudeKeepAliveBlockerUnlocked(profile: SavedAccountProfile): string | null {
  const uuid = profileKey(profile);
  if (isLiveClaudeAccount(uuid)) return 'live account; the CLI refreshes it in normal use';
  const store = readClaudeCredentialStore(getClaudeProfileHome(uuid));
  if (store.status === 'error') return 'its saved login could not be read';
  const storeCreds = store.status === 'ok' ? parseClaudeCredentialBlob(store.blob) : null;
  if (!storeCreds) return 'no profile copy to refresh (keep-alive never restores backups)';
  const live = readClaudeCredentialStore();
  if (live.status === 'error') return 'the live login could not be read';
  const liveCreds = live.status === 'ok' ? parseClaudeCredentialBlob(live.blob) : null;
  if (liveCreds && claudeRefreshFingerprint(liveCreds) === claudeRefreshFingerprint(storeCreds)) {
    return 'same refresh token as the live login';
  }
  if (readHealthSidecar('claude-code', profile.id)?.source === 'live-sync') {
    return 'copied from the live login; waits for a switch away from it';
  }
  const backupCreds = parseClaudeCredentialBlob(readClaudeBackup(uuid));
  if (claudeCredentialFreshness(backupCreds) > claudeCredentialFreshness(storeCreds)) {
    return 'its saved backup is newer than the profile copy';
  }
  return null;
}

function findClaudeProfileById(accountId: string): SavedAccountProfile | null {
  return listSavedAccountProfiles('claude-code').find((p) => p.id === accountId) ?? null;
}

/** {@link beginClaudeKeepAlive} without taking the lease (dry runs). */
export function getClaudeKeepAliveBlocker(accountId: string): string | null {
  try {
    return withClaudeAuthSwapLock(() => {
      const profile = findClaudeProfileById(accountId);
      return profile ? claudeKeepAliveBlockerUnlocked(profile) : 'account not found';
    });
  } catch (err) {
    return `could not acquire the account-switch lock: ${err}`;
  }
}

/**
 * Check a Claude profile for keep-alive and take its lease, both under the
 * swap lock, so no switch can make it live (or copy it into live) while the
 * CLI refreshes it. Pair with {@link finishClaudeKeepAlive}.
 */
export function beginClaudeKeepAlive(
  accountId: string,
  leaseMs: number,
): { ok: true } | { ok: false; reason: string } {
  try {
    return withClaudeAuthSwapLock(() => {
      const profile = findClaudeProfileById(accountId);
      if (!profile) return { ok: false as const, reason: 'account not found' };
      const blocker = claudeKeepAliveBlockerUnlocked(profile);
      if (blocker) return { ok: false as const, reason: blocker };
      if (!acquireAccountLease('claude-code', accountId, leaseMs)) {
        return { ok: false as const, reason: 'another keep-alive run holds this account' };
      }
      return { ok: true as const };
    });
  } catch (err) {
    return { ok: false, reason: `could not acquire the account-switch lock: ${err}` };
  }
}

/** Record what the CLI refreshed (backup + sidecar) and release the lease. */
export function finishClaudeKeepAlive(accountId: string): void {
  try {
    withClaudeAuthSwapLock(() => {
      const profile = findClaudeProfileById(accountId);
      if (!profile) return;
      const uuid = profileKey(profile);
      if (isLiveClaudeAccount(uuid)) return;
      const store = readClaudeCredentialStore(getClaudeProfileHome(uuid));
      if (store.status !== 'ok') return;
      const backup = readClaudeBackup(uuid);
      const storeCreds = parseClaudeCredentialBlob(store.blob);
      if (
        storeCreds &&
        claudeCredentialFreshness(storeCreds) >
          claudeCredentialFreshness(parseClaudeCredentialBlob(backup))
      ) {
        const updated = mergeClaudeLoginIntoLive(backup, store.blob);
        writeClaudeBackup(uuid, updated);
        writeClaudeHealthSidecar(profile.id, updated, 'keepalive');
      }
    });
  } catch {
    /* the next sync or probe records the refresh */
  } finally {
    releaseAccountLease('claude-code', accountId);
  }
}

/**
 * Give an inactive profile a CLI-usable copy from its backup when its profile
 * home has none (it was live when it was last seen, or a switch could not
 * write it). User-initiated launches only; keep-alive never does this.
 */
export function restoreClaudeProfileFromBackup(
  accountId: string,
): 'restored' | 'present' | 'live' | 'none' {
  try {
    return withClaudeAuthSwapLock(() => {
      const profile = findClaudeProfileById(accountId);
      if (!profile) return 'none';
      const uuid = profileKey(profile);
      if (isLiveClaudeAccount(uuid)) return 'live';
      const store = readClaudeCredentialStore(getClaudeProfileHome(uuid));
      if (store.status !== 'absent') return store.status === 'ok' ? 'present' : 'none';
      const backup = readClaudeBackup(uuid);
      if (!parseClaudeCredentialBlob(backup)) return 'none';
      materializeInactiveProfile(uuid, backup);
      return 'restored';
    });
  } catch {
    return 'none';
  }
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

  // Refuse to treat one of our own profile homes as the live home: a shell
  // that eval'd `sidekick accounts env` would otherwise overwrite that profile.
  if (isLiveClaudeHomeSidekickProfile()) {
    return switchFailure(
      'claude-code',
      uuid,
      `CLAUDE_CONFIG_DIR points at a sidekick profile home (${path.resolve(getLiveClaudeHome())}); unset it before switching accounts.`,
    );
  }

  // Phase 1: register the outgoing login if sidekick has never seen it, finish
  // any interrupted switch, and enforce the one-copy rule. Only then is the
  // "previous" account known: it is whatever was really live.
  const sync = syncClaudeLiveStateUnlocked('live-sync');
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

  const stored = readStoredClaudeAccount(uuid);
  if (!stored) {
    return finishSwitchResult({
      ...base,
      success: false,
      needsLogin: true,
      error: `Stored credentials for "${targetName}" not found; sign in again.`,
    });
  }

  // Preflight on the credential that would be installed: never install one we
  // already know is dead.
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
  if (!options.force && isAccountLeaseHeld('claude-code', target.id)) {
    return finishSwitchResult({
      ...base,
      success: false,
      error: `Keep-alive is refreshing "${targetName}" right now; try again in a few seconds.`,
    });
  }

  try {
    return withClaudeRefreshLocksSync([getLiveClaudeHome(), getClaudeProfileHome(uuid)], () =>
      installSwitchTargetUnlocked(target, targetName, base, previousAccountId),
    );
  } catch (err) {
    return finishSwitchResult({
      ...base,
      success: false,
      error:
        err instanceof ClaudeRefreshLockBusyError
          ? `${err.message} Nothing was changed.`
          : `The switch failed before anything was changed: ${err}`,
    });
  }
}

/**
 * Capture → journal → install → verify → commit, holding the swap lock and
 * Claude Code's refresh locks for the live home and the target's home.
 */
function installSwitchTargetUnlocked(
  target: SavedAccountProfile,
  targetName: string,
  base: SwitchAccountResult,
  previousAccountId: string | null,
): SwitchAccountResult {
  const uuid = profileKey(target);
  const fail = (error: string, extra: Partial<SwitchAccountResult> = {}): SwitchAccountResult =>
    finishSwitchResult({ ...base, success: false, error, ...extra });

  // Re-read inside the refresh locks: a keep-alive or CLI may have moved either store.
  const stored = readStoredClaudeAccount(uuid);
  const targetCreds = parseClaudeCredentialBlob(stored?.credentials);
  if (!stored || !targetCreds) {
    return fail(`Stored credentials for "${targetName}" not found; sign in again.`, {
      needsLogin: true,
    });
  }

  let live = readClaudeCredentialStore();
  if (live.status === 'error') {
    return fail('The live Claude login could not be read, so nothing was changed. Try again.');
  }
  const liveIdentity = readActiveClaudeAccount();
  const outgoing = liveIdentity ? findClaudeProfileForIdentity(liveIdentity) : null;
  const outgoingUuid = outgoing ? profileKey(outgoing) : null;
  let liveCreds = live.status === 'ok' ? parseClaudeCredentialBlob(live.blob) : null;

  if (outgoingUuid === uuid) {
    // The live login is this profile under a rotated account id (matched by
    // email): installing its saved copy would be a downgrade, not a switch.
    return finishSwitchResult({
      ...base,
      alreadyActive: true,
      verified: true,
      verification: 'store',
      health: getAccountHealth('claude-code', target.id),
      hints: [`${targetName} is already the active Claude account.`],
    });
  }
  const liveFp = claudeRefreshFingerprint(liveCreds);
  const liveOwner =
    liveFp && outgoingUuid ? findProfileHoldingFingerprint(liveFp, outgoingUuid) : null;
  if (liveOwner) {
    // Capturing would file that chain under the wrong account.
    return fail(
      `The live credential belongs to ${liveOwner.label ?? liveOwner.email ?? liveOwner.id}, but the live identity says ${liveIdentity?.email}; run \`claude\` once (or sign in again) and retry. Nothing was changed.`,
    );
  }

  // Capture the outgoing login, verified, before anything replaces it. This
  // is mandatory even with `force`: losing it would lose that account's chain.
  let captured = false;
  const capture = (blob: unknown): string | null => {
    if (!outgoingUuid) {
      return 'The live login has no account identity to save it under; run `claude` once and retry.';
    }
    try {
      writeClaudeBackup(outgoingUuid, blob);
      return null;
    } catch (err) {
      return `The outgoing login could not be saved, so nothing was changed: ${err}`;
    }
  };
  if (liveCreds && live.status === 'ok') {
    const error = capture(live.blob);
    if (error) return fail(error);
    captured = true;
  }

  const fromFp = claudeRefreshFingerprint(liveCreds);
  const toFp = claudeRefreshFingerprint(targetCreds);
  writeSwitchJournal({
    from: outgoingUuid,
    to: uuid,
    fromFp,
    toFp,
    at: new Date().toISOString(),
  });

  // The live store must not have moved since the capture.
  const recheck = readClaudeCredentialStore();
  if (recheck.status === 'error') {
    clearSwitchJournal();
    return fail('The live Claude login could not be re-read, so nothing was changed. Try again.');
  }
  const recheckCreds = recheck.status === 'ok' ? parseClaudeCredentialBlob(recheck.blob) : null;
  if (
    claudeRefreshFingerprint(recheckCreds) !== fromFp &&
    recheck.status === 'ok' &&
    recheckCreds
  ) {
    const error = capture(recheck.blob);
    if (error) {
      clearSwitchJournal();
      return fail(error);
    }
    captured = true;
    live = recheck;
    liveCreds = recheckCreds;
    writeSwitchJournal({
      from: outgoingUuid,
      to: uuid,
      fromFp: claudeRefreshFingerprint(liveCreds),
      toFp,
      at: new Date().toISOString(),
    });
  }

  let originalConfig: string | null = null;
  try {
    originalConfig = fs.readFileSync(getClaudeConfigPath(), 'utf8');
  } catch {
    /* no existing config to back up */
  }

  const install = installIntoLiveClaudeStore(stored.credentials, uuid, 'switch', {
    live,
    liveAccountUuid: liveIdentity?.uuid ?? null,
    capturedOutgoing: captured,
  });

  const rollback = (written: unknown): boolean => {
    // Nothing usable was displaced when live held no login: there is nothing
    // to put back, and the result must not claim otherwise.
    let restored = live.status === 'ok';
    if (live.status === 'ok') {
      const current = readClaudeCredentialStore();
      const untouched =
        current.status === 'ok' && JSON.stringify(current.blob) === JSON.stringify(live.blob);
      if (!untouched) {
        const undo = installIntoLiveClaudeStore(live.blob, outgoingUuid ?? uuid, 'rollback', {
          live: current,
          liveAccountUuid: readActiveClaudeAccount()?.uuid ?? null,
          written,
        });
        restored = undo.ok;
      }
    }
    if (originalConfig !== null) {
      try {
        fs.writeFileSync(getClaudeConfigPath(), originalConfig);
      } catch {
        restored = false;
      }
    }
    try {
      setActiveSavedAccount('claude-code', previousAccountId, { silent: true });
    } catch {
      /* rollback failed */
    }
    clearSwitchJournal();
    return restored;
  };
  const restoredSuffix = (restored: boolean): string =>
    restored
      ? 'the previous login was restored.'
      : captured
        ? 'the previous login could not be restored automatically; it is saved, run `sidekick accounts doctor`.'
        : 'the live store held no usable login before the switch; run `sidekick accounts doctor`.';

  if (!install.ok) {
    if (!install.wrote) {
      clearSwitchJournal();
      return fail(install.reason);
    }
    const restored = rollback(install.attempted);
    return fail(
      `Failed to write Claude credentials (${install.reason}); ${restoredSuffix(restored)}`,
    );
  }

  try {
    mergeOauthAccountIntoLiveConfig(stored.oauthAccount);
  } catch (err) {
    const restored = rollback(install.installed);
    return fail(`Failed to write the Claude identity (${err}); ${restoredSuffix(restored)}`);
  }

  // Verify by re-reading the live store.
  const installed = readClaudeCredentialStore(undefined, { keychainOnly: true });
  const installedCreds =
    installed.status === 'ok' ? parseClaudeCredentialBlob(installed.blob) : null;
  const verified =
    installedCreds !== null &&
    installedCreds.accessToken === targetCreds.accessToken &&
    readActiveClaudeAccount()?.uuid === uuid;
  if (!verified) {
    const restored = rollback(install.installed);
    return fail(
      `The live Claude credential store did not reflect the switch to "${targetName}"; ${restoredSuffix(restored)}`,
      { verification: 'failed' },
    );
  }

  // Pointer before the rest of the commit: from here on the switch happened.
  try {
    setActiveSavedAccount('claude-code', target.id);
  } catch (err) {
    const restored = rollback(install.installed);
    return fail(`Failed to update account registry (${err}); ${restoredSuffix(restored)}`);
  }

  // Commit: the outgoing account becomes inactive and gets its single CLI copy;
  // the target is live and keeps none.
  if (outgoingUuid && captured && live.status === 'ok') {
    try {
      materializeInactiveProfile(outgoingUuid, live.blob);
      writeClaudeHealthSidecar(outgoingUuid, live.blob, 'switch');
    } catch (err) {
      base.warnings.push(
        `The previous login is saved, but its profile copy could not be written yet (${err}).`,
      );
    }
  }
  try {
    writeClaudeBackup(uuid, install.installed);
    writeClaudeHealthSidecar(uuid, install.installed, 'switch');
  } catch {
    /* the next sync refreshes the live account's backup */
  }
  if (!deleteStoredCredentials(getClaudeProfileHome(uuid))) {
    base.warnings.push(
      `"${targetName}"'s profile copy could not be removed; the next sync retries.`,
    );
  }
  clearSwitchJournal();

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
 * whose freshly minted token must replace the (possibly dead) live one. The
 * guard only lets a strictly fresher credential of the same account through;
 * when live is already at least as new, nothing is written.
 */
export function applyClaudeProfileToLiveHome(uuid: string): AccountManagerResult {
  if (isLiveClaudeHomeSidekickProfile()) {
    return {
      success: false,
      error: `CLAUDE_CONFIG_DIR points at a sidekick profile home (${path.resolve(getLiveClaudeHome())}); the login was saved, but unset it before making the account live.`,
    };
  }
  try {
    return withClaudeAuthSwapLock(() => {
      const stored = readStoredClaudeAccount(uuid);
      if (!stored) {
        return { success: false, error: `Stored credentials for ${uuid} not found.` };
      }
      const profileHome = getClaudeProfileHome(uuid);
      return withClaudeRefreshLocksSync([getLiveClaudeHome(), profileHome], () => {
        const live = readClaudeCredentialStore();
        const liveUuid = readActiveClaudeAccount()?.uuid ?? null;
        const install = installIntoLiveClaudeStore(stored.credentials, uuid, 'relogin', {
          live,
          liveAccountUuid: liveUuid,
        });
        if (!install.ok) {
          if (install.code === 'not-newer') {
            return { success: true, warning: install.reason };
          }
          return {
            success: false,
            error: `Could not install the refreshed credentials: ${install.reason}`,
          };
        }
        mergeOauthAccountIntoLiveConfig(stored.oauthAccount);
        writeClaudeBackup(uuid, install.installed);
        writeClaudeHealthSidecar(uuid, install.installed, 'login');
        // The account is live now: its profile home keeps no CLI copy.
        deleteStoredCredentials(profileHome);
        return { success: true };
      });
    });
  } catch (err) {
    return { success: false, error: `Could not install the refreshed credentials: ${err}` };
  }
}

/**
 * @deprecated The home `claude` should use for the active account. The live
 * account's profile home holds no credential, so this is the live home for the
 * live account; kept for API compatibility.
 */
export function resolveActiveClaudeHome(): string {
  const active = getActiveSavedAccount('claude-code');
  if (!active) return getLiveClaudeHome();
  const uuid = active.providerAccountId ?? active.id;
  return isLiveClaudeAccount(uuid) ? getLiveClaudeHome() : getClaudeProfileHome(uuid);
}

/**
 * @deprecated Re-install the active profile's credential into the live home.
 * It never follows the registry pointer across accounts (after a native
 * `claude /login` the pointer can be stale): when the live login is another
 * account it refuses — use {@link switchToAccount}. For the same account it is
 * a guarded re-login that writes only a strictly fresher credential.
 */
export function applyActiveClaudeToLiveHome(): AccountManagerResult {
  const active = getActiveSavedAccount('claude-code');
  if (!active) {
    return { success: false, error: 'No active Claude account found.' };
  }
  const uuid = active.providerAccountId ?? active.id;
  const liveUuid = readActiveClaudeAccount()?.uuid;
  if (liveUuid && liveUuid !== uuid) {
    return {
      success: false,
      error:
        'The live Claude login belongs to another account; use switchToAccount() to change accounts.',
    };
  }
  if (!readStoredClaudeAccount(uuid)) {
    return { success: false, error: `Stored credentials for ${active.email ?? uuid} not found.` };
  }
  return applyClaudeProfileToLiveHome(uuid);
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
          // The live account keeps no profile-home copy; nothing to migrate.
          if (isLiveClaudeAccount(uuid)) continue;
          if (
            readActiveCredentials(getClaudeProfileHome(uuid)) &&
            readProfileClaudeOauthAccount(uuid)
          ) {
            continue;
          }

          const credentials = readClaudeBackup(uuid);
          const oauthAccount = readFlatClaudeOauthAccount(uuid);
          if (!credentials || !oauthAccount) continue;

          withClaudeAuthSwapLock(() =>
            writeClaudeProfileMirrorUnlocked(uuid, credentials, oauthAccount, 'migration'),
          );
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
      getClaudeCredentialBackupPath(uuid),
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
