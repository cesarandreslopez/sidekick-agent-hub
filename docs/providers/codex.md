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

Codex CLI sessions are monitored from all candidate Codex home directories. When a managed Codex profile is active, Sidekick scans that profile's sessions directory first, then falls back to the system default `~/.codex/sessions/`. When `CODEX_HOME` is explicitly set, only that directory is used. Set `sidekick.sessionProvider` to `codex` or leave as `auto`.

## Rate Limits

Codex CLI embeds rate-limit data in its event stream (via `token_count` events with `rate_limits`). Sidekick extracts this automatically and displays it in:

- **VS Code dashboard**: The quota section shows "Rate Limits" with primary and secondary window gauges
- **CLI dashboard**: The Sessions panel Summary tab shows a "Rate Limits" section with utilization bars
- **`sidekick quota`**: When the active provider is Codex, shows rate-limit bars with reset countdowns

No separate API polling is needed — rate-limit data arrives as part of normal session monitoring.

## Account Management

Sidekick supports multiple Codex accounts with isolated profiles — each profile gets its own `CODEX_HOME` directory for independent auth and configuration.

### How It Works

Each Codex profile is stored in `~/.config/sidekick/accounts/codex/profiles/{profileId}/codex-home/`. When you switch profiles, Sidekick sets the `CODEX_HOME` environment variable so the Codex CLI uses the correct credentials. If no managed profile is active, Sidekick falls back to the system default `~/.codex/`.

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

When no active Codex session exists, `sidekick quota` falls back to the most recent cached rate-limit snapshot for the active account. Snapshots are stored in `~/.config/sidekick/quota-snapshots.json` and display with a "cached from" timestamp to indicate staleness.

## Provider Status

Sidekick monitors OpenAI API health via status.openai.com when Codex is the active provider. Degraded or outage states appear as a banner in the dashboard gauge row. Also available via `sidekick status`.

## Troubleshooting

### Connection issues

- Verify `OPENAI_API_KEY` or `CODEX_API_KEY` is set
- Check `~/.codex/.credentials.json` exists if using file-based credentials
- Verify Codex CLI is installed: `codex --version`
