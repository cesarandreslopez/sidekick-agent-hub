# Phase 03 — Login-orchestration facade (`accountManager.ts`)

**Workstream:** WS3 · **Package:** `sidekick-shared` · **Depends on:** 01, 02 · **Blocks:** 04, 07, 08, 09

## Goal

Expose a single, provider-agnostic, **headless-capable** API that a TTY-less desktop (or the CLI) can use to
acquire a new account: begin an isolated login → poll for completion → finalize (register + optionally
activate). Plus a turnkey `spawnAccountLogin` helper for Node/TTY hosts (the CLI). This is the API that
unblocks contextful issue #203 (Option A).

See `api-contract.md` for the exact, authoritative signatures. This file is the implementation recipe.

## Files to touch

- **New:** `sidekick-shared/src/accountManager.ts`.
- **New:** `sidekick-shared/src/accountManager.test.ts`.
- Reuse: `claudeProfiles.ts` (01), `credentialIO.ts` (02), `accounts.ts`, `codexProfiles.ts`,
  `accountRegistry.ts`, `accountStatus.ts`.
- Reuse the existing `AccountProviderId` from `accountRegistry.ts:5` (`'claude-code' | 'codex'`) — **do not
  redefine it.**

## Step-by-step

### `beginAccountLogin(provider, label)` — pure setup, spawns nothing

- **Codex:** call `prepareCodexAccount(label)` (`codexProfiles.ts:366`). If it returns `needsLogin:false`
  (auth was importable and it auto-finalized), return `{ success:true, loginId: profileId, alreadyComplete:true }`.
  Otherwise return:
  ```ts
  { success:true, loginId: profileId, command:'codex', args:['login'],
    env:{ CODEX_HOME: codexHome }, configDir: codexHome }
  ```
- **Claude:** generate a `uuid`, compute `home = getClaudeProfileHome(uuid)`, `mkdir -p` it (`0o700`), write a
  small pending-profile marker (`{ label, addedAt }`, mirror `codexProfiles.ts:159 writePendingProfile`), and
  return:
  ```ts
  { success:true, loginId: uuid, command: resolveClaudeLoginCommand().command,
    args: resolveClaudeLoginCommand().args, env:{ CLAUDE_CONFIG_DIR: home }, configDir: home }
  ```
  Implement `resolveClaudeLoginCommand()` to pick the right invocation for the installed `claude` (see
  **Risk: login command** below). Default to `{ command:'claude', args:['/login'] }`; allow override via an
  options arg and/or `SIDEKICK_CLAUDE_LOGIN_ARGS`.

### `getAccountLoginStatus(provider, loginId)` — poll, no side effects

- **Codex:** `isCodexProfileAuthenticated(getCodexProfileHome(loginId))` (`codexProfiles.ts:325`) →
  `authenticated` else `pending`. Include `email` from `readCodexAccountMetadata` when available.
- **Claude:** `isClaudeProfileAuthenticated(getClaudeProfileHome(loginId))` (Phase 01) → `authenticated`,
  with `email` from `readClaudeProfileIdentity`; else `pending`.
- Return `{ state: 'pending'|'authenticated'|'failed', email? }`. `failed` is reserved for callers that
  detect a dead child process / timeout (the helper sets it; the bare poll returns `pending`/`authenticated`).

### `finalizeAccountLogin(provider, loginId, opts?)` — register + optionally activate

- **Codex:** delegate to `finalizeCodexAccount(loginId)` (`codexProfiles.ts:407`). If `opts.activate === false`,
  skip the swap (finalize currently activates; thread an `activate` flag through, or call the registry
  upsert without `performCodexAuthSwap`). Preserve the OS-keyring warning path (`codexProfiles.ts:432`).
- **Claude:** the new logic —
  1. `home = getClaudeProfileHome(loginId)`; `id = readClaudeProfileIdentity(home)`; error if `null`.
  2. Read isolated credentials: `readActiveCredentials(home)` (Phase 02) and the `oauthAccount` from
     `<home>/.claude.json`.
  3. Persist into the existing backup layout keyed by `id.uuid`: write
     `credentials/{uuid}.credentials.json` and `configs/{uuid}.config.json` (reuse `accounts.ts` writers /
     `getCredentialsDir`:67, `getConfigsDir`:71). This keeps the registry format unchanged.
  4. Register via the registry: `upsertSavedAccountProfile({ id:uuid, providerId:'claude-code',
     providerAccountId:uuid, email, label, addedAt, metadata:{email} })` (`accountRegistry.ts:163`).
  5. If `opts.activate !== false`: call the switch path (Phase 04 `switchToAccount(uuid)`), which applies to
     the live home. If `activate:false`, just leave the registry entry.
  6. Clean up the isolated profile dir (or keep it as the per-account profile home — **keep it**, since
     Phase 04 treats profile homes as canonical; delete only the pending marker).
- Return `AccountManagerResult` (`accounts.ts:41`).

### `spawnAccountLogin(provider, label, opts?)` — turnkey for Node/TTY hosts

- `const begin = beginAccountLogin(provider, label)`; if `alreadyComplete`, `return finalizeAccountLogin(...)`.
- Spawn `begin.command begin.args` with `env: { ...process.env, ...begin.env }` and `stdio: opts.stdio ?? 'inherit'`.
  (This is the headless-safe replacement for the CLI's `runCodexLogin` at `account.ts:211`.)
- Poll `getAccountLoginStatus` every ~2s up to `opts.timeoutMs ?? 180_000` (ai-switcher uses 90×2s),
  calling `opts.onStatus?.(s)` each tick; honor `opts.signal` (AbortController). On `authenticated` →
  `finalizeAccountLogin(provider, begin.loginId, { activate: opts.activate ?? true })`. On child exit before
  auth → one final status check, else `{ success:false, error:'login did not complete' }`.

### Thin generic wrappers

- `switchAccount(provider, id)` → `provider==='codex' ? switchToCodexAccount(id) : switchToAccount(id)`.
- `listAllAccounts()` → `{ claude: listAccounts(), codex: listCodexAccounts(), activeByProvider: readSavedAccountRegistry()?.activeByProvider }`.

## Risk: the `claude` login command

`claude` login invocation differs across CLI versions: `claude /login` (REPL slash command), bare `claude`
(first-run prompt), or `claude auth login` (used by ai-switcher `tools.rs:552`). `resolveClaudeLoginCommand()`
must be robust: probe `claude --help` / version if cheap, default to `['/login']`, and allow an override
param + env var. Document the chosen default in `api-contract.md`. **Validate manually on a real machine
during Phase 07** before relying on it.

## Acceptance criteria / tests

- `beginAccountLogin('claude-code','work')` returns `command/args/env.CLAUDE_CONFIG_DIR/configDir` and creates
  the profile home; `beginAccountLogin('codex','work')` returns `env.CODEX_HOME` (mock `prepareCodexAccount`).
- `getAccountLoginStatus` flips `pending → authenticated` once a fake credential + identity appear in the
  profile home (mock `process.platform` + fs/keychain).
- `finalizeAccountLogin('claude-code', id)` writes the backup files, upserts the registry entry, and (default)
  activates; with `{activate:false}` it registers without switching.
- `spawnAccountLogin` resolves success when a mocked child + a fake credential appear; respects `signal`
  abort and `timeoutMs`.
- `switchAccount`/`listAllAccounts` route to the right per-provider functions.

## Done-when

`npx vitest run src/accountManager.test.ts` passes; the four core functions + two wrappers exist and match
`api-contract.md`. (Exported from `index.ts` in Phase 09.) Update tracker row 03.
