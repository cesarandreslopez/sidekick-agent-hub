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
  last_refresh?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface CodexAuthIdentity {
  email?: string;
  workspaceId?: string;
  planType?: string;
  authMode: 'chatgpt' | 'api-key';
}

// Codex refreshes OAuth tokens at most every 8 days; a stored refresh token
// older than that may already be rejected by the auth server.
const STALE_AUTH_THRESHOLD_MS = 8 * 24 * 60 * 60 * 1000;

export interface CodexAccountManagerResult extends AccountManagerResult {
  needsLogin?: boolean;
  profileId?: string;
  codexHome?: string;
}

function getDefaultSystemCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

function getExplicitCodexHome(): string | null {
  const explicitHome = process.env.CODEX_HOME?.trim();
  return explicitHome ? explicitHome : null;
}

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

export function getSystemCodexHome(): string {
  return getExplicitCodexHome() ?? getDefaultSystemCodexHome();
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
  try {
    fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// auth.json must be copied byte-for-byte: re-serializing would drop fields
// added by newer codex versions, and the rotated refresh token inside is
// only valid in its freshest form.
function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = filePath + '.tmp';
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
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

function parseAuthJson(raw: string | null): AuthJsonFile | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthJsonFile;
  } catch {
    return null;
  }
}

function readAuthIdentityFromRaw(raw: string | null): CodexAuthIdentity | null {
  const parsed = parseAuthJson(raw);
  if (!parsed) return null;

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

  return { email, workspaceId, planType, authMode };
}

function readLastRefresh(raw: string | null, fallbackPath?: string): number | null {
  const parsed = parseAuthJson(raw);
  if (parsed?.last_refresh) {
    const ts = Date.parse(parsed.last_refresh);
    if (!Number.isNaN(ts)) return ts;
  }
  if (fallbackPath) {
    try {
      return fs.statSync(fallbackPath).mtimeMs;
    } catch { /* fall through */ }
  }
  return null;
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

function getCodexLoginStatus(codexHome: string): { loggedIn: boolean; authMode?: 'chatgpt' | 'api-key' } {
  try {
    const env = { ...process.env, CODEX_HOME: codexHome };
    const result = spawnSync('codex', ['login', 'status'], {
      encoding: 'utf8',
      env,
      timeout: 4000,
      killSignal: 'SIGKILL',
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

function detectRunningCodexProcess(): boolean {
  if (process.platform === 'win32') return false;
  try {
    return spawnSync('pgrep', ['-x', 'codex'], {
      encoding: 'utf8',
      timeout: 4000,
      killSignal: 'SIGKILL',
    }).status === 0;
  } catch {
    return false;
  }
}

export function readCodexAccountMetadata(codexHome: string): AccountIdentityMetadata {
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

export function isCodexProfileAuthenticated(codexHome: string): boolean {
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
  // Account switching swaps auth.json inside the system home, so the system
  // home (or an explicit CODEX_HOME) is always the single live home.
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

export function finalizeCodexAccount(
  profileId: string,
  opts: { activate?: boolean } = {},
): CodexAccountManagerResult {
  const pending = readPendingProfile(profileId);
  if (!pending) {
    return { success: false, error: `Codex profile ${profileId} was not prepared.` };
  }

  const codexHome = getCodexProfileHome(profileId);
  if (!isCodexProfileAuthenticated(codexHome)) {
    return { success: false, error: 'Codex profile is not authenticated yet.' };
  }

  const metadata = readCodexAccountMetadata(codexHome);
  const profile: SavedAccountProfile = {
    id: profileId,
    providerId: 'codex',
    label: pending.label,
    email: metadata.email,
    addedAt: pending.addedAt,
    metadata,
  };
  upsertSavedAccountProfile(profile);

  if (opts.activate === false) {
    return { success: true };
  }

  const hasCredentialFiles =
    fs.existsSync(path.join(codexHome, 'auth.json')) ||
    fs.existsSync(path.join(codexHome, '.credentials.json'));
  if (!hasCredentialFiles) {
    // Authenticated via the OS keyring — there are no credential files to
    // swap, so the registry pointer is all we can update.
    setActiveSavedAccount('codex', profileId);
    return {
      success: true,
      warning: 'Codex stores credentials in the OS keyring; sidekick cannot swap them per account, so `codex` keeps using the keyring credentials.',
    };
  }

  return performCodexAuthSwap(profile);
}

function getCodexStashDir(): string {
  return path.join(getAccountsDir(), 'codex', 'stash');
}

function stashLiveCodexAuth(liveAuthRaw: string | null, liveLegacyRaw: string | null): string | null {
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

function findProfileForIdentity(identity: CodexAuthIdentity | null): SavedAccountProfile | null {
  const profiles = listCodexAccounts();
  if (identity?.workspaceId) {
    const byWorkspace = profiles.find(profile => profile.metadata?.workspaceId === identity.workspaceId);
    if (byWorkspace) return byWorkspace;
  }
  if (identity?.email) {
    const byEmail = profiles.find(profile => (profile.email ?? profile.metadata?.email) === identity.email);
    if (byEmail) return byEmail;
  }
  if (!identity?.workspaceId && !identity?.email) {
    // API-key auth or unparseable tokens carry no identity; assume the live
    // file belongs to whichever account the registry says is active.
    return getActiveCodexAccount();
  }
  return null;
}

interface SyncBackResult {
  syncedProfileId?: string;
  stashPath?: string;
  warning?: string;
}

// Codex rotates the refresh token whenever it refreshes auth.json, so the
// live file is always the freshest copy of its account. Before replacing it,
// preserve it in the matching profile's backup — or stash it if it belongs to
// no saved account. Best-effort: never throws.
function syncBackLiveCodexAuth(liveAuthRaw: string | null, liveLegacyRaw: string | null): SyncBackResult {
  if (!liveAuthRaw && !liveLegacyRaw) return {};

  try {
    const identity = readAuthIdentityFromRaw(liveAuthRaw);
    const profile = findProfileForIdentity(identity);

    if (!profile) {
      const stashPath = stashLiveCodexAuth(liveAuthRaw, liveLegacyRaw);
      return {
        stashPath: stashPath ?? undefined,
        warning: stashPath
          ? `Live Codex credentials did not match any saved account; stashed at ${stashPath}.`
          : 'Live Codex credentials did not match any saved account and could not be stashed.',
      };
    }

    const profileHome = getCodexProfileHome(profile.id);
    if (liveAuthRaw) atomicWriteFile(path.join(profileHome, 'auth.json'), liveAuthRaw);
    if (liveLegacyRaw) atomicWriteFile(path.join(profileHome, '.credentials.json'), liveLegacyRaw);

    try {
      const metadata = readCodexAccountMetadata(profileHome);
      upsertSavedAccountProfile({
        ...profile,
        email: metadata.email ?? profile.email,
        metadata: { ...profile.metadata, ...metadata },
      });
    } catch { /* metadata refresh is best-effort */ }

    return { syncedProfileId: profile.id };
  } catch (err) {
    return { warning: `Could not back up live Codex credentials: ${err}` };
  }
}

function performCodexAuthSwap(target: SavedAccountProfile): CodexAccountManagerResult {
  const systemHome = getSystemCodexHome();
  const liveAuthPath = path.join(systemHome, 'auth.json');
  const liveLegacyPath = path.join(systemHome, '.credentials.json');
  const liveAuthRaw = readFileOrNull(liveAuthPath);
  const liveLegacyRaw = readFileOrNull(liveLegacyPath);

  if (!liveAuthRaw && !liveLegacyRaw && getCodexLoginStatus(systemHome).loggedIn) {
    return {
      success: false,
      error: 'Codex stores credentials in the OS keyring; file-based account switching is not supported. Set `cli_auth_credentials_store = "file"` in ~/.codex/config.toml and run `codex login` again.',
    };
  }

  const profileHome = getCodexProfileHome(target.id);
  const targetAuthPath = path.join(profileHome, 'auth.json');
  const targetAuthRaw = readFileOrNull(targetAuthPath);
  const targetLegacyRaw = readFileOrNull(path.join(profileHome, '.credentials.json'));
  const targetName = target.label ?? target.email ?? target.id;

  if (!targetAuthRaw && !targetLegacyRaw) {
    return { success: false, error: `No stored credentials for "${targetName}". Remove and re-add this account.` };
  }
  if (targetAuthRaw && !parseAuthJson(targetAuthRaw)) {
    return { success: false, error: `Stored credentials for "${targetName}" are corrupted. Remove and re-add this account.` };
  }

  const warnings: string[] = [];
  if (detectRunningCodexProcess()) {
    warnings.push('A codex process appears to be running; restart codex sessions so they pick up the switched account.');
  }

  // If the live file already belongs to the target account it is the freshest
  // copy (rotated refresh token included) — never replace it with a staler
  // backup, which would permanently invalidate the login. Just refresh the
  // backup and the registry pointer.
  const liveIdentity = readAuthIdentityFromRaw(liveAuthRaw);
  const targetIdentity = readAuthIdentityFromRaw(targetAuthRaw);
  const targetWorkspaceId = target.metadata?.workspaceId ?? targetIdentity?.workspaceId;
  const targetEmail = target.email ?? target.metadata?.email ?? targetIdentity?.email;
  const liveMatchesTarget = Boolean(
    (liveIdentity?.workspaceId && targetWorkspaceId && liveIdentity.workspaceId === targetWorkspaceId) ||
    (liveIdentity?.email && targetEmail && liveIdentity.email === targetEmail) ||
    (liveAuthRaw !== null && liveAuthRaw === targetAuthRaw) ||
    (!liveAuthRaw && !targetAuthRaw && liveLegacyRaw !== null && liveLegacyRaw === targetLegacyRaw),
  );

  if (liveMatchesTarget) {
    try {
      if (liveAuthRaw) atomicWriteFile(targetAuthPath, liveAuthRaw);
      if (liveLegacyRaw) atomicWriteFile(path.join(profileHome, '.credentials.json'), liveLegacyRaw);
      const metadata = readCodexAccountMetadata(profileHome);
      upsertSavedAccountProfile({
        ...target,
        email: metadata.email ?? target.email,
        metadata: { ...target.metadata, ...metadata },
      });
    } catch { /* backup refresh is best-effort */ }
    setActiveSavedAccount('codex', target.id);
    return { success: true, warning: warnings.length ? warnings.join(' ') : undefined };
  }

  const targetLastRefresh = readLastRefresh(targetAuthRaw, targetAuthPath);
  if (targetLastRefresh !== null && Date.now() - targetLastRefresh > STALE_AUTH_THRESHOLD_MS) {
    warnings.push(`Stored credentials for "${targetName}" have not been refreshed in over 8 days; codex may ask you to log in again.`);
  }

  const syncBack = syncBackLiveCodexAuth(liveAuthRaw, liveLegacyRaw);
  if (syncBack.warning) warnings.push(syncBack.warning);

  const restoreLiveFiles = (): void => {
    try {
      if (liveAuthRaw) atomicWriteFile(liveAuthPath, liveAuthRaw);
      else fs.rmSync(liveAuthPath, { force: true });
      if (liveLegacyRaw) atomicWriteFile(liveLegacyPath, liveLegacyRaw);
      else fs.rmSync(liveLegacyPath, { force: true });
    } catch { /* rollback is best-effort */ }
  };

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
    return { success: false, error: `Failed to write Codex credentials: ${err}` };
  }

  try {
    setActiveSavedAccount('codex', target.id);
  } catch (err) {
    restoreLiveFiles();
    return { success: false, error: `Failed to update account registry: ${err}` };
  }

  return { success: true, warning: warnings.length ? warnings.join(' ') : undefined };
}

export function switchToCodexAccount(profileId: string): CodexAccountManagerResult {
  const target = listCodexAccounts().find(account => account.id === profileId);
  if (!target) {
    return { success: false, error: `Codex account ${profileId} not found.` };
  }

  return performCodexAuthSwap(target);
}

// One-time migration for installs created when profile homes doubled as live
// CODEX_HOMEs: the active profile's auth.json may hold a fresher rotated
// refresh token than the system home. Best-effort: never throws.
export function reconcileCodexAuthState(): void {
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
      // in through the OS keyring.
      if (!getCodexLoginStatus(systemHome).loggedIn) {
        atomicWriteFile(liveAuthPath, profileAuthRaw);
      }
      writeMarker();
      return;
    }

    const liveIdentity = readAuthIdentityFromRaw(liveAuthRaw);
    const profileIdentity = readAuthIdentityFromRaw(profileAuthRaw);
    const sameIdentity = Boolean(
      (liveIdentity?.workspaceId && profileIdentity?.workspaceId && liveIdentity.workspaceId === profileIdentity.workspaceId) ||
      (liveIdentity?.email && liveIdentity.email === profileIdentity?.email),
    );

    if (sameIdentity) {
      const liveRefresh = readLastRefresh(liveAuthRaw, liveAuthPath);
      const profileRefresh = readLastRefresh(profileAuthRaw, profileAuthPath);
      if (profileRefresh !== null && (liveRefresh === null || profileRefresh > liveRefresh)) {
        // The profile copy was the live home under the old model and holds
        // the valid rotated refresh token — promote it.
        stashLiveCodexAuth(liveAuthRaw, null);
        atomicWriteFile(liveAuthPath, profileAuthRaw);
      } else {
        atomicWriteFile(profileAuthPath, liveAuthRaw);
      }
    } else {
      // The live credentials belong to a different account; the live state
      // wins — point the registry at the matching saved profile if there is
      // one, and refresh its backup.
      const matching = findProfileForIdentity(liveIdentity);
      if (matching && matching.id !== active.id) {
        atomicWriteFile(path.join(getCodexProfileHome(matching.id), 'auth.json'), liveAuthRaw);
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
