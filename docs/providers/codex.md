# Codex CLI

Uses the OpenAI API via Codex CLI for inference.

## Setup

1. Install Codex CLI globally:
   ```bash
   npm install -g @openai/codex
   ```
2. Ensure your OpenAI API key is available:
   - `OPENAI_API_KEY` or `CODEX_API_KEY` environment variable
   - Or `~/.codex/.credentials.json`
3. Set `sidekick.inferenceProvider` to `codex` in settings

## How It Works

- Spawns the Codex CLI as a subprocess for each inference request
- No SDK dependency — direct CLI invocation
- Uses OpenAI API billing

## Session Monitoring

Codex CLI sessions are monitored from the system `~/.codex/sessions/` directory — the single live Codex home regardless of which managed profile is active. Profile directories that recorded sessions under the old per-profile-home model are still scanned so historical sessions remain visible. When `CODEX_HOME` is explicitly set, only that directory is used. Set `sidekick.sessionProvider` to `codex` or leave as `auto`.

Codex evidence is captured at full fidelity: base instructions and developer/system messages surface as `system` audit entries, `token_count` records are normalized into system events that carry rate limits, an `apply_patch` is expanded into one edit per file, repeated tool emissions are de-duplicated, and MCP tool calls keep their server attribution. Codex sessions are parsed through the same canonical event pipeline as the other providers, so the dashboard, reports, and project timeline render consistent transcripts.

## Rate Limits

Codex CLI embeds rate-limit data in its event stream (via `token_count` events with `rate_limits`). Sidekick extracts this automatically and displays it in:

- **VS Code dashboard**: The quota section shows "Rate Limits" with primary and secondary window gauges
- **CLI dashboard**: The Sessions panel Summary tab shows a "Rate Limits" section with utilization bars
- **`sidekick quota`**: When the active provider is Codex, shows rate-limit bars with reset countdowns

No separate API polling is needed by default — rate-limit data arrives as part of normal session monitoring. For one-shot CLI checks, `sidekick quota --provider codex --refresh` explicitly refreshes from Codex's usage API first, then falls back to local rollout data and cached snapshots if the API is unavailable.

## Account Management

Sidekick supports multiple Codex accounts with isolated profiles — each profile keeps a backup of its credentials, and switching accounts swaps the active profile's credentials into `~/.codex/auth.json`.

### How It Works

Each Codex profile stores backed-up credentials in `~/.config/sidekick/accounts/codex/profiles/{profileId}/codex-home/`. When you switch profiles, Sidekick first syncs the live (rotated) tokens from `~/.codex/auth.json` back into the matching profile backup, then atomically swaps the target profile's `auth.json` into the system `~/.codex/` home — the same pattern used for Claude Code account switching. The Codex CLI always runs against `~/.codex/`, so every codex terminal picks up the switch, not just the ones Sidekick launches.

Live credentials are never overwritten with a staler copy of the same account — Codex rotates refresh tokens, and resurrecting an old one would permanently invalidate the login. Installs created under the older per-profile-`CODEX_HOME` model are migrated automatically on first start; unrecognized live credentials are stashed as a new profile, never dropped. Account add, switch, and remove surface warnings when something needs attention: a running codex process that should be restarted, stale credentials, or credentials held in the OS keyring that Sidekick cannot swap.

!!! tip "First-run default"

    If `~/.codex/auth.json` already exists when Sidekick first starts, the extension and CLI auto-register it as a **"Default"** Codex profile — no manual `Sidekick: Add Account` / `sidekick account --provider codex --add --label …` is required to get started. Additional Codex profiles still go through the flows below. Manually saved profiles are never overwritten by the bootstrap.

### VS Code

1. Set your inference provider to `codex`
2. Run **`Sidekick: Add Account`** — enter a label (e.g., "Work")
3. A terminal opens for `codex login` — complete the login flow
4. Sidekick auto-finalizes the profile when the terminal closes
5. Repeat for additional accounts
6. Run **`Sidekick: Switch Account`** to switch via QuickPick

Account actions are also available from the status bar menu — click the account indicator to switch or add accounts.

### CLI

```bash
sidekick account --provider codex                    # list Codex accounts
sidekick account --provider codex --add --label Work # prepare profile + login
sidekick account --provider codex --switch           # switch to next account
sidekick account --provider codex --switch-to Work   # switch by label, email, or ID
sidekick account --provider codex --remove Work      # remove a profile
```

### Quota Snapshots

When no active Codex session exists, `sidekick quota` first checks recent account-level Codex rollouts for a usable rate-limit event, then falls back to the most recent cached rate-limit snapshot for the active account. Snapshots are stored in `~/.config/sidekick/quota-snapshots.json` and display with a "cached from" timestamp to indicate staleness.

## Provider Status

Sidekick monitors OpenAI API health via status.openai.com when Codex is the active provider. Degraded or outage states appear as a banner in the dashboard gauge row. Also available via `sidekick status`.

## Troubleshooting

### Connection issues

- Verify `OPENAI_API_KEY` or `CODEX_API_KEY` is set
- Check `~/.codex/.credentials.json` exists if using file-based credentials
- Verify Codex CLI is installed: `codex --version`
