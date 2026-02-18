# OpenCode

Uses your configured OpenCode provider and model for inference.

## Setup

1. Install OpenCode and ensure it's running (`opencode` in a terminal)
2. Sidekick connects to the local server on port 4096
3. Set `sidekick.inferenceProvider` to `opencode` in settings

## How It Works

- Uses `@opencode-ai/sdk` to connect to the local OpenCode server
- Model selection is handled by your OpenCode configuration
- Tier values (fast/balanced/powerful) are passed as hints, but OpenCode's settings take precedence

## Session Monitoring

OpenCode sessions are monitored from `~/.local/share/opencode/`. Set `sidekick.sessionProvider` to `opencode` or leave as `auto`.

## Troubleshooting

### Connection issues

- Ensure OpenCode is running (`opencode` in a terminal)
- Sidekick connects to `http://127.0.0.1:4096` by default
