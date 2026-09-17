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

Codex evidence is captured at full fidelity: base instructions and developer/system messages surface as `system` audit entries, `token_count` records are normalized into system events that carry rate limits, an `apply_patch` is expanded into one edit per file, repeated tool emissions are de-duplicated, and MCP tool calls keep their server attribution. Codex sessions are parsed through the same canonical event pipeline as the other providers, so the dashboard, reports, and project timeline render consistent transcripts.

## Rate Limits

Codex CLI embeds rate-limit data in its event stream (via `token_count` events with `rate_limits`). Sidekick extracts this automatically and displays it in:

- **VS Code dashboard**: The quota section shows "Rate Limits" with primary and secondary window gauges
- **CLI dashboard**: The Sessions panel Summary tab shows a "Rate Limits" section with utilization bars
- **`sidekick quota`**: When the active provider is Codex, shows rate-limit bars with projected end-of-window utilization and reset countdowns

No separate API polling is needed for the dashboards — rate-limit data arrives as part of normal session monitoring. One-shot checks are different: `sidekick quota` (with automatic detection or `--provider codex`), `sidekick quota --all`, and the MCP `get_quota_status` tool always ask Codex's usage API first, so they reflect current utilization and reset credits without a `--refresh` flag. If the API fails, the newer of the local rollout sample and the cached snapshot is shown (the cache wins ties), labelled with its age, and a `Refresh` row explains the failed API attempt.

When quota is refreshed from the API, Sidekick also reads ChatGPT's reset-credit endpoint and surfaces any available **reset credits** — one-off grants that reset your rate-limit windows — as a "Reset Credits: N available" line (with each credit's expiration) in both `sidekick quota` and the VS Code dashboard "Rate Limits" tile. The last fetched credits are cached alongside the quota snapshot, so they remain visible when a later refresh falls back to local data.

Codex reports several rate-limit families per session, keyed by `limit_id`: the aggregate plan quota (`codex`) plus model/feature-specific families (e.g. `codex_bengalfox`). Sidekick always prefers the aggregate family, so a freshly-used per-model family reading 0% can never mask real plan usage in the quota view.

## Account Management

Sidekick supports multiple Codex accounts with isolated profiles — each profile keeps a backup of its credentials, and switching accounts swaps the active profile's credentials into `~/.codex/auth.json`.

### How It Works

Each Codex profile stores backed-up credentials in `~/.config/sidekick/accounts/codex/profiles/{profileId}/codex-home/`. When you switch profiles, Sidekick first syncs the live (rotated) tokens from `~/.codex/auth.json` back into the matching profile backup, then atomically swaps the target profile's `auth.json` into the system `~/.codex/` home — the same pattern used for Claude Code account switching. The Codex CLI always runs against `~/.codex/`, so every codex terminal picks up the switch, not just the ones Sidekick launches.

Live credentials are never overwritten with a staler copy of the same account — Codex rotates refresh tokens, and resurrecting an old one would permanently invalidate the login. Installs created under the older per-profile-`CODEX_HOME` model are migrated automatically on first start; a live login Sidekick has not seen is registered as a profile labelled with its email, and duplicate profiles for one workspace are merged (the older profile keeps its label; the other is stashed, never deleted). Account add, switch, and remove surface warnings when something needs attention: a running codex process that should be restarted, stale credentials, or credentials held in the OS keyring that Sidekick cannot swap.

!!! tip "Registered automatically"

    The login in `~/.codex/auth.json` is registered under its email when Sidekick starts, and again whenever a native `codex login` changes it. Additional profiles go through the flows below; the rotated tokens of the live login are folded back into its profile continuously.

### VS Code

1. Open the **Accounts** view in the Agent Hub sidebar (any inference provider)
2. Run **Sidekick: Add Account…**, choose Codex, and complete `codex login` in the terminal Sidekick opens; the profile is saved as soon as the isolated home authenticates
3. Switch with the arrows icon on an account or from the status bar quick pick; **Undo** reverts

A switch warns when `codex` sessions or the Codex desktop app are running (they share `~/.codex` and pick up the switch after a restart) and refuses accounts whose stored login is known to be dead, pointing at **Sign In Again** instead.

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
