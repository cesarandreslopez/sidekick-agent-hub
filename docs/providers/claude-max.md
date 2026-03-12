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

- Token usage with elapsed-time quota projections
- 5-hour and 7-day subscription quota gauges with projected end-of-window utilization
- Cost tracking (included in subscription)

If quota data becomes unavailable, Sidekick now keeps the quota surface visible and classifies the failure: missing credentials / expired Claude Code sign-in, rate limits, transient network or server failures, and unexpected API responses are shown as distinct states instead of a single generic error.

## Best For

- Heavy daily use of inline completions (no per-token cost)
- Users already paying for Claude Max ($100-200/month)
- Teams wanting to consolidate AI tooling costs

## Troubleshooting

### "Claude Code CLI not found"

- Verify installation: `claude --version`
- If installed via pnpm/yarn/volta, set `sidekick.claudePath` to the full path
- Find the path: `which claude` (Linux/Mac) or `where claude` (Windows)

### "Quota is unavailable"

- If Sidekick says sign-in is required, run `claude` and complete Claude Code sign-in again
- If Sidekick shows a rate limit, wait for the suggested retry window and refresh
- If Sidekick shows a network or server issue, retry once connectivity or Anthropic service health recovers
