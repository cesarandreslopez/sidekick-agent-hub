# Integration Guide — consuming account management 2.0 from a TTY-less desktop

Audience: any downstream consumer of the `sidekick-agent-hub` npm package (`sidekick-shared`) that runs in a
Node host without a TTY — e.g. an Electron/Tauri **sidecar**. This is the exact recipe that lets such an app
build the full "Manage accounts" UX (the goal of `contextful_desktop` issue #203, Option A). **It documents
how to consume sidekick; it does not modify the consumer.**

Requires **`sidekick-agent-hub@^0.21.0`** (the acquisition API + Zod schemas land in 0.21.0; consumers on
0.18.5 only have switch-between-saved).

## What already works today (issue Option B — switch between saved)

These are pure local file I/O and need no login:

```ts
import { getActiveAccountStatus, listAllAccounts, switchAccount } from 'sidekick-agent-hub';

const status = getActiveAccountStatus();           // { claude:{present,email}, codex:{present,email} }
const all = listAllAccounts();                      // { claude:[…], codex:[…], activeByProvider }
switchAccount('claude-code', someUuid);             // or switchAccount('codex', profileId)
```

The reason the desktop's registry looks empty is that **nothing has acquired accounts yet** — that's Option A.

## Acquiring a NEW account (issue Option A) — the call sequence

The host owns the login process (so it can present a terminal / PTY however it likes). Sidekick handles the
isolation and completion detection.

```ts
import {
  beginAccountLogin, getAccountLoginStatus, finalizeAccountLogin, getActiveAccountStatus,
} from 'sidekick-agent-hub';

// 1) Begin — isolated profile; spawns nothing. Never disturbs the active account.
const begin = beginAccountLogin('claude-code', 'Work');   // or ('codex', 'Work')
if (!begin.success) throw new Error(begin.error);
if (begin.alreadyComplete) {                               // Codex: existing auth was importable
  finalizeAccountLogin('codex', begin.loginId, { activate: true });
} else {
  // 2) Spawn the returned command in YOUR pty/terminal with the returned env merged in.
  //    e.g. node-pty: pty.spawn(begin.command!, begin.args!, { env: { ...process.env, ...begin.env } })
  //    The user completes the browser OAuth in that terminal.

  // 3) Poll until authenticated (or your own timeout). ~2s cadence; ~3min is typical.
  //    getAccountLoginStatus has no side effects.
  //    while (getAccountLoginStatus('claude-code', begin.loginId).state === 'pending') await sleep(2000);

  // 4) Finalize — registers the account and (default) makes it active via the live-home apply.
  const res = finalizeAccountLogin('claude-code', begin.loginId, { activate: true });
  if (!res.success) throw new Error(res.error);
  if (res.warning) /* surface to the user (e.g. Codex OS-keyring note) */;
}

// 5) Refresh your UI.
const status = getActiveAccountStatus();
```

### Turnkey variant (if your host can run the child for you)

```ts
import { spawnAccountLogin } from 'sidekick-agent-hub';
const res = await spawnAccountLogin('codex', 'Work', {
  stdio: 'inherit',                 // or 'pipe' and forward to your UI terminal
  onStatus: s => updateUi(s),
  timeoutMs: 180_000,
});
```

Use this when you have a place to host the process (VS Code integrated terminal, a spawned `Terminal.app`,
an embedded xterm). Prefer the explicit begin/poll/finalize sequence when you want full control of the
terminal UX.

## Suggested sidecar IPC mapping (for contextful, informational)

The issue notes that `src/sidecar/handlers/accounts.ts` exposes only the read-only `ensureSidekickAccounts`.
A minimal wiring adds handlers that delegate straight to the facade:

| IPC command | Delegates to |
|---|---|
| `listAccounts` | `listAllAccounts()` |
| `switchAccount` | `switchAccount(provider, id)` |
| `beginAccountLogin` | `beginAccountLogin(provider, label)` |
| `getAccountLoginStatus` | `getAccountLoginStatus(provider, loginId)` |
| `finalizeAccountLogin` | `finalizeAccountLogin(provider, loginId, { activate })` |

**Zod parity:** `sidekick-agent-hub` exports Zod schemas for every result shape
(`accountManagerResultSchema`, `beginAccountLoginResultSchema`, `accountLoginStatusSchema`,
`listAllAccountsResultSchema`, …). Use them directly in the sidecar's outbound-envelope validation so the
`contracts.test.ts` TS+Zod parity check passes without hand-writing schemas.

## Caveats to handle in the UI

- **Browser OAuth is interactive.** The host must present the spawned `claude`/`codex` login terminal and let
  the user finish the browser flow. Sidekick detects completion; it does not automate the browser.
- **macOS keychain prompts** can appear during finalize/switch (credentials are read/written via `security`).
- **Codex OS-keyring accounts** can't be file-swapped; `switch`/`finalize` return a `warning` — show it.
- **Switching mid-session** may require the consumer to reinitialize provider tokens/models (e.g. a workspace
  reinit) so running sessions pick up the new account.
- The `claude` login invocation can vary by CLI version; override via `opts.loginCommand` if your environment
  needs it.
