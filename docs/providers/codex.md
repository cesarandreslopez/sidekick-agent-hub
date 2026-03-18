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

Codex CLI sessions are monitored from `~/.codex/sessions/`. Set `sidekick.sessionProvider` to `codex` or leave as `auto`.

## Rate Limits

Codex CLI embeds rate-limit data in its event stream (via `token_count` events with `rate_limits`). Sidekick extracts this automatically and displays it in:

- **VS Code dashboard**: The quota section shows "Rate Limits" with primary and secondary window gauges
- **CLI dashboard**: The Sessions panel Summary tab shows a "Rate Limits" section with utilization bars
- **`sidekick quota`**: When the active provider is Codex, shows rate-limit bars with reset countdowns

No separate API polling is needed — rate-limit data arrives as part of normal session monitoring.

## Provider Status

Sidekick monitors OpenAI API health via status.openai.com when Codex is the active provider. Degraded or outage states appear as a banner in the dashboard gauge row. Also available via `sidekick status`.

## Troubleshooting

### Connection issues

- Verify `OPENAI_API_KEY` or `CODEX_API_KEY` is set
- Check `~/.codex/.credentials.json` exists if using file-based credentials
- Verify Codex CLI is installed: `codex --version`
