import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  getAccountsDir,
  getActiveSavedAccount,
  listSavedAccountProfiles,
  removeSavedAccountProfile,
  setActiveSavedAccount,
  upsertSavedAccountProfile,
} from './accountRegistry';
import type { AccountIdentityMetadata, SavedAccountProfile } from './accountRegistry';
import type { AccountManagerResult } from './accounts';

interface PendingCodexProfile {
  label: string;
  addedAt: string;
}

interface AuthJsonFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

export interface CodexAccountManagerResult extends AccountManagerResult {
  needsLogin?: boolean;
  profileId?: string;
  codexHome?: string;
}

function getSystemCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

export function getCodexProfilesDir(): string {
  return path.join(getAccountsDir(), 'codex', 'profiles');
}

function getCodexProfileDir(profileId: string): string {
  return path.join(getCodexProfilesDir(), profileId);
}

export function getCodexProfileHome(profileId: string): string {
  return path.join(getCodexProfileDir(profileId), 'codex-home');
}

function getCodexProfileStatePath(profileId: string): string {
  return path.join(getCodexProfileDir(profileId), 'profile.json');
}

function ensureCodexProfileDirs(profileId: string): void {
  fs.mkdirSync(getCodexProfileHome(profileId), { recursive: true, mode: 0o700 });
}

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  const tmp = filePath + '.tmp';
  const json = JSON.stringify(data, null, 2);
  JSON.parse(json);
  fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
  fs.renameSync(tmp, filePath);
}

function readPendingProfile(profileId: string): PendingCodexProfile | null {
  try {
    return JSON.parse(fs.readFileSync(getCodexProfileStatePath(profileId), 'utf8')) as PendingCodexProfile;
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

function copySourceCodexConfig(sourceHome: string, targetHome: string): void {
  copyIfExists(path.join(sourceHome, 'config.toml'), path.join(targetHome, 'config.toml'));
}

function importCurrentCodexAuth(sourceHome: string, targetHome: string): boolean {
  const authCopied = copyIfExists(path.join(sourceHome, 'auth.json'), path.join(targetHome, 'auth.json'));
  const legacyCredsCopied = copyIfExists(path.join(sourceHome, '.credentials.json'), path.join(targetHome, '.credentials.json'));
  return authCopied || legacyCredsCopied;
}

function parseJwtPayload<T>(jwt: string): T | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}

function readMetadataFromAuthJson(codexHome: string): AccountIdentityMetadata {
  const authPath = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authPath)) return {};

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8')) as AuthJsonFile;
    const idToken = parsed.tokens?.id_token;
    const claims = idToken ? parseJwtPayload<Record<string, unknown>>(idToken) : null;
    const profileClaims = claims?.['https://api.openai.com/profile'] as Record<string, unknown> | undefined;
    const authClaims = claims?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;

    const email = typeof claims?.email === 'string'
      ? claims.email
      : typeof profileClaims?.email === 'string'
        ? profileClaims.email
        : undefined;

    const workspaceId = typeof authClaims?.chatgpt_account_id === 'string'
      ? authClaims.chatgpt_account_id
      : parsed.tokens?.account_id;

    const planType = typeof authClaims?.chatgpt_plan_type === 'string'
      ? authClaims.chatgpt_plan_type
      : undefined;

    const authMode = parsed.OPENAI_API_KEY || parsed.auth_mode === 'api_key'
      ? 'api-key'
      : 'chatgpt';

    return {
      email,
      workspaceId,
      planType,
      authMode,
    };
  } catch {
    return {};
  }
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

function getCodexLoginStatus(codexHome: string): { loggedIn: boolean; authMode?: 'chatgpt' | 'api-key' } {
  try {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const result = spawnSync('codex', ['login', 'status'], {
      encoding: 'utf8',
      env,
    });
    const stdout = String(result.stdout ?? '').trim();
    if (result.status === 0 && /^Logged in/i.test(stdout)) {
      if (/API key/i.test(stdout)) {
        return { loggedIn: true, authMode: 'api-key' };
      }
      if (/ChatGPT/i.test(stdout)) {
        return { loggedIn: true, authMode: 'chatgpt' };
      }
      return { loggedIn: true };
    }
  } catch {
    // Ignore missing CLI or spawn errors.
  }
  return { loggedIn: false };
}

function readCodexAccountMetadata(codexHome: string): AccountIdentityMetadata {
  const fromAuth = readMetadataFromAuthJson(codexHome);
  if (fromAuth.email || fromAuth.workspaceId || fromAuth.planType || fromAuth.authMode) {
    return fromAuth;
  }

  const fromLegacy = readMetadataFromLegacyCredentials(codexHome);
  if (fromLegacy.authMode) {
    return fromLegacy;
  }

  const status = getCodexLoginStatus(codexHome);
  if (status.loggedIn) {
    return {
      authMode: status.authMode ?? 'unknown',
    };
  }

  return {};
}

function isCodexProfileAuthenticated(codexHome: string): boolean {
  if (
    fs.existsSync(path.join(codexHome, 'auth.json')) ||
    fs.existsSync(path.join(codexHome, '.credentials.json'))
  ) {
    return true;
  }

  return getCodexLoginStatus(codexHome).loggedIn;
}

function ensureUniqueCodexLabel(label: string, excludeId?: string): string | null {
  const normalized = label.trim().toLowerCase();
  const conflict = listCodexAccounts().find(account =>
    account.id !== excludeId &&
    (account.label ?? '').trim().toLowerCase() === normalized,
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
  const explicitHome = process.env.CODEX_HOME;
  if (explicitHome) return explicitHome;

  const active = getActiveCodexAccount();
  if (active) {
    const managedHome = getCodexProfileHome(active.id);
    if (fs.existsSync(managedHome)) return managedHome;
  }

  return getSystemCodexHome();
}

export function getCodexExecutionEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    CODEX_HOME: resolveSidekickCodexHome(),
  };
}

export function prepareCodexAccount(label: string): CodexAccountManagerResult {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return { success: false, error: 'Codex accounts require a non-empty label.' };
  }

  const labelError = ensureUniqueCodexLabel(trimmedLabel);
  if (labelError) {
    return { success: false, error: labelError };
  }

  const profileId = randomUUID();
  const codexHome = getCodexProfileHome(profileId);
  ensureCodexProfileDirs(profileId);
  writePendingProfile(profileId, {
    label: trimmedLabel,
    addedAt: new Date().toISOString(),
  });

  const sourceHome = getSystemCodexHome();
  copySourceCodexConfig(sourceHome, codexHome);
  const imported = importCurrentCodexAuth(sourceHome, codexHome);

  if (imported) {
    const finalized = finalizeCodexAccount(profileId);
    return {
      ...finalized,
      profileId,
      codexHome,
      needsLogin: false,
    };
  }

  return {
    success: true,
    profileId,
    codexHome,
    needsLogin: true,
  };
}

export function finalizeCodexAccount(profileId: string): AccountManagerResult {
  const pending = readPendingProfile(profileId);
  if (!pending) {
    return { success: false, error: `Codex profile ${profileId} was not prepared.` };
  }

  const codexHome = getCodexProfileHome(profileId);
  if (!isCodexProfileAuthenticated(codexHome)) {
    return { success: false, error: 'Codex profile is not authenticated yet.' };
  }

  const metadata = readCodexAccountMetadata(codexHome);
  upsertSavedAccountProfile({
    id: profileId,
    providerId: 'codex',
    label: pending.label,
    email: metadata.email,
    addedAt: pending.addedAt,
    metadata,
  });
  setActiveSavedAccount('codex', profileId);

  return { success: true };
}

export function switchToCodexAccount(profileId: string): AccountManagerResult {
  const target = listCodexAccounts().find(account => account.id === profileId);
  if (!target) {
    return { success: false, error: `Codex account ${profileId} not found.` };
  }

  setActiveSavedAccount('codex', profileId);
  return { success: true };
}

export function removeCodexAccount(profileId: string): AccountManagerResult {
  const removed = removeSavedAccountProfile('codex', profileId);
  if (!removed) {
    return { success: false, error: `Codex account ${profileId} not found.` };
  }

  fs.rmSync(getCodexProfileDir(profileId), { recursive: true, force: true });
  return { success: true };
}
