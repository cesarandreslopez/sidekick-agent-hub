# Settings Reference

All settings use the `sidekick.*` prefix. Open VS Code Settings (`Ctrl+,`) and search for "sidekick".

## Provider

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.inferenceProvider` | `auto` | AI provider: `auto`, `claude-max`, `claude-api`, `opencode`, `codex` |
| `sidekick.claudePath` | (empty) | Custom path to Claude CLI (for pnpm/yarn/non-standard installs) |

## Model Selection

All model settings accept: `auto` (recommended), a tier (`fast`/`balanced`/`powerful`), a legacy name (`haiku`/`sonnet`/`opus`), or a full model ID.

| Setting | Default | Auto Tier |
|---------|---------|-----------|
| `sidekick.inlineModel` | `auto` | fast |
| `sidekick.transformModel` | `auto` | powerful |
| `sidekick.commitMessageModel` | `auto` | balanced |
| `sidekick.docModel` | `auto` | fast |
| `sidekick.explanationModel` | `auto` | balanced |
| `sidekick.errorModel` | `auto` | balanced |
| `sidekick.inlineChatModel` | `auto` | balanced |
| `sidekick.reviewModel` | `auto` | balanced |
| `sidekick.prDescriptionModel` | `auto` | balanced |

See [Model Resolution](model-resolution.md) for details on how tiers map to models.

## Inline Completions

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.enabled` | `true` | Enable inline completions |
| `sidekick.debounceMs` | `1000` | Delay before requesting completion (ms) |
| `sidekick.inlineContextLines` | `30` | Lines of context before/after cursor |
| `sidekick.multiline` | `false` | Enable multi-line completions (prose files always use multiline) |
| `sidekick.transformContextLines` | `50` | Lines of context for transforms |
| `sidekick.showCompletionHint` | `true` | Show visual hint at cursor |
| `sidekick.completionHintDelayMs` | `1500` | Delay before showing hint (ms) |

## Session Monitoring

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.enableSessionMonitoring` | `true` | Enable CLI agent session monitoring |
| `sidekick.sessionProvider` | `auto` | Which agent to monitor: `auto`, `claude-code`, `opencode`, `codex` |

## Commit Messages

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.commitMessageStyle` | `conventional` | Format: `conventional` or `simple` |
| `sidekick.commitMessageGuidance` | (empty) | Default guidance for all commits |
| `sidekick.showCommitButton` | `true` | Show sparkle button in Source Control |

## Explanations

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.explanationComplexity` | `imposter-syndrome` | Default level: `eli5`, `curious-amateur`, `imposter-syndrome`, `senior`, `phd` |

## Notifications

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.notifications.enabled` | `true` | Enable session notifications |
| `sidekick.notifications.triggers.env-access` | `true` | Alert on credential file access |
| `sidekick.notifications.triggers.destructive-cmd` | `true` | Alert on destructive commands |
| `sidekick.notifications.triggers.tool-error` | `true` | Alert on tool error bursts |
| `sidekick.notifications.triggers.compaction` | `true` | Alert on context compaction |
| `sidekick.notifications.triggers.sensitive-path-write` | `true` | Alert on writes to sensitive paths |
| `sidekick.notifications.triggers.cycle-detected` | `true` | Alert on detected agent retry cycles |
| `sidekick.notifications.tokenThreshold` | `500000` | Token usage alert threshold (0 = disabled) |

!!! warning "Deprecated"
    `sidekick.inlineTimeout` is deprecated and will be removed in a future release. Use `sidekick.timeouts.inlineCompletion` instead.

## Timeouts

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.timeouts.inlineCompletion` | `15000` | Inline completion timeout (ms) |
| `sidekick.timeouts.explanation` | `30000` | Explanation timeout (ms) |
| `sidekick.timeouts.commitMessage` | `30000` | Commit message timeout (ms) |
| `sidekick.timeouts.documentation` | `45000` | Documentation timeout (ms) |
| `sidekick.timeouts.codeTransform` | `60000` | Code transform timeout (ms) |
| `sidekick.timeouts.review` | `45000` | Pre-commit review timeout (ms) |
| `sidekick.timeouts.prDescription` | `45000` | PR description timeout (ms) |
| `sidekick.timeouts.inlineChat` | `60000` | Inline chat timeout (ms) |
| `sidekick.timeouts.errorExplanation` | `30000` | Error explanation timeout (ms) |
| `sidekick.timeoutPerKb` | `500` | Additional timeout per KB of context (ms) |
| `sidekick.maxTimeout` | `120000` | Maximum timeout cap (ms) |
| `sidekick.autoRetryOnTimeout` | `false` | Auto-retry on timeout |

## Event Logging

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.enableEventLog` | `false` | Record events to JSONL audit trail |
| `sidekick.eventLogMaxSizeMB` | `500` | Max total event log size before cleanup |
| `sidekick.eventLogMaxAgeDays` | `30` | Max age for event log files |

## Session Handoff

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.autoHandoff` | `off` | Handoff mode: `off`, `generate-only`, `generate-and-notify` |
