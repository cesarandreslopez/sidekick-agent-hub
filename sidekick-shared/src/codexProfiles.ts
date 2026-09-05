import * as fs from 'fs';
import * as os from 'os';
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

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
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

function copySourceCodexConfig(sourceHome: string, targetHome: string): void {
  copyIfExists(path.join(sourceHome, 'config.toml'), path.join(targetHome, 'config.toml'));
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
  const profileClaims = claims?.['https://api.openai.com/profile'] as
    | Record<string, unknown>
    | undefined;
  const authClaims = claims?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;

  const email =
    typeof claims?.email === 'string'
      ? claims.email
      : typeof profileClaims?.email === 'string'
        ? profileClaims.email
        : undefined;

  const workspaceId =
    typeof authClaims?.chatgpt_account_id === 'string'
      ? authClaims.chatgpt_account_id
      : parsed.tokens?.account_id;

  const planType =
    typeof authClaims?.chatgpt_plan_type === 'string' ? authClaims.chatgpt_plan_type : undefined;

  const authMode = parsed.OPENAI_API_KEY || parsed.auth_mode === 'api_key' ? 'api-key' : 'chatgpt';

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
    } catch {
      /* fall through */
    }
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

interface CodexLoginStatus {
  loggedIn: boolean;
  authMode?: 'chatgpt' | 'api-key';
}

const PROBE_TIMEOUT_MS = 4000;

function parseCodexLoginStatusOutput(status: number | null, stdout: string): CodexLoginStatus {
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
function getCodexLoginStatus(codexHome: string): CodexLoginStatus {
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

function getCodexLoginStatusAsync(codexHome: string): Promise<CodexLoginStatus> {
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

/** Sync sibling of {@link detectRunningCodexProcessAsync}; see the event-loop caveat above. */
function detectRunningCodexProcess(): boolean {
  if (process.platform === 'win32') return false;
  try {
    return (
      spawnSync('pgrep', ['-x', 'codex'], {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      }).status === 0
    );
  } catch {
    return false;
  }
}

function detectRunningCodexProcessAsync(): Promise<boolean> {
  if (process.platform === 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFile(
        'pgrep',
        ['-x', 'codex'],
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (error) => resolve(!error),
      );
    } catch {
      resolve(false);
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
          setActiveSavedAccount('codex', match.id);
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

type CodexPrepareStep =
  | { result: CodexAccountManagerResult }
  | { finalize: { profileId: string; codexHome: string } };

type CodexFinalizeStep = { result: CodexAccountManagerResult } | { swap: SavedAccountProfile };

function prepareCodexAccountCore(label: string): CodexPrepareStep {
  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return { result: { success: false, error: 'Codex accounts require a non-empty label.' } };
  }

  const labelError = ensureUniqueCodexLabel(trimmedLabel);
  if (labelError) {
    return { result: { success: false, error: labelError } };
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
    return { result: { success: false, error: `Codex profile ${profileId} was not prepared.` } };
  }

  const codexHome = getCodexProfileHome(profileId);
  if (!probes.authenticated) {
    return { result: { success: false, error: 'Codex profile is not authenticated yet.' } };
  }

  const profile: SavedAccountProfile = {
    id: profileId,
    providerId: 'codex',
    label: pending.label,
    email: probes.metadata.email,
    addedAt: pending.addedAt,
    metadata: probes.metadata,
  };
  upsertSavedAccountProfile(profile);

  if (opts.activate === false) {
    return { result: { success: true } };
  }

  if (!hasCodexCredentialFiles(codexHome)) {
    // Authenticated via the OS keyring — there are no credential files to
    // swap, so the registry pointer is all we can update.
    setActiveSavedAccount('codex', profileId);
    return {
      result: {
        success: true,
        warning:
          'Codex stores credentials in the OS keyring; sidekick cannot swap them per account, so `codex` keeps using the keyring credentials.',
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
    return { success: false, error: `Codex profile ${profileId} was not prepared.` };
  }
  const codexHome = getCodexProfileHome(profileId);
  const authenticated = isCodexProfileAuthenticated(codexHome);
  const step = finalizeCodexAccountCore(profileId, opts, {
    authenticated,
    metadata: authenticated ? readCodexAccountMetadata(codexHome) : {},
  });
  return 'swap' in step ? performCodexAuthSwap(step.swap) : step.result;
}

/** {@link finalizeCodexAccount} without blocking the event loop on CLI probes. */
export async function finalizeCodexAccountAsync(
  profileId: string,
  opts: { activate?: boolean } = {},
): Promise<CodexAccountManagerResult> {
  if (!readPendingProfile(profileId)) {
    return { success: false, error: `Codex profile ${profileId} was not prepared.` };
  }
  const codexHome = getCodexProfileHome(profileId);
  const authenticated = await isCodexProfileAuthenticatedAsync(codexHome);
  const step = finalizeCodexAccountCore(profileId, opts, {
    authenticated,
    metadata: authenticated ? await readCodexAccountMetadataAsync(codexHome) : {},
  });
  return 'swap' in step ? performCodexAuthSwapAsync(step.swap) : step.result;
}

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

function findProfileForIdentity(identity: CodexAuthIdentity | null): SavedAccountProfile | null {
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
function syncBackLiveCodexAuth(
  liveAuthRaw: string | null,
  liveLegacyRaw: string | null,
): SyncBackResult {
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
      // File-based metadata only: this runs with auth files just written, and
      // the CLI-probe fallback must never spawn while the swap lock is held.
      const metadata = readCodexAccountMetadataFromFiles(profileHome) ?? {};
      upsertSavedAccountProfile({
        ...profile,
        email: metadata.email ?? profile.email,
        metadata: { ...profile.metadata, ...metadata },
      });
    } catch {
      /* metadata refresh is best-effort */
    }

    return { syncedProfileId: profile.id };
  } catch (err) {
    return { warning: `Could not back up live Codex credentials: ${err}` };
  }
}

/**
 * Serializes live-auth mutations across processes. Codex rotates refresh
 * tokens, so two interleaved swaps stashing and restoring auth.json can
 * resurrect a stale token and permanently invalidate the login. Lock ordering:
 * this lock is taken first and the registry lock (inside setActiveSavedAccount
 * / upsertSavedAccountProfile) inside it — never the reverse.
 */
function withCodexAuthSwapLock<T>(operation: () => T): T {
  const lockDir = path.join(getAccountsDir(), 'codex');
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  return withFileLockSync(path.join(lockDir, 'auth-swap.lock'), operation);
}

interface CodexAuthSwapProbes {
  codexRunning: boolean;
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
    codexRunning: detectRunningCodexProcess(),
    systemKeyringLoggedIn: hasCodexCredentialFiles(systemHome)
      ? false
      : getCodexLoginStatus(systemHome).loggedIn,
  };
}

async function resolveCodexSwapProbesAsync(): Promise<CodexAuthSwapProbes> {
  const systemHome = getSystemCodexHome();
  return {
    codexRunning: await detectRunningCodexProcessAsync(),
    systemKeyringLoggedIn: hasCodexCredentialFiles(systemHome)
      ? false
      : (await getCodexLoginStatusAsync(systemHome)).loggedIn,
  };
}

function performCodexAuthSwap(target: SavedAccountProfile): CodexAccountManagerResult {
  const probes = resolveCodexSwapProbesSync();
  try {
    return withCodexAuthSwapLock(() => performCodexAuthSwapCore(target, probes));
  } catch (err) {
    // Keep the non-throwing result contract when the lock cannot be acquired.
    return { success: false, error: `Could not acquire the account-switch lock: ${err}` };
  }
}

async function performCodexAuthSwapAsync(
  target: SavedAccountProfile,
): Promise<CodexAccountManagerResult> {
  const probes = await resolveCodexSwapProbesAsync();
  try {
    // The sync lock is fine here: probes are pre-resolved, so the critical
    // section is only fast local-filesystem work.
    return withCodexAuthSwapLock(() => performCodexAuthSwapCore(target, probes));
  } catch (err) {
    return { success: false, error: `Could not acquire the account-switch lock: ${err}` };
  }
}

function performCodexAuthSwapCore(
  target: SavedAccountProfile,
  probes: CodexAuthSwapProbes,
): CodexAccountManagerResult {
  const systemHome = getSystemCodexHome();
  const liveAuthPath = path.join(systemHome, 'auth.json');
  const liveLegacyPath = path.join(systemHome, '.credentials.json');
  const liveAuthRaw = readFileOrNull(liveAuthPath);
  const liveLegacyRaw = readFileOrNull(liveLegacyPath);

  if (!liveAuthRaw && !liveLegacyRaw && probes.systemKeyringLoggedIn) {
    return {
      success: false,
      error:
        'Codex stores credentials in the OS keyring; file-based account switching is not supported. Set `cli_auth_credentials_store = "file"` in ~/.codex/config.toml and run `codex login` again.',
    };
  }

  const profileHome = getCodexProfileHome(target.id);
  const targetAuthPath = path.join(profileHome, 'auth.json');
  const targetAuthRaw = readFileOrNull(targetAuthPath);
  const targetLegacyRaw = readFileOrNull(path.join(profileHome, '.credentials.json'));
  const targetName = target.label ?? target.email ?? target.id;

  if (!targetAuthRaw && !targetLegacyRaw) {
    return {
      success: false,
      error: `No stored credentials for "${targetName}". Remove and re-add this account.`,
    };
  }
  if (targetAuthRaw && !parseAuthJson(targetAuthRaw)) {
    return {
      success: false,
      error: `Stored credentials for "${targetName}" are corrupted. Remove and re-add this account.`,
    };
  }

  const warnings: string[] = [];
  if (probes.codexRunning) {
    warnings.push(
      'A codex process appears to be running; restart codex sessions so they pick up the switched account.',
    );
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
    (liveIdentity?.workspaceId &&
      targetWorkspaceId &&
      liveIdentity.workspaceId === targetWorkspaceId) ||
    (liveIdentity?.email && targetEmail && liveIdentity.email === targetEmail) ||
    (liveAuthRaw !== null && liveAuthRaw === targetAuthRaw) ||
    (!liveAuthRaw && !targetAuthRaw && liveLegacyRaw !== null && liveLegacyRaw === targetLegacyRaw),
  );

  if (liveMatchesTarget) {
    try {
      if (liveAuthRaw) atomicWriteFile(targetAuthPath, liveAuthRaw);
      if (liveLegacyRaw)
        atomicWriteFile(path.join(profileHome, '.credentials.json'), liveLegacyRaw);
      // File-based metadata only — see the swap-lock note above.
      const metadata = readCodexAccountMetadataFromFiles(profileHome) ?? {};
      upsertSavedAccountProfile({
        ...target,
        email: metadata.email ?? target.email,
        metadata: { ...target.metadata, ...metadata },
      });
    } catch {
      /* backup refresh is best-effort */
    }
    setActiveSavedAccount('codex', target.id);
    return { success: true, warning: warnings.length ? warnings.join(' ') : undefined };
  }

  const targetLastRefresh = readLastRefresh(targetAuthRaw, targetAuthPath);
  if (targetLastRefresh !== null && Date.now() - targetLastRefresh > STALE_AUTH_THRESHOLD_MS) {
    warnings.push(
      `Stored credentials for "${targetName}" have not been refreshed in over 8 days; codex may ask you to log in again.`,
    );
  }

  const syncBack = syncBackLiveCodexAuth(liveAuthRaw, liveLegacyRaw);
  if (syncBack.warning) warnings.push(syncBack.warning);

  const restoreLiveFiles = (): void => {
    try {
      if (liveAuthRaw) atomicWriteFile(liveAuthPath, liveAuthRaw);
      else fs.rmSync(liveAuthPath, { force: true });
      if (liveLegacyRaw) atomicWriteFile(liveLegacyPath, liveLegacyRaw);
      else fs.rmSync(liveLegacyPath, { force: true });
    } catch {
      /* rollback is best-effort */
    }
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
  const target = listCodexAccounts().find((account) => account.id === profileId);
  if (!target) {
    return { success: false, error: `Codex account ${profileId} not found.` };
  }

  return performCodexAuthSwap(target);
}

/** {@link switchToCodexAccount} without blocking the event loop on CLI probes. */
export async function switchToCodexAccountAsync(
  profileId: string,
): Promise<CodexAccountManagerResult> {
  const target = listCodexAccounts().find((account) => account.id === profileId);
  if (!target) {
    return { success: false, error: `Codex account ${profileId} not found.` };
  }

  return performCodexAuthSwapAsync(target);
}

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
    const profileIdentity = readAuthIdentityFromRaw(profileAuthRaw);
    const sameIdentity = Boolean(
      (liveIdentity?.workspaceId &&
        profileIdentity?.workspaceId &&
        liveIdentity.workspaceId === profileIdentity.workspaceId) ||
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
