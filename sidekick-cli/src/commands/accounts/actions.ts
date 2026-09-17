/**
 * `sidekick accounts` subcommand implementations. Every action takes an
 * {@link AccountsContext} rather than a Commander instance so the legacy
 * `sidekick account` alias and the interactive picker share one code path.
 */

import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import type { Command } from 'commander';
import {
  DEFAULT_AUTO_SWITCH_CONFIG,
  addCurrentAccount,
  detectRunningAccountConsumers,
  getAccountLaunchEnv,
  getClaudeProfileHome,
  getCodexCredentialStoreMode,
  getCodexProfileHome,
  getLastSwitch,
  listAccountsWithHealth,
  listSavedAccountProfiles,
  refreshInactiveAccounts,
  removeAccount,
  removeCodexAccount,
  spawnAccountLogin,
  switchAccountAsync,
  syncLiveAccountState,
  undoLastSwitch,
  upsertSavedAccountProfile,
  writeLauncher,
} from 'sidekick-shared';
import type {
  AccountManagerResult,
  AccountProviderId,
  AccountView,
  AutoSwitchConfig,
  SwitchAccountResult,
  SyncReport,
} from 'sidekick-shared';
import { readCliConfig, writeCliConfig } from '../../utils/cliConfig';
import { confirmDestructive } from '../../utils/confirm';
import { checkInteractivePreflight, currentTerminalCapabilities } from '../interactivePreflight';
import {
  EMPTY_STATE_GUIDANCE,
  FIRST_RUN_GUIDANCE,
  PROVIDER_NAMES,
  accountDisplayName,
  allLearned,
  formatAccountList,
  formatHealth,
  renderSwitchSummary,
  summarizeSwitch,
} from './format';
import {
  defaultShellCommand,
  detectShell,
  envUsageHint,
  formatEnvExport,
  parseShellKind,
  type ShellKind,
} from './envExport';
import { describe, parseProviderFilter, resolveAccount } from './resolveAccount';

export interface AccountsContext {
  json: boolean;
  provider?: AccountProviderId;
  yes: boolean;
  /** stdin/stdout are terminals (prompts and pickers are possible). */
  interactive: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Overridable for tests. */
  now?: () => number;
}

function rootOpts(cmd: Command): Record<string, unknown> {
  let current: Command = cmd;
  while (current.parent) current = current.parent;
  return current.opts();
}

/** Build the context for a Commander subcommand (root flags + local flags). */
export function contextFromCommand(
  cmd: Command,
  local: Record<string, unknown> = {},
): AccountsContext {
  const root = rootOpts(cmd);
  const parentProvider = cmd.parent?.opts?.().provider as string | undefined;
  const providerValue =
    (local.provider as string | undefined) ??
    parentProvider ??
    (root.provider as string | undefined);
  const parsed = parseProviderFilter(providerValue);
  if (parsed.error) {
    process.stderr.write(chalk.red(parsed.error) + '\n');
    process.exitCode = 1;
  }
  return {
    json: Boolean(root.json),
    provider: parsed.provider,
    yes: Boolean(local.yes || local.force),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (line) => process.stdout.write(line + '\n'),
    err: (line) => process.stderr.write(line + '\n'),
  };
}

function fail(ctx: AccountsContext, message: string): void {
  ctx.err(chalk.red(message));
  process.exitCode = 1;
}

function now(ctx: AccountsContext): number {
  return ctx.now?.() ?? Date.now();
}

/** Fold live logins into the registry and tell the user what was learned. */
export async function syncAndReport(ctx: AccountsContext): Promise<SyncReport> {
  const report = await syncLiveAccountState({ reason: 'manual' });
  for (const [provider, entry] of [
    ['claude-code', report.claude],
    ['codex', report.codex],
  ] as const) {
    if (entry.registered) {
      ctx.err(
        chalk.dim(
          `Registered ${entry.registered.email ?? entry.registered.id} (${PROVIDER_NAMES[provider]}).`,
        ),
      );
    }
    for (const warning of entry.warnings) ctx.err(chalk.yellow(warning));
  }
  return report;
}

function views(ctx: AccountsContext): AccountView[] {
  return listAccountsWithHealth(ctx.provider, { now: now(ctx) });
}

// ── list ─────────────────────────────────────────────────────────────────

export async function listAction(ctx: AccountsContext): Promise<void> {
  const report = await syncAndReport(ctx);
  const all = views(ctx);
  if (ctx.json) {
    const registeredNow = [report.claude.registered, report.codex.registered]
      .filter((entry): entry is { id: string; email?: string } => Boolean(entry))
      .map((entry) => entry.id);
    const activeByProvider = {
      'claude-code': all.find((v) => v.providerId === 'claude-code' && v.isActive)?.id ?? null,
      codex: all.find((v) => v.providerId === 'codex' && v.isActive)?.id ?? null,
    };
    ctx.out(JSON.stringify({ accounts: all, activeByProvider, registeredNow }, null, 2));
    return;
  }
  if (all.length === 0) {
    ctx.out(chalk.dim(EMPTY_STATE_GUIDANCE));
    return;
  }
  ctx.out(formatAccountList(all, now(ctx)));
  if (allLearned(all)) ctx.out('\n' + chalk.dim(FIRST_RUN_GUIDANCE));
}

// ── switch / undo ────────────────────────────────────────────────────────

export function printSwitchResult(
  ctx: AccountsContext,
  result: SwitchAccountResult,
  targetName: string,
): void {
  if (ctx.json) {
    ctx.out(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
    return;
  }
  const rendered = renderSwitchSummary(summarizeSwitch(result, targetName));
  for (const line of rendered.stderr) ctx.err(line);
  for (const line of rendered.stdout) ctx.out(line);
  if (!result.success) process.exitCode = 1;
}

function pickNextAccount(ctx: AccountsContext, all: AccountView[]): AccountView | null {
  const provider = ctx.provider ?? inferProviderForNext(all);
  if (!provider) {
    fail(
      ctx,
      all.length === 0
        ? 'No saved accounts to switch between; run `sidekick accounts add` first.'
        : 'Two providers have saved accounts; add --provider claude-code or --provider codex.',
    );
    return null;
  }
  const pool = all.filter((v) => v.providerId === provider);
  if (pool.length < 2) {
    fail(ctx, `Need at least 2 saved ${PROVIDER_NAMES[provider]} accounts to switch.`);
    return null;
  }
  const currentIdx = pool.findIndex((v) => v.isActive);
  return pool[(currentIdx + 1) % pool.length];
}

function inferProviderForNext(all: AccountView[]): AccountProviderId | undefined {
  const providers = new Set(all.map((v) => v.providerId));
  return providers.size === 1 ? [...providers][0] : undefined;
}

export async function switchAction(
  ctx: AccountsContext,
  identifier: string | undefined,
  options: { next?: boolean; force?: boolean } = {},
): Promise<SwitchAccountResult | null> {
  await syncAndReport(ctx);
  const all = views(ctx);
  let target: AccountView | null = null;
  if (options.next) {
    target = pickNextAccount(ctx, all);
  } else if (identifier) {
    const resolved = resolveAccount(all, identifier, ctx.provider);
    if ('error' in resolved) {
      fail(ctx, resolved.error);
      if (resolved.candidates.length && resolved.candidates.length < all.length + 1) {
        ctx.err(chalk.dim(`Candidates: ${resolved.candidates.map(describe).join(', ')}`));
      }
      return null;
    }
    target = resolved.account;
  } else {
    fail(ctx, 'Name an account to switch to, or use --next.');
    return null;
  }
  if (!target) return null;

  const result = await switchAccountAsync(target.providerId, target.id, { force: options.force });
  printSwitchResult(ctx, result, accountDisplayName(target));
  return result;
}

export async function undoAction(ctx: AccountsContext): Promise<void> {
  const providers: AccountProviderId[] = ctx.provider ? [ctx.provider] : ['claude-code', 'codex'];
  const withRecord = providers.filter((provider) => getLastSwitch(provider));
  if (withRecord.length === 0) {
    fail(ctx, 'There is no account switch to undo.');
    return;
  }
  if (withRecord.length > 1) {
    fail(
      ctx,
      'Both providers have a switch to undo; add --provider claude-code or --provider codex.',
    );
    return;
  }
  const provider = withRecord[0];
  const result = await undoLastSwitch(provider);
  const target = listAccountsWithHealth(provider).find((v) => v.id === result.accountId);
  printSwitchResult(ctx, result, target ? accountDisplayName(target) : result.accountId);
}

// ── add / login ──────────────────────────────────────────────────────────

async function prompt(question: string, fallback = ''): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function chooseProvider(ctx: AccountsContext): Promise<AccountProviderId | null> {
  if (ctx.provider) return ctx.provider;
  if (!ctx.interactive || ctx.json) {
    fail(ctx, 'Choose a provider: --provider claude-code or --provider codex.');
    return null;
  }
  const answer = await prompt(`Which provider?\n  1) Claude Code\n  2) Codex\nChoice [1]: `, '1');
  if (answer === '1' || /^claude/i.test(answer)) return 'claude-code';
  if (answer === '2' || /^codex/i.test(answer)) return 'codex';
  fail(ctx, `Unknown choice "${answer}".`);
  return null;
}

async function confirmYes(ctx: AccountsContext, question: string): Promise<boolean> {
  if (ctx.yes) return true;
  if (!ctx.interactive || ctx.json) return false;
  const answer = (await prompt(`${question} [Y/n] `, 'y')).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function printLoginResult(
  ctx: AccountsContext,
  provider: AccountProviderId,
  result: AccountManagerResult,
  label: string,
): AccountView | null {
  if (!result.success) {
    fail(ctx, result.error ?? 'Account login failed.');
    if (result.error?.includes('timed out')) {
      ctx.err(
        chalk.dim(
          `Nothing was saved. Re-run: sidekick accounts add --provider ${provider}${label ? ` --label ${JSON.stringify(label)}` : ''}`,
        ),
      );
    }
    return null;
  }
  const saved = listAccountsWithHealth(provider, { now: now(ctx) });
  const view =
    saved.find((v) => v.id === result.profileId) ??
    saved.filter((v) => v.health.isLive || v.isActive).at(-1) ??
    saved.at(-1) ??
    null;
  if (result.warning) ctx.err(chalk.yellow(result.warning));
  if (ctx.json) {
    ctx.out(
      JSON.stringify({
        action: 'login',
        provider,
        success: true,
        account: view,
        warning: result.warning ?? null,
      }),
    );
  } else if (view) {
    ctx.out(chalk.green('Saved ') + describe(view));
  } else {
    ctx.out(chalk.green('Account saved.'));
  }
  return view;
}

export async function addAction(
  ctx: AccountsContext,
  options: { label?: string; current?: boolean } = {},
): Promise<void> {
  const provider = await chooseProvider(ctx);
  if (!provider) return;

  if (options.current) {
    await registerCurrentAction(ctx, provider, options.label);
    return;
  }

  const preflight = checkInteractivePreflight(
    currentTerminalCapabilities(),
    'accounts add',
    'sidekick accounts add --current',
  );
  if (preflight) {
    ctx.err(preflight.message.trimEnd());
    process.exitCode = preflight.exitCode;
    return;
  }

  let label = options.label?.trim() ?? '';
  if (!label && !ctx.yes) {
    label = await prompt('Label for this account (Enter to use the signed-in email): ');
  }

  const cli = provider === 'codex' ? 'codex login' : 'claude auth login';
  ctx.err(chalk.dim(`Opening ${cli} in an isolated profile — your current login is untouched.`));
  ctx.err(chalk.dim('Complete the sign-in in the browser; press Ctrl+C to cancel.'));

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  let result: AccountManagerResult;
  try {
    result = await spawnAccountLogin(provider, label, {
      stdio: 'inherit',
      activate: false,
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }

  const view = printLoginResult(ctx, provider, result, label);
  if (!view) return;
  if (view.isActive || view.health.isLive) return;
  if (
    await confirmYes(
      ctx,
      `Make ${describe(view)} the active ${PROVIDER_NAMES[provider]} account now?`,
    )
  ) {
    const switched = await switchAccountAsync(provider, view.id);
    printSwitchResult(ctx, switched, accountDisplayName(view));
  } else if (!ctx.json) {
    ctx.out(
      chalk.dim(
        `Switch later with: sidekick accounts switch ${JSON.stringify(accountDisplayName(view))}`,
      ),
    );
  }
}

async function registerCurrentAction(
  ctx: AccountsContext,
  provider: AccountProviderId,
  label: string | undefined,
): Promise<void> {
  const report = await syncAndReport(ctx);
  const entry = provider === 'codex' ? report.codex : report.claude;
  const all = listAccountsWithHealth(provider, { now: now(ctx) });
  const live = all.find((v) => v.health.isLive) ?? all.find((v) => v.isActive);
  if (!live) {
    fail(
      ctx,
      entry.warnings[0] ??
        `No live ${PROVIDER_NAMES[provider]} login found. Sign in with \`${provider === 'codex' ? 'codex login' : 'claude'}\` first.`,
    );
    return;
  }
  if (label?.trim()) {
    if (provider === 'claude-code') {
      const result = addCurrentAccount(label.trim());
      if (!result.success) {
        fail(ctx, result.error ?? 'Could not relabel the account.');
        return;
      }
    } else {
      const profile = listSavedAccountProfiles('codex').find((p) => p.id === live.id);
      if (profile) {
        upsertSavedAccountProfile({
          ...profile,
          label: label.trim(),
          metadata: { ...profile.metadata, origin: 'manual' },
        });
      }
    }
  }
  const updated =
    listAccountsWithHealth(provider, { now: now(ctx) }).find((v) => v.id === live.id) ?? live;
  if (ctx.json) {
    ctx.out(
      JSON.stringify({
        action: 'registered',
        provider,
        account: updated,
        registeredNow: Boolean(entry.registered),
      }),
    );
  } else {
    ctx.out(chalk.green(entry.registered ? 'Registered ' : 'Already saved: ') + describe(updated));
  }
}

export async function loginAction(ctx: AccountsContext, identifier: string): Promise<void> {
  await syncAndReport(ctx);
  const resolved = resolveAccount(views(ctx), identifier, ctx.provider);
  if ('error' in resolved) {
    fail(ctx, resolved.error);
    return;
  }
  const account = resolved.account;
  const preflight = checkInteractivePreflight(
    currentTerminalCapabilities(),
    'accounts login',
    'sidekick accounts list',
  );
  if (preflight) {
    ctx.err(preflight.message.trimEnd());
    process.exitCode = preflight.exitCode;
    return;
  }
  const cli = account.providerId === 'codex' ? 'codex login' : 'claude auth login';
  ctx.err(
    chalk.dim(`Opening ${cli} to sign in again as ${describe(account)}; press Ctrl+C to cancel.`),
  );
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  let result: AccountManagerResult;
  try {
    result = await spawnAccountLogin(account.providerId, account.label ?? '', {
      stdio: 'inherit',
      activate: account.isActive || account.health.isLive,
      existingAccountId: account.id,
      signal: controller.signal,
    });
  } finally {
    process.off('SIGINT', onSigint);
  }
  printLoginResult(ctx, account.providerId, result, account.label ?? '');
}

// ── remove ───────────────────────────────────────────────────────────────

export async function removeAction(ctx: AccountsContext, identifier: string): Promise<void> {
  const resolved = resolveAccount(views(ctx), identifier, ctx.provider);
  if ('error' in resolved) {
    fail(ctx, resolved.error);
    return;
  }
  const account = resolved.account;
  if (!ctx.yes) {
    if (ctx.json || !ctx.interactive) {
      fail(ctx, 'Refusing to remove an account without confirmation. Re-run with --yes.');
      return;
    }
    const confirmed = await confirmDestructive(
      `Permanently remove ${PROVIDER_NAMES[account.providerId]} account ${describe(account)}? This deletes the saved credentials`,
    );
    if (!confirmed) {
      ctx.err(chalk.dim('Aborted — account not removed.'));
      process.exitCode = 1;
      return;
    }
  }
  const result =
    account.providerId === 'codex' ? removeCodexAccount(account.id) : removeAccount(account.id);
  if (!result.success) {
    fail(ctx, result.error ?? 'Failed to remove account.');
    return;
  }
  if (ctx.json) {
    ctx.out(
      JSON.stringify({
        action: 'removed',
        provider: account.providerId,
        id: account.id,
        label: account.label ?? null,
        email: account.email ?? null,
      }),
    );
  } else {
    ctx.out(chalk.green('Removed ') + describe(account));
    if (account.isActive) {
      ctx.out(
        chalk.dim(
          `The live ${account.providerId === 'codex' ? '~/.codex' : 'claude'} login is unchanged; switch to another saved account when you are ready.`,
        ),
      );
    }
  }
}

// ── shell / env / launcher ───────────────────────────────────────────────

function resolveLaunch(ctx: AccountsContext, identifier: string, force?: boolean) {
  const resolved = resolveAccount(views(ctx), identifier, ctx.provider);
  if ('error' in resolved) {
    fail(ctx, resolved.error);
    return null;
  }
  const launch = getAccountLaunchEnv(resolved.account.providerId, resolved.account.id, { force });
  if (launch.error) {
    fail(ctx, launch.error);
    return null;
  }
  for (const warning of launch.warnings) ctx.err(chalk.yellow(`! ${warning}`));
  return { account: resolved.account, launch };
}

export async function envAction(
  ctx: AccountsContext,
  identifier: string,
  options: { shell?: string } = {},
): Promise<void> {
  const shell: ShellKind | null = options.shell ? parseShellKind(options.shell) : detectShell();
  if (!shell) {
    fail(ctx, `Unknown shell "${options.shell}". Use bash, zsh, fish, powershell, or cmd.`);
    return;
  }
  const resolved = resolveLaunch(ctx, identifier);
  if (!resolved) return;
  if (ctx.json) {
    ctx.out(JSON.stringify(resolved.launch, null, 2));
    return;
  }
  if (process.stdout.isTTY)
    ctx.err(chalk.dim(envUsageHint(shell, JSON.stringify(accountDisplayName(resolved.account)))));
  process.stdout.write(formatEnvExport(resolved.launch.env, resolved.launch.envUnset, shell));
}

export async function shellAction(
  ctx: AccountsContext,
  identifier: string,
  commandArgs: string[] = [],
): Promise<void> {
  const resolved = resolveLaunch(ctx, identifier);
  if (!resolved) return;
  const { account, launch } = resolved;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launch.env,
    SIDEKICK_ACCOUNT: accountDisplayName(account),
  };
  for (const name of launch.envUnset) delete env[name];
  const target = commandArgs.length
    ? { command: commandArgs[0], args: commandArgs.slice(1) }
    : defaultShellCommand();
  if (!commandArgs.length) {
    ctx.err(
      chalk.dim(
        `Subshell as ${describe(account)} — ${launch.command} here uses this account. Type exit to return.`,
      ),
    );
  }
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(target.command, target.args, { env, stdio: 'inherit', windowsHide: false });
    child.on('error', (error) => {
      ctx.err(chalk.red(`Could not start ${target.command}: ${error.message}`));
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
  process.exitCode = exitCode;
}

export function launcherAction(
  ctx: AccountsContext,
  name: string,
  provider: AccountProviderId,
): void {
  const active = listAccountsWithHealth(provider).find((v) => v.isActive);
  if (!active) {
    fail(ctx, `No active ${PROVIDER_NAMES[provider]} account found for launcher creation.`);
    return;
  }
  const profileHome =
    provider === 'codex' ? getCodexProfileHome(active.id) : getClaudeProfileHome(active.id);
  try {
    writeLauncher(name, provider, profileHome);
  } catch (error) {
    fail(ctx, error instanceof Error ? error.message : String(error));
    return;
  }
  const launcherPath = path.join(os.homedir(), '.local', 'bin', name);
  if (ctx.json) {
    ctx.out(
      JSON.stringify({ action: 'launcher', provider, name, path: launcherPath, profileHome }),
    );
  } else {
    ctx.out(chalk.green('Launcher created: ') + launcherPath);
    ctx.out(
      chalk.dim(
        `Tip: \`sidekick accounts shell ${JSON.stringify(accountDisplayName(active))}\` works on every platform.`,
      ),
    );
  }
}

// ── doctor ───────────────────────────────────────────────────────────────

export interface AccountCheck {
  id: string;
  status: 'ok' | 'info' | 'warning' | 'error';
  title: string;
  message: string;
  repair?: string;
}

export async function collectAccountChecks(ctx: AccountsContext): Promise<AccountCheck[]> {
  const checks: AccountCheck[] = [];
  const all = views(ctx);
  if (all.length === 0) {
    checks.push({
      id: 'accounts',
      status: 'info',
      title: 'Saved accounts',
      message: 'No accounts saved yet.',
      repair: 'Sign in with claude or codex, or run `sidekick accounts add`.',
    });
  }
  for (const view of all) {
    const badge = formatHealth(view.health, now(ctx));
    const status =
      view.health.state === 'expired' || view.health.state === 'missing'
        ? 'error'
        : view.health.state === 'expiring'
          ? 'warning'
          : view.health.state === 'unknown'
            ? 'info'
            : 'ok';
    checks.push({
      id: `account:${view.providerId}:${view.id}`,
      status,
      title: `${PROVIDER_NAMES[view.providerId]} · ${describe(view)}${view.isActive ? ' (active)' : ''}`,
      message: `${badge.state}${badge.detail ? ` — ${badge.detail}` : ''}`,
      ...(status === 'error' || status === 'warning'
        ? { repair: `sidekick accounts login ${JSON.stringify(accountDisplayName(view))}` }
        : {}),
    });
  }

  const consumers = await detectRunningAccountConsumers(ctx.provider);
  checks.push({
    id: 'running-apps',
    status: consumers.length ? 'info' : 'ok',
    title: 'Running apps that hold a login',
    message: consumers.length
      ? consumers.map((c) => `${c.kind} (pid ${c.pids.join(', ')}): ${c.reachability}`).join('\n')
      : 'None detected; a switch takes effect for the next session.',
  });

  if (!ctx.provider || ctx.provider === 'codex') {
    const mode = getCodexCredentialStoreMode();
    const keyring = mode === 'keyring' || mode === 'auto';
    checks.push({
      id: 'codex-credential-store',
      status: keyring ? 'warning' : 'ok',
      title: 'Codex credential store',
      message: keyring
        ? `cli_auth_credentials_store = "${mode}": codex keeps its login in the OS keyring, which sidekick cannot switch.`
        : `cli_auth_credentials_store = "${mode === 'unknown' ? 'file (default)' : mode}": switchable.`,
      ...(keyring
        ? {
            repair:
              'Set cli_auth_credentials_store = "file" in ~/.codex/config.toml and run `codex login` again.',
          }
        : {}),
    });
  }

  const keepAlive = Boolean(readCliConfig().accounts?.keepAlive);
  checks.push({
    id: 'keep-alive',
    status: 'info',
    title: 'Keep-alive for inactive accounts',
    message: keepAlive
      ? 'On: the dashboard refreshes inactive accounts through the official CLIs.'
      : 'Off: inactive accounts expire after a few weeks unless you sign in again.',
    ...(keepAlive ? {} : { repair: 'sidekick accounts config keep-alive on' }),
  });
  return checks;
}

const STATUS_GLYPH: Record<AccountCheck['status'], string> = {
  ok: chalk.green('✓'),
  info: chalk.cyan('i'),
  warning: chalk.yellow('!'),
  error: chalk.red('✗'),
};

export async function doctorAction(ctx: AccountsContext): Promise<void> {
  await syncAndReport(ctx);
  const checks = await collectAccountChecks(ctx);
  const worst = checks.some((c) => c.status === 'error')
    ? 'error'
    : checks.some((c) => c.status === 'warning')
      ? 'warning'
      : 'ok';
  if (ctx.json) {
    ctx.out(JSON.stringify({ status: worst, checks }, null, 2));
    return;
  }
  ctx.out(chalk.bold('Account health'));
  for (const check of checks) {
    ctx.out(`${STATUS_GLYPH[check.status]} ${chalk.bold(check.title)}`);
    for (const line of check.message.split('\n')) ctx.out(`    ${line}`);
    if (check.repair) ctx.out(chalk.dim(`    fix: ${check.repair}`));
  }
  if (worst === 'error') process.exitCode = 1;
}

// ── config ───────────────────────────────────────────────────────────────

export function parseAutoSwitchConfig(value: string): AutoSwitchConfig {
  if (value.trim().toLowerCase() === 'off') {
    return { ...DEFAULT_AUTO_SWITCH_CONFIG, enabled: false };
  }
  const thresholdPct = Number(value);
  if (!Number.isFinite(thresholdPct) || thresholdPct <= 0 || thresholdPct > 100) {
    throw new Error('Use `off` or a percentage between 1 and 100.');
  }
  return { enabled: true, thresholdPct };
}

export function configAction(ctx: AccountsContext, key: string, value: string): void {
  const config = readCliConfig();
  const accounts = { ...(config.accounts ?? {}) };
  try {
    if (key === 'auto-switch') {
      const autoSwitch = parseAutoSwitchConfig(value);
      writeCliConfig({ ...config, accounts: { ...accounts, autoSwitch } });
      if (ctx.json) ctx.out(JSON.stringify({ action: 'config', autoSwitch }));
      else {
        ctx.out(
          chalk.green(
            autoSwitch.enabled
              ? `Auto-switch threshold set to ${autoSwitch.thresholdPct}%.`
              : 'Auto-switch disabled.',
          ),
        );
        ctx.out(
          chalk.dim(
            'Continuous auto-switch runs in a long-running host such as VS Code or the dashboard.',
          ),
        );
      }
      return;
    }
    if (key === 'keep-alive') {
      const normalized = value.trim().toLowerCase();
      if (!['on', 'off', 'true', 'false'].includes(normalized))
        throw new Error('Use `on` or `off`.');
      const keepAlive = normalized === 'on' || normalized === 'true';
      writeCliConfig({ ...config, accounts: { ...accounts, keepAlive } });
      if (ctx.json) ctx.out(JSON.stringify({ action: 'config', keepAlive }));
      else {
        ctx.out(chalk.green(keepAlive ? 'Keep-alive enabled.' : 'Keep-alive disabled.'));
        if (keepAlive)
          ctx.out(
            chalk.dim(
              'The dashboard refreshes inactive accounts through `claude auth status` / `codex login status` in their isolated profiles.',
            ),
          );
      }
      return;
    }
    throw new Error(`Unknown setting "${key}". Use auto-switch or keep-alive.`);
  } catch (error) {
    fail(ctx, error instanceof Error ? error.message : String(error));
  }
}

/** One keep-alive pass, printed. Used by `accounts config keep-alive run`. */
export async function keepAliveRunAction(ctx: AccountsContext): Promise<void> {
  const result = await refreshInactiveAccounts({
    providers: ctx.provider ? [ctx.provider] : undefined,
  });
  if (ctx.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return;
  }
  ctx.out(
    `Refreshed ${result.refreshed.length}, skipped ${result.skipped.length}, failed ${result.failed.length}.`,
  );
  for (const failed of result.failed)
    ctx.err(chalk.yellow(`  ! ${failed.providerId} ${failed.id}: ${failed.error}`));
}
