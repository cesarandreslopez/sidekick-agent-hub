# OpenCode

Uses your configured OpenCode provider and model for inference.

## Setup

1. Install OpenCode and ensure it's running (`opencode` in a terminal)
2. Ensure `sqlite3` is installed and available on `PATH` if you want Sidekick to monitor OpenCode sessions
3. Sidekick connects to the local server on port 4096
4. Set `sidekick.inferenceProvider` to `opencode` in settings

## How It Works

- Uses `@opencode-ai/sdk` to connect to the local OpenCode server
- Model selection is handled by your OpenCode configuration
- Tier values (fast/balanced/powerful) are passed as hints, but OpenCode's settings take precedence

## Session Monitoring

OpenCode sessions are monitored from OpenCode's platform-specific data directory:

- Linux: `~/.local/share/opencode/`
- macOS: `~/Library/Application Support/opencode/`
- Windows: `%APPDATA%\\opencode\\`

Set `sidekick.sessionProvider` to `opencode` or leave as `auto`.

Sidekick reads `opencode.db` for DB-backed session discovery and monitoring. If `opencode.db` exists but `sqlite3` is missing or cannot be executed in the current environment, Sidekick now shows an actionable OpenCode-specific notice instead of silently failing session detection.

## z.ai Coding Plan quota

When OpenCode is configured with a z.ai Coding Plan (GLM), Sidekick reads the same quota endpoint used by z.ai's first-party usage plugin and displays the account's current 5-hour and weekly token quota.

- **CLI**: `sidekick quota --provider zai` renders authoritative 5-Hour / Weekly utilization from z.ai, including projected end-of-window utilization; `sidekick quota --provider opencode` auto-routes to z.ai when z.ai traffic is detected; `sidekick quota --all` includes the z.ai section when available; `sidekick quota history --provider zai` renders the 13-week heatmap.
- **VS Code**: the dashboard shows a z.ai quota card labeled **"Live z.ai API"** or **"Cached z.ai API snapshot"**.

How it works: Sidekick calls `GET https://api.z.ai/api/monitor/usage/quota/limit` with the z.ai token already stored by OpenCode (`auth.json`, preferring `zai-coding-plan` over `zai`). If those credentials are not available, Sidekick falls back to the official plugin environment variables: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

### Limitations

- **No z.ai inference provider.** z.ai is monitored through OpenCode credentials. You cannot select z.ai directly as an inference provider (`sidekick.inferenceProvider` remains `claude-max | claude-api | opencode | codex`).
- **No z.ai account management.** z.ai accounts cannot be saved, listed, or switched like Claude and Codex accounts in this release.
- **Cached fallback only.** If the z.ai API is unavailable, Sidekick may show the latest cached z.ai quota snapshot. It no longer estimates account quota from local traffic.
- **No native (non-z.ai) OpenCode quota.** OpenCode itself reports no rate-limit data; quota only appears when traffic is z.ai-routed.
- **Session asset extraction** (`sidekick extract`, **Sidekick: Extract Session Assets**) does **not support OpenCode yet** — only Claude Code and Codex.

## Troubleshooting

### Connection issues

- Ensure OpenCode is running (`opencode` in a terminal)
- Sidekick connects to `http://127.0.0.1:4096` by default

### Session monitoring issues

- Ensure `sqlite3` is installed and available on `PATH`
- If VS Code or your shell uses a different runtime environment, verify `sqlite3` is available there too
- If Sidekick reports an OpenCode runtime notice, confirm `sqlite3` can read `opencode.db` directly and then retry
