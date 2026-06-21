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

## z.ai Coding Plan quota (estimated)

When OpenCode routes inference to a z.ai Coding Plan (GLM) — i.e. assistant turns tagged `providerID ∈ {zai, zai-coding-plan}` — Sidekick **derives an estimated quota** from the traffic OpenCode has already written to `opencode.db`.

- **CLI**: `sidekick quota --provider zai` renders 5-Hour / Weekly utilization; `sidekick quota --provider opencode` auto-routes to z.ai when z.ai traffic is detected; `sidekick quota --all` includes the z.ai section; `sidekick quota history --provider zai` renders the 13-week heatmap. `--tier lite|pro|max|auto` overrides the assumed tier.
- **VS Code**: the dashboard shows a third quota card (5-Hour / Weekly) labeled **"Estimated from observed traffic"**. The [`sidekick.zai.tier`](../configuration/settings.md#zai-opencode-routing) setting overrides the tier.

How the estimate works: z.ai exposes **no quota/usage HTTP API** (verified against `docs.z.ai/openapi.json`). Sidekick accumulates per-turn tokens into rolling 5-hour and 7-day windows, converts them to prompt-equivalents, and compares against the published per-tier prompt budgets (per 5 hours / per week): **Lite** 80 / 400, **Pro** 400 / 2000, **Max** 1600 / 8000. When z.ai returns a rate-limit business error (`1308` / `1310` / `1313` / `1309`), the authoritative reset time embedded in the message is used.

### Limitations

The z.ai quota is a best-effort estimate, and several related capabilities are **not yet delivered** (planned for a future release):

- **Estimate, not authoritative.** Because there is no z.ai usage API, utilization reflects only the OpenCode traffic Sidekick observed on **this machine/workspace** — not z.ai's true account-wide usage across other clients or devices.
- **Provisional calibration.** The per-tier prompt budgets and the "~15–20 model invocations per prompt" conversion (midpoint 17.5) are published estimates; the utilization percentage may need recalibration after real-world validation.
- **Observed-only — no z.ai inference provider.** z.ai is *monitored* only when OpenCode routes to it. You cannot select z.ai directly as an inference provider (`sidekick.inferenceProvider` remains `claude-max | claude-api | opencode | codex`).
- **No z.ai account management.** z.ai accounts cannot be saved, listed, or switched like Claude and Codex accounts in this release.
- **Auto-tier under-detects early in a cycle.** With `tier: auto`, a higher-tier user looks like a lower-tier one until weekly volume crosses a budget; set the tier explicitly (`--tier` / `sidekick.zai.tier`) for accuracy.
- **Approximate reset times.** Without a trapped rate-limit error, window reset times are extrapolated from the first observed turn rather than read from z.ai.
- **No native (non-z.ai) OpenCode quota.** OpenCode itself reports no rate-limit data; quota only appears when traffic is z.ai-routed.
- **Session asset extraction** (`sidekick extract`, **Sidekick: Extract Session Assets**) does **not support OpenCode yet** — only Claude Code and Codex.

## Troubleshooting

### Connection issues

- Ensure OpenCode is running (`opencode` in a terminal)
- Sidekick connects to `http://127.0.0.1:4096` by default

### Session monitoring issues

- Ensure `sqlite3` is installed and available on `PATH`
- If VS Code or your shell uses a different runtime environment, verify `sqlite3` is available there too
- If Sidekick reports an OpenCode runtime notice, confirm `sqlite3` can read `opencode.db` directly and then retry
