# Claude Max

Uses your Claude Max subscription via the Claude Code CLI — no extra API cost.

## Setup

1. Install Claude Code CLI:
    ```bash
    npm install -g @anthropic-ai/claude-code
    ```
2. Authenticate:
    ```bash
    claude auth
    ```
3. Sidekick auto-detects Claude Code when `sidekick.inferenceProvider` is set to `auto`

## How It Works

- Uses `@anthropic-ai/claude-agent-sdk` via Claude Code CLI authentication
- No API keys needed — authentication is handled by the CLI
- Completions are covered by your existing Max plan

## Session Monitoring

Claude Code sessions are monitored from `~/.claude/projects/`. The dashboard shows:

- Token usage with quota projections
- 5-hour and 7-day subscription quota gauges
- Cost tracking (included in subscription)

## Best For

- Heavy daily use of inline completions (no per-token cost)
- Users already paying for Claude Max ($100-200/month)
- Teams wanting to consolidate AI tooling costs

## Troubleshooting

### "Claude Code CLI not found"

- Verify installation: `claude --version`
- If installed via pnpm/yarn/volta, set `sidekick.claudePath` to the full path
- Find the path: `which claude` (Linux/Mac) or `where claude` (Windows)
