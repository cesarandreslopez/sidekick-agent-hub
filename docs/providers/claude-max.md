# Claude Max

Uses your Claude Max subscription via the Claude Code CLI — no extra API cost.

## Setup

1. Install Claude Code CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```
2. Authenticate:
   ```bash
   claude auth login
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

## Peak Hours

Anthropic drains session limits faster on weekdays 13:00–19:00 UTC (see [Peak Hours](../features/peak-hours.md) for the full schedule and per-timezone breakdown). Sidekick surfaces this state subtly — a pill in the dashboard and a `🟠` glyph in the status bar during an active peak window; `sidekick peak`, `sidekick quota`, and `sidekick status` in the CLI. The indicator requires both the Claude Max inference provider and the Claude Code session provider, since API-key, Enterprise, OpenCode, and Codex paths don't share the same session-limit concept.

## Multiple Accounts

If you have multiple Claude subscriptions (for example personal and work), Sidekick switches between their Claude Code CLI credentials natively — no `/logout` cycles. This applies to Claude Code sign-ins, not Claude API keys, and it does not reach the Claude Desktop app, which keeps its own web session. The full guide, including credential health, parallel sessions, and per-platform notes, is [Account Switcher](../features/account-switcher.md).

### VS Code

!!! tip "Registered automatically"

    The account you are signed in to when Sidekick activates is registered under its email, and so is any account you later sign in to with `claude /login`. You only run **Add Account** to sign in to a *second* account without leaving the first.

1. Open the **Accounts** view in the Agent Hub sidebar, or click the account badge in the status bar
2. Run **Sidekick: Add Account…**, choose Claude Code, and complete `claude auth login` in the terminal Sidekick opens
3. Switch with the arrows icon on an account, the status bar quick pick, or `Ctrl+K Ctrl+Shift+A`

Each switch is verified against the live credential store, reports which running `claude` sessions (and Claude Desktop, if open) still hold the previous account, and offers **Undo**. Switching resets Sidekick's auth client and refreshes quota when the inference provider is Claude Max.

### CLI

```bash
sidekick accounts                          # interactive picker
sidekick accounts add --label Work         # sign in to a second account
sidekick accounts switch work              # switch by label, email, or id
sidekick accounts shell work -- claude     # one claude session as Work, live login untouched
sidekick accounts doctor                   # expiry and running apps
```

Account data is stored in `~/.config/sidekick/accounts/` with `0o700` directory and `0o600` file permissions. Credential swaps are atomic, verified by reading the store back, and rolled back on mismatch.

**macOS note:** Claude Code stores active credentials in the system Keychain, keyed per `CLAUDE_CONFIG_DIR`; Sidekick reads and writes them with the `security` CLI and falls back to `.credentials.json` when the Keychain is locked. Saved Claude refresh tokens expire about three weeks after last use; the Accounts view and `sidekick accounts list` show the remaining time, and the optional `sidekick.accounts.keepAlive` setting refreshes inactive accounts through the CLI.

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
