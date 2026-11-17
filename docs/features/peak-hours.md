# Peak Hours

Since 2026-03-27, Anthropic drains Claude 5-hour session limits **faster** during a fixed weekday window. Sidekick surfaces this state so heavy work can be timed for off-peak hours — without adding another browser tab to your day.

## What peak hours are

|                    |                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **When**           | Weekdays **13:00 – 19:00 UTC** (06:00 – 12:00 PDT, 09:00 – 15:00 EDT, 14:00 – 20:00 BST)                          |
| **What changes**   | 5-hour session limits drain faster than normal                                                                    |
| **What doesn't**   | Weekly limits are unchanged                                                                                       |
| **Who's affected** | Plans with a 5-hour session limit: Free, Pro, Max, and Team                                                       |
| **Who's not**      | Ultra (no 5-hour session limit), Enterprise (dedicated capacity), pure API-key billing (no session-limit concept) |

On 2026-10-30 Anthropic renamed Max 5x to **Max** and Max 20x to **Ultra**, and removed Ultra's 5-hour session limit. Peak hours only change how fast the 5-hour limit drains, so they no longer affect Ultra.

Per Anthropic, roughly 7% of Pro users may hit session limits during peak hours that they would not have hit before the change.

## Where Sidekick shows it

In VS Code the indicator only appears when your active **inference provider is Claude Max** (`claude-max`, which any Claude subscription can use) and your **session provider is Claude Code**. In the CLI, `sidekick peak` also gates on the session provider (pass `--provider claude-code` to override auto-detection). OpenCode, Codex, and raw-API-key users never see a peak-hours pill and Sidekick never calls the upstream source on their behalf.

### VS Code extension

- **Dashboard card** — a subtle orange pill appears in the Agent Hub dashboard only while peak hours are _active_. Off-peak renders nothing.
- **Status bar** — a 🟠 glyph is appended to the existing session status bar item during peak. Hover for the countdown to off-peak.
- **Optional transition notification** — disabled by default; enable `sidekick.peakHours.notifyOnTransition` to get a one-time toast when the window opens or closes.

The VS Code indicators do not check your plan, so on Ultra they still appear during peak hours even though your limits are not affected.

### CLI

- `sidekick peak` — dedicated one-shot check. Human-readable by default, JSON with `--json`.
- `sidekick status` — the Claude and OpenAI health blocks are followed by a peak-hours block when the active provider is `claude-code`.
- `sidekick quota` — adds a one-line **Peak** row under the 5-hour / 7-day quota bars for Claude plans with a 5-hour session limit. On Ultra the row is left out, because the plan has no 5-hour window for peak hours to drain. The JSON output carries the `peak` state either way.

## Settings

| Setting                                 | Default | Description                                                                |
| --------------------------------------- | ------- | -------------------------------------------------------------------------- |
| `sidekick.peakHours.enabled`            | `true`  | Master toggle. When off, the service does not poll and the UI stays quiet. |
| `sidekick.peakHours.notifyOnTransition` | `false` | Emit a one-time VS Code toast when peak starts or ends.                    |

## Data source and privacy

Peak-hours state comes from **[promoclock.co](https://promoclock.co/)** — a free, independent tracker maintained by [@onursendere](https://x.com/onursendere) and **not affiliated with Anthropic**. The VS Code extension fetches `https://promoclock.co/api/status` once every 15 minutes only while the dashboard is open, your active inference provider is Claude Max, and your session provider is Claude Code. The CLI fetches it once per run of `sidekick peak`, of `sidekick status` with the `claude-code` provider, and of `sidekick quota` for Claude. No identifying information is sent; only a GET with your normal HTTP headers.

If the endpoint is unreachable, Sidekick silently falls back to showing nothing — it never surfaces a stale or guessed state.

To disable network calls to promoclock.co from VS Code, set `sidekick.peakHours.enabled` to `false`.
