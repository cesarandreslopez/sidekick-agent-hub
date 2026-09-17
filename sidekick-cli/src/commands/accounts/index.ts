/**
 * `sidekick accounts` — Commander registration and the interactive entry
 * point. Subcommand bodies live in ./actions.ts.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { listAccountsWithHealth, switchAccountAsync } from 'sidekick-shared';
import { confirmDestructive } from '../../utils/confirm';
import {
  addAction,
  configAction,
  contextFromCommand,
  doctorAction,
  envAction,
  keepAliveRunAction,
  listAction,
  loginAction,
  printSwitchResult,
  removeAction,
  shellAction,
  switchAction,
  syncAndReport,
  undoAction,
  type AccountsContext,
} from './actions';
import { PROVIDER_NAMES, accountDisplayName } from './format';
import { describe } from './resolveAccount';

const ACCOUNTS_EXAMPLES = `
Examples:
  $ sidekick accounts                        Interactive picker (arrow keys, Enter to switch)
  $ sidekick accounts add --label Work       Sign in to a second account; the current login is untouched
  $ sidekick accounts switch work            Switch by label, email, or id
  $ eval "$(sidekick accounts env work)"     This shell only: claude/codex use Work
  $ sidekick accounts shell work -- claude   One-off claude session as Work
  $ sidekick accounts doctor                 Expiry, running apps, and Codex keyring mode
`;

/** Interactive picker loop; falls back to the list when not on a terminal. */
export async function pickerAction(ctx: AccountsContext): Promise<void> {
  if (!ctx.interactive || ctx.json) {
    await listAction(ctx);
    return;
  }
  const { showAccountsPicker } = await import('./AccountsPickerInk');
  let message: string | null = null;
  await syncAndReport(ctx);
  while (true) {
    const views = listAccountsWithHealth(ctx.provider);
    const action = await showAccountsPicker(views, { message });
    message = null;
    switch (action.kind) {
      case 'quit':
        return;
      case 'switch': {
        const account = action.account!;
        const result = await switchAccountAsync(account.providerId, account.id);
        printSwitchResult(ctx, result, accountDisplayName(account));
        message = result.success
          ? result.alreadyActive
            ? `${describe(account)} is already active.`
            : `Switched ${PROVIDER_NAMES[account.providerId]} to ${describe(account)}.`
          : (result.error ?? 'Switch failed.');
        process.exitCode = 0;
        break;
      }
      case 'undo': {
        // Keep the headline (first stdout line) or the failure (stderr) for the banner.
        let headline: string | null = null;
        let failure: string | null = null;
        await undoAction({
          ...ctx,
          out: (line) => {
            headline ??= line;
          },
          err: (line) => {
            failure = line;
          },
        });
        message = failure ?? headline ?? 'Undone.';
        process.exitCode = 0;
        break;
      }
      case 'remove': {
        const account = action.account!;
        const confirmed = await confirmDestructive(
          `Permanently remove ${describe(account)}? This deletes the saved credentials`,
        );
        if (!confirmed) {
          message = 'Not removed.';
          break;
        }
        let failure: string | null = null;
        await removeAction(
          {
            ...ctx,
            yes: true,
            err: (line) => {
              failure = line;
            },
          },
          account.id,
        );
        message = failure ?? `Removed ${describe(account)}.`;
        process.exitCode = 0;
        break;
      }
      case 'add':
        await addAction(ctx, {});
        return;
      case 'login':
        await loginAction(ctx, action.account!.id);
        return;
      case 'shell':
        await shellAction(ctx, action.account!.id);
        return;
    }
  }
}

export function registerAccountsCommand(program: Command): void {
  const accounts = new Command('accounts')
    .description(
      'Manage Claude Code and Codex accounts: list, add, switch, and run parallel sessions',
    )
    .option('--provider <id>', 'claude-code, codex, or all (default: all)')
    .addHelpText('after', ACCOUNTS_EXAMPLES)
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const ctx = contextFromCommand(cmd, cmd.opts());
      if (process.exitCode) return;
      return pickerAction(ctx);
    });

  accounts
    .command('list')
    .description('Show saved accounts with health and expiry')
    .option('--provider <id>', 'claude-code, codex, or all')
    .action(async (opts: Record<string, unknown>, cmd: Command) =>
      listAction(contextFromCommand(cmd, opts)),
    );

  accounts
    .command('add')
    .description('Sign in to a new account in an isolated profile (the current login is untouched)')
    .option('--provider <id>', 'claude-code or codex (prompted when omitted)')
    .option('--label <name>', 'Display name (default: the signed-in email)')
    .option(
      '--current',
      'Register or relabel the login that is already active instead of signing in',
    )
    .option('-y, --yes', 'Skip prompts; activate the new account immediately')
    .action(async (opts: Record<string, unknown>, cmd: Command) =>
      addAction(contextFromCommand(cmd, opts), {
        label: opts.label as string | undefined,
        current: Boolean(opts.current),
      }),
    );

  accounts
    .command('switch')
    .description('Make an account the active one (name = label, email, or id)')
    .argument('[name]', 'Account label, email, id, or unique prefix')
    .option('--provider <id>', 'claude-code or codex')
    .option('--next', 'Switch to the next saved account of the provider')
    .option('--force', 'Switch even when the stored credential is reported expired')
    .action(async (name: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      await switchAction(contextFromCommand(cmd, opts), name, {
        next: Boolean(opts.next),
        force: Boolean(opts.force),
      });
    });

  accounts
    .command('login')
    .description('Sign in again to an existing (expired) account')
    .argument('<name>', 'Account label, email, id, or unique prefix')
    .option('--provider <id>', 'claude-code or codex')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) =>
      loginAction(contextFromCommand(cmd, opts), name),
    );

  accounts
    .command('remove')
    .description('Delete a saved account and its stored credentials')
    .argument('<name>', 'Account label, email, id, or unique prefix')
    .option('--provider <id>', 'claude-code or codex')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('--force', 'Alias for --yes')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) =>
      removeAction(contextFromCommand(cmd, opts), name),
    );

  accounts
    .command('shell')
    .description('Open a subshell (or run a command) where claude/codex use the account')
    .argument('<name>', 'Account label, email, id, or unique prefix')
    .argument('[command...]', 'Command to run instead of a subshell (after --)')
    .option('--provider <id>', 'claude-code or codex')
    .action(async (name: string, command: string[], opts: Record<string, unknown>, cmd: Command) =>
      shellAction(contextFromCommand(cmd, opts), name, command),
    );

  accounts
    .command('env')
    .description('Print the environment that points claude/codex at the account (for eval)')
    .argument('<name>', 'Account label, email, id, or unique prefix')
    .option('--provider <id>', 'claude-code or codex')
    .option('--shell <kind>', 'bash, zsh, fish, powershell, or cmd (default: detected)')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) =>
      envAction(contextFromCommand(cmd, opts), name, { shell: opts.shell as string | undefined }),
    );

  accounts
    .command('undo')
    .description('Revert the last account switch')
    .option('--provider <id>', 'claude-code or codex')
    .action(async (opts: Record<string, unknown>, cmd: Command) =>
      undoAction(contextFromCommand(cmd, opts)),
    );

  accounts
    .command('doctor')
    .description('Check credential expiry, running apps, and the Codex credential store')
    .option('--provider <id>', 'claude-code or codex')
    .action(async (opts: Record<string, unknown>, cmd: Command) =>
      doctorAction(contextFromCommand(cmd, opts)),
    );

  const config = accounts
    .command('config')
    .description('Persist account settings: auto-switch <pct|off>, keep-alive <on|off|run>')
    .argument('<key>', 'auto-switch or keep-alive')
    .argument('<value>', 'Percentage/off for auto-switch; on/off/run for keep-alive')
    .action(async (key: string, value: string, _opts: Record<string, unknown>, cmd: Command) => {
      const ctx = contextFromCommand(cmd, {});
      if (key === 'keep-alive' && value === 'run') return keepAliveRunAction(ctx);
      configAction(ctx, key, value);
    });
  config.addHelpText(
    'after',
    `\n${chalk.dim('Keep-alive refreshes inactive accounts through the official CLIs in their isolated profiles so they do not expire.')}\n`,
  );

  program.addCommand(accounts);
}
