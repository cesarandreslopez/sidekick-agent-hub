/**
 * Environment for running a provider CLI against a saved profile without
 * touching the live home: two accounts can run side by side, each with its
 * own refresh-token chain.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AccountProviderId } from './accountRegistry';
import { listSavedAccountProfiles } from './accountRegistry';
import { getAccountHealth, type AccountHealth } from './accountHealth';
import {
  CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV,
  getClaudeProfileHome,
  getLiveClaudeHome,
} from './claudeProfiles';
import {
  forceFileCredentialStore,
  getCodexProfileHome,
  getSystemCodexHome,
  readFileOrNull,
} from './codexPaths';
import { atomicWriteFileSync, atomicWriteJsonSync } from './writers/atomic';

export interface AccountLaunchEnv {
  provider: AccountProviderId;
  accountId: string;
  label?: string;
  email?: string;
  /** The isolated home the CLI will use. */
  home: string;
  /** Variables to set on the child. */
  env: Record<string, string>;
  /** Variables the host must remove from the child's environment. */
  envUnset: string[];
  command: 'claude' | 'codex';
  health: AccountHealth;
  warnings: string[];
  /** Set when the account cannot be launched (expired or missing credentials). */
  error?: string;
}

export interface AccountLaunchOptions {
  /**
   * Copy the live `settings.json` / `config.toml` into the profile home once
   * so the isolated session behaves like the live one (default true). Never
   * touches credentials or `oauthAccount`.
   */
  materialize?: boolean;
  /** Launch even when the stored credential is reported expired. */
  force?: boolean;
}

function materializeClaudeHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const liveHome = getLiveClaudeHome();
  const settingsTarget = path.join(home, 'settings.json');
  if (!fs.existsSync(settingsTarget)) {
    const settings = readFileOrNull(path.join(liveHome, 'settings.json'));
    if (settings) atomicWriteFileSync(settingsTarget, settings);
  }
  const configPath = path.join(home, '.claude.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* fresh */
  }
  if (config.hasCompletedOnboarding !== true) {
    atomicWriteJsonSync(configPath, { ...config, hasCompletedOnboarding: true });
  }
}

function materializeCodexHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const configTarget = path.join(home, 'config.toml');
  if (!fs.existsSync(configTarget)) {
    const source = readFileOrNull(path.join(getSystemCodexHome(), 'config.toml')) ?? '';
    atomicWriteFileSync(configTarget, forceFileCredentialStore(source));
  }
}

export function getAccountLaunchEnv(
  provider: AccountProviderId,
  accountId: string,
  options: AccountLaunchOptions = {},
): AccountLaunchEnv {
  const profile = listSavedAccountProfiles(provider).find((p) => p.id === accountId);
  const command = provider === 'codex' ? 'codex' : 'claude';
  const home =
    provider === 'codex'
      ? getCodexProfileHome(accountId)
      : getClaudeProfileHome(profile?.providerAccountId ?? accountId);
  const health = getAccountHealth(provider, accountId);
  const warnings: string[] = [];
  const base: AccountLaunchEnv = {
    provider,
    accountId,
    label: profile?.label,
    email: profile?.email ?? profile?.metadata?.email,
    home,
    env: provider === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home },
    envUnset: provider === 'codex' ? [] : [CLAUDE_SECURESTORAGE_CONFIG_DIR_ENV],
    command,
    health,
    warnings,
  };
  if (!profile) {
    return { ...base, error: `${provider} account ${accountId} not found.` };
  }
  if ((health.state === 'expired' || health.state === 'missing') && !options.force) {
    return {
      ...base,
      error: `Stored credentials for "${profile.label ?? profile.email ?? accountId}" have ${health.state === 'missing' ? 'not been saved' : 'expired'}; sign in again before launching.`,
    };
  }
  if (health.isLive) {
    warnings.push(
      'This account is also the live login. Two sessions refreshing the same login can invalidate each other; prefer switching instead.',
    );
  }
  if (health.state === 'expiring' && health.reason) warnings.push(health.reason);
  if (options.materialize !== false) {
    try {
      if (provider === 'codex') materializeCodexHome(home);
      else materializeClaudeHome(home);
    } catch (err) {
      warnings.push(`Could not prepare the isolated home: ${err}`);
    }
  }
  return base;
}
