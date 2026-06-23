# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.21.3] - 2026-06-23

### Added (sidekick-shared)

- **Quota projection helpers**: New exported `projectQuotaWindow()` / `withQuotaProjections()`, the `FIVE_HOUR_WINDOW_MS` / `SEVEN_DAY_WINDOW_MS` constants, and the `QuotaProjectionInput` type generalize the previously Claude-only end-of-window utilization projection, so Codex and z.ai quota states now populate `projectedFiveHour` / `projectedSevenDay`. Projection is idempotent and honors a `capturedAt` timestamp

### Changed (sidekick-cli)

- **`sidekick quota` projects every provider**: Quota output is now a unified table with aligned `now` / `projected` / `resets` columns, and projected end-of-window utilization is shown for all providers (Claude, Codex, z.ai) — previously Claude only. Bars are clamped to 0–100% and a `—` placeholder shows when a projection is unavailable; `sidekick quota --all` uses the same layout

### Fixed (sidekick-shared)

- **Bounded synchronous CLI probes**: Every synchronous `execFileSync` / `spawnSync` / `execSync` probe (keychain, Codex login / `pgrep`, `git rev-list`, `sqlite3`) now runs with `timeout: 4000` and `killSignal: 'SIGKILL'`, so a hung CLI, keychain prompt, or database can no longer block the caller indefinitely

### Fixed (sidekick-vscode)

- **Compact provider-outage status**: The dashboard's provider-status card now renders through a dedicated, testable display model (`providerStatusDisplay`) with severity, title, summary, an "N affected" count, and an `http(s)`-validated incident link, and inserts upstream status text/links via `textContent` / `createElement` instead of `innerHTML` (removing an HTML-injection vector)

### Security

- **npm audit**: Resolved reported dependency advisories across the monorepo — `dompurify` `^3.4.11` (VS Code webview sanitizer), `esbuild` `^0.28.1`, and `vitest` `^4.1.9`

### Changed (repo)

- **Repo-wide Prettier formatting**: Added a shared `prettier.config.cjs`, `format` / `format:check` scripts in all three packages, `scripts/format-all.sh` / `scripts/format-check-all.sh`, a `Format` CI workflow, and formatting gates in the release workflow

## [0.21.2] - 2026-06-22

### Changed (sidekick-shared)

- **Authoritative z.ai quota API**: z.ai Coding Plan quota is now read from z.ai's `api/monitor/usage/quota/limit` endpoint instead of being estimated from observed OpenCode traffic. New `zaiQuotaApi.ts` exports `resolveZaiQuota()`, `fetchZaiQuotaFromApi()`, `readZaiCredentials()`, and `quotaStateFromZaiQuotaLimitPayload()` — mapping the returned `TOKENS_LIMIT` percentages and `nextResetTime` values into Sidekick's 5-Hour / Weekly model, with credential discovery (OpenCode's stored `zai-coding-plan` → `zai` token, then `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`) and cached-snapshot fallback. The former observed-traffic estimator (`zaiQuota.ts` / `zaiQuotaWatcher.ts`) remains exported for compatibility but is deprecated and no longer used for product quota display

### Changed (sidekick-cli)

- **`sidekick quota --provider zai`** now renders authoritative z.ai plan utilization from z.ai's quota API (5-Hour / Weekly windows with real reset times), falling back to a cached snapshot when the API is unavailable. The `--tier lite|pro|max|auto` flag is deprecated and no longer affects the displayed utilization

### Changed (sidekick-vscode)

- **z.ai quota in the dashboard**: the z.ai card is now labeled "Live z.ai API" or "Cached z.ai API snapshot" (previously "Estimated from observed traffic"), reflecting authoritative quota from z.ai's API. The `sidekick.zai.tier` setting is deprecated and inert

## [0.21.1] - 2026-06-21

### Added (sidekick-shared)

- **z.ai Coding Plan quota derivation**: New `zaiQuota.ts` and `zaiQuotaWatcher.ts` modules derive an estimated `QuotaState` from OpenCode assistant turns tagged `providerID ∈ {zai, zai-coding-plan}`. Because z.ai exposes no quota/usage HTTP API (verified against `docs.z.ai/openapi.json`), utilization is computed by accumulating per-turn tokens into 5-hour and 7-day rolling windows and comparing against the published per-tier prompt budgets (Lite 80/400, Pro 400/2000, Max 1600/8000 prompts per 5h/week). Authoritative reset timestamps are extracted from trapped `1308`/`1310`/`1313`/`1309` business error codes when present

### Added (sidekick-cli)

- **z.ai quota on `sidekick quota`**: `sidekick quota --provider zai` derives and renders z.ai Coding Plan quota from observed OpenCode traffic; `--tier lite|pro|max|auto` overrides the plan tier used for utilization math (default `auto`). `sidekick quota --provider opencode` auto-routes to z.ai when z.ai traffic is detected. `sidekick quota --all` now includes the z.ai section when active, and `quota history --provider zai` renders a 13-week heatmap for the z.ai runtime

### Added (sidekick-vscode)

- **z.ai quota in the dashboard**: When OpenCode is the active session provider and z.ai routing is detected, the dashboard renders a third quota card (5-Hour / Weekly) labeled "Estimated from observed traffic". z.ai quota flows through the snapshot/history pipeline so the 13-week heatmap works automatically
- **`sidekick.zai.tier` setting**: New setting (`auto` | `lite` | `pro` | `max`, default `auto`) overrides the z.ai plan tier used for utilization math
- **Quota alerts for OpenCode**: Quota-failure alerts now also fire when the active session provider is `opencode`, so z.ai rate-limit errors surface as notifications

### Fixed

- **OpenCode data directory resolution**: `getOpenCodeDataDir()` now probes both the macOS (`~/Library/Application Support/opencode`) and Linux-style (`~/.local/share/opencode`) candidate paths and returns whichever actually contains `opencode.db`, matching where OpenCode's CLI writes on real installations. Previously, on macOS machines where OpenCode writes to `~/.local/share/opencode`, the dashboard and quota features failed to detect the DB

### Limitations

- The z.ai quota is **estimated, not authoritative**, and several capabilities are not yet delivered. z.ai exposes no usage API, so utilization is derived only from OpenCode traffic observed on this machine/workspace and compared against provisional per-tier prompt budgets. z.ai is **observed-only** (not selectable as an inference provider) and has **no account management** in this release; auto-tier detection under-reports early in a cycle; reset times are approximate unless a rate-limit error is trapped; OpenCode has no native (non-z.ai) quota. See the OpenCode provider guide for the full list of current limitations and planned work.

## [0.21.0] - 2026-06-21

### Added (sidekick-shared)

- **Account Management 2.0**: Provider-neutral account acquisition and switching APIs for Claude Max and Codex. `beginAccountLogin()`, `getAccountLoginStatus()`, `finalizeAccountLogin()`, and `spawnAccountLogin()` support isolated login profiles; `listAllAccounts()` and `switchAccount()` expose a shared account switcher surface for hosts
- **Claude profile homes**: Claude accounts now have canonical profile homes under Sidekick's account store, with account-specific macOS keychain service suffixes and startup migration from legacy flat backups. Switching applies the selected profile back to the live Claude home without destroying unrelated saved accounts
- **Terminal sync and quota auto-switch primitives**: New opt-in terminal profile pointers, shell hook/launcher helpers, and a default-off `AutoSwitchController` for switching to a healthier saved account when quota crosses a configured threshold
- **Account Zod schemas**: `sidekick-shared/schemas` and the package root now export account-management validators including `beginAccountLoginResultSchema`, `accountLoginStatusSchema`, `accountManagerResultSchema`, and `listAllAccountsResultSchema`

### Added (sidekick-cli)

- **Account login and all-provider views**: `sidekick account --login` starts provider-isolated login, `--provider all` lists Claude and Codex accounts together, `--launcher` creates opt-in terminal launchers, and `--auto-switch <pct|off>` persists the CLI auto-switch preference
- **Multi-provider quota output**: `sidekick quota --all` renders Claude and Codex quota state together — each provider degrades independently, so one provider's quota still prints when the other is unavailable; `--all --json` emits a provider-keyed payload suitable for dashboards and automation

### Added (sidekick-vscode)

- **Account sign-in and all-provider switching**: New commands for signing into Claude/Codex accounts from the integrated terminal and switching across all saved providers from one QuickPick. The account status bar now opens the all-provider switcher
- **Quota auto-switch setting**: `sidekick.accounts.autoSwitchThreshold` enables the default-off auto-switch controller in the extension host

### Documentation

- Added an Account Management provider guide covering the API contract, TTY-less login sequence, runtime schemas, and operational caveats for downstream desktop hosts.

## [0.20.0] - 2026-06-17

### Added (sidekick-shared)

- **Actionable session asset extraction**: New Node-only extraction APIs collect URLs, filesystem-validated file paths, commands the agent suggested for the user to run, and plan-mode plans from recent Claude Code and Codex sessions for exactly one cwd. `gatherAssetsForCwd()` merges supported agents with recency sorting, dedupe, and per-type caps; lower-level `extractUrls()`, `extractFilePaths()`, `extractCommands()`, `readClaudeAssets()`, and `readCodexAssets()` are exported for custom tooling. The API is safe for CLI and VS Code extension-host code, but intentionally not exported from `sidekick-shared/browser`
- **Session asset provenance**: Extracted assets now carry optional `agent`, `sessionPath`, and `source` metadata so CLI, VS Code, and custom tools can label where each URL, path, command, or plan came from without changing the stable `text`/`display` fields

### Added (sidekick-cli)

- **`sidekick extract`**: New one-shot command for pulling URLs, paths, commands, and plans out of recent Claude Code and Codex chats. Supports grouped colored text, `--json`, `--type url,path,command,plan`, `--limit`, and `-i/--interactive` picker actions that open URLs or copy selections. The command preserves exact-cwd scoping and reports OpenCode as unsupported instead of silently reading other providers
- **Extract output polish**: `sidekick extract` now validates invalid `--type` and `--limit` values, preserves `inChat` in JSON output, and labels text output with the source agent for each asset

### Added (sidekick-vscode)

- **Native asset extraction command**: `Sidekick: Extract Session Assets` opens a searchable VS Code QuickPick backed by the shared extractor. URLs open externally, file paths open in the editor at their line when available, commands copy to the clipboard, and plans open as Markdown scratch documents

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing the feature in [#17](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/17), adapted from his MIT-licensed [`trawl`](https://github.com/B33pBeeps/trawl) project.

## [0.19.3] - 2026-06-17

### Added (sidekick-shared)

- **Assistant turn timeline**: `segmentAssistantTurn()` now emits a required v2 `timeline` array that preserves reasoning, narration, and tool groups in original arrival order while keeping the final answer text excluded. The mirrored Zod schemas and public type exports include the new timeline contract for browser and IPC consumers

### Changed (sidekick-vscode)

- **Conversation view interleave**: The transcript rail now renders assistant reasoning, tool calls, and narration from the shared assistant-turn timeline, preserving provider-normalized arrival order for Claude, Codex, and OpenCode sessions while keeping the final answer separate. Tool calls render as concise rows with their summary inline, while tool results stay expandable to reveal their output

## [0.19.2] - 2026-06-15

### Added (sidekick-shared)

- **Assistant turn projection**: Browser-safe helpers that segment a provider-normalized assistant turn into a compact, UI-ready Process + Answer shape. `segmentAssistantTurn()` keeps only the final contiguous text run as `answer` and moves earlier narration, tool calls, and reasoning into `process.steps` / `reasoningBlocks` — adjacent tool calls collapse into grouped `toolGroup` steps, and process/reasoning are length-capped (with an "N omitted" marker) while the answer stays uncapped. `assistantTurnEventsFromSessionEvents()` adapts canonical `SessionEvent[]` into the turn-event stream the segmenter consumes, and `extractTurnSubagents()` / `reasoningSummary()` / `isAssistantTurnSubagentTool()` cover Claude `Task` subagent refs and bold-heading reasoning summaries. `Task` tool inputs are projected **without leaking the prompt** — only `subagent_type` and `description` survive. The mirrored Zod schemas (`assistantTurnProjectionSchema`, `assistantTurnEventSchema`, `assistantTurnProcessStepSchema`, `assistantTurnSubagentSchema`, and friends) validate the shape at UI/IPC boundaries, and the whole module is exposed fs-free via the `sidekick-shared/browser` and `sidekick-shared/schemas` subpaths

## [0.19.1] - 2026-06-09

### Added (sidekick-shared)

- **Zod boundary schemas**: Runtime validation for the data shapes that cross process/IPC boundaries — quota (`quotaStateSchema`, `quotaWindowSchema`, `providerQuotaStateSchema`, `claudeProviderQuotaStateSchema`, `codexProviderQuotaStateSchema`, `providerQuotaMapSchema`, `peakHoursStateSchema`, `quotaFailureDescriptorSchema`), quota history (`quotaHistorySampleSchema`, `quotaHistoryDailyBucketSchema`), and account status (`activeAccountStatusSchema`, `activeProviderAccountStatusSchema`). Each is exported alongside its mirrored TypeScript type
- **`extractSessionEvents()` helper**: Unwraps Claude Code's `{ type: 'progress', data: { message } }` envelopes — which `sessionEventSchema` alone rejects — into canonical `SessionEvent[]`. Recurses through nested envelopes (depth-bounded at 8), returns zero events for unrecognized input, and never throws
- **`sidekick-shared/schemas` subpath**: A dedicated entry point exposing the Zod boundary schemas without `node:fs` / `node:path` — lean enough to import into browser bundles or boundary-validation modules without dragging in the rest of the library

### Changed (sidekick-shared)

- **Forgiving model-ID lookups**: `getModelContextWindowSize()`, `parseModelId()`, and `getModelPricing()` now trim and lowercase their input, so padded or mixed-case IDs (e.g. `" Claude-Opus-4-8 "`) resolve without caller-side normalization. `getModelPricing()` still tries the verbatim ID first — preserving mixed-case LiteLLM override keys — before retrying normalized
- **`sideEffects: false`**: The package is now marked side-effect-free so downstream bundlers can tree-shake unused exports

## [0.19.0] - 2026-06-09

### Added (sidekick-shared)

- **Claude Opus 4.8 & Fable 5 support**: `claude-opus-4-8` and `claude-fable-5` (Anthropic's new Mythos-class flagship) are now recognized everywhere models are interpreted — 1M-token context windows in `getModelContextWindowSize()`, static pricing (Opus 4.8: $5/$25 per MTok; Fable 5: $10/$50 per MTok, with standard 1.25×/0.1× cache write/read multipliers), `parseModelId()` recognizes the `fable` family, `shortModelName()` renders "Fable", and model pickers rank Fable above Opus

### Changed (sidekick-shared)

- **Codex account switching now swaps `~/.codex/auth.json`**: Switching Codex accounts previously only updated the Sidekick registry pointer and relied on `CODEX_HOME` redirection, so codex terminals outside Sidekick never saw the switch. `switchToCodexAccount()` now mirrors the Claude switch pattern — it syncs the live (rotated) tokens back into the matching profile backup, then atomically swaps the target profile's `auth.json` into the system `~/.codex/` home, with rollback on failure. Live credentials are never overwritten by a staler copy of the same account (Codex rotates refresh tokens; resurrecting an old one permanently invalidates the login). Profile directories under `~/.config/sidekick/accounts/codex/profiles/` are now pure credential backups — `resolveSidekickCodexHome()` always returns the system home — and `finalizeCodexAccount()` activates freshly added accounts through the same swap. A one-time startup reconciliation migrates installs created under the old dual-home model; unknown live credentials are stashed, never dropped

### Fixed (sidekick-shared)

- **Opus 4.6/4.7 cost over-estimation**: Dashed model IDs (`claude-opus-4-6`, `claude-opus-4-7`) used to prefix-match the `claude-opus-4` pricing entry ($15/$75) instead of their actual $5/$25 rate, inflating estimated costs 3×. The static table now carries explicit dashed and dotted keys for Opus 4.6/4.7/4.8 and corrects the dotted `claude-opus-4.6` entry
- **Haiku 4.5 unpriced under dashed IDs**: `claude-haiku-4-5-20251001` matched no static pricing key (only the dotted `claude-haiku-4.5` existed), so costs rendered as "—" unless the LiteLLM catalog hydration rescued it. Dashed keys for Haiku 4.5 and Sonnet 4.5/4.6 are now in the static table
- **Temp-file cleanup in profile state writes**: `atomicWriteJson()` now removes its `.tmp` file when the write or rename fails instead of leaving it behind

### Changed (extension)

- **Refreshed Anthropic model tier defaults**: The `claude-api` and `opencode` inference providers now resolve fast/balanced/powerful to `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-8`. The previous defaults were retired or retiring upstream — `claude-3-5-haiku-20241022` was retired in February 2026 (requests 404), and `claude-sonnet-4-20250514` / `claude-opus-4-20250514` retire June 15, 2026. `ApiKeyClient`'s availability probe and shorthand mapping were updated to match
- **Fable display names**: Dashboard, conversation view, and webview model labels recognize `claude-fable-5`; the dashboard context-window tooltip no longer claims a fixed 200K window
- **Bundled `sidekick-shared` 0.19.0**: Account switching from the extension activates Codex profiles via the `auth.json` swap

### Changed (CLI)

- **Codex account swap warnings**: `sidekick account --provider codex` surfaces swap warnings on add, switch, and remove — a running codex process that needs restarting, stale credentials, or OS-keyring credential storage that Sidekick cannot swap

## [0.18.5] - 2026-06-04

### Added (sidekick-shared)

- **Session context evidence snapshots**: New `sessionContext` module projects a provider-neutral view of what an assistant has "seen" in a session. `buildSessionContextSnapshot()` extracts layered evidence sources (system, user prompts, tool inputs/outputs, thinking) from canonical `SessionEvent` streams; `calculateSessionContextPressure()` maps token usage to a low/medium/high band (60% / 80% thresholds); `createSessionContextProjector()` builds snapshots incrementally; and `readSessionContextSnapshot()` reads them through a provider reader. New types `SessionContextSnapshot`, `SessionContextSource`, `SessionContextCapabilities` (observed tools, MCP servers, permission mode, rate limits), and `SessionContextPressure`. Exported from both `sidekick-shared` and `sidekick-shared/browser`; all three session providers (`claude-code`, `codex`, `opencode`) gain a `readSessionContextSnapshot()` method

### Fixed (sidekick-shared)

- **Codex session evidence gaps**: The Codex parser now emits `system` audit events for base instructions and developer/system messages, normalizes `token_count` records into `system` events that carry normalized rate limits, expands a single `apply_patch` into one `Edit` per file, dedupes repeated `exec_command` / `mcp_tool_call` emissions, and preserves MCP server attribution (`_sidekickMcpServerName`) on synthesized tool inputs. `EventAggregator` now understands the `system` event type — these events are excluded from message counts and from tool/task/plan/subagent extraction, but still contribute to system-prompt context attribution and token totals. A new `ProviderReaderSessionWatcher` plus `parseTranscriptFromEvents()` route Codex sessions through the canonical `SessionEvent` → transcript path for parity with the other providers
- **HTML report source labels**: Transcript source labels (e.g. "base instructions", "token count", "developer") now render with a dedicated `.message-source` style instead of reusing the model-name badge
- **Codex stats read failures**: `readSessionStats` now surfaces a malformed-rollout error under `DEBUG` instead of swallowing it silently

### Changed (extension)

- **Codex parsing parity**: `ProjectTimelineDataService` and the related extension wiring consume the canonical Codex parsing path (provider reader + `parseTranscriptFromEvents`), keeping the project timeline, dashboard, and reports consistent with the CLI
- **Bundled `sidekick-shared` 0.18.5**: Picks up session context evidence snapshots and the Codex evidence gap closures

### Changed (CLI)

- **Consistent Codex transcripts**: `sidekick dashboard` and `sidekick report` now parse Codex sessions via `parseTranscriptFromEvents()`, matching the canonical event pipeline used elsewhere
- **Bundled `sidekick-shared` 0.18.5**: Picks up session context evidence snapshots and the Codex evidence gap closures

## [0.18.4] - 2026-05-27

### Fixed (sidekick-shared)

- **Codex quota snapshot selection across multiple rollout files**: When multiple Codex sessions report rate-limit data, the resolver now picks the snapshot from the newest reset window and, within the same window, the highest observed utilization — instead of returning whichever rollout file happened to be scanned first. New helpers `isPreferredQuotaHit()` and `findAccountRolloutFiles()` (which searches across all configured Codex home directories) replace the previous first-match return. `shouldKeepExistingSnapshot()` in the snapshot cache prevents a stale rollout from overwriting a higher-fidelity cached snapshot for the same reset window

### Changed (sidekick-shared)

- **Peak hours scoped to Claude Code session provider**: New helpers `scopePeakHoursToSessionProvider()`, `isClaudeCodeSessionProvider()`, and `createPeakHoursNotApplicableState()` gate peak-hours state on both the `claude-max` inference provider and the `claude-code` session provider. `PeakHoursState` gains an optional `notApplicable` field for providers where peak hours are irrelevant

### Changed (sidekick-vscode)

- **Peak hours hidden for non-Claude Code sessions**: `PeakHoursService` now takes a `getSessionProviderId` callback and requires both `claude-max` inference and `claude-code` session provider before polling. The dashboard pill and status bar glyph are suppressed for OpenCode and Codex session providers, and switching session providers triggers an immediate reconcile

### Changed (sidekick-cli)

- **`sidekick peak --provider <id>`**: New flag gates peak-hours output on the session provider. When the resolved provider is not `claude-code`, the command prints a "not applicable" message instead of calling the upstream endpoint. `sidekick peak` without `--provider` continues to auto-detect

### Fixed (sidekick-vscode)

- **Codex quota fallback on dashboard open**: When no live Codex session provides quota and the dashboard is opened or the provider switches to Codex, the dashboard now calls `resolveCodexQuotaFromLocalSources()` (workspace rollouts → account rollouts → snapshot cache) instead of only reading the snapshot cache directly

## [0.18.3] - 2026-05-19

### Added (sidekick-shared)

- **Per-workspace quota history (`appendQuotaHistorySample`, `readQuotaHistoryRange`, `readQuotaHistoryDailyBuckets`, `pruneQuotaHistory`, `getWorkspaceIdFromPath`)**: New append-only JSONL store at `~/.config/sidekick/quota-history/<workspaceId>/<provider>.jsonl`. 60-second per-sample debounce, 91-day (13-week) retention, atomic prune above 16 KB, `0600` file mode and `0700` directory mode, and an in-process append chain that prevents interleaved writes from concurrent callers. Workspace ids are `sha256(realpath)[0..16]` so the CLI and extension agree on the same store for a given folder. Live append failures are swallowed so the quota emission path is never poisoned, and snapshot writes are mirrored so existing latest-snapshot consumers keep working unchanged
- **`CodexQuotaWatcher` history hook**: New optional `workspaceId` and `appendHistorySample` options; when `workspaceId` is provided, every live Codex quota emit also appends a sample to the per-workspace history

### Added (sidekick-cli)

- **`sidekick quota history`**: New subcommand that renders a 13-week GitHub-contributions-style heatmap of quota utilization for the current workspace. Flags: `--weeks <n>` (1-26, default 13), `--provider claude|codex` (default both), `--workspace <path>` (default cwd). Bucketed glyphs (`· ░ ▒ ▓ █`) are color-coded by utilization band (≤0 / <25 / <50 / <75 / ≥75), with per-provider rows and a peak / avg / unavailable-days / samples footer. Days that hit `available: false` render as a red `×`. With the inherited `--json` flag, emits a `{ workspaceId, weeks, providers: { claude?, codex? }, generatedAt }` payload — the same shape consumed by the VS Code dashboard

### Added (sidekick-vscode)

- **Quota History dashboard panel**: New "Quota History · Last 13 weeks · peak utilization per day" section under the quota readout. Per-provider SVG heatmap (Claude / Codex) using bucketed `var(--vscode-textLink-foreground)` shades, per-cell `<title>` tooltips (date · peak % · sample count), a red overlay for days that hit "unavailable", and a "Less / More" legend. The section auto-hides when no data exists for either provider
- **History sampling**: Every Claude quota refresh from `QuotaService` and every Codex quota update from `CodexSessionProvider` now writes a sample into the shared workspace history JSONL when a workspace is open and a saved account is active. New `utils/workspaceId.ts` wraps `vscode.workspace.workspaceFolders[0]?.uri.fsPath → getWorkspaceIdFromPath` so the extension and CLI hash the same path to the same id

## [0.18.2] - 2026-05-19

### Added (sidekick-shared)

- **Codex quota orchestrator (`resolveCodexQuota()`)**: New entry point that resolves Codex rate-limit data in a single call with a configurable `source: 'local' | 'api' | 'auto'`. The `local` path walks the workspace's most recent Codex rollout, then recent account-level rollouts under `CODEX_HOME/sessions`, then the account-scoped snapshot cache; `api` calls Codex's ChatGPT `wham/usage` endpoint first with a local fallback; `auto` tries local first and falls back to the API. Helpers `resolveCodexQuotaFromLocalSources()`, `readLatestCodexQuotaFromRollouts()`, and `fetchCodexQuotaFromApi()` are also exported for callers that need finer control
- **Codex quota types**: `CodexQuotaApiOptions`, `CodexQuotaCreditsSnapshot`, `CodexQuotaResolveOptions`, and `CodexQuotaResolveSource` are exported alongside the new functions
- **Provider-specific quota metadata on `QuotaState`**: Optional `limitId`, `limitName`, `credits`, `planType`, and `rateLimitReachedType` fields propagate through quota snapshots, so callers can render plan, limit, and "rate limit reached" reasons without re-parsing upstream payloads

### Added (sidekick-cli)

- **`sidekick quota --refresh`**: New flag on the `quota` command that, for Codex, explicitly refreshes from the ChatGPT usage API before falling back to local rollout data and cached snapshots. Without the flag, the Codex quota path stays fully local and makes no upstream network call

### Changed (sidekick-cli)

- **Codex quota is local-only by default**: `sidekick quota --provider codex` now uses the new `resolveCodexQuota` orchestrator and only consults local sources (current workspace rollout → account-level rollouts → cached snapshot) unless `--refresh` is passed. Failure output still includes structured `failureKind` / `httpStatus` / `retryAfterMs` fields under `--json`

### Changed (sidekick-shared)

- **`CodexRateLimits` accepts nullable reset fields**: `primary.resets_at`, `secondary.resets_at`, `primary.window_minutes`, and `secondary.window_minutes` are now `number | null | undefined`, matching the live Codex usage API payload. `quotaFromCodexRateLimits()` normalizes nullish percentages and timestamps and accepts an additional `'api'` source value alongside `'session'` / `'cache'`
- **`CodexQuotaWatcher` falls back to local rollouts**: When the active workspace has no live Codex rollout, the watcher now consults `resolveCodexQuotaFromLocalSources()` (workspace + account-level rollouts) before falling back to the account-scoped snapshot cache. New optional `maxTailBytes` / `maxSessionFiles` knobs cap the work done while scanning rollouts

### Fixed (sidekick-shared)

- **Codex `state_N.sqlite` discovery**: `CodexDatabase` and the provider auto-detector now match both `state.sqlite` and versioned `state_N.sqlite` filenames (preferring the most recently modified DB). Fresh Codex CLI installs that no longer write a plain `state.sqlite` are now detected and read correctly
- **`JsonlSessionWatcher` emits rate-limit-only `token_count` events**: When a Codex `token_count` payload carries `rate_limits` but no `last_token_usage` / `total_token_usage`, the watcher now still emits a `system` event with the rate limits attached (summary `Rate limits updated`). Quota updates can no longer be swallowed just because the same record has no token-usage delta

## [0.18.1] - 2026-05-08

### Added (sidekick-shared)

- **Shared display formatting (`formatTokenCount()`, `formatDurationMs()`)**: Single source of truth for compact token (`12.5k` / `1.2M`) and duration (`5m 30s`) rendering, exposed from the root, `sidekick-shared/browser`, and `sidekick-shared/formatting` entrypoints so CLI, webview, and downstream consumers no longer fork their own helpers
- **Raw JSONL tailing (`createJsonlTail()`)**: Offset-tracked incremental JSONL reads with optional Zod validation, debounced `fs.watch` plus catch-up polling, and a post-batch callback that lets aggregation-driven consumers defer expensive UI/metric updates until parsing for a chunk is complete

### Changed (sidekick-vscode)

- **Public shared imports**: Extension code now consumes supported `sidekick-shared` entrypoints (`sidekick-shared`, `sidekick-shared/browser`, `sidekick-shared/phrases`) instead of reaching into `dist/*`. `services/JsonlParser.ts` is now a compatibility shim re-exporting `JsonlParser`, `extractTokenUsage`, and `extractToolCall` from `sidekick-shared`, removing the forked parser implementation
- **Shared display formatting**: Status bar, session summary, analysis prompt, handoff document, and bundled dashboard webview now reuse `formatTokenCount()`, `formatDurationMs()`, and `formatCost()` from `sidekick-shared`. Webview dashboard token cards render compact `12.3k` / `1.2M` totals (previously `12,345`); status bar, CLI, and tooltip helpers continue to use uppercase `K`/`M`

### Changed (sidekick-cli)

- **Shared dashboard formatting**: Terminal dashboard `fmtNum()` and `formatDuration()` now delegate to `formatTokenCount()` and `formatDurationMs()` from `sidekick-shared`, preserving the existing CLI surface (uppercase `K`/`M` suffix, compact `1m5s` style) while removing forked rounding logic

## [0.18.0] - 2026-05-08

### Added (sidekick-shared)

- **Provider-aware quota orchestration (`MultiProviderQuotaService`)**: New service that coordinates Claude polling, peak-hours enrichment, account labels, transient-failure backoff, and optional Codex quota watcher updates behind one typed `{ claude?, codex? }` event stream. Designed to replace ad-hoc per-provider polling wiring in downstream consumers
- **Codex quota watcher (`CodexQuotaWatcher`)**: Discovers the active Codex rollout for a workspace, watches it for live rate-limit updates, persists account-scoped snapshots, and falls back to cached or unavailable states when no live data exists. Plugs directly into `MultiProviderQuotaService` or runs standalone
- **Account status helper (`getActiveAccountStatus()`)**: Single-pass read of active Claude Code and Codex account status, returning a consistent provider-shaped result for startup and setup flows
- **Tool-call extraction helper (`extractToolCall()`)**: Extracts a top-level `tool_use` event, complementing the existing `extractToolCalls()` assistant-content-block helper for providers that normalize tool calls as their own events
- **Cost provenance & model display helpers**: `calculateCostWithProvenance()` and `mergeCostSources()` preserve whether a cost was provider-reported, locally estimated, or unpriced — essential for honest UI rollups. `shortModelName()`, `getModelDisplayInfo()`, `compareModelIds()`, and `sortModelIds()` provide reusable display and ranking primitives next to pricing
- **Phrase categories (`PHRASE_CATEGORIES`)**: Exposes the category structure behind the existing flat `ALL_PHRASES` array, enabling category-aware UI without duplicating the phrase set

### Changed

- **Legacy Claude model parsing**: `parseModelId()` now recognizes legacy IDs such as `claude-3-opus-20240229` and `claude-3-5-sonnet-20241022` (version before family) in addition to the modern `claude-{family}-{version}-...` form
- **Version sync**: VS Code extension and CLI bumped to 0.18.0 in lockstep with the shared library to keep release tags aligned. No runtime behavior change in the extension or CLI; downstream wiring of `MultiProviderQuotaService` and `CodexQuotaWatcher` will land in a follow-up release

## [0.17.7] - 2026-04-28

### Fixed

- **Quota snapshot write race**: `sidekick-shared` now writes `quota-snapshots.json` through a unique temp file per write and cleans up partial writes on error, preventing concurrent Codex quota updates from colliding on `quota-snapshots.json.tmp` and surfacing `ENOENT` during active sessions when the VS Code extension and CLI update quota at the same time

## [0.17.6] - 2026-04-19

### Added

- **Claude peak-hours indicator**: Sidekick now surfaces Anthropic's peak-hours schedule (weekdays 13:00–19:00 UTC — when session limits drain faster for Free/Pro/Max/Team subscriptions) across all three surfaces, gated on the Claude Max inference provider so OpenCode / Codex / API-key users see nothing and make no upstream network calls
  - **Shared library**: new `fetchPeakHoursStatus()` and `PeakHoursState` exports from `sidekick-shared`, backed by the public `promoclock.co/api/status` endpoint (third-party, unaffiliated with Anthropic) with a graceful `unavailable: true` fallback on any network or parse error
  - **VS Code extension**: new `PeakHoursService` polls every 15 minutes while the dashboard is open and the active provider is Claude Max. A subtle orange pill appears in the dashboard only during an active peak window (off-peak renders nothing), and the session status bar appends a `🟠` glyph with a countdown in the tooltip. Optional opt-in transition notification via `sidekick.peakHours.notifyOnTransition`. Master toggle: `sidekick.peakHours.enabled` (default `true`)
  - **CLI**: new `sidekick peak` one-shot command; `sidekick status` now includes a **Claude Peak Hours** block when the active provider is `claude-code`; `sidekick quota` shows a one-line peak summary under the 5-hour / 7-day bars for Claude subscriptions. All three support `--json`
- **Documentation**: new `docs/features/peak-hours.md` explaining the schedule, who's affected, where the indicator shows up, and the privacy posture around the third-party data source. Linked from the settings reference and the CLI feature docs

## [0.17.5] - 2026-04-18

### Added

- **Default account auto-registration**: On first startup, Sidekick now auto-registers the active system Claude Code and Codex credentials as a "Default" account in the shared account registry — without overwriting accounts that were saved manually. Quota and analytics surfaces that read from the registry work out of the box instead of silently no-oping until someone ran `Save Current Account` / `sidekick account --add`. Exposed from `sidekick-shared` as `ensureDefaultAccounts()`, wired into CLI startup via a non-blocking Commander `preAction` hook (so `--version` / `--help` stay fast) and into VS Code extension activation. Idempotent — repeated calls never create duplicates, and per-provider errors are logged and swallowed rather than thrown

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing this feature in [#16](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/16).

## [0.17.4] - 2026-04-17

### Added

- **`sidekick-shared` packaging split**: `sidekick-shared` now ships supported, documented subpath entries — `sidekick-shared/browser` for pure, filesystem-free helpers safe in webview/browser bundles (context-window lookup, model parsing, cost math), and `sidekick-shared/node` for Node-only pricing hydration. Plus convenience subpaths `sidekick-shared/phrases`, `sidekick-shared/modelContext`, and `sidekick-shared/modelInfo`
- **Typed `exports` map on `sidekick-shared`**: Downstream consumers (including TypeScript) now resolve the new subpaths cleanly with per-entry `types` + `default` conditions. Existing `sidekick-shared/dist/*` deep imports keep working via a compat entry in the exports map, so nothing breaks in this release
- **Webview import guard (VS Code extension)**: New ESLint `no-restricted-imports` rule scoped to `sidekick-vscode/src/webview/**` forbids importing `sidekick-shared` (root), `sidekick-shared/node`, or `sidekick-shared/dist/pricingCatalog` — preventing Node-only code from ever being pulled into a browser bundle through a future refactor

### Changed

- **Pricing hydration call sites migrated to `/node`**: The VS Code extension host (`extension.ts`) and the CLI (`cli.ts`) now import `hydratePricingCatalog` from `sidekick-shared/node` instead of a `dist/*` deep path (extension) or the package root (CLI). Runtime behavior is unchanged; the import now self-documents that this code is Node-only

## [0.17.3] - 2026-04-17

### Changed

- **Changelog hygiene**: Republish of 0.17.2 after removing a stray empty `## [Unreleased]` heading that was bundled into the 0.17.2 VS Code extension `.vsix`. No behavioral or code changes — the extension, CLI, and shared library are functionally identical to 0.17.2

## [0.17.2] - 2026-04-17

### Added

- **LiteLLM pricing hydration**: On startup, the extension and CLI fetch the LiteLLM pricing catalog and cache it to `~/.config/sidekick/pricing-catalog.json` with a 24-hour TTL, 3s timeout, and stale-cache fallback. Fresh pricing lands automatically without needing a release
- **Expanded pricing coverage**: `PRICING_TABLE` now recognizes Anthropic, OpenAI, and Google model families — GPT-4o, GPT-4.1, GPT-5.x, o1, o3, and o3-mini in addition to the existing Claude entries
- **Reasoning-token billing**: `CostTokenUsage` now carries `reasoningTokens`, priced at the output rate (matches OpenAI billing)
- **Provider-omitted cost computation**: `EventAggregator` computes cost from the pricing table when the provider doesn't report one — Claude Code and Codex sessions now show real dollars in the CLI dashboard
- **New VS Code settings**: `sidekick.pricing.hydrateFromLiteLLM` (default `true`) and `sidekick.pricing.cacheTtlHours` (default `24`) — disable or tune the LiteLLM hydration from the UI

### Fixed

- **Context-window % wrong for Opus 4.7 (and other new models)**: The dashboard and status bar now report accurate context usage for Claude Opus 4.7, Sonnet 4.7, GPT-5.4, and GPT-5.3-Codex variants. The model → context-window map in `sidekick-shared` now includes these families (Opus 4.7 = 1M, Sonnet 4.7 = 1M, GPT-5.4 = 1.05M, GPT-5.3-Codex = 400K, GPT-5.3-Codex-Spark = 128K) instead of falling through to 200K via prefix match. Also honors Claude Code's `[1m]` suffix as an explicit 1M marker
- **Silent Sonnet-priced fallback for unknown models**: Unknown models (Codex, GPT-5.x, o-series) were previously billed at Sonnet rates, silently inventing a dollar figure. `getModelInfo()` now returns `null` cost for unknown models and `formatCost(null)` renders as `—` — in the VS Code dashboard as `—` per row with a footer warning and a `*` marker on totals when priced and unpriced rows mix; in the CLI dashboard in yellow

### Changed

- **`historical-data.json` schema v2**: `ModelUsageRecord` gains an optional `priced` flag and `SessionSummary` gains an optional `unpricedModelIds` array so historical data can distinguish real costs from unknown-model gaps. Fix-forward only — v1 records continue to read correctly, no migration required

## [0.17.1] - 2026-04-13

### Fixed

- **Codex multi-home session discovery**: Provider detection and session monitoring now scan all candidate Codex home directories (managed profile + system `~/.codex/`) instead of only the active managed profile, fixing missed sessions when the managed profile home has no activity

## [0.17.0] - 2026-04-13

### Added

- **Multi-provider account registry**: Account management is now provider-aware — each provider (Claude Code, Codex) maintains its own active account with independent switching, stored in a v2 registry format that auto-migrates from v1
- **Codex profile management**: Full lifecycle for Codex accounts — prepare, finalize, switch, and remove profiles with isolated `CODEX_HOME` directories per account
- **Quota snapshot caching**: Cached rate-limit snapshots per provider/account in `~/.config/sidekick/quota-snapshots.json` for offline fallback with "cached from" indicators
- **VS Code multi-provider account UI**: `Switch Account`, `Add Account`, and `Remove Account` commands now work for both Claude Code and Codex — with guided login flow for Codex profiles
- **CLI multi-provider account commands**: `sidekick account --provider codex` for Codex account management with `--add`, `--switch-to`, and `--remove` by email, label, or ID

### Fixed

- **Account type safety**: Added type guards and typed overloads to `AccountService`, removing unsafe type assertions from extension commands
- **Email normalization**: CLI Claude account lookup now normalizes email case for reliable matching
- **Codex monitoring recovery**: `restartCodexMonitoring` failures are now handled gracefully instead of propagating

## [0.16.1] - 2026-03-27

### Fixed

- **Provider status scoping**: VS Code and CLI dashboards now scope degraded-service notices to the monitored session provider — Claude status for Claude Code, OpenAI status for Codex, and no provider-status banner for OpenCode
- **Cross-platform account tests**: `sidekick-shared` account tests now mock credential I/O instead of depending on platform-specific credential stores, restoring green test runs on macOS

## [0.16.0] - 2026-03-23

### Added

- **Shared library: Zod schemas** for runtime JSONL event validation (`sessionEventSchema`, `messageUsageSchema`, `sessionMessageSchema`)
- **Shared library: Token usage & tool call extractors** — pure functions `extractTokenUsage()` and `extractToolCalls()` for single-event processing
- **Shared library: Model info & pricing** — `getModelInfo()`, `calculateCost()`, `formatCost()` ported from VS Code extension into shared module
- **Shared library: Typed JSONL parser** — optional `schema` parameter on `JsonlParser` for Zod-validated parsing
- **Shared library: QuotaPoller class** — reusable polling with exponential backoff, active/idle intervals, and cached fallback
- **VS Code: Tool result pairing** — Tool Inspector now shows truncated tool outputs (read content, bash stdout, search results) paired with each tool call
- **VS Code: Recursive subagent tree** — Subagent tree view now displays nested parent/child relationships using trace-based parsing
- **CLI: Consistent cost formatting** — all cost displays now use shared `formatCost()` with intelligent decimal precision

### Changed

- **VS Code: ModelPricingService** now delegates to `sidekick-shared/modelInfo` (reduced from 256 to ~50 lines)
- **CLI: QuotaService** rewritten to wrap shared `QuotaPoller` instead of manual polling loop
- **CLI: modelContext** now re-exports `getModelInfo` from shared library

## [0.15.2] - 2026-03-18

### Fixed

- **CLI help descriptions**: Updated `quota` and `status` command descriptions to reflect provider-aware behavior
- **`sidekick quota --provider`**: Added local `--provider` option so `sidekick quota --provider codex` works without requiring the flag before the subcommand

## [0.15.0] - 2026-03-18

### Added

- **OpenAI status page monitoring**: The CLI dashboard and VS Code extension now poll OpenAI's status page alongside Claude's, showing incidents and degraded components for Codex users
- **Codex rate limits as first-class quota**: Codex CLI rate-limit data (from token_count event streams) now displays in the VS Code dashboard quota section, CLI Sessions panel, and `sidekick quota` command — with provider-aware labels ("Rate Limits" vs "Subscription Quota") throughout

### Fixed

- **QuotaService polling for non-Claude providers**: `QuotaService.start()` no longer runs for Codex sessions, preventing failed OAuth calls from overwriting valid rate-limit data

## [0.14.2] - 2026-03-16

### Fixed

- **Quota polling interval**: Reduced quota refresh from every 30 seconds to every 5 minutes in both the VS Code extension and CLI dashboard to avoid unnecessary API calls
- **SessionsPanel `detailWidth()` call**: Removed unused parameter from `detailWidth()` in the CLI Sessions panel
- **Extension type fixes**: Fixed null assertion on `sessionMonitor` and improved Promise typing in the connection test flow

### Added

- **Provider status dashboard message**: New `updateProviderStatus` message type for pushing provider status updates to the dashboard webview

## [0.14.1] - 2026-03-14

### Fixed

- **Per-model context window sizes**: Claude Opus 4.6 and Sonnet 4.6 now correctly report 1M context windows instead of 200K. Context gauge, status bar, and session summaries show accurate utilization percentages for all models
- **Missing model**: Added `claude-haiku-4-5` to the context window lookup table

### Changed

- **Centralized model context map**: Consolidated three duplicate model-to-context-size maps (in `claudeCode.ts`, `openCode.ts`, `codex.ts`, and the CLI dashboard) into a single canonical `getModelContextWindowSize()` function in `sidekick-shared`
- **Dynamic context window override**: All three providers (Claude Code, OpenCode, Codex) now support runtime-reported context window limits via `setDynamicContextWindowLimit()`, allowing accurate context sizing when the same model has different limits per subscription tier or access method

## [0.14.0] - 2026-03-12

### Added

- **Native Multi-Account Switching**: Save, list, and switch between multiple Claude Code accounts from within Sidekick — no more manual `claude login` / logout cycles. Accounts are stored in `~/.config/sidekick/accounts/` with atomic writes, strict file permissions, and rollback-on-failure safety
- **Shared Account Manager** (`sidekick-shared`): New `accounts.ts` module with `addCurrentAccount()`, `switchToAccount()`, `removeAccount()`, `listAccounts()`, `getActiveAccount()`, and `readActiveClaudeAccount()` — consumed by both the VS Code extension and CLI
- **VS Code Account Commands**: Three new commands — `Sidekick: Save Current Claude Account`, `Sidekick: Switch Claude Account` (QuickPick), and `Sidekick: Remove Claude Account` — with automatic auth client reset and quota refresh on switch
- **Account Status Bar**: New status bar item (visible when 2+ accounts are managed) showing the active account label or email, with click-to-switch
- **Account Switching in Status Bar Menu**: The main Sidekick status bar menu now shows **Switch Account** or **Save Current Account** when the inference provider is Claude Code
- **CLI `sidekick account` Command**: Manage accounts from the terminal — `--add`, `--label`, `--switch`, `--switch-to <email>`, `--remove <email>`, and `--json` output
- **CLI Quota Account Label**: `sidekick quota` now shows the active account email above the quota bars when multi-account is enabled
- **macOS Keychain Support**: Credential I/O now reads and writes Claude Code's active credentials via the system Keychain on macOS (where Claude Code stores them), instead of assuming `~/.claude/.credentials.json` on all platforms. Fixes account switching, quota checks, and account saving on macOS

## [0.13.8] - 2026-03-12

### Added

- **Structured quota failure metadata**: `fetchQuota()` now classifies unavailable states with `failureKind`, `httpStatus`, and `retryAfterMs`, so first-party consumers and external callers can distinguish auth failures, network errors, rate limits, server failures, and unexpected API responses without parsing human-readable strings
- **Shared quota failure presentation helper**: First-party consumers now share a common `describeQuotaFailure()` helper for consistent quota error copy, severity mapping, retryability hints, and stable alert keys

### Changed

- **CLI quota UX**: `sidekick quota` and the CLI dashboard now render structured quota failure states with clearer auth/rate-limit/server copy, show unavailable quota inline in the Sessions panel, and fire low-noise transition-based quota toasts instead of relying on raw error strings
- **VS Code quota UX**: The dashboard now renders structured unavailable quota states, shows lightweight dashboard toasts on new quota failure transitions, and stores those alerts in dashboard notification history without using native VS Code popup notifications

## [0.13.7] - 2026-03-11

### Changed

- **CLI npm README sync**: Updated the published CLI package README to match the current OpenCode monitoring guidance, including platform-specific data directories and the `sqlite3` runtime requirement
- **DeepWiki badge cleanup**: Removed Ask DeepWiki badges from documentation pages and the published CLI package README while keeping the repo root README badge intact

## [0.13.6] - 2026-03-11

### Changed

- **Refreshed CLI Dashboard Wordmark**: Updated the CLI dashboard wordmark/header styling for a cleaner, more intentional branded splash experience

### Fixed

- **OpenCode DB-backed monitoring**: Manual selection now accepts synthetic `db-sessions/<projectId>` folders, and workspace discovery now resolves OpenCode projects by worktree, sandboxes, and session directory instead of silently falling back to legacy file paths
- **OpenCode runtime notices**: VS Code and CLI now show OpenCode-only actionable notices when `opencode.db` exists but `sqlite3` is missing, blocked, or otherwise unusable in the current environment

## [0.13.5] - 2026-03-10

### Added

- **Provider Status Monitoring**: New `fetchProviderStatus()` in sidekick-shared polls `status.claude.com` for API health — returns indicator, affected components, and active incidents with graceful fallback on network errors
- **CLI `sidekick status` Command**: One-shot command with color-coded text output and `--json` mode for checking Claude API status
- **CLI Dashboard Status Banner**: Status bar shows a colored `● API minor/major/critical` indicator when Claude is degraded; Sessions panel Summary tab shows affected components and active incident details
- **VS Code Dashboard Status Banner**: Dashboard gauge row shows a color-bordered banner with indicator, affected components, and incident link when Claude API is degraded; hidden when all systems are operational

## [0.13.4] - 2026-03-08

### Fixed

- **Onboarding Phrase Spam**: Motivational phrase on splash screen and detail pane no longer changes every render tick (~80ms) — memoized so it stays stable until a meaningful state change (fixes [#13](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/13))

### Changed

- **Simplified CLI Logo**: Replaced 6-line ASCII robot art with a compact 1–2 line text header across splash, help, and changelog overlays — renders cleanly in all terminals
- **Removed Dead Branding Exports**: Removed unused `getSplashContent()` and `HELP_HEADER` from branding module

## [0.13.3] - 2026-03-04

### Changed

- **Shared Task Tracking Consolidation**: Moved task lifecycle logic (TodoWrite, UpdatePlan, Agent/Task spawn, goal gate detection) from VS Code `SessionMonitor` into the shared `EventAggregator` — CLI and shared library consumers now get full task tracking out of the box
- **Shared `parseTodoDependencies` Export**: Dependency-parsing utility for OpenCode todos now exported from `sidekick-shared` for external use

### Fixed

- **Task Deduplication**: `addBlockedBy` and `addBlocks` arrays no longer accumulate duplicate entries on repeated TaskUpdate calls
- **Active Task Tracking**: Active task ID now correctly cleared when a task transitions from `in_progress` to another status (was only cleared on delete)
- **TaskCreate Error Handling**: Failed TaskCreate tool calls (error results) no longer create phantom tasks in the tracked state
- **Goal Gate Re-evaluation**: Goal gate status re-evaluated after every TaskUpdate, not just on initial creation
- **Task Timestamps**: TaskCreate timestamps now preserved from the tool_use event rather than always using the result timestamp

## [0.13.2] - 2026-03-04

### Added

- **Shared Library npm Publication**: `sidekick-shared` published to npm as a standalone package — provides types, parsers, providers, readers, formatters, aggregation, search, reporting, credentials, and quota for building tools on top of Sidekick session data
- **CI/CD Publish Shared Job**: Release workflow now includes a `publish-shared` job that lints, tests, builds, and publishes `sidekick-shared` to npm before the CLI publish step
- **Shared Library Issue Templates**: Bug report and feature request templates now include a "Shared Library (sidekick-shared)" component checkbox

## [0.13.1] - 2026-03-04

### Added

- **CLI `sidekick quota` Command**: One-shot subscription quota check showing 5-hour and 7-day utilization with color-coded progress bars and reset countdowns — supports `--json` for machine-readable output
- **Quota Projections**: Elapsed-time projections shown alongside current utilization in the CLI quota command, TUI dashboard, and VS Code dashboard — projects end-of-window usage based on linear extrapolation (e.g., `40% → 100%`)

## [0.13.0] - 2026-03-03

### Added

- **VS Code Toast Notifications**: Dismissable toast notifications in the dashboard webview with `aria-live` for screen readers — copying a CLAUDE.md suggestion now shows "Copied to clipboard" feedback
- **VS Code Reduced Motion Support**: `prefers-reduced-motion` media queries across all webviews — animations and transitions disabled when OS-level setting is enabled
- **VS Code Keyboard Navigation for Explain Panel**: Complexity level selector is now a proper segmented control with `role="tablist"` and roving tabindex — Arrow, Home, and End keys navigate between levels
- **VS Code Improved Focus Indicators**: Focus-visible outlines upgraded to 2px with positive offset across all webviews for better keyboard navigation visibility
- **VS Code ARIA Landmarks**: Explain and Error panels use semantic `<main>`, `role="region"`, `aria-live`, `role="status"`, `role="alert"`, and `aria-label` attributes throughout
- **VS Code Theme-Aware Gauge Colors**: Context usage gauge reads colors from VS Code theme CSS variables instead of hardcoded RGB values
- **VS Code Redesigned Explain Panel**: Complexity selector replaced with a unified segmented control (bordered pill-style bar) with smooth hover/active transitions
- **VS Code Redesigned Error Panel**: Explanation sections now have color-coded left borders (red/orange/green), section icons, padded card-like backgrounds, and staggered slide-in entrance animations
- **VS Code Three-Dot Pulse Loader**: Replaced spinning circle loader with a three-dot pulse animation in Explain and Error panels
- **VS Code Improved Empty States**: All 7 sidebar panels have rewritten empty-state copy with icons, titles, and clearer instructions
- **VS Code Card Entrance Animations**: Fade-in animations with stagger delay in Task Board, Plan Board, and Project Timeline
- **VS Code Custom Scrollbar and Selection Styling**: Themed 6px scrollbars and VS Code-matching text selection colors across all webviews
- **VS Code Apply Fix Button States**: Animated "Applying..." state, green "Applied" confirmation, hover lift, and active press effects
- **VS Code Narrow Viewport Support**: Responsive styles for sidebar panels narrower than 260px

### Changed

- **VS Code Pulse Animation Throttling**: Value pulse animations in the dashboard throttled to once per 800ms per element, reducing visual noise during rapid updates
- **VS Code Inline Styles Replaced**: Context health score and truncation warnings now use CSS classes instead of inline styles

### Fixed

- **Codex SQL Parameter Binding**: Fixed `string.replace('?', ...)` only replacing the first placeholder — now uses regex with sequential index counter so each `?` maps to the correct parameter
- **Codex Double Filesystem Stat**: Collapsed redundant `existsSync` + `statSync` calls in `CodexDatabase.isAvailable()` to a single `statSync` in try/catch

### Security

- **XSS Prevention**: Added `escapeHtml()` across all innerHTML interpolations in Dashboard, MindMap, TaskBoard, and webview scripts
- **Cryptographic CSP Nonces**: Nonce generation now uses `crypto.getRandomValues()` instead of `Math.random()`
- **Command Injection Prevention**: CLI discovery and version checks now use `execFileSync`/`spawnSync` instead of `execSync` with string interpolation
- **URL Protocol Validation**: `openExternal` handler validates `^https?://` before opening URLs, preventing `file://` and `javascript:` protocol attacks

## [0.12.10] - 2026-03-01

### Added

- **Shared FrequencyTracker**: Generic LRU-bounded frequency counter for tracking tool name, event type, and keyword frequency across sessions
- **Shared HeatmapTracker**: 60-minute rolling circular buffer tracking event activity intensity per minute
- **Shared PatternExtractor**: Simplified Drain-style algorithm that clusters event summaries into templates (e.g. `Read src/<*>.ts`) to surface repetitive tool patterns
- **Shared EventHighlighter**: Keyword-based semantic syntax highlighting for event content — errors red, success green, warnings yellow, actions cyan, file paths magenta, HTTP status/method coloring — with blessed, ANSI, and HTML output formats
- **Shared AdvancedFilter**: Four filter modes — substring (case-insensitive), fuzzy (space-separated multi-word), regex (with validation), and date range (since/until) — with search-term highlighting
- **CLI Events Panel** (key 7): Scrollable live event stream with type badges, timestamps, and highlighted summaries; detail tabs for full event JSON and surrounding context
- **CLI Charts Panel** (key 8): Tool frequency bars, event distribution, 60-minute activity heatmap (`░▒▓█`), and pattern analysis with frequency bars
- **CLI Multi-Mode Filter**: `/` filter overlay now supports substring, fuzzy, regex, and date modes — Tab cycles modes, regex mode shows validation errors
- **CLI Search Term Highlighting**: Active filter terms highlighted in side list items
- **VS Code Analytics Charts**: Tool frequency bar chart, event distribution doughnut chart, activity heatmap grid, and event patterns section in the dashboard webview — theme-safe with runtime CSS variable resolution
- **VS Code Event Stream Tree View**: Live sidebar tree showing color-coded session events with type icons, timestamps, and ring buffer of 200 events
- **Tests for FrequencyTracker, HeatmapTracker, PatternExtractor, EventHighlighter, and AdvancedFilter**

### Changed

- **Shared EventAggregator**: Now tracks tool frequency, word frequency, event patterns, and heatmap buckets via the new aggregation primitives
- **CLI Timeline Highlighting**: Event summaries in the Sessions panel Timeline tab now use semantic keyword coloring

### Removed

- **CLI Search Panel**: Removed redundant Search panel (previously key 7) — the `/` filter serves the same purpose with better multi-mode support

## [0.12.9] - 2026-02-28

### Added

- **VS Code Hourly Drill-Down**: Clicking a day bar in the dashboard historical chart now shows per-hour token/cost breakdown
- **VS Code Content Security Policy**: CSP nonce added to the Generate HTML Report webview (security hardening)
- **VS Code `setSessionProvider` Command**: `sidekick.setSessionProvider` now discoverable in the Command Palette
- **VS Code Notification Toggles**: New notification trigger toggles for `sensitive-path-write` and `cycle-detected` in Settings
- **VS Code Offline Assets**: Chart.js and D3.js bundled locally — dashboard and mind map now work offline (no CDN dependency)
- **VS Code ARIA Accessibility**: ARIA attributes across 6 webview panels (Dashboard, MindMap, ToolInspector, TaskBoard, PlanBoard, ProjectTimeline) — tab roles, live regions, toggle states, and labeled icon buttons
- **CLI Standalone Data Commands**: `sidekick tasks`, `sidekick decisions`, `sidekick notes`, `sidekick stats`, `sidekick handoff` for accessing project data without launching the TUI
- **CLI `sidekick search <query>`**: Cross-session full-text search from the terminal
- **CLI `sidekick context`**: Composite output of tasks, decisions, notes, and handoff for piping into other tools
- **CLI `--list` flag on `sidekick dump`**: Discover available session IDs before requiring `--session <id>`
- **CLI Search Panel**: Search panel (panel 7) wired into the TUI dashboard
- **Shared `HourlyData` type and `getHourlyData()`**: New method in HistoricalDataService for hourly breakdowns
- **125 tests for EventAggregator** (1,579 lines of core logic, previously 0 test coverage)
- **17 tests for CompletionCache**
- **19 tests for BurnRateCalculator**
- **18 tests for tokenEstimator**
- **57 tests for diffFilter**

### Changed

- **VS Code Cancellable AI Operations**: Long-running AI operations (test connection, commit message, docs, explain, error analysis, inline completions) are now cancellable via the progress notification
- **VS Code `sidekick.inlineTimeout` deprecated**: Use `sidekick.timeouts.inlineCompletion` instead (legacy setting still honored as fallback)
- **VS Code Completion Hint Settings**: `showCompletionHint` and `completionHintDelayMs` settings now properly wired (were previously ignored)
- **CLI `taskMerger` utility**: Duplicate `mergeTasks` logic extracted into shared `taskMerger` utility
- **CLI Model Constants**: Hardcoded model IDs extracted to named constants

### Fixed

- **VS Code `stopMonitoring` disposable leak**: Fixed disposable leak on repeated stop/restart cycles
- **VS Code Production Build**: esbuild production builds now run in parallel (faster builds)
- **CLI `convention` icon**: Notes panel icon replaced with valid `tip` type
- **CLI Linux Clipboard**: Now supports Wayland (`wl-copy`) and `xsel` fallbacks, with error messages instead of silent failure
- **CLI `provider.dispose()`**: Added to `dump` and `report` commands (prevents SQLite connection leaks)

## [0.12.8] - 2026-02-28

### Added

- **VS Code Design Token System**: Shared design tokens (`getDesignTokenCSS()`, `getSharedStyles()`) providing consistent spacing, typography, radius, color, transition, and elevation variables across all 5 webview panels
  - Micro-interactions: tab fade-in, timeline slide-in, progress bar shimmer, active status pulse, value update flash animation
  - Dashboard visual hierarchy: tier dividers, group summaries when collapsed, count badges, accent borders on expanded sections
  - Card hover micro-lift, active plan/session glow, section title opacity treatment
  - Skeleton loading states replacing text-only loading messages
  - Shared component tokens applied to headers, status badges, icon buttons, and cards across Dashboard, MindMap, TaskBoard, PlanBoard, and ProjectTimeline providers

### Changed

- **CLI Dashboard UI/UX Polish**: Visual overhaul of the TUI dashboard for better hierarchy, consistency, and readability
  - Splash screen and help overlay now display the robot ASCII logo (matching the changelog overlay)
  - Toast notifications show severity icons (✘ error, ⚠ warning, ● info) with inner padding
  - Focused pane uses double-border (`╔═╗║╚═╝`) for clear focus indication
  - Section dividers (`── Title ────`) replace bare bold headers throughout the summary, agents, and context attribution views
  - Tab bar: active tab underlined in magenta, inactive tabs dimmed, bracket syntax removed
  - Status bar: segmented layout with left (brand), center (provider/events), and right (keybindings) zones using `│` separators; keys bold, labels dim
  - Summary metrics condensed: elapsed/events/compactions on one line, tokens on one line with cache rate and cost, bold values with dim labels
  - Sparklines now display peak metadata annotations
  - Progress bars use blessed color tags for consistent coloring
  - Help overlay uses dot-leader alignment (`key ···· description`) for all keybinding rows
  - Empty state hints per panel (e.g. "Tasks appear as your agent works.")
  - Session picker groups sessions by provider with section headers when multiple providers are present

## [0.12.7] - 2026-02-27

### Added

- **HTML Session Report**: Self-contained HTML report with full transcript, token/cost stats, model breakdown, and tool-use summary — zero external dependencies
  - Transcript parser extracts user/assistant/system messages with thinking blocks, tool calls, and tool results from JSONL session files
  - Stats cards show total tokens, cost, duration, and model usage at a glance
  - Collapsible thinking blocks and tool detail sections for readability
  - Dark/light theme support
  - VS Code: `Sidekick: Generate HTML Report` command, also available as "HTML Report" option in `Dump Session`
  - CLI: `sidekick report` command with `--output`, `--theme`, `--no-open`, and `--no-thinking` flags
  - TUI Dashboard: press `r` to generate and open an HTML report for the current session

### Changed

- **Code quality pass**: Simplified ternary expressions, replaced `var` with `const`/`let`, deduplicated repeated logic across `DashboardViewProvider`, `MindMapViewProvider`, and shared library modules

## [0.12.6] - 2026-02-26

### Added

- **Session Introspection Pipeline**: New analysis layer for deep session inspection
  - Noise classifier filters irrelevant tool events (system reminders, sidechains) from analysis
  - Tool summarizer aggregates tool events into concise summaries
  - Debug log parser extracts structured data from Claude Code debug logs
  - Session activity detector classifies session state (active, idle, stalled)
  - Subagent trace parser for analyzing subagent execution chains
  - Session path resolver discovers related files (debug logs, plan files, JSONL) for a session
- **Session Dump Command**: Export session data in text, markdown, or JSON format
  - VS Code: `Sidekick: Dump Session` command (Command Palette, status bar, toolbar)
  - CLI: `sidekick dump` command with `--format`, `--width`, and `--expand` options
  - Shared formatters ensure identical output between VS Code and CLI
- **Plans Panel Re-enabled**: Plans UI restored in both VS Code and CLI
  - `parsePlanMarkdown()` now handles simple bullet points (`- Step`, `* Step`)
  - Plan file discovery reads from `~/.claude/plans/` via session slug cross-reference
  - Plans panel re-enabled in CLI dashboard as fallback data source
- **OpenCode & Codex Provider Improvements**:
  - OpenCode model tier mapping (tiers resolve to concrete model IDs instead of being dropped)
  - Codex subagent scanning via `forked_from_id` (database + filesystem)
  - `getCurrentUsageSnapshot()` for real-time token tracking on Codex and Claude Code
- **New Phrase Categories**: 3 new categories (25 phrases each) — Rubber Duck, Dependency Hell, Stack Overflow

### Fixed

- **Destructive command false positives**: `/dev/null`, `/dev/stdout`, `/dev/stderr` redirects no longer trigger destructive command alerts
- **Old snapshot format migration**: Restoring sessions from pre-0.12.3 snapshots no longer shows empty timeline entries — field names are now migrated from old format

### Changed

- **Phrase library deduplicated**: Moved ~1,300 lines of identical phrase content from CLI and VS Code into `sidekick-shared` as a single source of truth (net -1,231 lines of duplication)

## [0.12.5] - 2026-02-24

### Fixed

- **CLI update check too slow to notice new versions**: Reduced npm registry cache TTL from 24 hours to 4 hours so upgrade notices appear sooner after a new release

## [0.12.4] - 2026-02-24

### Fixed

- **Session crash on upgrade**: Fixed `d.timestamp.getTime is not a function` error when restoring tool call data from session snapshots — `Date` objects were serialized to strings by JSON but not rehydrated on restore, causing the session monitor to crash on first run after upgrading from 0.12.2 to 0.12.3

## [0.12.3] - 2026-02-24

### Added

- **Unified Session Aggregation Layer**: Types, parsers, DB wrappers, and aggregation logic extracted from the VS Code extension into `sidekick-shared`, so both the extension and CLI consume a single implementation
  - `EventAggregator` provides tokens, tools, tasks, subagents, plans, context attribution, compaction, burn rate, and latency tracking for any consumer
  - Snapshot sidecar persistence for fast session resume — avoids replaying the full event log on reconnect
  - `eventBridge` maps shared `SessionEvent` to the extension's legacy `FollowEvent` for backward compatibility
  - Net reduction of ~4,100 lines of duplicated code across the three packages
- **Loading Indicator**: Status bar shows a loading spinner during initial session replay so it's clear the dashboard is catching up
- **Latest-Node Indicator**: The most recently added node is visually marked
  - VS Code mind map: subtle pulse animation on the latest D3 node
  - CLI mind map: yellow marker on the latest tree/boxed node
- **Plan Analytics**: Agent plans are now a first-class, analytically-rich data type
  - **Enriched plan data model**: Plan steps track complexity (low/medium/high), timing, token usage, tool call counts, cost, and error messages
  - **Complexity detection**: Automatic complexity classification from explicit markers (`[high]`, `[low]`) and keyword heuristics (refactor → high, fix → low)
  - **Mind Map enrichments**: Plan step nodes color-coded by complexity (red=high, yellow=medium, green=low), sized by token usage, with enriched tooltips showing duration/tokens/errors
  - **Cross-provider plan extraction**: Shared `PlanExtractor` handles Claude Code (EnterPlanMode/ExitPlanMode), OpenCode (`<proposed_plan>` XML), and Codex (UpdatePlan tool) — CLI no longer ignores Claude Code and OpenCode plans
  - **Handoff integration**: Session handoff documents include a "Plan Progress" section with completed/remaining steps and last active step status
  - **Plan-to-cost attribution**: Per-step dollar cost computed via ModelPricingService, aggregated on plan totals
- **Mind Map Legend Interaction** (VS Code): Legend items are now interactive — hover to highlight all nodes of that category (fading everything else), click to lock the highlight in place
- **Mind Map Phase Grouping** (VS Code): Plan steps with phase assignments are grouped under intermediate phase nodes in the force-directed graph, with sequential links between phases
- **CLI Node Type Filter**: Press `f` on the Mind Map tab to cycle through node type filters (file, tool, task, subagent, command, plan, knowledge-note) — non-matching sections render dimmed in grey

### Fixed

- **Kanban board regression**: Subagent and plan-step tasks now correctly appear in the kanban board — previously they were lost during the aggregation refactor
- **First-load performance**: Suppressed hundreds of wasteful VS Code UI update events during initial session replay, making the first load noticeably faster

### Changed

- **Plan UI surfaces temporarily disabled**: Dashboard Plan Progress/History sections, Plans sidebar panel (VS Code), Plans panel (CLI), and plan persistence are disabled until plan-mode event capture is reliably working end-to-end. Plan nodes in the mind map remain active.
- CLI `DashboardState` now delegates to shared `EventAggregator` instead of maintaining its own aggregation logic

## [0.12.2] - 2026-02-23

### Added

- **CLI update notifications**: The CLI dashboard now checks npm for newer versions on startup (cached for 24h) and shows a yellow banner in the status bar when an update is available
- **Extension CLI version check**: When opening the CLI dashboard from VS Code, the extension checks if the installed CLI version is outdated and offers to update it via an info notification

## [0.12.1] - 2026-02-23

### Fixed

- **CLI dashboard launch from VS Code**: Fixed exit code 127 when launching the CLI dashboard via the extension button on systems using nvm, volta, or other Node version managers. The terminal now injects the CLI's directory into `PATH` so the node binary is found even when shell init is bypassed.
- **CLI discovery for nvm users**: Added nvm installation paths (`~/.nvm/versions/node/*/bin/`) to the common path scan so the CLI is discovered without relying on `which`.

## [0.12.0] - 2026-02-22

### Added

- **Truncation Detection**: Detects when agent tool outputs are silently truncated by the runtime
  - Scans every tool result for 6 known truncation markers
  - Dashboard shows total truncation count and per-tool breakdown with warning indicator
  - Files with 3+ truncated outputs automatically surfaced as knowledge note candidates
- **Context Health Monitoring**: Tracks context fidelity as compactions degrade the conversation
  - Fidelity score starts at 100% and decreases with each compaction event
  - Color-coded dashboard gauge: green (70-100%), yellow (40-69%), red (below 40%)
  - Handoffs include a "Context Health Warning" section when fidelity drops below 50%
- **Goal Gates**: Automatic detection and visual flagging of critical tasks
  - Tasks flagged when matching critical keywords or blocking 3+ other tasks
  - Kanban board: red left border and warning badge on goal-gate cards
  - Incomplete goal gates get a dedicated section in handoff documents
- **Cycle Detection**: Identifies when agents enter repetitive tool-call loops
  - Sliding-window algorithm with configurable window size (default: 10 calls)
  - VS Code warning notification with affected file list when cycles are detected
  - Mind map marks cycling files with `isCycling` indicator
- **"Open CLI Dashboard" VS Code Command**: Launches the Sidekick TUI dashboard in a VS Code terminal — install the CLI with `npm install -g sidekick-agent-hub`

### Fixed

- **`retry_loop` inefficiency detection**: Now properly emits when consecutive fail-retry pairs are detected on the same tool and target
- **`command_failure` inefficiency detection**: Now correctly filters to only failed Bash calls and emits when the same base command fails 3+ times

## [0.11.0] - 2026-02-19

### Added

- **Knowledge Notes System**: Capture reusable knowledge (gotchas, patterns, guidelines, tips) attached to files
  - Manual note creation via editor context menu with four note types
  - Gutter icons per note type with hover tooltips showing content and status
  - Tree view in sidebar grouped by file
  - Lifecycle staleness tracking: active → needs review → stale → obsolete
  - Auto-extraction of candidates from repeated errors, recovery patterns, and guidance suggestions
  - Auto-surfacing in GuidanceAdvisor analysis and mind map visualization
  - "Inject Knowledge Notes" command to append notes to CLAUDE.md/AGENTS.md
  - Note management: right-click to edit, delete, or confirm notes in the tree view
  - Persisted in `~/.config/sidekick/knowledge-notes/`
- **Sidekick CLI**: Full-screen TUI dashboard for monitoring agent sessions from the terminal
  - Ink-based terminal UI with panels for sessions, tasks, kanban, mind map, notes, decisions, search, files, and git diff
  - Multi-provider support: auto-detects Claude Code, OpenCode, and Codex sessions
  - Usage: `sidekick dashboard [--project <path>] [--provider <id>]`
- **Shared Data Access Layer** (`sidekick-shared`): Pure TypeScript library extracting readers, types, and session providers from the extension — no VS Code dependencies
- **Multi-Session Project Timeline**: Chronological view of all sessions in the current project
  - Card-based layout with session labels, duration bars, and metadata badges (tokens, tasks, errors, model)
  - Time range filtering (24h, 7d, 30d, all)
  - Expandable detail panels showing tool usage breakdown, tasks, and error summaries
  - Click to open any past session in the dashboard
  - Auto-refreshes on session start/end and token usage
- **Mind Map Knowledge Note Nodes**: Active knowledge notes appear as amber nodes linked to their file nodes

## [0.10.3] - 2026-02-19

### Added

- Mind map circular layout toggle — switch between force-directed and static circular arrangement
  - Nodes grouped by type on a circle with curved bezier links
  - Smooth animated transitions between layouts

## [0.10.2] - 2026-02-19

### Fixed

- Notification triggers no longer replay historical events on session load
- SubagentScanner no longer spams logs when subagents directory doesn't exist

## [0.10.1] - 2026-02-19

### Fixed

- Fixed broken image references in Marketplace README
- Updated Marketplace keywords to reflect multi-provider rebrand
- Added Mermaid diagrams to architecture and configuration docs
- Added install/download count badges to READMEs and docs
- Added documentation links to all feature and provider mentions in READMEs
- Fixed broken icon reference in docs index and root README

## [0.10.0] - 2026-02-18

### Added

- **Multi-Provider Inference**: Support for OpenCode and Codex CLI as inference providers alongside Claude Max and Claude API
- **Multi-Provider Session Monitoring**: Monitor sessions from OpenCode and Codex CLI in addition to Claude Code
- **Model Resolver with Tier System**: Unified model selection via tiers (fast/balanced/powerful) with auto-detection per feature
- **Session Handoff System**: Provider-aware context handoff documents for seamless session continuation
- **Cross-Session Task Persistence**: Tasks persist across sessions in `~/.config/sidekick/tasks/`
- **Decision Log Extraction**: Tracks and persists architectural decisions from sessions
- **Event Logging Audit Trail**: Optional JSONL event logging for debugging (`~/.config/sidekick/event-logs/`)
- **Plan Visualization**: Step nodes with status indicators in mind map view
- **Documentation Site**: Material for MkDocs documentation with GitHub Pages deployment

### Changed

- Rebranded from "Sidekick for Max" to "Sidekick Agent Hub"
- Removed RSVP Speed Reader feature

### Fixed

- Codex CLI: replaced `@openai/codex-sdk` with direct CLI spawning for reliable inference
- Multiple provider parity fixes for OpenCode and Codex CLI

## [0.9.1] - 2026-02-15

### Added

- **Subagent Cards on Kanban Board**: Spawned subagents (via the `Task` tool) now appear as cards on the Kanban board
  - Each subagent spawn creates an "In Progress" card with the agent's description as the title
  - Cards show agent type chip (e.g. "Explore", "Plan", "Bash") with cyan accent
  - Cards move to "Completed" when the subagent finishes (or are removed on failure)
  - Visually distinguished from regular tasks with a cyan left border
  - Header summary shows separate counts (e.g. "3 tasks, 2 agents")

### Fixed

- **Kanban board refresh on subagent completion**: Board now updates immediately when a subagent finishes instead of waiting for the next tool call

## [0.9.0] - 2026-02-14

### Added

- **Context Token Attribution**: Stacked bar chart showing token distribution across 7 categories (system prompt, CLAUDE.md, user messages, assistant responses, tool I/O, thinking)
- **Notification Triggers**: Configurable alerts for credential access, destructive commands, tool error bursts, compaction, and token thresholds
- **Compaction Detection**: `summary` events now processed with timeline markers and context size deltas
- **Timeline Search & Filtering**: Full-text search with noise classification and uncapped event display
- **Conversation Viewer**: Full editor tab with chat-style session rendering and built-in search
- **Cross-Session Search**: QuickPick-based search across all `~/.claude/projects/` sessions
- **Rich Tool Call Inspector**: Full editor tab with per-tool specialized rendering (diffs for Edit, commands for Bash, etc.)
- New commands: View Session Conversation, Search Across Sessions, Open Tool Inspector

### Improved

- **Message Noise Classification**: Sidechain detection and system reminder filtering with dashboard toggles
- **Enhanced Subagent Visualization**: Token metrics, duration tracking, and parallel execution detection
- **Tool Analytics Drill-Down**: Click analytics rows to see individual tool calls

## [0.8.5] - 2026-02-14

### Fixed

- **Accurate cost estimation**: Session costs now use actual per-model input/output/cache token breakdown instead of a 50/50 approximation
- **Toggle command persistence**: `Sidekick: Toggle` now updates config so inline completions actually stop
- **XSS hardening in RSVP reader**: Replaced `innerHTML` with DOM API in word display
- **Session re-initialization**: `Stop Monitoring` preserves `workspaceState` on re-create
- **Overly broad completion filter**: `however` pattern no longer rejects valid code containing the word mid-line
- **Task Board column mismatch**: Removed stale `'deleted'` column from inline script
- **SVG in binary filter**: `.svg` removed from `BINARY_EXTENSIONS` — it's text-based XML
- **JSDoc default mismatch**: `truncateDiffIntelligently` docs corrected from 3500 to 8000
- **Timer leak**: Dashboard clears `_richerPanelTimer` on dispose

### Improved

- Extracted shared utilities: `getNonce`, `extractTaskIdFromResult`, `stripMarkdownFences`
- Type safety: proper type guard replaces `as any` casts; typed `handleTokenUsage`; disambiguated `WebviewMessage` names
- Dead code removal: always-true ternary, unused fields, identical branches
- Moved analysis types to `types/analysis.ts` to fix inverted dependency direction
- `seenHashes` pruning retains 75% (was 50%) to reduce re-processing window
- TempFilesTreeProvider polling skips when no session is active

## [0.8.4] - 2026-02-14

### Improved

- **Collapsible Session Navigator**: The Sessions panel in the dashboard sidebar is now collapsible
  - Click the header to expand/collapse the session list
  - Expanded by default; chevron rotates to indicate state
  - Pin, Refresh, and Browse buttons remain independently clickable

## [0.8.3] - 2026-02-10

### Improved

- **Dashboard UX polish**: Improved layout and feedback for the Session Summary and Session tabs
  - Moved "Generate AI Narrative" button to top of Summary tab, immediately after the metrics row, so it's visible without scrolling
  - Added progress notification with time estimate when generating narratives (VS Code notification + inline spinner)
  - Reorganized Session tab from one monolithic "Session Details" section into three thematic groups:
    - **Session Activity** — Activity Timeline, File Changes, Errors
    - **Performance & Cost** — Model Breakdown, Tool Analytics, Tool Efficiency, Cache Effectiveness, Advanced Burn Rate
    - **Tasks & Recovery** — Task Performance, Recovery Patterns
  - Promoted richer panels (Task Performance, Cache, Recovery, etc.) from nested collapsibles to always-visible sections within their group — one click to expand, no double-expand needed

## [0.8.2] - 2026-02-07

### Added

- **Kanban Board**: TaskCreate/TaskUpdate activity now appears in a dedicated Kanban view
  - Groups tasks by status with real-time updates
  - Collapsible columns with hidden-task summaries

## [0.8.1] - 2026-02-07

### Fixed

- **Mind map layout recovery for dense subagent graphs** ([#8](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/8))
  - Added a **Reset Layout** control to rebuild the D3 simulation and recenter on the main session node without refreshing the view
  - Tuned force behavior to keep clusters compact and readable (localized many-body repulsion, adaptive link distance/collision spacing, gentle x/y centering)

## [0.8.0] - 2026-02-04

### Added

- **CLAUDE.md Suggestions**: AI-powered session analysis for optimizing Claude Code usage
  - Analyzes session patterns to detect recovery strategies (when Claude gets stuck and how it recovers)
  - Generates best practices and suggestions for your CLAUDE.md file
  - Progress UI with collapsible suggestion panels in the dashboard
  - Helps you learn from your own Claude Code sessions

### Changed

- Refactored prompts to use XML tags for better AI instruction structure

## [0.7.10] - 2026-02-03

### Added

- **Historical Analytics**: Retroactive data import from existing Claude Code sessions
- **Response Latency Tracking**: Real-time latency metrics in dashboard
- **Task Nodes in Mind Map**: Task tool calls visualized as distinct nodes
- **Dashboard UX**: Improved metric button layout and sizing

## [0.7.9] - 2026-02-02

### Fixed

- **Custom folder session auto-discovery**: Fixed automatic detection of new sessions (e.g., after `/clean`) when monitoring a custom folder

## [0.7.8] - 2026-02-02

### Added

- **Mind Map: Directory & Command Nodes**: Grep/Glob and Bash tool calls now show their targets in the mind map

### Fixed

- **Custom folder new session detection**: Discovery polling now uses the custom directory instead of the workspace path
- **Folder picker prioritization**: VS Code workspace now appears first in the "Browse Session Folders" list
- **Session dropdown custom folder**: Correctly shows sessions from the selected custom folder

## [0.7.7] - 2026-02-02

### Added

- **Browse Session Folders**: Manually select any Claude project folder to monitor, regardless of workspace path
- **Token Usage Tooltips**: Hover over token metrics to see quota projections and estimated time to exhaustion
- **Activity Timeline Enhancements**: Claude's text responses now visible in the activity timeline
- **Mind Map Subagent Visibility**: Spawned Task agents appear as distinct nodes in the mind map
- **Dynamic Node Sizing**: Mind map nodes scale based on content length
- **Latest Link Highlighting**: Most recent connections in the mind map are visually emphasized
- **Line Change Statistics**: Files Touched tree view and mind map now show +/- line change counts

### Fixed

- **Git Repository Detection**: Improved detection for nested git repositories

## [0.7.6] - 2026-01-31

### Added

- **Subscription Quota Display**: View Claude Max 5-hour and 7-day usage limits in the Session Analytics dashboard
  - Color-coded gauges with reset countdown timers
  - Auto-refreshes every 30 seconds when visible
  - Uses OAuth token from Claude Code CLI credentials

## [0.7.5] - 2026-01-30

### Fixed

- **Subdirectory session discovery**: Session monitoring now finds Claude Code sessions started from subdirectories of the workspace
  - Discovers sessions when Claude Code starts from a subdirectory (e.g., `/project/packages/app`)
  - Prefix-based matching with most-recently-active selection
  - Enhanced diagnostics with `subdirectoryMatches` field

## [0.7.4] - 2026-01-30

### Added

- **Mind Map URL Nodes**: WebFetch and WebSearch calls now appear as clickable nodes
  - URLs display as cyan nodes showing hostname, click to open in browser
  - Search queries display truncated text, click to search Google
  - File nodes clickable to open in VS Code editor

## [0.7.3] - 2026-01-29

### Added

- **Timeout Manager**: Centralized, context-aware timeout handling across all AI operations
  - Configurable timeouts per operation type via settings
  - Auto-adjustment based on context/prompt size
  - Progress indication with cancellation support
  - "Retry with longer timeout" option on timeout

## [0.7.2] - 2026-01-29

### Fixed

- **Session path encoding**: Fixed session monitoring on Windows/Mac with 3-strategy discovery fallback

## [0.7.1] - 2026-01-29

### Fixed

- **Silent timeout on inline completions**: Now shows warning notification with options to open settings or view logs

### Added

- New setting `sidekick.inlineTimeout` for configurable timeout (default: 15s)

## [0.7.0] - 2026-01-29

### Added

- **Claude Code Session Monitor**: Real-time analytics dashboard for monitoring Claude Code sessions
  - Session analytics dashboard with token usage, costs, and activity timeline
  - Mind map visualization showing conversation flow and file relationships
  - Latest files touched tree view
  - Subagents tree view for monitoring spawned Task agents
  - Status bar metrics and activity bar integration
- New commands: Open Session Dashboard, Start/Stop Monitoring, Refresh/Find Session

## [0.6.0] - 2026-01-26

### Added

- **Generate Documentation**: Auto-generate JSDoc/docstrings (`Ctrl+Shift+D`)
- **Explain Code**: AI-powered explanations with 5 complexity levels (`Ctrl+Shift+E`)
- **Error Explanations**: Lightbulb quick actions for error diagnosis and fixes
- **Quick Ask (Inline Chat)**: Ask questions without leaving editor (`Ctrl+I`)
- **Pre-commit AI Review**: Review changes before committing (eye icon in Source Control)
- **PR Description Generation**: Auto-generate PR descriptions (PR icon in Source Control)
- Context menu submenu organizing all Sidekick commands
- Completion hint visual indicator

### Fixed

- Claude CLI path resolution for non-standard installations

## [0.5.0] - 2025-01-24

### Added

- **RSVP Reader**: Speed reading with AI-powered explanations
  - Word-by-word display with ORP (Optimal Recognition Point) highlighting for faster reading
  - Adjustable reading speed (100-900 WPM)
  - Five AI explanation complexity levels: ELI5, Curious Amateur, Imposter Syndrome, Senior, PhD Mode
  - Toggle between speed reading mode and full-text view
  - Dual-mode content: switch between original text and AI explanation
  - Context menu integration with submenu for quick access
  - Keyboard shortcut: `Ctrl+Shift+R` (Cmd+Shift+R on Mac)
  - Rich playback controls: Space (play/pause), arrows (navigate/speed), R (restart), F (full-text toggle)
- New settings: `rsvpMode`, `explanationComplexity`, `explanationModel`

## [0.4.0] - 2025-01-21

### Added

- **AI Commit Message Generation**: Generate commit messages from staged changes with one click
  - Sparkle button in Source Control toolbar
  - Analyzes git diff to create contextual messages
  - Conventional Commits or simple description format
  - Configurable model (defaults to Sonnet)
  - Default guidance setting for consistent commit style
  - Regenerate with custom guidance
  - Filters out lockfiles, binary files, and generated code
- New settings: `commitMessageModel`, `commitMessageStyle`, `commitMessageGuidance`, `showCommitButton`

## [0.3.2] - 2025-01-21

### Added

- **Custom Claude CLI path setting** (`sidekick.claudePath`): Specify a custom path to the Claude CLI executable for non-standard installations (pnpm, yarn, volta, etc.)
- **Auto-detection of common CLI paths**: Extension now checks common installation locations (pnpm, yarn, volta, npm global, Homebrew) before falling back to PATH

### Fixed

- Fixed "Claude Code CLI not found" error for users who installed Claude CLI via pnpm, yarn, or other package managers ([#3](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/3))
- Improved error message with instructions for setting custom CLI path

## [0.3.1] - 2025-01-21

### Added

- Demo GIFs in README for better feature visibility
- Social media preview image

### Fixed

- Minor documentation improvements

## [0.3.0] - 2025-01-21

### Added

- Status bar menu with quick access to all extension options
- View Logs command for debugging completion issues
- Test Connection command to verify API connectivity
- Prose file support with automatic multiline mode (Markdown, plaintext, HTML, XML, LaTeX)
- Model indicator in status bar

### Changed

- Increased default debounce from 300ms to 1000ms
- Improved prompt engineering to reduce meta-responses
- Higher character limits for prose files (2000/3000 chars vs 500/800 for code)
- Better truncation logic using logical boundaries

### Fixed

- Reduced meta-commentary in completions ("I'll complete this...")
- Better code fence removal from responses
- Improved handling of long responses

## [0.2.0] - 2025-01-10

### Added

- Code transform feature (`Ctrl+Shift+M` / `Cmd+Shift+M`)
- Independent model selection for inline completions and transforms
- Transform uses Opus by default for highest quality
- Context lines configuration for transforms

### Changed

- Rebranded from "Claude Code Max" to "Sidekick for Max"
- Optimized default context settings

## [0.1.0] - 2025-01-09

### Added

- Initial release
- Inline code completions with ghost text
- VS Code extension with status bar toggle
- FastAPI server using Claude Code CLI
- Support for Haiku and Sonnet models
- Debounced completion requests
- Request cancellation for stale completions
- In-memory LRU cache
- Rate limiting
- JSONL logging with metrics
- Health check endpoint with usage statistics
