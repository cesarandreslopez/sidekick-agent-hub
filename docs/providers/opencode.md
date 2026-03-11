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

## Troubleshooting

### Connection issues

- Ensure OpenCode is running (`opencode` in a terminal)
- Sidekick connects to `http://127.0.0.1:4096` by default

### Session monitoring issues

- Ensure `sqlite3` is installed and available on `PATH`
- If VS Code or your shell uses a different runtime environment, verify `sqlite3` is available there too
- If Sidekick reports an OpenCode runtime notice, confirm `sqlite3` can read `opencode.db` directly and then retry
