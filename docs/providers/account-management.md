# Account Management

Sidekick account management lets Node hosts acquire, list, and switch Claude Max and Codex CLI accounts through
`sidekick-shared`. The API is designed for desktop apps, VS Code extension hosts, and CLIs that need isolated
login flows without reimplementing Claude/Codex credential detection.

Requires `sidekick-shared@^0.21.0`.

## Account State

Use the provider-neutral helpers when building account switchers:

```ts
import { getActiveAccountStatus, listAllAccounts, switchAccount } from 'sidekick-shared';

const status = getActiveAccountStatus();
const all = listAllAccounts();

const result = switchAccount('claude-code', 'account-uuid');
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

## TTY-Less Login

`beginAccountLogin` creates an isolated profile and returns the command a host should run. It does not spawn a
process and does not change the active account.

```ts
import { beginAccountLogin, getAccountLoginStatus, finalizeAccountLogin } from 'sidekick-shared';

const begin = beginAccountLogin('claude-code', 'Work');
if (!begin.success) throw new Error(begin.error);

if (begin.alreadyComplete) {
  const res = finalizeAccountLogin('codex', begin.loginId, { activate: true });
  if (!res.success) throw new Error(res.error);
} else {
  // Spawn begin.command with begin.args in your terminal or PTY.
  // Merge begin.env into the child environment.

  while (getAccountLoginStatus('claude-code', begin.loginId).state === 'pending') {
    await sleep(2000);
  }

  const res = finalizeAccountLogin('claude-code', begin.loginId, { activate: true });
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

`sidekick-shared` exports Zod schemas from both the package root and `sidekick-shared/schemas`:

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

Available account-management schemas:

| Schema                          | Validates                                      |
| ------------------------------- | ---------------------------------------------- |
| `accountProviderIdSchema`       | `'claude-code'` or `'codex'`                   |
| `beginAccountLoginResultSchema` | login begin success/failure payloads           |
| `accountLoginStatusSchema`      | `pending`, `authenticated`, or `failed` status |
| `accountManagerResultSchema`    | switch/finalize result payloads                |
| `accountEntrySchema`            | Claude account registry entries                |
| `savedAccountProfileSchema`     | provider-neutral saved account profiles        |
| `listAllAccountsResultSchema`   | provider-neutral account list payloads         |

## Operational Notes

- Browser OAuth is interactive; the host must present the spawned Claude or Codex login terminal.
- macOS may show keychain prompts during finalize or switch.
- Codex OS-keyring accounts can return `success: true` with a warning when credentials cannot be file-swapped.
- Switching while sessions are running may require reinitializing provider clients so new credentials are used.
- Claude login arguments can vary by CLI version; override with `opts.loginCommand` or `SIDEKICK_CLAUDE_LOGIN_ARGS`.
