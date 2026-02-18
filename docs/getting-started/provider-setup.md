# Provider Setup

Sidekick Agent Hub supports four inference providers. You only need to set up one.

## Claude Max (Recommended)

Uses your Claude Max subscription via the Claude Code CLI — no extra API cost.

1. Install and authenticate Claude Code CLI:
    ```bash
    npm install -g @anthropic-ai/claude-code
    claude auth
    ```
2. Follow the prompts to authenticate with your Claude Max subscription
3. Start coding — Sidekick auto-detects Claude Code and uses it for inference

!!! tip "Why Claude Max is recommended"
    Inline completions fire frequently as you type. With an API key, per-token costs add up quickly. With Max, completions are covered by your existing plan.

## Claude API

Direct Anthropic API access with per-token billing.

1. Run **"Sidekick: Set API Key"** from the Command Palette (`Ctrl+Shift+P`)
2. Enter your Anthropic API key
3. Switch provider in settings:
    - Open Settings (`Ctrl+,`) → search `sidekick.inferenceProvider` → select `claude-api`
    - Or: status bar → "Switch Inference Provider" → Claude API

## OpenCode

Uses your configured OpenCode provider and model.

1. Ensure OpenCode is installed and running (`opencode` in a terminal)
2. Sidekick connects to the local server on port 4096
3. Switch provider:
    - Settings → `sidekick.inferenceProvider` → `opencode`
    - Or: status bar → "Switch Inference Provider" → OpenCode

!!! note
    Model selection is handled by your OpenCode configuration. Tier values (fast/balanced/powerful) are passed as hints, but OpenCode's own model settings take precedence.

## Codex CLI

Uses the OpenAI API via Codex CLI.

1. Install Codex CLI globally:
    ```bash
    npm install -g @openai/codex
    ```
2. Ensure your OpenAI API key is available:
    - `OPENAI_API_KEY` or `CODEX_API_KEY` environment variable
    - Or `~/.codex/.credentials.json`
3. Switch provider:
    - Settings → `sidekick.inferenceProvider` → `codex`
    - Or: status bar → "Switch Inference Provider" → Codex CLI

## Auto-Detection

When `sidekick.inferenceProvider` is set to `auto` (the default), Sidekick detects the most recently used coding agent based on filesystem timestamps and uses it for inference.

## Session Monitoring Providers

Session monitoring uses a separate `sidekick.sessionProvider` setting. It also defaults to `auto` and supports:

- **Claude Code** — monitors `~/.claude/projects/`
- **OpenCode** — monitors `~/.local/share/opencode/`
- **Codex CLI** — monitors `~/.codex/sessions/`
