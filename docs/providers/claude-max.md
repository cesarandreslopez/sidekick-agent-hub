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

## Peak Hours

Anthropic drains session limits faster on weekdays 13:00–19:00 UTC (see [Peak Hours](../features/peak-hours.md) for the full schedule and per-timezone breakdown). Sidekick surfaces this state subtly — a pill in the dashboard and a `🟠` glyph in the status bar during an active peak window; `sidekick peak`, `sidekick quota`, and `sidekick status` in the CLI. The indicator only appears on Claude Max, since API-key and Enterprise paths don't share the same session-limit concept.

## Multiple Accounts

If you have multiple Claude Max subscriptions (e.g., personal and work), Sidekick can switch between their Claude Code CLI credentials natively — no manual `claude login` / logout cycles. This feature manages Claude Code sign-in credentials specifically; it does not apply to Claude API keys. For Codex multi-account management, see the [Codex provider docs](codex.md#account-management).

### VS Code

!!! tip "First-run default"

    If you were already signed in to Claude Code before installing Sidekick, the extension auto-registers that account as **"Default"** on activation. You only need the steps below to add a _second_ account or to relabel the first one. Manually saved accounts are never overwritten.

1. Sign in to Claude Code with your first account
2. Run **`Sidekick: Save Current Claude Account`** — optionally add a label like "Personal"
3. Sign in to Claude Code with your second account (`claude login`)
4. Run **`Sidekick: Save Current Claude Account`** — label it "Work"
5. Run **`Sidekick: Switch Claude Account`** to switch via QuickPick

When 2+ accounts are saved, a status bar item shows the active account. Click it to switch. Switching automatically resets the auth client and refreshes quota — no restart needed.

You can also reach account actions from the main **Sidekick · Claude** status bar menu — click it and select **Switch Account** (when 2+ accounts are saved) or **Save Current Account** (to start multi-account setup). These entries only appear when the inference provider is Claude Code.

### CLI

```bash
sidekick account --add --label Personal   # save current account
sidekick account --add --label Work       # save another account
sidekick account                          # list all accounts
sidekick account --switch                 # switch to next account
sidekick account --switch-to work@co.com  # switch to specific account
sidekick account --remove work@co.com     # remove an account
```

Account data is stored in `~/.config/sidekick/accounts/` with `0o700` directory and `0o600` file permissions. Credential swaps use atomic writes with rollback on failure.

**macOS note:** Claude Code stores active credentials in the system Keychain (not a file). Sidekick reads and writes Keychain credentials automatically via the `security` CLI. One limitation: if you run `claude login` externally, VS Code cannot detect the change automatically — run **Save Current Claude Account** to pick up the new credentials.

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
