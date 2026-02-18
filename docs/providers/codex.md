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

## Troubleshooting

### Connection issues

- Verify `OPENAI_API_KEY` or `CODEX_API_KEY` is set
- Check `~/.codex/.credentials.json` exists if using file-based credentials
- Verify Codex CLI is installed: `codex --version`
