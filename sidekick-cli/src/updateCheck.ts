/**
 * npm update check behind the dashboard's version badge and the one-shot
 * commands' "update available" notice.
 *
 * The registry is asked at most once per {@link UPDATE_CHECK_TTL_MS}; every
 * other run answers from `update-check.json` in the config directory, which
 * both surfaces share. A one-shot command starts the check in Commander's
 * `preAction` hook, so the fetch overlaps the command's own work, and collects
 * it in `postAction`. A short abort bounds the wait, so a fast command never
 * stalls for long and no detached helper process is needed (a Node SEA build
 * could not spawn one the way `node script.js` can).
 */

declare const __CLI_VERSION__: string;

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { getConfigDir } from 'sidekick-shared';
import { atomicWriteJsonSync } from 'sidekick-shared/node';

// ── Types ──

export interface UpdateInfo {
  current: string;
  latest: string;
}

/** Contents of `update-check.json`. Pre-0.30.1 files hold only `latest` and `checkedAt`. */
export interface UpdateCheckCache {
  /** Newest version npm reported; absent until a fetch has succeeded. */
  latest?: string;
  /** Last registry attempt, successful or not (epoch ms). */
  checkedAt: number;
  /** When the one-shot notice was last printed (epoch ms). */
  notifiedAt?: number;
  /** The version that notice announced. */
  notifiedVersion?: string;
}

export interface ResolveLatestOptions {
  /** False answers from the cache alone, however old it is. */
  allowFetch: boolean;
  /** Registry timeout. */
  timeoutMs: number;
  configDir?: string;
  now?: () => number;
  fetchLatest?: (signal: AbortSignal) => Promise<string>;
}

export interface ResolvedLatest {
  latest: string | null;
  /** The cache as it stands after this resolution (what was read or written). */
  cache: UpdateCheckCache | null;
}

export interface UpdateNoticeOptions {
  allowFetch: boolean;
  current?: string;
  timeoutMs?: number;
  configDir?: string;
  now?: () => number;
  fetchLatest?: (signal: AbortSignal) => Promise<string>;
}

export interface UpdateNoticeHandle {
  /** Settles the check and returns the notice text, or null when nothing should be printed. */
  finish(): Promise<string | null>;
}

export interface UpdateNoticeContext {
  commandToken: string | undefined;
  json: boolean;
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
}

// ── Constants ──

export const NPM_PACKAGE = 'sidekick-agent-hub';
const REGISTRY_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
const RELEASE_URL_PREFIX = 'https://github.com/cesarandreslopez/sidekick-agent-hub/releases/tag/v';
export const UPDATE_CHECK_CACHE_FILE = 'update-check.json';
/** How long a registry answer, or a failed attempt, is reused. */
export const UPDATE_CHECK_TTL_MS = 4 * 60 * 60 * 1000;
/** The one-shot notice repeats for the same version at most this often (twice a day). */
export const UPDATE_NOTICE_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Registry budget for one-shot commands, measured from the start of the command. */
export const UPDATE_NOTICE_TIMEOUT_MS = 2000;
const DASHBOARD_TIMEOUT_MS = 5000;

/**
 * Commands that never print the notice: `statusline` runs on every shell
 * prompt, `mcp` owns stdout/stdin for the protocol, and `dashboard` shows the
 * newer version in its own status bar.
 */
const NOTICE_EXCLUDED_COMMANDS = new Set(['statusline', 'mcp', 'dashboard']);

// ── Version comparison ──

function parseVersion(version: string): { core: number[]; prerelease: boolean } {
  const cleaned = version.trim().replace(/^v/, '');
  const [core] = cleaned.split('+', 1);
  const dash = core.indexOf('-');
  const numbers = (dash === -1 ? core : core.slice(0, dash))
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return { core: numbers, prerelease: dash !== -1 };
}

/**
 * Compare two semver strings. Returns true if `a` is newer than `b`.
 * A pre-release suffix sorts below its release (`1.0.0-beta` < `1.0.0`); two
 * pre-releases of the same core compare equal, since npm's `latest` tag never
 * points at one.
 */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const va = pa.core[i] ?? 0;
    const vb = pb.core[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return !pa.prerelease && pb.prerelease;
}

// ── Cache ──

function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+/.test(value);
}

export function readUpdateCache(configDir: string = getConfigDir()): UpdateCheckCache | null {
  try {
    const cachePath = path.join(configDir, UPDATE_CHECK_CACHE_FILE);
    if (!fs.existsSync(cachePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.checkedAt !== 'number' || !Number.isFinite(parsed.checkedAt)) return null;
    const cache: UpdateCheckCache = { checkedAt: parsed.checkedAt };
    if (isVersionString(parsed.latest)) cache.latest = parsed.latest;
    if (typeof parsed.notifiedAt === 'number') cache.notifiedAt = parsed.notifiedAt;
    if (isVersionString(parsed.notifiedVersion)) cache.notifiedVersion = parsed.notifiedVersion;
    return cache;
  } catch {
    // Corrupt or unreadable cache: treat as absent.
    return null;
  }
}

export function writeUpdateCache(
  cache: UpdateCheckCache,
  configDir: string = getConfigDir(),
): void {
  try {
    atomicWriteJsonSync(path.join(configDir, UPDATE_CHECK_CACHE_FILE), cache);
  } catch {
    // Non-fatal: the next run simply checks again.
  }
}

// ── Registry ──

export async function fetchLatestVersion(signal: AbortSignal): Promise<string> {
  const res = await fetch(REGISTRY_URL, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Registry returned ${res.status}`);
  const data = (await res.json()) as { version?: unknown };
  if (!isVersionString(data.version)) throw new Error('Registry response has no version');
  return data.version;
}

/**
 * The newest published version, from the cache while it is fresh and from the
 * registry otherwise. A failed fetch still stamps `checkedAt` (keeping the last
 * known `latest`), so an offline machine waits out the TTL instead of paying
 * the timeout on every command.
 */
export async function resolveLatestVersion(options: ResolveLatestOptions): Promise<ResolvedLatest> {
  const now = options.now ?? Date.now;
  const configDir = options.configDir ?? getConfigDir();
  const cached = readUpdateCache(configDir);
  const age = cached ? now() - cached.checkedAt : Infinity;
  const fresh = age >= 0 && age < UPDATE_CHECK_TTL_MS;
  if (fresh || !options.allowFetch) {
    return { latest: cached?.latest ?? null, cache: cached };
  }

  const fetchLatest = options.fetchLatest ?? fetchLatestVersion;
  let next: UpdateCheckCache;
  try {
    const latest = await fetchLatest(AbortSignal.timeout(options.timeoutMs));
    next = { ...cached, latest, checkedAt: now() };
  } catch {
    next = { ...cached, checkedAt: now() };
  }
  writeUpdateCache(next, configDir);
  return { latest: next.latest ?? null, cache: next };
}

// ── Dashboard ──

/** One-shot check for the TUI dashboard, which shows the result in its status bar. */
export class UpdateCheckService {
  private _callback: ((info: UpdateInfo | null) => void) | null = null;

  /** Register a callback for the update check result. */
  onResult(cb: (info: UpdateInfo | null) => void): void {
    this._callback = cb;
  }

  /** Run the update check (one-shot). */
  async check(): Promise<void> {
    try {
      const current = __CLI_VERSION__;
      const { latest } = await resolveLatestVersion({
        allowFetch: true,
        timeoutMs: DASHBOARD_TIMEOUT_MS,
      });
      this._callback?.(latest && isNewer(latest, current) ? { current, latest } : null);
    } catch {
      this._callback?.(null);
    }
  }
}

// ── One-shot command notice ──

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

/**
 * Whether this command run may print the update notice. The notice is for a
 * person at a terminal, so machine-facing runs are left alone: `--json`, CI,
 * piped or redirected output, and the commands in
 * {@link NOTICE_EXCLUDED_COMMANDS}. `SIDEKICK_NO_UPDATE_NOTIFIER=1` (or the
 * cross-tool `NO_UPDATE_NOTIFIER`) turns it off entirely.
 */
export function shouldRunUpdateNotice(context: UpdateNoticeContext): boolean {
  const { commandToken, env } = context;
  if (commandToken === undefined || commandToken.startsWith('-')) return false;
  if (NOTICE_EXCLUDED_COMMANDS.has(commandToken)) return false;
  if (context.json) return false;
  if (envFlag(env.SIDEKICK_NO_UPDATE_NOTIFIER) || envFlag(env.NO_UPDATE_NOTIFIER)) return false;
  if (envFlag(env.CI)) return false;
  return context.stdoutIsTTY && context.stderrIsTTY;
}

export function formatUpdateNotice(current: string, latest: string): string {
  const install = chalk.cyan(`npm install -g ${NPM_PACKAGE}`);
  return [
    '',
    `${chalk.yellow('Update available:')} sidekick ${chalk.dim(current)} → ${chalk.green(latest)} — run ${install}`,
    chalk.dim(`Release notes: ${RELEASE_URL_PREFIX}${latest}`),
    '',
  ].join('\n');
}

/**
 * Start the check without blocking the command. `finish()` settles it (bounded
 * by `timeoutMs` from the start) and returns the notice when a newer version
 * exists and the same version was not announced in the last
 * {@link UPDATE_NOTICE_INTERVAL_MS}. A version newer than the one last
 * announced is shown straight away.
 */
export function startUpdateNotice(options: UpdateNoticeOptions): UpdateNoticeHandle {
  const now = options.now ?? Date.now;
  const configDir = options.configDir ?? getConfigDir();
  const current = options.current ?? __CLI_VERSION__;
  const pending = resolveLatestVersion({
    allowFetch: options.allowFetch,
    timeoutMs: options.timeoutMs ?? UPDATE_NOTICE_TIMEOUT_MS,
    configDir,
    now,
    fetchLatest: options.fetchLatest,
  }).catch((): ResolvedLatest => ({ latest: null, cache: null }));

  return {
    async finish() {
      const { latest, cache } = await pending;
      if (!latest || !cache || !isNewer(latest, current)) return null;
      const at = now();
      const sinceLast = cache.notifiedAt === undefined ? Infinity : at - cache.notifiedAt;
      const shownRecently =
        cache.notifiedVersion === latest && sinceLast >= 0 && sinceLast < UPDATE_NOTICE_INTERVAL_MS;
      if (shownRecently) return null;
      writeUpdateCache({ ...cache, notifiedAt: at, notifiedVersion: latest }, configDir);
      return formatUpdateNotice(current, latest);
    },
  };
}
