/**
 * `sidekick account` — Manage saved Claude and Codex accounts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  getConfigDir,
  listAccounts,
  getActiveAccount,
  addCurrentAccount,
  switchToAccount,
  removeAccount,
  readActiveClaudeAccount,
  listCodexAccounts,
  getActiveCodexAccount,
  prepareCodexAccount,
  switchToCodexAccount,
  removeCodexAccount,
  spawnAccountLogin,
  listAllAccounts,
  writeLauncher,
  getClaudeProfileHome,
  getCodexProfileHome,
  DEFAULT_AUTO_SWITCH_CONFIG,
} from 'sidekick-shared';
import type { AccountManagerResult, AccountProviderId, AutoSwitchConfig, SavedAccountProfile } from 'sidekick-shared';
import { resolveProviderId } from '../cli';

interface AccountCommandOptions {
  provider?: string;
  add?: boolean;
  label?: string;
  switch?: boolean;
  switchTo?: string;
  remove?: string;
  login?: boolean;
  launcher?: string;
  autoSwitch?: string;
}

export async function accountAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;
  const opts = cmd.opts() as AccountCommandOptions;

  if (opts.autoSwitch !== undefined) {
    configureAutoSwitch(opts.autoSwitch, jsonOutput);
    return;
  }

  if (opts.provider?.trim().toLowerCase() === 'all') {
    listAllProviderAccounts(jsonOutput);
    return;
  }

  const providerId = resolveProviderId(
    opts.provider ? { provider: opts.provider } : globalOpts,
    'claude-code',
  );

  if (providerId === 'opencode') {
    process.stderr.write(chalk.yellow('OpenCode account management is not supported.\n'));
    process.exit(1);
    return;
  }

  if (providerId === 'codex') {
    await codexAccountAction(opts, jsonOutput);
    return;
  }

  await claudeAccountAction(opts, jsonOutput);
}

function autoSwitchConfigPath(): string {
  return path.join(getConfigDir(), 'cli-config.json');
}

function readCliConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(autoSwitchConfigPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeCliConfig(config: Record<string, unknown>): void {
  const filePath = autoSwitchConfigPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function parseAutoSwitchConfig(value: string): AutoSwitchConfig {
  if (value.trim().toLowerCase() === 'off') {
    return { ...DEFAULT_AUTO_SWITCH_CONFIG, enabled: false };
  }
  const thresholdPct = Number(value);
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || thresholdPct > 100) {
    throw new Error('Use --auto-switch off or a percentage between 1 and 100.');
  }
  return { enabled: true, thresholdPct };
}

function configureAutoSwitch(value: string, jsonOutput: boolean): void {
  try {
    const autoSwitch = parseAutoSwitchConfig(value);
    const config = readCliConfig();
    writeCliConfig({
      ...config,
      accounts: {
        ...((config.accounts as Record<string, unknown> | undefined) ?? {}),
        autoSwitch,
      },
    });
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'auto-switch', autoSwitch }) + '\n');
    } else {
      process.stdout.write(autoSwitch.enabled
        ? chalk.green(`Auto-switch threshold set to ${autoSwitch.thresholdPct}%.\n`)
        : chalk.green('Auto-switch disabled.\n'));
      process.stdout.write(chalk.dim('Continuous auto-switch runs in a long-running host such as VS Code.\n'));
    }
  } catch (error) {
    process.stderr.write(chalk.red(error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(1);
  }
}

function listAllProviderAccounts(jsonOutput: boolean): void {
  const accounts = listAllAccounts();
  if (jsonOutput) {
    process.stdout.write(JSON.stringify(accounts, null, 2) + '\n');
    return;
  }

  process.stdout.write(chalk.bold('Claude Accounts\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  for (const account of accounts.claude) {
    const isActive = account.uuid === accounts.activeByProvider['claude-code'];
    const marker = isActive ? chalk.green('  * ') : '    ';
    const label = account.label ? chalk.dim(` (${account.label})`) : '';
    process.stdout.write(`${marker}${account.email}${label}\n`);
  }
  process.stdout.write('\n' + chalk.bold('Codex Accounts\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  for (const account of accounts.codex) {
    const isActive = account.id === accounts.activeByProvider.codex;
    const marker = isActive ? chalk.green('  * ') : '    ';
    const details = [account.email, account.metadata?.planType].filter(Boolean).join(' · ');
    process.stdout.write(`${marker}${account.label ?? account.id}${details ? chalk.dim(` (${details})`) : ''}\n`);
  }
}

function printLoginResult(provider: AccountProviderId, result: AccountManagerResult, opts: AccountCommandOptions, jsonOutput: boolean): void {
  if (!result.success) {
    process.stderr.write(chalk.red(result.error ?? 'Account login failed.') + '\n');
    process.exit(1);
    return;
  }

  const active = provider === 'codex' ? getActiveCodexAccount() : getActiveAccount();
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({
      action: 'login',
      provider,
      success: true,
      account: active ?? null,
      warning: result.warning ?? null,
    }) + '\n');
    return;
  }

  if (result.warning) process.stderr.write(chalk.yellow(result.warning) + '\n');
  const display = provider === 'codex'
    ? (active && 'id' in active ? formatCodexAccount(active as SavedAccountProfile) : opts.label)
    : (active && 'email' in active ? `${active.email}${active.label ? ` (${active.label})` : ''}` : opts.label);
  process.stdout.write(chalk.green('Account saved: ') + (display ?? 'unknown') + '\n');
}

async function handleLogin(provider: AccountProviderId, opts: AccountCommandOptions, jsonOutput: boolean): Promise<void> {
  if (!opts.label?.trim()) {
    process.stderr.write(chalk.red('Account login requires `--label`.\n'));
    process.exit(1);
    return;
  }
  const result = await spawnAccountLogin(provider, opts.label, { stdio: 'inherit' });
  printLoginResult(provider, result, opts, jsonOutput);
}

function createLauncher(provider: AccountProviderId, opts: AccountCommandOptions, jsonOutput: boolean): void {
  const name = opts.launcher!;
  const active = provider === 'codex' ? getActiveCodexAccount() : getActiveAccount();
  if (!active) {
    process.stderr.write(chalk.red('No active account found for launcher creation.\n'));
    process.exit(1);
    return;
  }

  const profileHome = provider === 'codex'
    ? getCodexProfileHome((active as SavedAccountProfile).id)
    : getClaudeProfileHome((active as ReturnType<typeof getActiveAccount>)!.uuid);

  try {
    writeLauncher(name, provider, profileHome);
  } catch (error) {
    process.stderr.write(chalk.red(error instanceof Error ? error.message : String(error)) + '\n');
    process.exit(1);
    return;
  }

  const launcherPath = path.join(os.homedir(), '.local', 'bin', name);
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ action: 'launcher', provider, name, path: launcherPath, profileHome }) + '\n');
  } else {
    process.stdout.write(chalk.green('Launcher created: ') + launcherPath + '\n');
    process.stdout.write(chalk.dim(`Open a new terminal or run \`${name}\` directly.\n`));
  }
}

async function claudeAccountAction(opts: AccountCommandOptions, jsonOutput: boolean): Promise<void> {
  if (opts.login) {
    await handleLogin('claude-code', opts, jsonOutput);
    return;
  }

  if (opts.launcher) {
    createLauncher('claude-code', opts, jsonOutput);
    return;
  }

  if (opts.add) {
    const result = addCurrentAccount(opts.label);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to save account.') + '\n');
      process.exit(1);
      return;
    }

    const active = readActiveClaudeAccount();
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'added', provider: 'claude-code', email: active?.email, label: opts.label }) + '\n');
    } else {
      process.stdout.write(chalk.green('Account saved: ') + (active?.email ?? 'unknown') +
        (opts.label ? chalk.dim(` (${opts.label})`) : '') + '\n');
    }
    return;
  }

  if (opts.remove) {
    const accounts = listAccounts();
    const target = findClaudeAccount(opts.remove, accounts);
    if (!target) {
      process.stderr.write(chalk.red(`Account "${opts.remove}" not found.`) + '\n');
      process.exit(1);
      return;
    }

    const result = removeAccount(target.uuid);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to remove account.') + '\n');
      process.exit(1);
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'removed', provider: 'claude-code', email: target.email }) + '\n');
    } else {
      process.stdout.write(chalk.green('Removed: ') + target.email + '\n');
    }
    return;
  }

  if (opts.switchTo) {
    const accounts = listAccounts();
    const target = findClaudeAccount(opts.switchTo!, accounts);
    if (!target) {
      process.stderr.write(chalk.red(`Account "${opts.switchTo}" not found.`) + '\n');
      process.exit(1);
      return;
    }

    const result = switchToAccount(target.uuid);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to switch.') + '\n');
      process.exit(1);
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', provider: 'claude-code', email: target.email }) + '\n');
    } else {
      process.stdout.write(chalk.green('Switched to: ') + target.email +
        (target.label ? chalk.dim(` (${target.label})`) : '') + '\n');
    }
    return;
  }

  if (opts.switch) {
    const accounts = listAccounts();
    if (accounts.length < 2) {
      process.stderr.write(chalk.yellow('Need at least 2 saved accounts to switch.') + '\n');
      process.exit(1);
      return;
    }

    const active = getActiveAccount();
    const currentIdx = active ? accounts.findIndex(a => a.uuid === active.uuid) : -1;
    const nextIdx = (currentIdx + 1) % accounts.length;
    const target = accounts[nextIdx];
    const result = switchToAccount(target.uuid);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to switch.') + '\n');
      process.exit(1);
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', provider: 'claude-code', email: target.email }) + '\n');
    } else {
      process.stdout.write(chalk.green('Switched to: ') + target.email +
        (target.label ? chalk.dim(` (${target.label})`) : '') + '\n');
    }
    return;
  }

  const accounts = listAccounts();
  if (accounts.length === 0) {
    const current = readActiveClaudeAccount();
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ provider: 'claude-code', accounts: [], current: current ?? null }) + '\n');
    } else if (current) {
      process.stdout.write(chalk.dim('No saved accounts. Currently signed in as: ') + current.email + '\n');
      process.stdout.write(chalk.dim('Run `sidekick account --add` to save this account.\n'));
    } else {
      process.stdout.write(chalk.dim('No saved accounts. Sign in with `claude` first.\n'));
    }
    return;
  }

  if (jsonOutput) {
    const active = getActiveAccount();
    process.stdout.write(JSON.stringify({
      provider: 'claude-code',
      accounts: accounts.map(a => ({ ...a, active: a.uuid === active?.uuid })),
    }, null, 2) + '\n');
    return;
  }

  const active = getActiveAccount();
  process.stdout.write(chalk.bold('Claude Accounts\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  for (const account of accounts) {
    const isActive = account.uuid === active?.uuid;
    const marker = isActive ? chalk.green('  * ') : '    ';
    const label = account.label ? chalk.dim(` (${account.label})`) : '';
    process.stdout.write(`${marker}${account.email}${label}\n`);
  }
}

function findClaudeAccount(identifier: string, accounts: ReturnType<typeof listAccounts>): ReturnType<typeof listAccounts>[number] | undefined {
  const normalized = identifier.trim().toLowerCase();
  return accounts.find(a =>
    a.uuid === identifier ||
    a.email.toLowerCase() === normalized ||
    (a.label ?? '').trim().toLowerCase() === normalized,
  );
}

function findCodexAccount(identifier: string, accounts: SavedAccountProfile[]): SavedAccountProfile | undefined {
  const normalized = identifier.trim().toLowerCase();
  return accounts.find(account =>
    account.id === identifier ||
    (account.label ?? '').trim().toLowerCase() === normalized ||
    (account.email ?? '').trim().toLowerCase() === normalized,
  );
}

function formatCodexAccount(account: SavedAccountProfile): string {
  if (!account.email) return account.label ?? account.id;
  return `${account.label ?? account.id} (${account.email})`;
}

function printCodexWarning(warning: string | undefined, jsonOutput: boolean): void {
  if (warning && !jsonOutput) {
    process.stderr.write(chalk.yellow(warning) + '\n');
  }
}

async function codexAccountAction(opts: AccountCommandOptions, jsonOutput: boolean): Promise<void> {
  if (opts.login) {
    await handleLogin('codex', opts, jsonOutput);
    return;
  }

  if (opts.launcher) {
    createLauncher('codex', opts, jsonOutput);
    return;
  }

  if (opts.add) {
    if (!opts.label?.trim()) {
      process.stderr.write(chalk.red('Codex accounts require `--label`.\n'));
      process.exit(1);
      return;
    }

    const prepared = prepareCodexAccount(opts.label);
    if (!prepared.success) {
      process.stderr.write(chalk.red(prepared.error ?? 'Failed to prepare Codex account.') + '\n');
      process.exit(1);
      return;
    }

    const warning = prepared.warning;
    if (prepared.needsLogin) {
      process.stderr.write(chalk.red('No current Codex auth was importable. Use `sidekick account --provider codex --login --label <name>`.\n'));
      process.exit(1);
      return;
    }

    const active = getActiveCodexAccount();
    printCodexWarning(warning, jsonOutput);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({
        action: 'added',
        provider: 'codex',
        id: active?.id,
        label: active?.label,
        email: active?.email ?? null,
        authMode: active?.metadata?.authMode ?? null,
        warning: warning ?? null,
      }) + '\n');
    } else {
      process.stdout.write(chalk.green('Codex account saved: ') + (active ? formatCodexAccount(active) : opts.label) + '\n');
    }
    return;
  }

  if (opts.remove) {
    const accounts = listCodexAccounts();
    const target = findCodexAccount(opts.remove, accounts);
    if (!target) {
      process.stderr.write(chalk.red(`Codex account "${opts.remove}" not found.`) + '\n');
      process.exit(1);
      return;
    }

    const wasActive = getActiveCodexAccount()?.id === target.id;
    const result = removeCodexAccount(target.id);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to remove Codex account.') + '\n');
      process.exit(1);
      return;
    }

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'removed', provider: 'codex', id: target.id, label: target.label }) + '\n');
    } else {
      process.stdout.write(chalk.green('Removed: ') + formatCodexAccount(target) + '\n');
      if (wasActive) {
        process.stdout.write(chalk.dim('The live ~/.codex credentials are unchanged. Use `--switch-to` to activate another saved account.\n'));
      }
    }
    return;
  }

  if (opts.switchTo) {
    const accounts = listCodexAccounts();
    const target = findCodexAccount(opts.switchTo, accounts);
    if (!target) {
      process.stderr.write(chalk.red(`Codex account "${opts.switchTo}" not found.`) + '\n');
      process.exit(1);
      return;
    }

    const result = switchToCodexAccount(target.id);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to switch Codex account.') + '\n');
      process.exit(1);
      return;
    }

    printCodexWarning(result.warning, jsonOutput);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', provider: 'codex', id: target.id, label: target.label, warning: result.warning ?? null }) + '\n');
    } else {
      process.stdout.write(chalk.green('Switched to: ') + formatCodexAccount(target) + '\n');
    }
    return;
  }

  if (opts.switch) {
    const accounts = listCodexAccounts();
    if (accounts.length < 2) {
      process.stderr.write(chalk.yellow('Need at least 2 saved Codex accounts to switch.') + '\n');
      process.exit(1);
      return;
    }

    const active = getActiveCodexAccount();
    const currentIdx = active ? accounts.findIndex(account => account.id === active.id) : -1;
    const nextIdx = (currentIdx + 1) % accounts.length;
    const target = accounts[nextIdx];
    const result = switchToCodexAccount(target.id);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to switch Codex account.') + '\n');
      process.exit(1);
      return;
    }

    printCodexWarning(result.warning, jsonOutput);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', provider: 'codex', id: target.id, label: target.label, warning: result.warning ?? null }) + '\n');
    } else {
      process.stdout.write(chalk.green('Switched to: ') + formatCodexAccount(target) + '\n');
    }
    return;
  }

  const accounts = listCodexAccounts();
  if (accounts.length === 0) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ provider: 'codex', accounts: [], current: null }) + '\n');
    } else {
      process.stdout.write(chalk.dim('No saved Codex accounts. Run `sidekick account --provider codex --add --label <name>` to create one.\n'));
    }
    return;
  }

  if (jsonOutput) {
    const active = getActiveCodexAccount();
    process.stdout.write(JSON.stringify({
      provider: 'codex',
      accounts: accounts.map(account => ({
        ...account,
        active: account.id === active?.id,
      })),
    }, null, 2) + '\n');
    return;
  }

  const active = getActiveCodexAccount();
  process.stdout.write(chalk.bold('Codex Accounts\n'));
  process.stdout.write(chalk.dim('─'.repeat(50) + '\n'));
  for (const account of accounts) {
    const isActive = account.id === active?.id;
    const marker = isActive ? chalk.green('  * ') : '    ';
    const details = [account.email, account.metadata?.planType].filter(Boolean).join(' · ');
    process.stdout.write(`${marker}${account.label ?? account.id}${details ? chalk.dim(` (${details})`) : ''}\n`);
  }
}
