/**
 * Multi-account management for Claude Max subscriptions.
 *
 * Handles saving, listing, switching, and removing Claude accounts.
 * Both the VS Code extension and CLI consume this module.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConfigDir } from './paths';
import { readActiveCredentials, writeActiveCredentials } from './credentialIO';

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
  } catch { /* fall through */ }
  // Fallback: ~/.claude.json (some Claude Code versions store config here)
  return path.join(os.homedir(), '.claude.json');
}

export function getAccountsDir(): string {
  return path.join(getConfigDir(), 'accounts');
}

function getCredentialsDir(): string {
  return path.join(getAccountsDir(), 'credentials');
}

function getConfigsDir(): string {
  return path.join(getAccountsDir(), 'configs');
}

function getRegistryPath(): string {
  return path.join(getAccountsDir(), 'accounts.json');
}

// ── Directory bootstrap ──────────────────────────────────────────────────

function ensureDirs(): void {
  for (const dir of [getAccountsDir(), getCredentialsDir(), getConfigsDir()]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ── Atomic file write ────────────────────────────────────────────────────

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  // Validate we can re-parse before writing
  JSON.parse(json);
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
  fs.renameSync(tmp, filePath);
}

// ── Registry operations ──────────────────────────────────────────────────

export function readAccountRegistry(): AccountRegistry | null {
  try {
    const content = fs.readFileSync(getRegistryPath(), 'utf8');
    const parsed = JSON.parse(content);
    if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) return null;
    return parsed as AccountRegistry;
  } catch {
    return null;
  }
}

export function writeAccountRegistry(registry: AccountRegistry): void {
  ensureDirs();
  atomicWriteJson(getRegistryPath(), registry);
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
    return { success: false, error: 'No active Claude account found. Sign in with `claude` first.' };
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
  let registry = readAccountRegistry() ?? {
    version: 1 as const,
    activeAccountUuid: null,
    accounts: [],
  };

  // 5. Check if account already exists — update credentials + label
  const existing = registry.accounts.find(a => a.uuid === active.uuid);
  if (existing) {
    if (label !== undefined) existing.label = label;
    atomicWriteJson(path.join(getCredentialsDir(), `${active.uuid}.credentials.json`), credBlob);
    atomicWriteJson(path.join(getConfigsDir(), `${active.uuid}.config.json`), configBlob);
    registry.activeAccountUuid = active.uuid;
    writeAccountRegistry(registry);
    return { success: true };
  }

  // 6. New account — back up credentials
  atomicWriteJson(path.join(getCredentialsDir(), `${active.uuid}.credentials.json`), credBlob);
  atomicWriteJson(path.join(getConfigsDir(), `${active.uuid}.config.json`), configBlob);

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

  const target = registry.accounts.find(a => a.uuid === uuid);
  if (!target) {
    return { success: false, error: `Account ${uuid} not found in registry.` };
  }

  if (registry.activeAccountUuid === uuid) {
    return { success: true }; // Already active
  }

  // 1. Back up current credentials + config (for the currently-active account)
  let originalCreds: unknown = null;
  let originalConfig: string | null = null;

  originalCreds = readActiveCredentials();

  try {
    originalConfig = fs.readFileSync(getClaudeConfigPath(), 'utf8');
  } catch { /* no existing config to back up */ }

  // Save current account's backup if we know who's active
  const currentActive = readActiveClaudeAccount();
  if (currentActive) {
    if (originalCreds) {
      try {
        atomicWriteJson(
          path.join(getCredentialsDir(), `${currentActive.uuid}.credentials.json`),
          originalCreds
        );
      } catch { /* best effort */ }
    }
    if (originalConfig) {
      try {
        const parsed = JSON.parse(originalConfig);
        if (parsed.oauthAccount) {
          atomicWriteJson(
            path.join(getConfigsDir(), `${currentActive.uuid}.config.json`),
            parsed.oauthAccount
          );
        }
      } catch { /* best effort */ }
    }
  }

  // 2. Read target account's backed-up credentials + config
  let targetCreds: unknown;
  let targetOauthAccount: unknown;
  try {
    targetCreds = JSON.parse(
      fs.readFileSync(path.join(getCredentialsDir(), `${uuid}.credentials.json`), 'utf8')
    );
  } catch {
    return { success: false, error: `Backed-up credentials for ${target.email} not found.` };
  }
  try {
    targetOauthAccount = JSON.parse(
      fs.readFileSync(path.join(getConfigsDir(), `${uuid}.config.json`), 'utf8')
    );
  } catch {
    return { success: false, error: `Backed-up config for ${target.email} not found.` };
  }

  // 3. Write target credentials (platform-aware: Keychain on macOS, file on Linux)
  try {
    writeActiveCredentials(targetCreds);
  } catch (err) {
    // Rollback: restore original credentials
    if (originalCreds) {
      try { writeActiveCredentials(originalCreds); } catch { /* rollback failed */ }
    }
    return { success: false, error: `Failed to write credentials: ${err}` };
  }

  // 4. Merge target oauthAccount into current .claude.json
  try {
    let configObj: Record<string, unknown> = {};
    try {
      configObj = JSON.parse(fs.readFileSync(getClaudeConfigPath(), 'utf8'));
    } catch { /* file may not exist yet */ }
    configObj.oauthAccount = targetOauthAccount;
    atomicWriteJson(getClaudeConfigPath(), configObj);
  } catch (err) {
    // Rollback: restore original credentials and config
    if (originalCreds) {
      try { writeActiveCredentials(originalCreds); } catch { /* rollback failed */ }
    }
    if (originalConfig) {
      try { fs.writeFileSync(getClaudeConfigPath(), originalConfig); } catch { /* rollback failed */ }
    }
    return { success: false, error: `Failed to write config: ${err}` };
  }

  // 5. Update registry
  registry.activeAccountUuid = uuid;
  writeAccountRegistry(registry);

  return { success: true };
}

// ── Remove account ───────────────────────────────────────────────────────

export function removeAccount(uuid: string): AccountManagerResult {
  const registry = readAccountRegistry();
  if (!registry) {
    return { success: false, error: 'No account registry found.' };
  }

  const idx = registry.accounts.findIndex(a => a.uuid === uuid);
  if (idx === -1) {
    return { success: false, error: `Account ${uuid} not found.` };
  }

  // Remove backed-up files
  try { fs.unlinkSync(path.join(getCredentialsDir(), `${uuid}.credentials.json`)); } catch { /* ok */ }
  try { fs.unlinkSync(path.join(getConfigsDir(), `${uuid}.config.json`)); } catch { /* ok */ }

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
  return readAccountRegistry()?.accounts ?? [];
}

export function getActiveAccount(): AccountEntry | null {
  const registry = readAccountRegistry();
  if (!registry?.activeAccountUuid) return null;
  return registry.accounts.find(a => a.uuid === registry.activeAccountUuid) ?? null;
}

export function isMultiAccountEnabled(): boolean {
  const registry = readAccountRegistry();
  return (registry?.accounts.length ?? 0) >= 1;
}
