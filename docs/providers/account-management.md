# Account Management

This page is the `sidekick-shared` API guide. For the end-user walkthrough (VS Code Accounts view, status bar,
`sidekick accounts`, credential health, parallel sessions, platform notes) see
[Account Switcher](../features/account-switcher.md).

Sidekick account management lets Node hosts acquire, list, and switch Claude Max and Codex CLI accounts through
`sidekick-shared`. The API is designed for desktop apps, VS Code extension hosts, and CLIs that need isolated
login flows without reimplementing Claude/Codex credential detection.

Requires `sidekick-shared@^0.25.0`. Every login and switch entry point comes in a sync and an async form
(`switchAccount`/`switchAccountAsync`, `getAccountLoginStatus`/`getAccountLoginStatusAsync`,
`finalizeAccountLogin`/`finalizeAccountLoginAsync`, `prepareCodexAccount`/`prepareCodexAccountAsync`,
`finalizeCodexAccount`/`finalizeCodexAccountAsync`, `switchToCodexAccount`/`switchToCodexAccountAsync`).
The sync forms probe the `codex` CLI with blocking child processes (up to a few seconds) and are meant for
one-shot CLI callers; hosts with a UI event loop — extension hosts, desktop apps — should use the async forms,
which run the same probes off the loop. On `sidekick-shared` 0.21.0–0.24.4 only the sync forms exist.

## Account State

Use the provider-neutral helpers when building account switchers:

```ts
import { getActiveAccountStatus, listAllAccounts, switchAccountAsync } from 'sidekick-shared';

const status = getActiveAccountStatus();
const all = listAllAccounts();

const result = await switchAccountAsync('claude-code', 'account-uuid');
if (!result.success) throw new Error(result.error);
if (result.warning) showWarning(result.warning);
```

`listAllAccounts()` returns Claude entries, Codex profiles, and active account ids keyed by provider:

```ts
type AccountProviderId = 'claude-code' | 'codex';

interface ListAllAccountsResult {
  claude: AccountEntry[];
  codex: SavedAccountProfile[];
  activeByProvider: Record<AccountProviderId, string | null>;
}
```

### Live vs. saved active account

The `activeByProvider` ids above come from the saved registry pointer, which only Sidekick's own switch flow
updates. For **display** surfaces that must reflect the account a user is actually logged into — even after a
native `claude /login` or `codex login` outside Sidekick — use the live-first resolvers instead:

```ts
import { resolveActiveClaudeAccount, resolveActiveCodexAccount } from 'sidekick-shared';
import type { ResolvedActiveAccount } from 'sidekick-shared';

const claude: ResolvedActiveAccount = resolveActiveClaudeAccount();
// claude.source === 'live'     → from live provider auth (label set when it matches a saved profile)
// claude.source === 'registry' → no usable live identity; fell back to the saved active pointer
// claude.source === 'none'     → neither a live identity nor a saved active account

const codex = resolveActiveCodexAccount();
```

Each resolver prefers the live provider auth (`~/.claude/.claude.json` oauthAccount; the `~/.codex/auth.json`
id_token JWT) over the saved pointer, falls back to the registry, and — on an unambiguous match to a saved
profile — self-heals the `activeByProvider` pointer so registry-keyed data (quota history, auto-switch) tracks
the real account. Self-heal is best-effort and never creates or deletes profiles; an unknown live account is
shown as-is with no label.

### React to account changes

Instead of polling `getActiveAccountStatus()`, subscribe to `onAccountsChanged()` (0.25.0). It combines
process-local mutation signals, filesystem watches on the account stores, and a low-frequency catch-up poll,
and emits only when the status actually changed:

```ts
import { onAccountsChanged } from 'sidekick-shared';

const subscription = onAccountsChanged(
  ({ reason, status }) => {
    // reason: 'local' | 'filesystem' | 'poll'
    refreshAccountSwitcher(status.claude, status.codex);
  },
  { emitCurrent: true },
);
// later: subscription.dispose();
```

The library's own quota services (`QuotaPoller`, `MultiProviderQuotaService`, `CodexQuotaWatcher`) subscribe
to the same signal: they stay dormant while no matching account exists and wake when one appears.

## Sync and Health (0.26.6)

The live homes (`CLAUDE_CONFIG_DIR` or `~/.claude`; `CODEX_HOME` or `~/.codex`) are the source of truth for
which account is logged in; saved profiles are backups that `syncLiveAccountState()` keeps fresh. One sync
registers logins the registry has never seen (label = email, `metadata.origin: 'live-sync'`), folds the live
credential into its profile when it is newer (Claude: `expiresAt`; Codex: `last_refresh`), merges duplicate
Codex profiles for one workspace (oldest keeps id and label; losers are stashed under `accounts/codex/stash/`),
and re-points the active pointer silently. `ensureDefaultAccounts()` runs it at startup after removing
abandoned isolated logins; `onAccountsChanged()` runs it on every filesystem or poll event before reporting.

```ts
import { syncLiveAccountState, listAccountsWithHealth, getAccountHealth } from 'sidekick-shared';

const report = await syncLiveAccountState({ reason: 'manual' });
report.claude.registered; // { id, email } when a live login was learned

for (const view of listAccountsWithHealth()) {
  view.health.state; // 'fresh' | 'expiring' | 'expired' | 'unknown' | 'missing'
  view.health.refreshExpiresAt; // ms since epoch; `refreshExpiryEstimated` when derived from the snapshot age
  view.source; // 'learned' (auto-registered) | 'registered'
}
```

Health comes from a secret-free `health.json` sidecar next to each profile, written by every credential
store. `getAccountHealth(provider, id, { probe: 'cache' })` never spawns; `probe: 'store'` re-reads the stored
credential (a bounded Keychain call on macOS) and rewrites the sidecar. `listAccountsWithHealth` defaults to
`probe: 'auto'`, which probes only profiles that have no sidecar yet. Claude refresh tokens expire about three
weeks after issue; snapshots that predate the CLI recording that expiry are estimated and marked as such.

## Switch Result and Undo (0.26.6)

`switchAccount[Async]` returns a `SwitchAccountResult` (a superset of `AccountManagerResult`, so existing
callers compile):

```ts
const result = await switchAccountAsync('claude-code', id, { force: false, verifyWithCli: false });
result.verified; // the live store read back the written credential
result.verification; // 'store' | 'cli' | 'none' | 'failed' (failed → rolled back)
result.needsLogin; // the target's stored credential is expired or missing; nothing was written
result.runningConsumers; // [{ kind: 'claude-cli' | 'claude-desktop' | 'codex-cli' | 'codex-app' | 'vscode-extension-host', pids, switched, reachability }]
result.warnings; // per-consumer reachability sentences + health warnings (also joined into `warning`)
result.hints; // "New claude sessions use …"
result.undoToken; // pass to undoLastSwitch(provider, token) to revert; a newer switch invalidates it
result.alreadyActive; // the target was already live; nothing was written
```

The switch is two-phase: the live credential is folded into the outgoing profile first (registering it if
unknown), then the target is installed, verified by re-reading the store, and only then does the active
pointer move. `detectRunningAccountConsumers()` returns the same consumer list without switching;
`describeAccountConsumer(kind)` builds an entry for kinds the host detects itself (its own extension host).

## Isolated Launch (0.26.6)

```ts
import { getAccountLaunchEnv } from 'sidekick-shared';

const launch = getAccountLaunchEnv('codex', id); // { env: { CODEX_HOME }, envUnset, command, home, health, warnings, error? }
```

The env points a child `claude`/`codex` at the profile home without touching the live login. `envUnset` lists
variables the host must remove from the child (`CLAUDE_SECURESTORAGE_CONFIG_DIR` overrides Claude Code's
keychain naming). The helper refuses `expired`/`missing` profiles and warns when the profile is also live.

## Keep-Alive (0.26.6)

`refreshInactiveAccounts()` runs the official CLI (`claude auth status`, `codex login status`) inside each
inactive profile whose credential is `expiring`, then re-probes the store. It never touches the live account
and never calls OAuth endpoints. Hosts schedule it behind an opt-in setting.

## Codex Credential Store Requirement

`getCodexCredentialStoreMode()` reads `cli_auth_credentials_store` from `config.toml`. `keyring` (and `auto`
without an `auth.json`) cannot be switched: `prepareCodexAccount` refuses up front and `syncLiveAccountState`
reports `skipped: 'keyring'` with the fix (`cli_auth_credentials_store = "file"` followed by `codex login`).
Profile homes always get a `config.toml` forced to `"file"` so isolated logins write `auth.json`.

## Windows Notes

Credentials are plain files under `%USERPROFILE%\.claude` and `%USERPROFILE%\.codex`; atomic writes retry
transient `EPERM`/`EBUSY` sharing violations. Running consumers are detected with `tasklist`. The Claude
Desktop and Codex desktop apps are matched by image name (`Claude.exe`, `Codex.exe`).

## TTY-Less Login

`beginAccountLogin` creates an isolated profile and returns the command a host should run. It does not spawn a
process and does not change the active account.

```ts
import {
  beginAccountLogin,
  getAccountLoginStatusAsync,
  finalizeAccountLoginAsync,
} from 'sidekick-shared';

const begin = beginAccountLogin('claude-code', 'Work'); // runs `claude auth login` (or `codex login`)
if (!begin.success) throw new Error(begin.error);
// begin.env: variables to set; begin.envUnset: variables the child must NOT inherit.
// Pass { existingAccountId } to re-authenticate a saved profile in place.

if (begin.alreadyComplete) {
  const res = await finalizeAccountLoginAsync('claude-code', begin.loginId, { activate: true });
  if (!res.success) throw new Error(res.error);
} else {
  // Spawn begin.command with begin.args in your terminal or PTY.
  // Merge begin.env into the child environment.

  while ((await getAccountLoginStatusAsync('claude-code', begin.loginId)).state === 'pending') {
    await sleep(2000);
  }

  const res = await finalizeAccountLoginAsync('claude-code', begin.loginId, { activate: true });
  if (!res.success) throw new Error(res.error);
  if (res.warning) showWarning(res.warning);
}
```

For hosts that can let Sidekick spawn the child process, use the convenience wrapper:

```ts
import { spawnAccountLogin } from 'sidekick-shared';

const res = await spawnAccountLogin('codex', 'Work', {
  stdio: 'inherit',
  onStatus: (status) => updateLoginUi(status),
  timeoutMs: 180_000,
});
```

## Runtime Schemas

`sidekick-shared` exports Zod schemas from `sidekick-shared/schemas`; the package root re-exports only the pre-0.26.6 ones (`accountProviderIdSchema` through `listAllAccountsResultSchema`):

```ts
import {
  beginAccountLoginResultSchema,
  accountLoginStatusSchema,
  accountManagerResultSchema,
  listAllAccountsResultSchema,
} from 'sidekick-shared/schemas';
```

Use these at IPC or sidecar boundaries so runtime validation and TypeScript types stay aligned:

```ts
const payload = listAllAccountsResultSchema.parse(await sidecar.invoke('listAccounts'));
```

As of 0.25.0, account and quota entry points guarantee results that validate against the schemas exported in
the same release — re-parsing a value returned directly by the library is unnecessary; reserve `.parse()` for
data that crossed a process or IPC boundary.

Available account-management schemas:

| Schema                                     | Validates                                             |
| ------------------------------------------ | ----------------------------------------------------- |
| `accountProviderIdSchema`                  | `'claude-code'` or `'codex'`                          |
| `beginAccountLoginResultSchema`            | login begin success/failure payloads                  |
| `accountLoginStatusSchema`                 | `pending`, `authenticated`, or `failed` status        |
| `accountManagerResultSchema`               | switch/finalize result payloads                       |
| `accountEntrySchema`                       | Claude account registry entries                       |
| `savedAccountProfileSchema`                | provider-neutral saved account profiles               |
| `listAllAccountsResultSchema`              | provider-neutral account list payloads                |
| `accountHealthSchema`, `accountViewSchema` | per-account health and list views (0.26.6)            |
| `switchAccountResultSchema`                | verified switch results with consumers and undo token |
| `runningAccountConsumerSchema`             | running apps that hold a login                        |
| `syncReportSchema`                         | `syncLiveAccountState` reports                        |
| `accountLaunchEnvSchema`                   | isolated-launch environments                          |
| `lastSwitchRecordSchema`                   | undo records                                          |

## Operational Notes

- Browser OAuth is interactive; the host must present the spawned Claude or Codex login terminal.
- macOS may show a keychain prompt the first time `security` reads Claude Code's item.
- Codex OS-keyring logins are refused at add and switch time (see above); `finalizeCodexAccount` still returns
  `success: true` with a warning for a profile that authenticated into the keyring.
- Running consumers keep the previous account until they restart; `SwitchAccountResult.runningConsumers`
  names them. The Claude Desktop app is never switched.
- `claude auth login` is the default login command (0.26.6); override with `opts.loginCommand` or
  `SIDEKICK_CLAUDE_LOGIN_ARGS` for older CLIs. `spawnAccountLogin` treats `timeoutMs` as an inactivity budget
  and `maxTimeoutMs` (default 900 s) as the hard ceiling.
- The shell-hook helpers (`installShellHook`, `uninstallShellHook`, `isShellHookInstalled`,
  `setTerminalActiveProfile`) were removed in 0.26.6; use `getAccountLaunchEnv` and `writeLauncher`.
