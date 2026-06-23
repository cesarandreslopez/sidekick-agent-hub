import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  getAccountsDir,
  readSavedAccountRegistry,
  upsertSavedAccountProfile,
  type AccountProviderId,
  type SavedAccountProfile,
} from './accountRegistry';
import {
  type AccountEntry,
  type AccountManagerResult,
  listAccounts,
  switchToAccount,
} from './accounts';
import {
  ensureClaudeProfileDirs,
  getClaudeProfileHome,
  isClaudeProfileAuthenticated,
  readClaudeProfileIdentity,
} from './claudeProfiles';
import { readActiveCredentials, writeActiveCredentials } from './credentialIO';
import {
  finalizeCodexAccount,
  getCodexProfileHome,
  isCodexProfileAuthenticated,
  listCodexAccounts,
  prepareCodexAccount,
  readCodexAccountMetadata,
  switchToCodexAccount,
} from './codexProfiles';

export interface BeginAccountLoginSuccess {
  success: true;
  loginId: string;
  alreadyComplete?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  configDir?: string;
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

export interface SpawnAccountLoginOptions extends FinalizeAccountLoginOptions {
  onStatus?: (status: AccountLoginStatus) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  stdio?: 'inherit' | 'pipe';
  loginCommand?: AccountLoginCommand;
}

export interface ListAllAccountsResult {
  claude: AccountEntry[];
  codex: SavedAccountProfile[];
  activeByProvider: Record<AccountProviderId, string | null>;
}

interface PendingClaudeProfile {
  label: string;
  addedAt: string;
}

function getClaudeProfileDir(loginId: string): string {
  return path.dirname(getClaudeProfileHome(loginId));
}

function getPendingClaudeProfilePath(loginId: string): string {
  return path.join(getClaudeProfileDir(loginId), 'profile.json');
}

function atomicWriteJson(filePath: string, data: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  JSON.parse(json);
  try {
    fs.writeFileSync(tmp, json, { encoding: 'utf8', mode });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw err;
  }
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

function getClaudeCredentialsBackupPath(uuid: string): string {
  return path.join(getAccountsDir(), 'credentials', `${uuid}.credentials.json`);
}

function getClaudeConfigBackupPath(uuid: string): string {
  return path.join(getAccountsDir(), 'configs', `${uuid}.config.json`);
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

  const sourceConfig = path.join(sourceHome, '.claude.json');
  if (fs.existsSync(sourceConfig)) {
    fs.copyFileSync(sourceConfig, path.join(canonicalHome, '.claude.json'));
  }
  writeActiveCredentials(credentials, canonicalHome);
}

function parseClaudeLoginArgs(raw: string | undefined): string[] | null {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.split(/\s+/) : null;
}

export function resolveClaudeLoginCommand(
  opts: { loginCommand?: AccountLoginCommand } = {},
): AccountLoginCommand {
  if (opts.loginCommand) return opts.loginCommand;
  return {
    command: 'claude',
    args: parseClaudeLoginArgs(process.env.SIDEKICK_CLAUDE_LOGIN_ARGS) ?? ['/login'],
  };
}

export function beginAccountLogin(
  provider: AccountProviderId,
  label: string,
  opts: { loginCommand?: AccountLoginCommand } = {},
): BeginAccountLoginResult {
  if (provider === 'codex') {
    const prepared = prepareCodexAccount(label);
    if (!prepared.success || !prepared.profileId || !prepared.codexHome) {
      return { success: false, error: prepared.error ?? 'Could not prepare Codex account login.' };
    }

    if (prepared.needsLogin === false) {
      return {
        success: true,
        loginId: prepared.profileId,
        alreadyComplete: true,
        configDir: prepared.codexHome,
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
    };
  }

  const trimmedLabel = label.trim();
  if (!trimmedLabel) {
    return { success: false, error: 'Claude accounts require a non-empty label.' };
  }

  const loginId = randomUUID();
  const home = getClaudeProfileHome(loginId);
  writePendingClaudeProfile(loginId, {
    label: trimmedLabel,
    addedAt: new Date().toISOString(),
  });
  const loginCommand = resolveClaudeLoginCommand(opts);

  return {
    success: true,
    loginId,
    command: loginCommand.command,
    args: loginCommand.args,
    env: { CLAUDE_CONFIG_DIR: home },
    configDir: home,
  };
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

  const home = getClaudeProfileHome(loginId);
  const identity = readClaudeProfileIdentity(home);
  return isClaudeProfileAuthenticated(home)
    ? { state: 'authenticated', email: identity?.email }
    : { state: 'pending' };
}

export function finalizeAccountLogin(
  provider: AccountProviderId,
  loginId: string,
  opts: FinalizeAccountLoginOptions = {},
): AccountManagerResult {
  if (provider === 'codex') {
    return finalizeCodexAccount(loginId, opts);
  }

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
  atomicWriteJson(getClaudeCredentialsBackupPath(identity.uuid), credentials);
  atomicWriteJson(getClaudeConfigBackupPath(identity.uuid), oauthAccount);
  copyClaudeProfileToCanonicalHome(home, identity.uuid, credentials);

  upsertSavedAccountProfile({
    id: identity.uuid,
    providerId: 'claude-code',
    providerAccountId: identity.uuid,
    email: identity.email,
    label: pending?.label,
    addedAt: pending?.addedAt ?? new Date().toISOString(),
    metadata: {
      email: identity.email,
    },
  });

  removePendingClaudeProfile(loginId);
  if (loginId !== identity.uuid) {
    removePendingClaudeProfile(identity.uuid);
  }

  if (opts.activate === false) {
    return { success: true };
  }

  return switchToAccount(identity.uuid);
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

export async function spawnAccountLogin(
  provider: AccountProviderId,
  label: string,
  opts: SpawnAccountLoginOptions = {},
): Promise<AccountManagerResult> {
  if (opts.signal?.aborted) {
    return { success: false, error: 'Account login aborted.' };
  }

  const begin = beginAccountLogin(provider, label, { loginCommand: opts.loginCommand });
  if (!begin.success) return { success: false, error: begin.error };

  if (begin.alreadyComplete) {
    return finalizeAccountLogin(provider, begin.loginId, { activate: opts.activate ?? true });
  }

  if (!begin.command) {
    return { success: false, error: 'Account login command was not prepared.' };
  }

  let childExited = false;
  let childExitCode: number | null = null;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(begin.command, begin.args ?? [], {
      env: { ...process.env, ...(begin.env ?? {}) },
      stdio: opts.stdio ?? 'inherit',
    });
  } catch (err) {
    return { success: false, error: `Could not spawn account login: ${err}` };
  }

  child.on('exit', (code) => {
    childExited = true;
    childExitCode = code;
  });

  while (true) {
    if (opts.signal?.aborted) {
      child.kill();
      emitStatus(opts, { state: 'failed', error: 'Account login aborted.' });
      return { success: false, error: 'Account login aborted.' };
    }

    const status = emitStatus(opts, getAccountLoginStatus(provider, begin.loginId));
    if (status.state === 'authenticated') {
      return finalizeAccountLogin(provider, begin.loginId, { activate: opts.activate ?? true });
    }

    if (childExited) {
      const finalStatus = emitStatus(opts, getAccountLoginStatus(provider, begin.loginId));
      if (finalStatus.state === 'authenticated') {
        return finalizeAccountLogin(provider, begin.loginId, { activate: opts.activate ?? true });
      }
      emitStatus(opts, {
        state: 'failed',
        error: `Account login exited before authentication completed${childExitCode === null ? '.' : ` (exit ${childExitCode}).`}`,
      });
      return { success: false, error: 'Account login did not complete.' };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      emitStatus(opts, { state: 'failed', error: 'Account login timed out.' });
      return { success: false, error: 'Account login timed out.' };
    }

    const shouldContinue = await waitForNextPoll(Math.min(2_000, remainingMs), opts.signal);
    if (!shouldContinue) {
      child.kill();
      emitStatus(opts, { state: 'failed', error: 'Account login aborted.' });
      return { success: false, error: 'Account login aborted.' };
    }
  }
}

export function switchAccount(provider: AccountProviderId, id: string): AccountManagerResult {
  return provider === 'codex' ? switchToCodexAccount(id) : switchToAccount(id);
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
