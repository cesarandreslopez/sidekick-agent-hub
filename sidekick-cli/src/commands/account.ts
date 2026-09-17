/**
 * `sidekick account` — deprecated flag-style alias for `sidekick accounts`.
 * Prints the modern equivalent on stderr and delegates to the same actions.
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import {
  addAction,
  configAction,
  contextFromCommand,
  launcherAction,
  listAction,
  removeAction,
  switchAction,
  type AccountsContext,
} from './accounts/actions';
import { parseProviderFilter } from './accounts/resolveAccount';

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
  yes?: boolean;
  force?: boolean;
}

/** The `sidekick accounts …` command equivalent to a legacy flag combination. */
export function mapLegacyInvocation(opts: AccountCommandOptions): string {
  const provider = opts.provider && opts.provider !== 'all' ? ` --provider ${opts.provider}` : '';
  const label = opts.label ? ` --label ${JSON.stringify(opts.label)}` : '';
  if (opts.autoSwitch !== undefined)
    return `sidekick accounts config auto-switch ${opts.autoSwitch}`;
  if (opts.launcher) return `sidekick accounts shell <name>`;
  if (opts.login) return `sidekick accounts add${provider}${label}`;
  if (opts.add) return `sidekick accounts add --current${provider}${label}`;
  if (opts.switchTo) return `sidekick accounts switch ${JSON.stringify(opts.switchTo)}${provider}`;
  if (opts.switch) return `sidekick accounts switch --next${provider}`;
  if (opts.remove)
    return `sidekick accounts remove ${JSON.stringify(opts.remove)}${provider}${opts.yes || opts.force ? ' --yes' : ''}`;
  return `sidekick accounts list${provider}`;
}

export async function accountAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const opts = cmd.opts() as AccountCommandOptions;
  // Legacy default was Claude-only; `all` listed both providers.
  const providerValue =
    opts.provider ??
    (opts.add || opts.login || opts.switch || opts.switchTo || opts.remove || opts.launcher
      ? 'claude-code'
      : 'all');
  const parsed = parseProviderFilter(providerValue);
  if (parsed.error) {
    process.stderr.write(chalk.red(parsed.error) + '\n');
    process.exitCode = 1;
    return;
  }
  const ctx: AccountsContext = {
    ...contextFromCommand(cmd, { provider: 'all', yes: opts.yes, force: opts.force }),
    provider: parsed.provider,
  };
  process.stderr.write(
    chalk.dim(`sidekick account is deprecated; use: ${mapLegacyInvocation(opts)}\n`),
  );

  if (opts.autoSwitch !== undefined) {
    configAction(ctx, 'auto-switch', opts.autoSwitch);
    return;
  }
  if (opts.launcher) {
    launcherAction(ctx, opts.launcher, parsed.provider ?? 'claude-code');
    return;
  }
  if (opts.login) {
    await addAction({ ...ctx, provider: parsed.provider ?? 'claude-code' }, { label: opts.label });
    return;
  }
  if (opts.add) {
    await addAction(
      { ...ctx, provider: parsed.provider ?? 'claude-code' },
      { label: opts.label, current: true },
    );
    return;
  }
  if (opts.remove) {
    await removeAction(ctx, opts.remove);
    return;
  }
  if (opts.switchTo) {
    await switchAction(ctx, opts.switchTo);
    return;
  }
  if (opts.switch) {
    await switchAction({ ...ctx, provider: parsed.provider ?? 'claude-code' }, undefined, {
      next: true,
    });
    return;
  }
  await listAction(ctx);
}
