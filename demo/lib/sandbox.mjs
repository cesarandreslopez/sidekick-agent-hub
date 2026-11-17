/**
 * A credential-free sandbox for recording: a fake home with its own Claude Code,
 * Codex, OpenCode and Sidekick folders, stub binaries for everything that could
 * reach a real login, and seeds that keep the dashboard off the network.
 *
 * It follows sidekick-shared/src/testing/credentialGuard.ts, plus two things the
 * test guard gets for free from its process and a recording does not:
 *
 * - CLAUDE_CONFIG_DIR is set explicitly. Without it, macOS keychain reads go to the
 *   real `Claude Code-credentials` item, whatever HOME says.
 * - update-check.json is seeded fresh. The dashboard's update check ignores
 *   SIDEKICK_NO_UPDATE_NOTIFIER and asks npm whenever the cache is stale.
 *
 * The root is short, neutral and hyphen-free on purpose (/tmp/acme): its paths
 * appear on screen, and some labels decode Claude's folder names by turning
 * every '-' back into '/'.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEMO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(DEMO_DIR);
export const SANDBOX_ROOT = process.env.SK_DEMO_ROOT ?? '/tmp/acme';
export const PROJECT_NAME = 'storefront';
const MARKER = '.sidekick-demo-sandbox';
/** Quota reset times are fixed relative to when this module loaded, so every process agrees. */
const SANDBOX_STARTED_AT = Date.now();
export const CLI_BIN = join(REPO_ROOT, 'sidekick-cli/dist/sidekick-cli.mjs');
export const NET_SHIM = join(DEMO_DIR, 'lib/net-shim.mjs');

const CLI_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'sidekick-cli/package.json'), 'utf8')).version;

/** Claude Code's project-folder name for a working directory. */
export function encodeClaudeProjectDir(absPath) {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function sandboxPaths(root = SANDBOX_ROOT) {
  const home = root;
  return {
    root,
    home,
    project: join(home, PROJECT_NAME),
    bin: join(root, '.demo-bin'),
    claudeHome: join(home, '.claude'),
    codexHome: join(home, '.codex'),
    xdgData: join(home, '.local', 'share'),
    config: join(home, '.config', 'sidekick'),
    vscodeUserData: join(root, '.vscode-demo', 'user-data'),
    vscodeExtensions: join(root, '.vscode-demo', 'extensions'),
  };
}

/** Where Claude Code would keep the sessions for the demo project. */
export function claudeSessionDir(paths = sandboxPaths()) {
  // Claude Code encodes the resolved cwd; on macOS /tmp resolves to /private/tmp.
  const resolved = existsSync(paths.project) ? realpathSync(paths.project) : paths.project;
  return join(paths.claudeHome, 'projects', encodeClaudeProjectDir(resolved));
}

const STUBS = {
  // Keychain: every lookup misses, nothing is ever written.
  security: '#!/bin/sh\necho "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2\nexit 44\n',
  claude: '#!/bin/sh\necho "claude is stubbed in the demo sandbox" >&2\nexit 1\n',
  codex: '#!/bin/sh\necho "codex is stubbed in the demo sandbox" >&2\nexit 1\n',
  open: '#!/bin/sh\nexit 0\n',
  'xdg-open': '#!/bin/sh\nexit 0\n',
};

/**
 * Create (or reset) the sandbox. `fresh` wipes it first; otherwise only the
 * per-take state (dashboard snapshots) is cleared.
 */
export function prepareSandbox({ fresh = false, root = SANDBOX_ROOT } = {}) {
  const paths = sandboxPaths(root);
  if (fresh && existsSync(root)) {
    // Only ever wipe a folder this module created.
    if (!existsSync(join(root, MARKER))) {
      throw new Error(`${root} exists and is not a demo sandbox (no ${MARKER}); refusing to delete it.`);
    }
    rmSync(root, { recursive: true, force: true });
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, MARKER), 'Created by demo/lib/sandbox.mjs. Safe to delete.\n');
  for (const dir of [paths.home, paths.project, paths.bin, paths.claudeHome, paths.codexHome, paths.xdgData, paths.config]) {
    mkdirSync(dir, { recursive: true });
  }
  for (const [name, body] of Object.entries(STUBS)) {
    const file = join(paths.bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }
  // Fresh update cache that already knows the current version: no fetch, no banner.
  writeFileSync(
    join(paths.config, 'update-check.json'),
    JSON.stringify({ latest: CLI_VERSION, checkedAt: Date.now() }, null, 2),
  );
  // Each take replays its session from the start.
  rmSync(join(paths.config, 'snapshots'), { recursive: true, force: true });
  seedAccountsAndQuota(paths);
  return paths;
}

/** Demo accounts. Only example.com addresses ever appear on screen. */
export const DEMO_ACCOUNTS = [
  { id: '0b6c2f9e-4d1a-4c3e-9a57-1f2e3d4c5b6a', providerId: 'claude-code', label: 'Work', email: 'dev@example.com' },
  { id: '5e8a1d7c-2b3f-4e6a-8c9d-0a1b2c3d4e5f', providerId: 'claude-code', label: 'Personal', email: 'me@example.com' },
  { id: '9c4b7a2e-6f1d-4b8c-a3e5-7d6c5b4a3f2e', providerId: 'codex', label: 'Work', email: 'dev@example.com' },
];

/**
 * Accounts and a fresh status-line quota sample for the active Claude account,
 * written relative to now. resolveQuota() answers from a fresh snapshot before it
 * looks for credentials, so the quota views show real-looking numbers offline.
 */
export function seedAccountsAndQuota(paths, now = Date.now()) {
  const iso = (ms) => new Date(ms).toISOString();
  const hour = 3_600_000;
  const accountsDir = join(paths.config, 'accounts');
  mkdirSync(accountsDir, { recursive: true });
  const registry = {
    version: 2,
    activeByProvider: { 'claude-code': DEMO_ACCOUNTS[0].id, codex: DEMO_ACCOUNTS[2].id },
    accounts: DEMO_ACCOUNTS.map((account, i) => ({
      id: account.id,
      providerId: account.providerId,
      addedAt: iso(now - (30 - i) * 86_400_000),
      label: account.label,
      email: account.email,
      metadata: { email: account.email, ...(account.providerId === 'claude-code' ? { planType: 'max' } : { planType: 'pro', authMode: 'chatgpt' }) },
    })),
  };
  writeFileSync(join(accountsDir, 'accounts.json'), JSON.stringify(registry, null, 2));

  // Health sidecars: expiry metadata only. Account health reads these first.
  DEMO_ACCOUNTS.forEach((account, i) => {
    const dir = join(accountsDir, account.providerId === 'codex' ? 'codex' : 'claude', 'profiles', account.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'health.json'),
      JSON.stringify({
        version: 1,
        capturedAt: now - (i + 1) * 9 * 60_000,
        accessExpiresAt: now + (5 + i) * hour,
        refreshExpiresAt: now + (17 - i * 3) * 24 * hour,
        hasRefreshToken: true,
        authMode: account.providerId === 'codex' ? 'chatgpt' : 'oauth',
        lastRefreshAt: now - (i + 1) * 9 * 60_000,
        source: 'login',
      }),
    );
  });

  const minute = 60_000;
  const claudeQuota = {
    fiveHour: { utilization: 38, resetsAt: iso(now + 133 * minute) },
    sevenDay: { utilization: 27, resetsAt: iso(now + 3 * 1440 * minute + 7 * 60 * minute) },
    available: true,
    providerId: 'claude-code',
    source: 'statusline',
    capturedSource: 'statusline',
    capturedAt: iso(now - 20_000),
    stale: false,
    planLabel: 'Max',
  };
  const snapshots = {
    version: 1,
    snapshots: [{ providerId: 'claude-code', accountId: DEMO_ACCOUNTS[0].id, quota: claudeQuota }],
  };
  writeFileSync(join(paths.config, 'quota-snapshots.json'), JSON.stringify(snapshots, null, 2));

  // A demo login for the live Claude home. The tokens are obviously fake and never
  // leave the machine: the network shims answer the usage endpoint locally and
  // refuse everything else. Without a login the dashboards' quota pollers report
  // "sign in required" instead of exercising the real quota path.
  writeFileSync(
    join(paths.claudeHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-DEMO-SANDBOX-NOT-A-REAL-TOKEN',
        refreshToken: 'sk-ant-ort01-DEMO-SANDBOX-NOT-A-REAL-TOKEN',
        expiresAt: now + 6 * hour,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      },
    }),
  );
  const oauthAccount = {
    accountUuid: 'd3f1a2b4-5c6d-4e7f-8091-a2b3c4d5e6f7',
    emailAddress: DEMO_ACCOUNTS[0].email,
    organizationUuid: 'e4a2b3c5-6d7e-4f80-91a2-b3c4d5e6f708',
    displayName: 'Dev',
    organizationName: 'Acme',
  };
  for (const file of [join(paths.claudeHome, '.claude.json'), join(paths.home, '.claude.json')]) {
    writeFileSync(file, JSON.stringify({ oauthAccount, hasCompletedOnboarding: true }));
  }
}

/** The usage the network shims report for the demo login (see net-shim.mjs and vscode-shim). */
export function demoQuota(now = Date.now()) {
  const minute = 60_000;
  return {
    five_hour: { utilization: 38, resets_at: new Date(now + 133 * minute).toISOString() },
    seven_day: { utilization: 27, resets_at: new Date(now + (3 * 1440 + 7 * 60) * minute).toISOString() },
    extra_usage: { is_enabled: false },
  };
}

/** Environment for any process that runs inside the sandbox. */
export function sandboxEnv(paths = sandboxPaths(), extra = {}) {
  const env = {
    PATH: `${paths.bin}:${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: join(paths.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(paths.home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: paths.claudeHome,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: paths.claudeHome,
    CODEX_HOME: paths.codexHome,
    XDG_DATA_HOME: paths.xdgData,
    XDG_CONFIG_HOME: join(paths.home, '.config'),
    SIDEKICK_CONFIG_DIR: paths.config,
    SIDEKICK_NO_UPDATE_NOTIFIER: '1',
    SIDEKICK_OFFLINE: '1',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    USER: 'demo',
    LOGNAME: 'demo',
    SHELL: '/bin/zsh',
    TZ: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Every node process in the sandbox gets the network shim (status pages answer
    // "operational", nothing else leaves the machine).
    NODE_OPTIONS: `--import=${pathToFileURL(NET_SHIM).href}`,
    SK_DEMO_QUOTA: JSON.stringify(demoQuota(SANDBOX_STARTED_AT)),
    ...extra,
  };
  return env;
}
