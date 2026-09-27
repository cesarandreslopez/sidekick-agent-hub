/**
 * Opt-in keep-alive for saved-but-inactive accounts. Sidekick never calls the
 * providers' OAuth endpoints itself: it runs the official CLI inside the
 * profile's isolated home and lets the CLI refresh (and rotate) the token
 * where it belongs, then re-reads the store to record the new expiry.
 *
 * A refresh rotates the refresh token, so for Claude it only runs where the
 * profile home holds the one live copy of its chain: never the live account,
 * never a copy whose refresh token equals live's, never a copy taken from the
 * live store that no switch has handed back yet, and never a stale copy when
 * the backup is newer. The check and a lease are taken under the swap lock, so
 * no switch can install that account while its CLI is refreshing.
 */
import { execFile } from 'child_process';
import { getAccountHealth, listAccountsWithHealth, type AccountView } from './accountHealth';
import { getAccountLaunchEnv } from './accountLaunch';
import type { AccountProviderId } from './accountRegistry';
import { beginClaudeKeepAlive, finishClaudeKeepAlive, getClaudeKeepAliveBlocker } from './accounts';

export interface KeepAliveRunner {
  (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<{
    status: number | null;
    stdout: string;
  }>;
}

export interface RefreshInactiveAccountsOptions {
  providers?: AccountProviderId[];
  /** Per-account CLI timeout. Default 20 s. */
  timeoutMs?: number;
  /** Report what would run without running it. */
  dryRun?: boolean;
  /** Also refresh accounts whose credential is still fresh. Default false. */
  includeFresh?: boolean;
  runner?: KeepAliveRunner;
  now?: number;
}

export interface RefreshInactiveAccountsResult {
  refreshed: Array<{ id: string; providerId: AccountProviderId }>;
  skipped: Array<{ id: string; providerId: AccountProviderId; reason: string }>;
  failed: Array<{ id: string; providerId: AccountProviderId; error: string }>;
}

/** The command each CLI runs to load (and refresh) its stored login. */
export function keepAliveCommand(provider: AccountProviderId): { command: string; args: string[] } {
  if (provider === 'codex') return { command: 'codex', args: ['login', 'status'] };
  const override = process.env.SIDEKICK_CLAUDE_KEEPALIVE_ARGS?.trim();
  return { command: 'claude', args: override ? override.split(/\s+/) : ['auth', 'status'] };
}

/** How long a keep-alive lease outlives the CLI timeout before it lapses on its own. */
const LEASE_GRACE_MS = 30_000;

const defaultRunner: KeepAliveRunner = (command, args, env, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { encoding: 'utf8', env, timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true },
        (error, stdout) => {
          const status = error
            ? (((error as { code?: unknown }).code as number | null) ?? null)
            : 0;
          resolve({
            status: typeof status === 'number' ? status : null,
            stdout: String(stdout ?? ''),
          });
        },
      );
    } catch {
      resolve({ status: null, stdout: '' });
    }
  });

function eligible(view: AccountView, includeFresh: boolean): string | null {
  if (view.health.isLive) return 'live account; the CLI refreshes it in normal use';
  if (view.health.state === 'expired') return 'expired; sign in again';
  if (view.health.state === 'missing') return 'no stored credentials';
  if (view.health.state === 'fresh' && !includeFresh) return 'fresh';
  if (view.providerId === 'codex' && view.health.state === 'unknown') return 'api-key login';
  return null;
}

/**
 * Serialised, bounded refresh of every inactive account that is `expiring`
 * (or `unknown` for Claude). Never touches the live account or any copy of
 * its chain.
 */
export async function refreshInactiveAccounts(
  options: RefreshInactiveAccountsOptions = {},
): Promise<RefreshInactiveAccountsResult> {
  const result: RefreshInactiveAccountsResult = { refreshed: [], skipped: [], failed: [] };
  const timeoutMs = options.timeoutMs ?? 20_000;
  const runner = options.runner ?? defaultRunner;
  const views = listAccountsWithHealth(undefined, { now: options.now }).filter(
    (view) => !options.providers || options.providers.includes(view.providerId),
  );

  for (const view of views) {
    const reason = eligible(view, options.includeFresh ?? false);
    if (reason) {
      result.skipped.push({ id: view.id, providerId: view.providerId, reason });
      continue;
    }
    const isClaude = view.providerId === 'claude-code';
    if (isClaude && options.dryRun) {
      const blocker = getClaudeKeepAliveBlocker(view.id);
      if (blocker) {
        result.skipped.push({ id: view.id, providerId: view.providerId, reason: blocker });
        continue;
      }
    }
    const { command, args } = keepAliveCommand(view.providerId);
    if (options.dryRun) {
      result.skipped.push({
        id: view.id,
        providerId: view.providerId,
        reason: `dry run: would run ${command} ${args.join(' ')}`,
      });
      continue;
    }
    if (isClaude) {
      const begin = beginClaudeKeepAlive(view.id, timeoutMs + LEASE_GRACE_MS);
      if (!begin.ok) {
        result.skipped.push({ id: view.id, providerId: view.providerId, reason: begin.reason });
        continue;
      }
    }
    const launch = getAccountLaunchEnv(view.providerId, view.id, {
      materialize: true,
      restoreBackup: false,
    });
    if (launch.error) {
      if (isClaude) finishClaudeKeepAlive(view.id);
      result.skipped.push({ id: view.id, providerId: view.providerId, reason: launch.error });
      continue;
    }
    const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
    for (const name of launch.envUnset) delete env[name];
    try {
      let run: Awaited<ReturnType<KeepAliveRunner>>;
      try {
        run = await runner(command, args, env, timeoutMs);
      } finally {
        if (isClaude) finishClaudeKeepAlive(view.id);
      }
      const after = getAccountHealth(view.providerId, view.id, {
        probe: 'store',
        now: options.now,
      });
      if (after.state === 'fresh') {
        result.refreshed.push({ id: view.id, providerId: view.providerId });
      } else {
        result.failed.push({
          id: view.id,
          providerId: view.providerId,
          error:
            run.status === 0
              ? `${command} ran but the stored credential is still ${after.state}.`
              : `${command} exited with status ${run.status ?? 'unknown'}.`,
        });
      }
    } catch (err) {
      result.failed.push({ id: view.id, providerId: view.providerId, error: String(err) });
    }
  }
  return result;
}
