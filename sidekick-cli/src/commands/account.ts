/**
 * `sidekick account` — Manage saved Claude and Codex accounts.
 */

import { spawnSync } from 'child_process';
import type { Command } from 'commander';
import chalk from 'chalk';
import {
  listAccounts,
  getActiveAccount,
  addCurrentAccount,
  switchToAccount,
  removeAccount,
  readActiveClaudeAccount,
  listCodexAccounts,
  getActiveCodexAccount,
  prepareCodexAccount,
  finalizeCodexAccount,
  switchToCodexAccount,
  removeCodexAccount,
} from 'sidekick-shared';
import type { SavedAccountProfile } from 'sidekick-shared';
import { resolveProviderId } from '../cli';

interface AccountCommandOptions {
  provider?: string;
  add?: boolean;
  label?: string;
  switch?: boolean;
  switchTo?: string;
  remove?: string;
}

export async function accountAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;
  const opts = cmd.opts() as AccountCommandOptions;

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
    codexAccountAction(opts, jsonOutput);
    return;
  }

  claudeAccountAction(opts, jsonOutput);
}

function claudeAccountAction(opts: AccountCommandOptions, jsonOutput: boolean): void {
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

function runCodexLogin(codexHome: string): { success: boolean; error?: string } {
  const result = spawnSync('codex', ['login'], {
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: codexHome },
  });

  if (result.error) {
    return { success: false, error: `Failed to start \`codex login\`: ${result.error.message}` };
  }

  if (result.status !== 0) {
    return { success: false, error: `\`codex login\` exited with status ${result.status}.` };
  }

  return { success: true };
}

function codexAccountAction(opts: AccountCommandOptions, jsonOutput: boolean): void {
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

    if (prepared.needsLogin) {
      if (!prepared.profileId || !prepared.codexHome) {
        process.stderr.write(chalk.red('Prepared Codex profile is missing login context.') + '\n');
        process.exit(1);
        return;
      }

      const login = runCodexLogin(prepared.codexHome);
      if (!login.success) {
        process.stderr.write(chalk.red(login.error ?? 'Codex login failed.') + '\n');
        process.exit(1);
        return;
      }

      const finalized = finalizeCodexAccount(prepared.profileId);
      if (!finalized.success) {
        process.stderr.write(chalk.red(finalized.error ?? 'Failed to finalize Codex account.') + '\n');
        process.exit(1);
        return;
      }
    }

    const active = getActiveCodexAccount();
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({
        action: 'added',
        provider: 'codex',
        id: active?.id,
        label: active?.label,
        email: active?.email ?? null,
        authMode: active?.metadata?.authMode ?? null,
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

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', provider: 'codex', id: target.id, label: target.label }) + '\n');
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

    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', provider: 'codex', id: target.id, label: target.label }) + '\n');
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
