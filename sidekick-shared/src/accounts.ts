/**
 * Multi-account management for Claude Max subscriptions.
 *
 * Handles saving, listing, switching, and removing Claude accounts.
 * Both the VS Code extension and CLI consume this module.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readActiveCredentials, writeActiveCredentials } from './credentialIO';
import {
  getAccountsDir,
  getActiveSavedAccount,
  listSavedAccountProfiles,
  readSavedAccountRegistry,
  replaceSavedAccountProfiles,
  setActiveSavedAccount,
  type ResolvedActiveAccount,
  type SavedAccountProfile,
} from './accountRegistry';
import { getClaudeProfileHome } from './claudeProfiles';

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

function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

function getClaudeConfigPath(): string {
  // Primary: ~/.claude/.claude.json
  const primary = path.join(getClaudeDir(), '.claude.json');
  try {
    const data = JSON.parse(fs.readFileSync(primary, 'utf8'));
    if (data?.oauthAccount) return primary;
  } catch {
    /* fall through */
  }
  // Fallback: ~/.claude.json (some Claude Code versions store config here)
  return path.join(os.homedir(), '.claude.json');
}

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

// ── Atomic file write ────────────────────────────────────────────────────

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  // Validate we can re-parse before writing
  JSON.parse(json);
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
  fs.renameSync(tmp, filePath);
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

function writeClaudeProfileConfig(uuid: string, oauthAccount: unknown): void {
  atomicWriteJson(path.join(getClaudeProfileHome(uuid), '.claude.json'), { oauthAccount });
}

function writeClaudeProfileCredentials(uuid: string, credentials: unknown): void {
  writeActiveCredentials(credentials, getClaudeProfileHome(uuid));
}

function writeClaudeProfileMirror(uuid: string, credentials: unknown, oauthAccount: unknown): void {
  writeClaudeProfileConfig(uuid, oauthAccount);
  writeClaudeProfileCredentials(uuid, credentials);
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

function readStoredClaudeAccount(
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
      writeClaudeProfileMirror(uuid, flatCredentials, flatOauthAccount);
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

function backupCurrentClaudeLiveHome(): void {
  const currentActive = readActiveClaudeAccount();
  if (!currentActive) return;

  const originalCreds = readActiveCredentials();
  const originalOauthAccount = readCurrentLiveOauthAccount();

  if (originalCreds) {
    try {
      atomicWriteJson(
        path.join(getCredentialsDir(), `${currentActive.uuid}.credentials.json`),
        originalCreds,
      );
      writeClaudeProfileCredentials(currentActive.uuid, originalCreds);
    } catch {
      // Best effort only.
    }
  }
  if (originalOauthAccount) {
    try {
      atomicWriteJson(
        path.join(getConfigsDir(), `${currentActive.uuid}.config.json`),
        originalOauthAccount,
      );
      writeClaudeProfileConfig(currentActive.uuid, originalOauthAccount);
    } catch {
      // Best effort only.
    }
  }
}

function mergeOauthAccountIntoLiveConfig(oauthAccount: unknown): void {
  let configObj: Record<string, unknown> = {};
  try {
    configObj = JSON.parse(fs.readFileSync(getClaudeConfigPath(), 'utf8'));
  } catch {
    // File may not exist yet.
  }
  configObj.oauthAccount = oauthAccount;
  atomicWriteJson(getClaudeConfigPath(), configObj);
}

// ── Registry operations ──────────────────────────────────────────────────

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
  const mappedClaudeProfiles: SavedAccountProfile[] = registry.accounts.map((account) => ({
    id: account.uuid,
    providerId: 'claude-code',
    providerAccountId: account.uuid,
    email: account.email,
    label: account.label,
    addedAt: account.addedAt,
    metadata: {
      email: account.email,
    },
  }));
  replaceSavedAccountProfiles('claude-code', mappedClaudeProfiles, registry.activeAccountUuid);
}

// ── Read active Claude account ───────────────────────────────────────────

export function readActiveClaudeAccount(): ActiveAccountInfo | null {
  try {
    const content = fs.readFileSync(getClaudeConfigPath(), 'utf8');
    const parsed = JSON.parse(content);
    const email = parsed?.oauthAccount?.emailAddress;
    const uuid = parsed?.oauthAccount?.accountUuid;
    if (!email || !uuid) return null;
    return { email, uuid };
  } catch {
    return null;
  }
}

// ── Add current account ──────────────────────────────────────────────────

export function addCurrentAccount(label?: string): AccountManagerResult {
  // 1. Read current Claude identity
  const active = readActiveClaudeAccount();
  if (!active) {
    return {
      success: false,
      error: 'No active Claude account found. Sign in with `claude` first.',
    };
  }

  // 2. Read current credentials (platform-aware: Keychain on macOS, file on Linux)
  const credBlob = readActiveCredentials();
  if (!credBlob) {
    return { success: false, error: 'Could not read Claude credentials.' };
  }

  // 3. Read oauthAccount section from .claude.json
  let configBlob: unknown;
  try {
    const raw = JSON.parse(fs.readFileSync(getClaudeConfigPath(), 'utf8'));
    configBlob = raw.oauthAccount;
  } catch {
    return { success: false, error: 'Could not read Claude config file.' };
  }

  ensureDirs();

  // 4. Load or create registry
  const registry = readAccountRegistry() ?? {
    version: 1 as const,
    activeAccountUuid: null,
    accounts: [],
  };

  // 5. Check if account already exists — update credentials + label
  const existing = registry.accounts.find((a) => a.uuid === active.uuid);
  if (existing) {
    if (label !== undefined) existing.label = label;
    atomicWriteJson(path.join(getCredentialsDir(), `${active.uuid}.credentials.json`), credBlob);
    atomicWriteJson(path.join(getConfigsDir(), `${active.uuid}.config.json`), configBlob);
    try {
      writeClaudeProfileMirror(active.uuid, credBlob, configBlob);
    } catch {
      /* flat backups remain available */
    }
    registry.activeAccountUuid = active.uuid;
    writeAccountRegistry(registry);
    return { success: true };
  }

  // 6. New account — back up credentials
  atomicWriteJson(path.join(getCredentialsDir(), `${active.uuid}.credentials.json`), credBlob);
  atomicWriteJson(path.join(getConfigsDir(), `${active.uuid}.config.json`), configBlob);
  try {
    writeClaudeProfileMirror(active.uuid, credBlob, configBlob);
  } catch {
    /* flat backups remain available */
  }

  // 7. Add entry
  registry.accounts.push({
    uuid: active.uuid,
    email: active.email,
    label,
    addedAt: new Date().toISOString(),
  });
  registry.activeAccountUuid = active.uuid;
  writeAccountRegistry(registry);

  return { success: true };
}

// ── Switch to account ────────────────────────────────────────────────────

export function switchToAccount(uuid: string): AccountManagerResult {
  const registry = readAccountRegistry();
  if (!registry) {
    return { success: false, error: 'No account registry found. Save an account first.' };
  }

  const target = registry.accounts.find((a) => a.uuid === uuid);
  if (!target) {
    return { success: false, error: `Account ${uuid} not found in registry.` };
  }

  // 1. Back up current credentials + config (for whichever Claude account is live).
  let originalCreds: unknown = null;
  let originalConfig: string | null = null;

  originalCreds = readActiveCredentials();

  try {
    originalConfig = fs.readFileSync(getClaudeConfigPath(), 'utf8');
  } catch {
    /* no existing config to back up */
  }

  try {
    backupCurrentClaudeLiveHome();
  } catch {
    /* best effort */
  }

  try {
    setActiveSavedAccount('claude-code', uuid);
  } catch (err) {
    return { success: false, error: `Failed to update account registry: ${err}` };
  }

  const applied = applyActiveClaudeToLiveHome();
  if (!applied.success) {
    try {
      setActiveSavedAccount('claude-code', registry.activeAccountUuid);
    } catch {
      /* rollback failed */
    }
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
    return applied;
  }

  return applied;
}

export function resolveActiveClaudeHome(): string {
  const active = getActiveSavedAccount('claude-code');
  if (!active) return getClaudeDir();
  return getClaudeProfileHome(active.providerAccountId ?? active.id);
}

export function applyActiveClaudeToLiveHome(): AccountManagerResult {
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

          writeClaudeProfileMirror(uuid, credentials, oauthAccount);
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
  const registry = readAccountRegistry();
  if (!registry) {
    return { success: false, error: 'No account registry found.' };
  }

  const idx = registry.accounts.findIndex((a) => a.uuid === uuid);
  if (idx === -1) {
    return { success: false, error: `Account ${uuid} not found.` };
  }

  // Remove backed-up files
  try {
    fs.unlinkSync(path.join(getCredentialsDir(), `${uuid}.credentials.json`));
  } catch {
    /* ok */
  }
  try {
    fs.unlinkSync(path.join(getConfigsDir(), `${uuid}.config.json`));
  } catch {
    /* ok */
  }

  // Remove from registry
  registry.accounts.splice(idx, 1);
  if (registry.activeAccountUuid === uuid) {
    registry.activeAccountUuid = registry.accounts[0]?.uuid ?? null;
  }
  writeAccountRegistry(registry);

  return { success: true };
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
 * live `~/.claude/.claude.json` identity over the saved registry pointer (which
 * only sidekick's own switch flow updates and therefore goes stale after a native
 * `claude /login`).
 *
 * Safe self-heal: when the live account matches a saved profile (by account UUID,
 * email as fallback) that isn't the current active pointer, the pointer is
 * re-pointed so registry-keyed data tracks reality too. Never creates or deletes
 * profiles; an unknown live account is shown as-is with no label and no write.
 */
export function resolveActiveClaudeAccount(): ResolvedActiveAccount {
  const live = readActiveClaudeAccount();
  if (live) {
    const profiles = listSavedAccountProfiles('claude-code');
    const match =
      profiles.find((p) => (p.providerAccountId ?? p.id) === live.uuid) ??
      profiles.find((p) => (p.email ?? p.metadata?.email) === live.email);
    if (match) {
      const active = getActiveSavedAccount('claude-code');
      if (!active || active.id !== match.id) {
        // Self-heal is best-effort: a registry write failure (read-only/full
        // disk) must never break display or extension activation. We still
        // return the correct live identity below.
        try {
          setActiveSavedAccount('claude-code', match.id);
        } catch {
          /* keep going with the live identity */
        }
      }
    }
    return {
      email: live.email,
      label: match?.label,
      providerAccountId: live.uuid,
      source: 'live',
    };
  }

  const active = getActiveAccount();
  if (active) {
    return {
      email: active.email,
      label: active.label,
      providerAccountId: active.uuid,
      source: 'registry',
    };
  }
  return { source: 'none' };
}

export function isMultiAccountEnabled(): boolean {
  return listSavedAccountProfiles('claude-code').length >= 1;
}
