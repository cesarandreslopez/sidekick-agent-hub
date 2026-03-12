/**
 * `sidekick account` — Manage Claude Max accounts.
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import {
  listAccounts,
  getActiveAccount,
  addCurrentAccount,
  switchToAccount,
  removeAccount,
  readActiveClaudeAccount,
} from 'sidekick-shared';

export async function accountAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const jsonOutput: boolean = !!globalOpts.json;

  const opts = cmd.opts() as {
    add?: boolean;
    label?: string;
    switch?: boolean;
    switchTo?: string;
    remove?: string;
  };

  // --add: save current account
  if (opts.add) {
    const result = addCurrentAccount(opts.label);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to save account.') + '\n');
      process.exit(1);
    }
    const active = readActiveClaudeAccount();
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'added', email: active?.email, label: opts.label }) + '\n');
    } else {
      process.stdout.write(chalk.green('Account saved: ') + (active?.email ?? 'unknown') +
        (opts.label ? chalk.dim(` (${opts.label})`) : '') + '\n');
    }
    return;
  }

  // --remove: remove an account by email
  if (opts.remove) {
    const accounts = listAccounts();
    const target = accounts.find(a => a.email === opts.remove || a.uuid === opts.remove);
    if (!target) {
      process.stderr.write(chalk.red(`Account "${opts.remove}" not found.`) + '\n');
      process.exit(1);
    }
    const result = removeAccount(target.uuid);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to remove account.') + '\n');
      process.exit(1);
    }
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'removed', email: target.email }) + '\n');
    } else {
      process.stdout.write(chalk.green('Removed: ') + target.email + '\n');
    }
    return;
  }

  // --switch-to: switch to a specific account by email
  if (opts.switchTo) {
    const accounts = listAccounts();
    const target = accounts.find(a => a.email === opts.switchTo || a.uuid === opts.switchTo);
    if (!target) {
      process.stderr.write(chalk.red(`Account "${opts.switchTo}" not found.`) + '\n');
      process.exit(1);
    }
    const result = switchToAccount(target.uuid);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to switch.') + '\n');
      process.exit(1);
    }
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', email: target.email }) + '\n');
    } else {
      process.stdout.write(chalk.green('Switched to: ') + target.email +
        (target.label ? chalk.dim(` (${target.label})`) : '') + '\n');
    }
    return;
  }

  // --switch (no argument): switch to next account in list
  if (opts.switch) {
    const accounts = listAccounts();
    if (accounts.length < 2) {
      process.stderr.write(chalk.yellow('Need at least 2 saved accounts to switch.') + '\n');
      process.exit(1);
    }
    const active = getActiveAccount();
    const currentIdx = active ? accounts.findIndex(a => a.uuid === active.uuid) : -1;
    const nextIdx = (currentIdx + 1) % accounts.length;
    const target = accounts[nextIdx];
    const result = switchToAccount(target.uuid);
    if (!result.success) {
      process.stderr.write(chalk.red(result.error ?? 'Failed to switch.') + '\n');
      process.exit(1);
    }
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ action: 'switched', email: target.email }) + '\n');
    } else {
      process.stdout.write(chalk.green('Switched to: ') + target.email +
        (target.label ? chalk.dim(` (${target.label})`) : '') + '\n');
    }
    return;
  }

  // Default: list accounts
  const accounts = listAccounts();
  if (accounts.length === 0) {
    // Show current signed-in account even if not saved
    const current = readActiveClaudeAccount();
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ accounts: [], current: current ?? null }) + '\n');
    } else {
      if (current) {
        process.stdout.write(chalk.dim('No saved accounts. Currently signed in as: ') + current.email + '\n');
        process.stdout.write(chalk.dim('Run `sidekick account --add` to save this account.\n'));
      } else {
        process.stdout.write(chalk.dim('No saved accounts. Sign in with `claude` first.\n'));
      }
    }
    return;
  }

  if (jsonOutput) {
    const active = getActiveAccount();
    process.stdout.write(JSON.stringify({
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
