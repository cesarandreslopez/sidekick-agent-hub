# Peak Hours

Since 2026-03-27, Anthropic drains Claude session limits **faster** during a fixed weekday window. Sidekick surfaces this state so heavy work can be timed for off-peak hours — without adding another browser tab to your day.

## What peak hours are

| | |
|---|---|
| **When** | Weekdays **13:00 – 19:00 UTC** (06:00 – 12:00 PDT, 09:00 – 15:00 EDT, 14:00 – 20:00 BST) |
| **What changes** | 5-hour session limits drain faster than normal |
| **What doesn't** | Weekly limits are unchanged |
| **Who's affected** | Free, Pro, Max, Team subscriptions |
| **Who's not** | Enterprise (dedicated capacity), pure API-key billing (no session-limit concept) |

Per Anthropic, roughly 7% of Pro users may hit session limits during peak hours that they would not have hit before the change.

## Where Sidekick shows it

The indicator only appears when your active **inference provider is Claude Max** (or your CLI session provider is `claude-code`). OpenCode, Codex, and raw-API-key users never see a peak-hours pill and Sidekick never calls the upstream source on their behalf.

### VS Code extension

- **Dashboard card** — a subtle orange pill appears in the Agent Hub dashboard only while peak hours are *active*. Off-peak renders nothing.
- **Status bar** — a 🟠 glyph is appended to the existing session status bar item during peak. Hover for the countdown to off-peak.
- **Optional transition notification** — disabled by default; enable `sidekick.peakHours.notifyOnTransition` to get a one-time toast when the window opens or closes.

### CLI

- `sidekick peak` — dedicated one-shot check. Human-readable by default, JSON with `--json`.
- `sidekick status` — the Claude and OpenAI health blocks are followed by a peak-hours block when the active provider is `claude-code`.
- `sidekick quota` — shows a one-line peak summary underneath the 5-hour / 7-day quota bars for Claude subscriptions.

## Settings

| Setting | Default | Description |
|---|---|---|
| `sidekick.peakHours.enabled` | `true` | Master toggle. When off, the service does not poll and the UI stays quiet. |
| `sidekick.peakHours.notifyOnTransition` | `false` | Emit a one-time VS Code toast when peak starts or ends. |

## Data source and privacy

Peak-hours state comes from **[promoclock.co](https://promoclock.co/)** — a free, independent tracker maintained by [@onursendere](https://x.com/onursendere) and **not affiliated with Anthropic**. Sidekick fetches `https://promoclock.co/api/status` once every 15 minutes only while the dashboard is open **and** your active inference provider is Claude Max. No identifying information is sent; only a GET with your normal HTTP headers.

If the endpoint is unreachable, Sidekick silently falls back to showing nothing — it never surfaces a stale or guessed state.

To disable network calls to promoclock.co entirely, set `sidekick.peakHours.enabled` to `false`.
