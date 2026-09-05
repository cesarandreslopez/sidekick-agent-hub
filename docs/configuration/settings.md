# Settings Reference

All settings use the `sidekick.*` prefix. Open VS Code Settings (`Ctrl+,`) and search for "sidekick".

## Provider

| Setting                      | Default | Description                                                               |
| ---------------------------- | ------- | ------------------------------------------------------------------------- |
| `sidekick.inferenceProvider` | `auto`  | AI provider: `auto`, `claude-max`, `claude-api`, `opencode`, `codex`      |
| `sidekick.claudePath`        | (empty) | Custom path to Claude CLI (for pnpm/yarn/non-standard installs)           |
| `sidekick.sidekickCliPath`   | (empty) | Custom path to the `sidekick` CLI executable (leave empty to auto-detect) |

## Accounts

| Setting                                 | Default | Description                                                                                                                     |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sidekick.accounts.autoSwitchThreshold` | `0`     | Quota utilization percentage (`1`–`100`) that triggers automatic switching to a healthier saved account. Set to `0` to disable. |

When the threshold is greater than `0`, the extension host watches multi-provider quota and switches to another saved account for the active provider once utilization crosses the threshold. Account sign-in and switching are available from the status bar menu and the Command Palette (**Sidekick: Add Account (Sign In)**, **Sidekick: Switch Account (All Providers)**). See [Account Management](../providers/account-management.md).

## z.ai (OpenCode routing)

| Setting             | Default | Description                                                                                                                                                   |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidekick.zai.tier` | `auto`  | Deprecated compatibility setting from the former z.ai estimator. Authoritative z.ai quota now comes from the z.ai quota API and does not use local tier math. |

When OpenCode is configured with a z.ai Coding Plan (GLM), Sidekick reads authoritative 5-hour and weekly quota percentages from z.ai's quota endpoint using the z.ai token stored by OpenCode, with fallback support for the official plugin's `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` environment variables.

See [OpenCode → z.ai Coding Plan quota](../providers/opencode.md#zai-coding-plan-quota) for details and limitations.

## Model Selection

All model settings accept: `auto` (recommended), a tier (`fast`/`balanced`/`powerful`), a legacy name (`haiku`/`sonnet`/`opus`), or a full model ID.

| Setting                       | Default | Auto Tier |
| ----------------------------- | ------- | --------- |
| `sidekick.inlineModel`        | `auto`  | fast      |
| `sidekick.transformModel`     | `auto`  | powerful  |
| `sidekick.commitMessageModel` | `auto`  | balanced  |
| `sidekick.docModel`           | `auto`  | fast      |
| `sidekick.explanationModel`   | `auto`  | balanced  |
| `sidekick.errorModel`         | `auto`  | balanced  |
| `sidekick.inlineChatModel`    | `auto`  | balanced  |
| `sidekick.reviewModel`        | `auto`  | balanced  |
| `sidekick.prDescriptionModel` | `auto`  | balanced  |

See [Model Resolution](model-resolution.md) for details on how tiers map to models.

## Inline Completions

| Setting                          | Default | Description                                                      |
| -------------------------------- | ------- | ---------------------------------------------------------------- |
| `sidekick.enabled`               | `true`  | Enable inline completions                                        |
| `sidekick.debounceMs`            | `1000`  | Delay before requesting completion (ms)                          |
| `sidekick.inlineContextLines`    | `30`    | Lines of context before/after cursor                             |
| `sidekick.multiline`             | `false` | Enable multi-line completions (prose files always use multiline) |
| `sidekick.transformContextLines` | `50`    | Lines of context for transforms                                  |
| `sidekick.showCompletionHint`    | `true`  | Show visual hint at cursor                                       |
| `sidekick.completionHintDelayMs` | `1500`  | Delay before showing hint (ms)                                   |

## Session Monitoring

| Setting                            | Default | Description                                                        |
| ---------------------------------- | ------- | ------------------------------------------------------------------ |
| `sidekick.enableSessionMonitoring` | `true`  | Enable CLI agent session monitoring (requires a window reload)     |
| `sidekick.sessionProvider`         | `auto`  | Which agent to monitor: `auto`, `claude-code`, `opencode`, `codex` |

`sidekick.enableSessionMonitoring` is read once at activation, so changing it prompts you to reload the window. While it is `false`, the Agent Hub container keeps only the Session Analytics view — which shows a placeholder with an **Enable session monitoring** button — and hides Mind Map, Kanban Board, Plans, Project Timeline, Latest Files Touched, Knowledge Notes, Subagents, and Event Stream.

## Commit Messages

| Setting                          | Default        | Description                           |
| -------------------------------- | -------------- | ------------------------------------- |
| `sidekick.commitMessageStyle`    | `conventional` | Format: `conventional` or `simple`    |
| `sidekick.commitMessageGuidance` | (empty)        | Default guidance for all commits      |
| `sidekick.showCommitButton`      | `true`         | Show sparkle button in Source Control |

## Explanations

| Setting                          | Default             | Description                                                                    |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `sidekick.explanationComplexity` | `imposter-syndrome` | Default level: `eli5`, `curious-amateur`, `imposter-syndrome`, `senior`, `phd` |

## Peak Hours

Only applies when the inference provider is Claude Max and the session provider is Claude Code. See [Peak Hours](../features/peak-hours.md) for background.

| Setting                                 | Default | Description                                                                                                                                                                 |
| --------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidekick.peakHours.enabled`            | `true`  | Show Claude peak-hours indicator in the dashboard and status bar. Polls [promoclock.co](https://promoclock.co/) (third-party) every 15 minutes while the dashboard is open. |
| `sidekick.peakHours.notifyOnTransition` | `false` | Show a one-time VS Code notification when peak hours start or end.                                                                                                          |

## Notifications

| Setting                                                | Default    | Description                                                   |
| ------------------------------------------------------ | ---------- | ------------------------------------------------------------- |
| `sidekick.notifications.enabled`                       | `true`     | Enable session notifications                                  |
| `sidekick.notifications.triggers.env-access`           | `true`     | Alert on credential file access                               |
| `sidekick.notifications.triggers.destructive-cmd`      | `true`     | Alert on destructive commands                                 |
| `sidekick.notifications.triggers.tool-error`           | `true`     | Alert on tool error bursts                                    |
| `sidekick.notifications.triggers.compaction`           | `true`     | Alert on context compaction                                   |
| `sidekick.notifications.triggers.sensitive-path-write` | `true`     | Alert on writes to sensitive paths                            |
| `sidekick.notifications.triggers.cycle-detected`       | `true`     | Alert on detected agent retry cycles                          |
| `sidekick.notifications.tokenThreshold`                | `500000`   | Total-token (incl. cache) alert threshold (0 = disabled)      |
| `sidekick.notifications.triggers.quota-threshold`      | `true`     | Alert when a subscription window crosses a threshold          |
| `sidekick.notifications.quotaFiveHourThresholds`       | `[80, 95]` | Five-hour window percentages that alert (highest is an error) |
| `sidekick.notifications.quotaSevenDayThresholds`       | `[90]`     | Seven-day window percentages that alert (highest is an error) |

!!! warning "Deprecated"
`sidekick.inlineTimeout` is deprecated and will be removed in a future release. Use `sidekick.timeouts.inlineCompletion` instead.

## Timeouts

| Setting                              | Default  | Description                               |
| ------------------------------------ | -------- | ----------------------------------------- |
| `sidekick.timeouts.inlineCompletion` | `15000`  | Inline completion timeout (ms)            |
| `sidekick.timeouts.explanation`      | `30000`  | Explanation timeout (ms)                  |
| `sidekick.timeouts.commitMessage`    | `30000`  | Commit message timeout (ms)               |
| `sidekick.timeouts.documentation`    | `45000`  | Documentation timeout (ms)                |
| `sidekick.timeouts.codeTransform`    | `60000`  | Code transform timeout (ms)               |
| `sidekick.timeouts.review`           | `45000`  | Pre-commit review timeout (ms)            |
| `sidekick.timeouts.prDescription`    | `45000`  | PR description timeout (ms)               |
| `sidekick.timeouts.inlineChat`       | `60000`  | Inline chat timeout (ms)                  |
| `sidekick.timeouts.errorExplanation` | `30000`  | Error explanation timeout (ms)            |
| `sidekick.timeoutPerKb`              | `500`    | Additional timeout per KB of context (ms) |
| `sidekick.maxTimeout`                | `120000` | Maximum timeout cap (ms)                  |
| `sidekick.autoRetryOnTimeout`        | `false`  | Auto-retry on timeout                     |

## Event Logging

| Setting                       | Default | Description                             |
| ----------------------------- | ------- | --------------------------------------- |
| `sidekick.enableEventLog`     | `false` | Record events to JSONL audit trail      |
| `sidekick.eventLogMaxSizeMB`  | `500`   | Max total event log size before cleanup |
| `sidekick.eventLogMaxAgeDays` | `30`    | Max age for event log files             |

## Pricing & Cost Tracking

| Setting                               | Default | Description                                                                 |
| ------------------------------------- | ------- | --------------------------------------------------------------------------- |
| `sidekick.pricing.hydrateFromLiteLLM` | `true`  | Fetch the LiteLLM catalog — prices and context window sizes — on activation |
| `sidekick.pricing.cacheTtlHours`      | `24`    | How long to cache the LiteLLM catalog (hours)                               |

The catalog is cached at `~/.config/sidekick/pricing-catalog.json` with a 3s fetch timeout and stale-cache fallback — if the network is down, the last good cache is used; if there is no cache, the static table ships as a fallback. Unknown models return `null` cost and render as `—` (yellow in the CLI; in the VS Code dashboard as `—` per row with a footer warning, and a `*` appended to the total when priced and unpriced rows are mixed).

### Context window sizes

The same catalog supplies context window sizes — it is literally named `model_prices_and_context_window.json` — so a newly released model sizes its context gauge correctly without waiting for an update.

Lookup is layered, most-trusted first: Claude Code's `[1m]` marker, then a window a provider actually reported, then the catalog, then the built-in table. Within that order an exact match in any layer beats a prefix match in every layer, so a known model is never sized from a catalog key that merely happens to be a prefix of its ID.

Windows that a provider reports for itself are remembered across runs in `~/.config/sidekick/observed-context-windows.json`. Codex reports one on every token count, and it reflects the window your account tier actually gets — often well below the model's published maximum — which is why it outranks the catalog. That file is written locally, never fetched, and needs no setting of its own.

## Session Handoff

| Setting                       | Default | Description                                                                          |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `sidekick.autoHandoff`        | `off`   | Handoff mode: `off`, `generate-only`, `generate-and-notify`                          |
| `sidekick.handoffUrlTemplate` | (empty) | External URL with `{sessionId}`, `{provider}`, and `{projectPath}` identifier fields |
