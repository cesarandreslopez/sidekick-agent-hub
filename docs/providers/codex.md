# Codex CLI

Uses your authenticated Codex CLI for inference.

## Setup

1. Install Codex CLI globally:
   ```bash
   npm install -g @openai/codex
   ```
2. Authenticate with `codex login`, or provide `OPENAI_API_KEY` / `CODEX_API_KEY`. Sidekick recognizes `auth.json` in the resolved Codex home (`CODEX_HOME` or `~/.codex/`), with legacy `.credentials.json` support.
3. Set `sidekick.inferenceProvider` to `codex` in settings

## How It Works

- Spawns the Codex CLI as a subprocess for each inference request
- No SDK dependency — direct CLI invocation
- Uses the Codex login or API credentials available to the CLI

## Session Monitoring

Codex CLI sessions are monitored from the system `~/.codex/sessions/` directory — the single live Codex home regardless of which managed profile is active. Profile directories that recorded sessions under the old per-profile-home model are still scanned so historical sessions remain visible. When `CODEX_HOME` is explicitly set, only that directory is used. Set `sidekick.sessionProvider` to `codex` or leave as `auto`.

Codex evidence is captured at full fidelity: base instructions and developer/system messages surface as `system` audit entries, `token_count` records are normalized into system events that carry rate limits (a call's tokens count only when `total_token_usage` changes, so repeated `token_count` events are not re-counted), an `apply_patch` is expanded into one edit per file, repeated tool emissions are de-duplicated, and MCP tool calls keep their server attribution. Codex sessions are parsed through the same canonical event pipeline as the other providers, so the dashboard, reports, and project timeline render consistent transcripts.

## Rate Limits

Codex CLI embeds rate-limit data in its event stream (via `token_count` events with `rate_limits`). Sidekick extracts this automatically and displays it in:

- **VS Code dashboard**: The quota section shows "Rate Limits" with primary and secondary window gauges
- **CLI dashboard**: The Sessions panel Summary tab shows a "Rate Limits" section with utilization bars
- **`sidekick quota`**: When the active provider is Codex, shows rate-limit bars with projected end-of-window utilization and reset countdowns

No separate API polling is needed for the dashboards — rate-limit data arrives as part of normal session monitoring. One-shot checks are different: `sidekick quota` (with automatic detection or `--provider codex`), `sidekick quota --all`, and the MCP `get_quota_status` tool always ask Codex's usage API first, so they reflect current utilization and reset credits without a `--refresh` flag. If the API fails, the newer of the local rollout sample and the cached snapshot is shown (the cache wins ties), labelled with its age, and a `Refresh` row explains the failed API attempt.

When quota is refreshed from the API, Sidekick also reads ChatGPT's reset-credit endpoint and surfaces any available **reset credits** — one-off grants that reset your rate-limit windows — as a "Reset Credits: N available" line (with each credit's expiration) in both `sidekick quota` and the VS Code dashboard "Rate Limits" tile. The last fetched credits are cached alongside the quota snapshot, so they remain visible when a later refresh falls back to local data.

Codex reports several rate-limit families per session, keyed by `limit_id`: the aggregate plan quota (`codex`) plus model/feature-specific families (e.g. `codex_bengalfox`). Sidekick always prefers the aggregate family, so a freshly-used per-model family reading 0% can never mask real plan usage in the quota view.

## Account Management

Sidekick saves multiple Codex logins while keeping the live account's only usable credential in the resolved
live home (`CODEX_HOME` or `~/.codex`). Its profile contains metadata; a verified private backup lives under
Sidekick's config root at `accounts/codex/backups/<id>.auth.json`. Inactive accounts can use their own profile homes.

### How It Works

A switch verifies outgoing and target backups, journals the transfer, removes the target's profile credential,
installs and verifies the target in the live home, then gives the outgoing account its inactive copy. A rollback
never overwrites a changed live snapshot. Sync repairs older duplicate layouts through the same guarded writer;
newer copies are preserved privately while repair is blocked. Session history remains available when duplicate
profiles are merged, but archived homes no longer retain account credentials.

Close Codex CLI, desktop, and IDE consumers before switching. Codex live writes are refused while consumers
are detected, when process discovery fails, or while keep-alive leases the target, even with `--force`.
Process discovery cannot exclude an external process starting after the check; it is not a shared refresh lock.

Explicit sign-in starts in an empty temporary home and cleans up after completion or cancellation. Opening a
terminal as the live account uses the live home. Opt-in keep-alive uses Codex's app-server refresh request for
eligible inactive accounts without starting inference. `codex login status` does not refresh ChatGPT tokens.
Plain `sidekick accounts doctor --provider codex` is read-only; `--fix` repairs known owned duplicates after confirmation.

### Verified upstream behavior

These decisions were checked against OpenAI Codex commit `985cf47a4eb6084b2ff6b30ebdb1216acda85bb4`:

- [login/src/auth/manager.rs:1598–1620](https://github.com/openai/codex/blob/985cf47a4eb6084b2ff6b30ebdb1216acda85bb4/codex-rs/login/src/auth/manager.rs#L1598-L1620) persists replacement refresh tokens and `last_refresh`; [lines 1679–1706](https://github.com/openai/codex/blob/985cf47a4eb6084b2ff6b30ebdb1216acda85bb4/codex-rs/login/src/auth/manager.rs#L1679-L1706) classify token reuse as permanent failure. Client code does not prove every server response rotates the token.
- [login/src/auth/storage.rs:206–222](https://github.com/openai/codex/blob/985cf47a4eb6084b2ff6b30ebdb1216acda85bb4/codex-rs/login/src/auth/storage.rs#L206-L222) truncates and rewrites `auth.json`; Sidekick uses its own atomic writer.
- [login/src/auth/manager.rs:2848–2881](https://github.com/openai/codex/blob/985cf47a4eb6084b2ff6b30ebdb1216acda85bb4/codex-rs/login/src/auth/manager.rs#L2848-L2881) uses a process-local semaphore, not a filesystem refresh lock.
- [cli/src/login.rs:443–478](https://github.com/openai/codex/blob/985cf47a4eb6084b2ff6b30ebdb1216acda85bb4/codex-rs/cli/src/login.rs#L443-L478) reads ChatGPT login status without refresh and prints it to stderr. The [app-server protocol](https://learn.chatgpt.com/docs/app-server) supports `account/read` with `refreshToken: true`.

### VS Code

1. Open the **Accounts** view in the Agent Hub sidebar (any inference provider)
2. Run **Sidekick: Add Account…**, choose Codex, and complete `codex login` in the terminal Sidekick opens; the profile is saved as soon as the isolated home authenticates
3. Switch with the arrows icon on an account or from the status bar quick pick; **Undo** reverts

A switch refuses while Codex consumers are running and refuses accounts whose stored login is known to be dead, pointing at **Sign In Again** instead.

### CLI

```bash
sidekick accounts list --provider codex             # Codex accounts with health
sidekick accounts add --provider codex --label Work # isolated codex login
sidekick accounts switch Work                       # switch by label, email, or id
sidekick accounts shell Work -- codex               # one codex session as Work
sidekick accounts doctor                            # includes the credential-store check
```

!!! warning "Keyring mode is not switchable"

    Codex 0.140+ can keep its login in the OS keyring (`cli_auth_credentials_store = "keyring"` or `"auto"`). Sidekick can only switch file-based logins: `sidekick accounts add` refuses up front, `doctor` reports it, and the fix is `cli_auth_credentials_store = "file"` in `~/.codex/config.toml` followed by `codex login`.

The full guide is [Account Switcher](../features/account-switcher.md).

### Quota Snapshots

Rate-limit samples are persisted for the active account in `~/.config/sidekick/quota-snapshots.json`: the dashboards write the latest `token_count` reading they observe, and `sidekick quota` writes each successful API answer or selected rollout sample. The dashboards reuse a snapshot younger than five minutes without a network call; the CLI and MCP fall back to the snapshot only when the API fails and no newer rollout sample exists. Cached samples display with a "cached from" timestamp and their age.

## Provider Status

Sidekick monitors public OpenAI service status via status.openai.com when Codex is the active provider. Degraded or outage states appear as a card in the dashboard gauge row with component associations, unresolved incidents, and check/provider-update timestamps; a failed check shows **Status unavailable** rather than implying normal operation. Also available via `sidekick status`. A public incident does not establish why a particular Codex request failed.

## Troubleshooting

### Connection issues

- Verify Codex is authenticated, or that `OPENAI_API_KEY` / `CODEX_API_KEY` is available to VS Code
- Check `auth.json` in the resolved Codex home if using file-based credentials
- Verify Codex CLI is installed: `codex --version`
