import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  getAccountsDir,
  listSavedAccountProfiles,
  readSavedAccountRegistry,
  upsertSavedAccountProfile,
  type AccountProviderId,
  type SavedAccountProfile,
} from './accountRegistry';
import { atomicWriteJsonSync as atomicWriteJson } from './writers/atomic';
import {
  type AccountEntry,
  type AccountManagerResult,
  applyClaudeProfileToLiveHome,
  listAccounts,
  readActiveClaudeAccount,
  storeClaudeProfileCredentials,
  storeClaudeProfileIdentity,
  switchToAccount,
  switchToAccountAsync,
} from './accounts';
import {
  buildClaudeChildEnv,
  CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV,
  ensureClaudeProfileDirs,
  getClaudeProfileDir,
  getClaudeProfileHome,
  isClaudeProfileAuthenticated,
  readClaudeProfileIdentity,
} from './claudeProfiles';
import { readActiveCredentials } from './credentialIO';
import {
  finalizeCodexAccount,
  finalizeCodexAccountAsync,
  getCodexProfileHome,
  isCodexProfileAuthenticated,
  isCodexProfileAuthenticatedAsync,
  listCodexAccounts,
  prepareCodexAccount,
  readCodexAccountMetadata,
  readCodexAccountMetadataAsync,
  switchToCodexAccount,
  switchToCodexAccountAsync,
} from './codexProfiles';
import {
  readLastSwitch,
  switchFailure,
  type LastSwitchRecord,
  type SwitchAccountOptions,
  type SwitchAccountResult,
} from './accountSwitch';

export interface BeginAccountLoginSuccess {
  success: true;
  loginId: string;
  alreadyComplete?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Variables the host must remove from the child's environment. */
  envUnset?: string[];
  configDir?: string;
  /** Set when the login re-authenticates an existing saved profile. */
  existingAccountId?: string;
}

export interface BeginAccountLoginFailure {
  success: false;
  error: string;
}

export type BeginAccountLoginResult = BeginAccountLoginSuccess | BeginAccountLoginFailure;

export type AccountLoginState = 'pending' | 'authenticated' | 'failed';

export interface AccountLoginStatus {
  state: AccountLoginState;
  email?: string;
  error?: string;
}

export interface FinalizeAccountLoginOptions {
  activate?: boolean;
}

export interface AccountLoginCommand {
  command: string;
  args: string[];
}

export interface BeginAccountLoginOptions {
  loginCommand?: AccountLoginCommand;
  /** Sign in again to this saved profile instead of creating a new one. */
  existingAccountId?: string;
}

export interface SpawnAccountLoginOptions
  extends FinalizeAccountLoginOptions, BeginAccountLoginOptions {
  onStatus?: (status: AccountLoginStatus) => void;
  signal?: AbortSignal;
  /**
   * Inactivity budget: the login fails when the isolated home has not changed
   * for this long. Default 180 s.
   */
  timeoutMs?: number;
  /** Hard ceiling while the child is alive. Default 900 s. */
  maxTimeoutMs?: number;
  stdio?: 'inherit' | 'pipe';
}

export interface ListAllAccountsResult {
  claude: AccountEntry[];
  codex: SavedAccountProfile[];
  activeByProvider: Record<AccountProviderId, string | null>;
}

interface PendingClaudeProfile {
  label: string;
  addedAt: string;
  existingAccountId?: string;
}

function getPendingClaudeProfilePath(loginId: string): string {
  return path.join(getClaudeProfileDir(loginId), 'profile.json');
}

function readPendingClaudeProfile(loginId: string): PendingClaudeProfile | null {
  try {
    return JSON.parse(
      fs.readFileSync(getPendingClaudeProfilePath(loginId), 'utf8'),
    ) as PendingClaudeProfile;
  } catch {
    return null;
  }
}

function writePendingClaudeProfile(loginId: string, pending: PendingClaudeProfile): void {
  ensureClaudeProfileDirs(loginId);
  atomicWriteJson(getPendingClaudeProfilePath(loginId), pending);
}

function removePendingClaudeProfile(loginId: string): void {
  try {
    fs.rmSync(getPendingClaudeProfilePath(loginId), { force: true });
  } catch {
    /* best effort */
  }
}

/**
 * A fresh `CLAUDE_CONFIG_DIR` puts the CLI through first-run onboarding before
 * the login prompt. Seeding the onboarding flag keeps the isolated login on the
 * sign-in flow only; `oauthAccount` is written by the CLI itself.
 */
function seedClaudeLoginHome(home: string): void {
  const configPath = path.join(home, '.claude.json');
  if (fs.existsSync(configPath)) return;
  try {
    atomicWriteJson(configPath, { hasCompletedOnboarding: true });
  } catch {
    /* the CLI creates the file itself */
  }
}

function readClaudeOauthAccount(home: string): unknown | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    return raw?.oauthAccount ?? null;
  } catch {
    return null;
  }
}

function copyClaudeProfileToCanonicalHome(
  sourceHome: string,
  accountUuid: string,
  credentials: unknown,
  oauthAccount: unknown,
): void {
  const canonicalHome = getClaudeProfileHome(accountUuid);
  fs.mkdirSync(canonicalHome, { recursive: true, mode: 0o700 });

  if (path.resolve(sourceHome) !== path.resolve(canonicalHome)) {
    try {
      fs.cpSync(sourceHome, canonicalHome, { recursive: true, force: true });
    } catch {
      // The credential and identity files are re-written below when possible.
    }
  }

  storeClaudeProfileIdentity(accountUuid, oauthAccount);
  storeClaudeProfileCredentials(accountUuid, credentials, 'login');
}

function parseClaudeLoginArgs(raw: string | undefined): string[] | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.split(/\s+/) : null;
}

/**
 * `claude auth login` signs in without the interactive first-run flow the bare
 * `claude /login` form triggers in a fresh config directory. Override with
 * `SIDEKICK_CLAUDE_LOGIN_ARGS` (space separated) for older CLIs.
 */
export function resolveClaudeLoginCommand(
  opts: { loginCommand?: AccountLoginCommand } = {},
): AccountLoginCommand {
  if (opts.loginCommand) return opts.loginCommand;
  return {
    command: 'claude',
    args: parseClaudeLoginArgs(process.env.SIDEKICK_CLAUDE_LOGIN_ARGS) ?? ['auth', 'login'],
  };
}

export function beginAccountLogin(
  provider: AccountProviderId,
  label: string,
  opts: BeginAccountLoginOptions = {},
): BeginAccountLoginResult {
  if (provider === 'codex') {
    const existing = opts.existingAccountId
      ? listCodexAccounts().find((account) => account.id === opts.existingAccountId)
      : undefined;
    if (opts.existingAccountId && !existing) {
      return { success: false, error: `Codex account ${opts.existingAccountId} not found.` };
    }
    // A re-login uses a throwaway label: finalize folds the fresh credentials
    // into the existing profile by identity and keeps its label.
    const effectiveLabel = existing
      ? `${existing.label ?? existing.email ?? 'codex'} (re-login ${randomUUID().slice(0, 8)})`
      : label.trim() || `Codex ${listCodexAccounts().length + 1}`;
    const prepared = prepareCodexAccount(effectiveLabel);
    if (!prepared.success || !prepared.profileId || !prepared.codexHome) {
      return { success: false, error: prepared.error ?? 'Could not prepare Codex account login.' };
    }

    if (prepared.needsLogin === false) {
      return {
        success: true,
        loginId: prepared.profileId,
        alreadyComplete: true,
        configDir: prepared.codexHome,
        existingAccountId: existing?.id,
      };
    }

    const loginCommand = opts.loginCommand ?? { command: 'codex', args: ['login'] };
    return {
      success: true,
      loginId: prepared.profileId,
      command: loginCommand.command,
      args: loginCommand.args,
      env: { CODEX_HOME: prepared.codexHome },
      configDir: prepared.codexHome,
      existingAccountId: existing?.id,
    };
  }

  const existing = opts.existingAccountId
    ? listSavedAccountProfiles('claude-code').find(
        (account) => account.id === opts.existingAccountId,
      )
    : undefined;
  if (opts.existingAccountId && !existing) {
    return { success: false, error: `Claude account ${opts.existingAccountId} not found.` };
  }

  const loginId = randomUUID();
  const home = getClaudeProfileHome(loginId);
  writePendingClaudeProfile(loginId, {
    label: existing?.label ?? label.trim(),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    existingAccountId: existing?.id,
  });
  seedClaudeLoginHome(home);
  const loginCommand = resolveClaudeLoginCommand(opts);

  return {
    success: true,
    loginId,
    command: loginCommand.command,
    args: loginCommand.args,
    env: { CLAUDE_CONFIG_DIR: home },
    envUnset: [CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV],
    configDir: home,
    existingAccountId: existing?.id,
  };
}

function getClaudeAccountLoginStatus(loginId: string): AccountLoginStatus {
  const home = getClaudeProfileHome(loginId);
  const identity = readClaudeProfileIdentity(home);
  return isClaudeProfileAuthenticated(home)
    ? { state: 'authenticated', email: identity?.email }
    : { state: 'pending' };
}

export function getAccountLoginStatus(
  provider: AccountProviderId,
  loginId: string,
): AccountLoginStatus {
  if (provider === 'codex') {
    const codexHome = getCodexProfileHome(loginId);
    if (!isCodexProfileAuthenticated(codexHome)) {
      return { state: 'pending' };
    }

    const metadata = readCodexAccountMetadata(codexHome);
    return {
      state: 'authenticated',
      email: metadata.email,
    };
  }

  return getClaudeAccountLoginStatus(loginId);
}

/**
 * {@link getAccountLoginStatus} without blocking the event loop on the codex
 * CLI probe. The sync variant blocks up to 4s per call while a codex login is
 * pending — ruinous for callers that poll it on an interval.
 */
export async function getAccountLoginStatusAsync(
  provider: AccountProviderId,
  loginId: string,
): Promise<AccountLoginStatus> {
  if (provider === 'codex') {
    const codexHome = getCodexProfileHome(loginId);
    if (!(await isCodexProfileAuthenticatedAsync(codexHome))) {
      return { state: 'pending' };
    }

    const metadata = await readCodexAccountMetadataAsync(codexHome);
    return {
      state: 'authenticated',
      email: metadata.email,
    };
  }

  return getClaudeAccountLoginStatus(loginId);
}

export function finalizeAccountLogin(
  provider: AccountProviderId,
  loginId: string,
  opts: FinalizeAccountLoginOptions = {},
): AccountManagerResult {
  if (provider === 'codex') {
    return finalizeCodexAccount(loginId, opts);
  }

  return finalizeClaudeAccountLogin(loginId, opts);
}

/** {@link finalizeAccountLogin} without blocking the event loop on CLI probes. */
export async function finalizeAccountLoginAsync(
  provider: AccountProviderId,
  loginId: string,
  opts: FinalizeAccountLoginOptions = {},
): Promise<AccountManagerResult> {
  if (provider === 'codex') {
    return finalizeCodexAccountAsync(loginId, opts);
  }

  return finalizeClaudeAccountLogin(loginId, opts);
}

function finalizeClaudeAccountLogin(
  loginId: string,
  opts: FinalizeAccountLoginOptions = {},
): AccountManagerResult {
  const home = getClaudeProfileHome(loginId);
  const identity = readClaudeProfileIdentity(home);
  if (!identity) {
    return { success: false, error: 'Claude profile is not authenticated yet.' };
  }

  const credentials = readActiveCredentials(home);
  if (!credentials) {
    return { success: false, error: 'Could not read Claude profile credentials.' };
  }

  const oauthAccount = readClaudeOauthAccount(home);
  if (!oauthAccount) {
    return { success: false, error: 'Could not read Claude profile config.' };
  }

  const pending = readPendingClaudeProfile(loginId);
  const existing = listSavedAccountProfiles('claude-code').find(
    (account) => (account.providerAccountId ?? account.id) === identity.uuid,
  );
  copyClaudeProfileToCanonicalHome(home, identity.uuid, credentials, oauthAccount);

  const warnings: string[] = [];
  if (pending?.existingAccountId && pending.existingAccountId !== identity.uuid) {
    warnings.push(
      `You signed in as ${identity.email}, which is a different account from the one you chose to re-authenticate; it was saved separately.`,
    );
  }

  upsertSavedAccountProfile({
    id: existing?.id ?? identity.uuid,
    providerId: 'claude-code',
    providerAccountId: identity.uuid,
    email: identity.email,
    label: existing?.label ?? (pending?.label || identity.email),
    addedAt: existing?.addedAt ?? pending?.addedAt ?? new Date().toISOString(),
    metadata: {
      ...existing?.metadata,
      email: identity.email,
      origin: 'login',
    },
  });

  removePendingClaudeProfile(loginId);
  if (loginId !== identity.uuid) {
    removePendingClaudeProfile(identity.uuid);
    try {
      fs.rmSync(getClaudeProfileDir(loginId), { recursive: true, force: true });
    } catch {
      /* the temporary login home is disposable */
    }
  }

  if (opts.activate === false) {
    return { success: true, warning: warnings.length ? warnings.join(' ') : undefined };
  }

  if (readActiveClaudeAccount()?.uuid === identity.uuid) {
    // Re-login of the account that is already live: the new token replaces
    // the live one (which may be the dead credential that prompted the login).
    const applied = applyClaudeProfileToLiveHome(identity.uuid);
    if (!applied.success) return applied;
  }

  const switched = switchToAccount(identity.uuid);
  return warnings.length
    ? { ...switched, warning: [switched.warning, ...warnings].filter(Boolean).join(' ') }
    : switched;
}

function emitStatus(
  opts: SpawnAccountLoginOptions,
  status: AccountLoginStatus,
): AccountLoginStatus {
  opts.onStatus?.(status);
  return status;
}

function waitForNextPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Most recent modification inside an isolated login home (the CLI writes as the user progresses). */
function latestHomeActivity(home: string | undefined): number {
  if (!home) return 0;
  let latest = 0;
  const candidates = [
    home,
    ...['.claude.json', '.credentials.json', 'auth.json', 'config.toml'].map((f) =>
      path.join(home, f),
    ),
  ];
  for (const candidate of candidates) {
    try {
      latest = Math.max(latest, fs.statSync(candidate).mtimeMs);
    } catch {
      /* absent */
    }
  }
  return latest;
}

function discardPendingLogin(provider: AccountProviderId, loginId: string): void {
  try {
    const dir =
      provider === 'codex'
        ? path.dirname(getCodexProfileHome(loginId))
        : getClaudeProfileDir(loginId);
    if (dir.startsWith(getAccountsDir())) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export async function spawnAccountLogin(
  provider: AccountProviderId,
  label: string,
  opts: SpawnAccountLoginOptions = {},
): Promise<AccountManagerResult> {
  if (opts.signal?.aborted) {
    return { success: false, error: 'Account login aborted.' };
  }

  const begin = beginAccountLogin(provider, label, {
    loginCommand: opts.loginCommand,
    existingAccountId: opts.existingAccountId,
  });
  if (!begin.success) return { success: false, error: begin.error };

  if (begin.alreadyComplete) {
    return finalizeAccountLoginAsync(provider, begin.loginId, { activate: opts.activate ?? true });
  }

  if (!begin.command) {
    return { success: false, error: 'Account login command was not prepared.' };
  }

  let childExited = false;
  let childExitCode: number | null = null;
  const childState: { spawnError?: Error } = {};
  const inactivityMs = opts.timeoutMs ?? 180_000;
  const maxMs = opts.maxTimeoutMs ?? 900_000;
  const startedAt = Date.now();
  let lastActivity = startedAt;
  let lastSeenMtime = latestHomeActivity(begin.configDir);

  const env: NodeJS.ProcessEnv =
    provider === 'codex'
      ? { ...process.env, ...(begin.env ?? {}) }
      : buildClaudeChildEnv(begin.configDir ?? '', process.env);
  for (const name of begin.envUnset ?? []) delete env[name];

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(begin.command, begin.args ?? [], {
      env,
      stdio: opts.stdio ?? 'inherit',
    });
  } catch (err) {
    discardPendingLogin(provider, begin.loginId);
    return { success: false, error: `Could not spawn account login: ${err}` };
  }

  child.on('exit', (code) => {
    childExited = true;
    childExitCode = code;
  });
  child.on('error', (error) => {
    childExited = true;
    childState.spawnError = error;
  });

  const abort = (): AccountManagerResult => {
    child.kill();
    discardPendingLogin(provider, begin.loginId);
    emitStatus(opts, { state: 'failed', error: 'Account login aborted.' });
    return { success: false, error: 'Account login aborted.' };
  };

  while (true) {
    if (opts.signal?.aborted) return abort();

    const status = emitStatus(opts, await getAccountLoginStatusAsync(provider, begin.loginId));
    if (status.state === 'authenticated') {
      return finalizeAccountLoginAsync(provider, begin.loginId, {
        activate: opts.activate ?? true,
      });
    }

    if (childExited) {
      if (childState.spawnError) {
        const error = `Could not spawn account login: ${childState.spawnError.message}`;
        discardPendingLogin(provider, begin.loginId);
        emitStatus(opts, { state: 'failed', error });
        return { success: false, error };
      }
      const finalStatus = emitStatus(
        opts,
        await getAccountLoginStatusAsync(provider, begin.loginId),
      );
      if (finalStatus.state === 'authenticated') {
        return finalizeAccountLoginAsync(provider, begin.loginId, {
          activate: opts.activate ?? true,
        });
      }
      discardPendingLogin(provider, begin.loginId);
      emitStatus(opts, {
        state: 'failed',
        error: `Account login exited before authentication completed${childExitCode === null ? '.' : ` (exit ${childExitCode}).`}`,
      });
      return { success: false, error: 'Account login did not complete.' };
    }

    const now = Date.now();
    const mtime = latestHomeActivity(begin.configDir);
    if (mtime > lastSeenMtime) {
      lastSeenMtime = mtime;
      lastActivity = now;
    }
    const remainingMs = Math.min(inactivityMs - (now - lastActivity), maxMs - (now - startedAt));
    if (remainingMs <= 0) {
      child.kill();
      discardPendingLogin(provider, begin.loginId);
      emitStatus(opts, { state: 'failed', error: 'Account login timed out.' });
      return { success: false, error: 'Account login timed out.' };
    }

    const shouldContinue = await waitForNextPoll(Math.min(2_000, remainingMs), opts.signal);
    if (!shouldContinue) return abort();
  }
}

export function switchAccount(
  provider: AccountProviderId,
  id: string,
  options: SwitchAccountOptions = {},
): SwitchAccountResult {
  return provider === 'codex' ? switchToCodexAccount(id, options) : switchToAccount(id, options);
}

/**
 * {@link switchAccount} without blocking the event loop on CLI/process probes.
 * The Claude path still performs bounded synchronous keychain reads on macOS.
 */
export async function switchAccountAsync(
  provider: AccountProviderId,
  id: string,
  options: SwitchAccountOptions = {},
): Promise<SwitchAccountResult> {
  return provider === 'codex'
    ? switchToCodexAccountAsync(id, options)
    : switchToAccountAsync(id, options);
}

export function getLastSwitch(provider: AccountProviderId): LastSwitchRecord | null {
  return readLastSwitch(provider);
}

/**
 * Switch back to the account that was live before the last recorded switch.
 * With `token`, the record must match (a stale Undo button never reverts a
 * newer switch).
 */
export async function undoLastSwitch(
  provider: AccountProviderId,
  token?: string,
): Promise<SwitchAccountResult> {
  const record = readLastSwitch(provider);
  if (!record) {
    return switchFailure(provider, '', 'There is no account switch to undo.');
  }
  if (token && token !== record.token) {
    return switchFailure(
      provider,
      record.from ?? '',
      'A newer account switch has happened since; nothing was undone.',
    );
  }
  if (!record.from) {
    return switchFailure(provider, '', 'The previous state had no saved account to return to.');
  }
  return switchAccountAsync(provider, record.from);
}

export function listAllAccounts(): ListAllAccountsResult {
  return {
    claude: listAccounts(),
    codex: listCodexAccounts(),
    activeByProvider: readSavedAccountRegistry()?.activeByProvider ?? {
      'claude-code': null,
      codex: null,
    },
  };
}
