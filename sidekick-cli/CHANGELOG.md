# Changelog

All notable changes to the Sidekick Agent Hub CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.21.0] - 2026-06-21

### Added

- **z.ai Coding Plan quota**: `sidekick quota --provider zai` derives and renders z.ai plan utilization from OpenCode traffic already on disk (5-Hour / Weekly windows with per-tier prompt budgets). `--tier lite|pro|max|auto` overrides the assumed plan tier (default `auto`). `sidekick quota --provider opencode` now auto-routes to z.ai quota when z.ai traffic is detected. `sidekick quota --all` includes the z.ai section when active
- **z.ai quota history heatmap**: `sidekick quota history --provider zai` renders a 13-week z.ai utilization heatmap for the current workspace, alongside the existing Claude and Codex heatmaps (now also in `--all`)
- **Account login**: `sidekick account --login` starts the provider-isolated login flow for Claude Max or Codex and saves the authenticated profile without disturbing the active account until finalization
- **All-provider account view**: `sidekick account --provider all` lists Claude and Codex saved accounts together, including active state. JSON output returns provider-keyed account arrays and active ids
- **Terminal account helpers**: `sidekick account --launcher <name>` creates opt-in launchers for the selected account, and `--auto-switch <pct|off>` persists the CLI auto-switch threshold preference
- **Multi-provider quota output**: `sidekick quota --all` shows Claude and Codex quota state together — each provider degrades independently, so one provider's quota still prints even when the other is unavailable; `--all --json` emits a provider-keyed payload for automation

### Changed

- **Bundled `sidekick-shared` 0.21.0**: Picks up Account Management 2.0 acquisition, switching, terminal sync, quota auto-switch, and account schema exports.

## [0.20.0] - 2026-06-17

### Added

- **`sidekick extract`**: New one-shot command for pulling actionable assets out of recent Claude Code and Codex chats for exactly the current cwd. It extracts URLs, filesystem-validated file paths, commands the agent suggested for the user to run, and plan-mode plans. Output is grouped and colored by default, labels each item with its source agent, validates invalid `--type` and `--limit` values, preserves `inChat` and per-item provenance in `--json`, and offers `-i/--interactive` for a picker that opens URLs or copies selected paths, commands, and plans. `--provider claude-code` and `--provider codex` scope extraction to one agent; OpenCode is reported as unsupported for now

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing this feature in [#17](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/17), adapted from his MIT-licensed [`trawl`](https://github.com/B33pBeeps/trawl) project.

## [0.19.3] - 2026-06-17

### Changed

- **Bundled `sidekick-shared` projection contract**: The shared assistant-turn projection now exposes a v2 `timeline` array for interleaved reasoning, narration, and tool groups. This is a shared-library contract update for downstream consumers and does not change CLI behavior by itself

## [0.19.2] - 2026-06-15

### Changed

- **Bundled `sidekick-shared` 0.19.2**: The shared library gains a browser-safe assistant-turn projection module (`segmentAssistantTurn()`, `assistantTurnEventsFromSessionEvents()`, and mirrored Zod schemas) that segments an assistant turn into a compact Process + Answer shape, with Claude `Task` subagent refs surfaced without leaking prompt text — internal additions that don't change CLI behavior

## [0.19.1] - 2026-06-09

### Changed

- **Bundled `sidekick-shared` 0.19.1**: Model-ID pricing and context-window lookups (behind the dashboard's cost and context gauges) now tolerate padded or mixed-case IDs. The shared library also gains Zod boundary schemas, an `extractSessionEvents()` progress-unwrapping helper, and a `/schemas` subpath export for downstream consumers — internal additions that don't change CLI behavior

## [0.19.0] - 2026-06-09

### Added

- **Claude Opus 4.8 & Fable 5 support**: The dashboard's context-window gauge and cost estimates recognize `claude-opus-4-8` and `claude-fable-5` (both 1M-token context; Opus 4.8: $5/$25 per MTok, Fable 5: $10/$50 per MTok) via the shared model catalog

### Changed

- **Codex account switching now swaps `~/.codex/auth.json`**: `sidekick account --provider codex --switch-to <id>` (and `--add`) activates the account by atomically swapping its backed-up credentials into the system `~/.codex/` home, mirroring the Claude switch pattern — codex terminals outside Sidekick pick up the switch. Profile directories become pure credential backups, with a one-time startup migration for installs created under the old `CODEX_HOME`-redirection model. The command surfaces swap warnings on add, switch, and remove: a running codex process that needs restarting, stale credentials, or OS-keyring credential storage that Sidekick cannot swap

### Fixed

- **Opus 4.6/4.7 cost over-estimation**: Dashed model IDs fell back to the Opus 4.0 pricing tier ($15/$75 instead of $5/$25), inflating estimated costs 3×
- **Haiku 4.5 unpriced under dashed IDs**: Costs for `claude-haiku-4-5-*` sessions could render as "—" because no dashed static pricing key existed

## [0.18.5] - 2026-06-04

### Changed

- **Consistent Codex transcripts**: `sidekick dashboard` and `sidekick report` now parse Codex sessions via `parseTranscriptFromEvents()`, matching the canonical `SessionEvent` pipeline used by the other providers
- **Bundled `sidekick-shared` 0.18.5**: Picks up the new session context evidence snapshot API (`buildSessionContextSnapshot`, `readSessionContextSnapshot`, `SessionContextSnapshot` and related types) and the Codex session evidence gap closures — `system` audit events, normalized `token_count` rate limits, per-file `apply_patch` expansion, tool-emission dedupe, MCP server attribution, and the new `ProviderReaderSessionWatcher`

## [0.18.4] - 2026-05-27

### Added

- **`sidekick peak --provider <id>`**: New flag gates peak-hours output on the session provider. When the resolved provider is not `claude-code`, the command prints a "not applicable" message instead of calling the upstream endpoint

### Changed

- **Bundled `sidekick-shared` 0.18.4**: Picks up `scopePeakHoursToSessionProvider()`, `isClaudeCodeSessionProvider()`, `createPeakHoursNotApplicableState()` for peak-hours scoping, the improved Codex quota snapshot selection logic (`isPreferredQuotaHit`, `findAccountRolloutFiles`, `shouldKeepExistingSnapshot`), and the `notApplicable` field on `PeakHoursState`

## [0.18.3] - 2026-05-19

### Added

- **`sidekick quota history`**: New subcommand that renders a 13-week GitHub-contributions-style heatmap of quota utilization for the current workspace. Flags: `--weeks <n>` (1-26, default 13), `--provider claude|codex` (default both), `--workspace <path>` (default cwd). Bucketed glyphs (`· ░ ▒ ▓ █`) are color-coded by utilization band (≤0 / <25 / <50 / <75 / ≥75), with per-provider rows and a peak / avg / unavailable-days / samples footer. Days that hit `available: false` render as a red `×`. With `--json`, emits a `{ workspaceId, weeks, providers: { claude?, codex? }, generatedAt }` payload — the same shape consumed by the VS Code dashboard

### Changed

- **Bundled `sidekick-shared` 0.18.3**: Picks up the new per-workspace quota history surface (`appendQuotaHistorySample`, `readQuotaHistoryRange`, `readQuotaHistoryDailyBuckets`, `pruneQuotaHistory`, `getWorkspaceIdFromPath`) and the optional `workspaceId` / `appendHistorySample` hooks on `CodexQuotaWatcher`

## [0.18.2] - 2026-05-19

### Added

- **`sidekick quota --refresh`**: New flag on the `quota` command that, for Codex, explicitly refreshes from the ChatGPT usage API before falling back to local rollout data and cached snapshots. Without the flag, the Codex quota path stays fully local and makes no upstream network call

### Changed

- **Codex quota is local-only by default**: `sidekick quota --provider codex` now delegates to the new `resolveCodexQuota` orchestrator in `sidekick-shared`. It checks the current workspace's most recent rollout, then recent account-level rollouts under `CODEX_HOME/sessions`, then the active account's cached snapshot — no upstream network call unless `--refresh` is passed. Failure output continues to include structured `failureKind` / `httpStatus` / `retryAfterMs` fields under `--json`
- **Bundled `sidekick-shared` 0.18.2**: Picks up the new Codex quota orchestrator (`resolveCodexQuota`, `resolveCodexQuotaFromLocalSources`, `readLatestCodexQuotaFromRollouts`, `fetchCodexQuotaFromApi`), the relaxed `CodexRateLimits` shape (nullable `resets_at` / `window_minutes`), the rate-limit-only `token_count` event emission in `JsonlSessionWatcher`, and `state_N.sqlite` discovery in `CodexDatabase` + provider auto-detect

## [0.18.1] - 2026-05-08

### Changed

- **Shared dashboard formatting**: terminal dashboard `fmtNum()` and `formatDuration()` now delegate to `formatTokenCount()` and `formatDurationMs()` from `sidekick-shared`, keeping the existing CLI surface (uppercase `K`/`M` suffix, compact `1m5s` style) while removing forked rounding logic

## [0.18.0] - 2026-05-08

### Changed

- **Bundled `sidekick-shared` 0.18.0**: Picks up the new provider-aware quota orchestration surface — `MultiProviderQuotaService`, `CodexQuotaWatcher`, `getActiveAccountStatus()`, `extractToolCall()`, cost-provenance helpers (`calculateCostWithProvenance`, `mergeCostSources`), and model display helpers (`shortModelName`, `getModelDisplayInfo`, `compareModelIds`, `sortModelIds`). `parseModelId()` also now recognizes legacy Claude IDs such as `claude-3-opus-20240229` and `claude-3-5-sonnet-20241022`
- **No CLI runtime changes**: This release ships the shared library upgrade for downstream tooling alignment; `sidekick quota`, `sidekick status`, and the live dashboard keep using the existing polling path. Wiring the new orchestrator into the CLI will land in a follow-up release

## [0.17.7] - 2026-04-28

### Fixed

- **Quota snapshot write race**: Updated the bundled `sidekick-shared` snapshot writer so concurrent `sidekick quota` / Codex session updates no longer collide on `quota-snapshots.json.tmp` or throw `ENOENT`. Failed writes now also clean up their partial temp files instead of leaving orphans in `~/.config/sidekick/`

## [0.17.6] - 2026-04-19

### Added

- **`sidekick peak` command**: One-shot check for Claude's current peak-hours state — weekdays 13:00–19:00 UTC, when session limits drain faster on Free/Pro/Max/Team subscriptions. Prints a color-coded status block with a countdown to the next transition. Data comes from the public `promoclock.co/api/status` endpoint (third-party, unaffiliated with Anthropic) with a graceful fallback when unreachable. `--json` emits the full raw state
- **Peak-hours block in `sidekick status`**: When the active provider is `claude-code`, the Claude + OpenAI health blocks are now followed by a **Claude Peak Hours** block (off-peak or in-peak, with countdown). Gated on the provider so OpenCode / Codex users don't trigger an unnecessary third-party fetch. `--json` output includes the new `peak` field
- **Peak-hours summary in `sidekick quota`**: Claude subscription quota output now shows a **Peak** line under the 5-hour / 7-day bars — green dot off-peak, orange dot during an active peak, with a countdown to the next transition. `--json` output includes the new `peak` field

## [0.17.5] - 2026-04-18

### Added

- **Default account bootstrap at CLI startup**: The CLI now calls `ensureDefaultAccounts()` from `sidekick-shared` at module load and awaits the result inside a Commander `preAction` hook, so the first real subcommand blocks briefly on the bootstrap while `--version` and `--help` stay instant. When a system Claude Code or Codex credential exists and no saved account is active for that provider yet, the CLI registers it as "Default" — `sidekick quota`, `sidekick account`, and `sidekick stats` now reflect the active account on first run without requiring an explicit `sidekick account --add` first. Idempotent, never overwrites manually saved accounts, and all errors are swallowed so startup is never blocked

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing this feature in [#16](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/16).

## [0.17.4] - 2026-04-17

### Changed

- **Pricing hydration import migrated to `sidekick-shared/node`**: `cli.ts` now imports `hydratePricingCatalog` from the new Node-only subpath and keeps `detectProvider` on the package root. Runtime behavior is unchanged; the split makes the CLI's import surface self-documenting (hydration is explicitly a Node API) and aligns the CLI with the shared library's new versioned public API contract

## [0.17.3] - 2026-04-17

### Changed

- **Version sync with the VS Code extension**: Republished to keep CLI, extension, and shared-library versions aligned after a cosmetic changelog fix in 0.17.3. No CLI code changes — functionally identical to 0.17.2

## [0.17.2] - 2026-04-17

### Added

- **LiteLLM pricing hydration on startup**: The CLI now fetches the LiteLLM pricing catalog on startup and caches to `~/.config/sidekick/pricing-catalog.json` with a 24-hour TTL, 3s timeout, and stale-cache fallback — new model prices are picked up without a CLI upgrade
- **Expanded pricing coverage**: GPT-4o, GPT-4.1, GPT-5.x, o1, o3, and o3-mini families are now priced alongside the existing Claude entries
- **Real-dollar Codex / Claude Code costs**: `EventAggregator` computes cost from the pricing table when the session provider doesn't report one, so `sidekick` live dashboards now show actual dollars for Codex and Claude Code sessions
- **`stats` footer lists unpriced models**: `sidekick stats` prints any models encountered with no pricing entry so missing coverage is visible

### Fixed

- **Context-gauge % wrong for Opus 4.7 (1M) and other new models**: The dashboard's context gauge was dividing by 200K for Claude Opus 4.7 (native 1M), inflating the displayed %. The shared model → context-window map now includes Opus/Sonnet 4.7 (1M), GPT-5.4 (1.05M), GPT-5.3-Codex (400K), and GPT-5.3-Codex-Spark (128K). Claude Code's `[1m]` suffix is now also honored as an explicit 1M marker
- **Silent Sonnet-priced fallback for unknown models**: Codex, GPT-5.x, and o-series rows were being rendered at Sonnet rates. Unknown-model rows now render as `—` in yellow instead of inventing a dollar figure

### Changed

- **`historical-data.json` schema v2**: reads `priced` flag and `unpricedModelIds` from records written by the latest VS Code extension; v1 records still read correctly

## [0.17.1] - 2026-04-13

### Fixed

- **Codex multi-home session discovery**: Provider detection now scans all candidate Codex home directories, fixing missed sessions when the managed profile home is empty but the system `~/.codex/` has activity

## [0.17.0] - 2026-04-13

### Added

- **Multi-provider account management**: `sidekick account` now supports `--provider codex` for Codex profile management alongside Claude Code accounts
- **Codex account lifecycle**: `--add` prepares a profile and spawns `codex login`; `--switch-to` and `--remove` accept email, label, or profile ID
- **Quota snapshot fallback**: `sidekick quota` for Codex shows cached rate-limit snapshots when no active session exists, with "cached from" timestamp

### Fixed

- **Email normalization**: Claude account lookup normalizes email case for reliable matching

## [0.16.1] - 2026-03-27

### Fixed

- **Dashboard provider status scoping**: The TUI now shows degraded-service notices only for the monitored provider — Claude for Claude Code sessions, OpenAI for Codex sessions, and no status banner for OpenCode

## [0.16.0] - 2026-03-23

### Changed

- **Consistent cost formatting**: All cost displays (`stats`, `context`, Sessions panel, narrative prompt) now use shared `formatCost()` with intelligent decimal precision (4 places for < $0.01, 2 otherwise)
- **QuotaService**: Rewritten to wrap shared `QuotaPoller` with exponential backoff instead of manual polling loop
- **modelContext**: Now re-exports `getModelInfo` from shared library alongside `getContextWindowSize`

## [0.15.2] - 2026-03-18

### Fixed

- **CLI help descriptions**: Updated `quota` and `status` command descriptions to reflect provider-aware behavior
- **`sidekick quota --provider`**: Added local `--provider` option so `sidekick quota --provider codex` works naturally

## [0.15.0] - 2026-03-18

### Added

- **OpenAI status page monitoring**: CLI dashboard now shows OpenAI API status alongside Claude API status
- **Codex rate limits in dashboard**: Sessions panel displays Codex rate-limit data with "Rate Limits" header instead of "Quota"
- **Provider-aware `sidekick quota` command**: Detects active provider and shows Codex rate limits, Claude subscription quota, or an informational message for OpenCode

### Fixed

- **QuotaService polling for Codex**: Dashboard no longer starts Claude OAuth quota polling when the active provider is Codex

## [0.14.2] - 2026-03-16

### Fixed

- **Quota polling interval**: Reduced quota refresh from every 30 seconds to every 5 minutes to avoid unnecessary API calls
- **SessionsPanel `detailWidth()` call**: Removed unused parameter from `detailWidth()` in the Sessions panel quota rendering

## [0.14.1] - 2026-03-14

### Fixed

- **Per-model context window sizes**: Dashboard context gauge now shows correct utilization for Claude Opus 4.6 (1M context) and other models with non-200K windows

### Changed

- **Shared model context lookup**: CLI dashboard now uses the centralized `getModelContextWindowSize()` from `sidekick-shared` instead of a local duplicate map

## [0.14.0] - 2026-03-12

### Added

- **`sidekick account` Command**: Manage Claude Code accounts from the terminal — list saved accounts, add the current account with an optional label, switch to the next or a specific account, and remove accounts. Supports `--json` output for scripting
- **Quota Account Label**: `sidekick quota` now shows the active account email and label above the quota bars when multi-account is enabled
- **macOS Keychain Support**: `sidekick account` and `sidekick quota` now read and write credentials via the system Keychain on macOS, fixing account switching and quota checks on Mac

## [0.13.8] - 2026-03-12

### Changed

- **Structured quota failure output**: `sidekick quota` now renders consistent auth, rate-limit, server, network, and unexpected-failure copy from shared quota failure descriptors while preserving `--json` machine-readable output
- **Dashboard unavailable quota rendering**: The Sessions panel now shows Claude Code quota failures inline instead of hiding the quota section whenever subscription data is unavailable
- **Quota transition toasts**: The Ink dashboard now fires low-noise toast notifications only when Claude Code quota failure state changes, avoiding repeated alerts every polling interval

## [0.13.7] - 2026-03-11

### Changed

- **npm README sync**: Updated the published CLI package README to reflect current OpenCode monitoring behavior, platform-specific data directories, and the `sqlite3` runtime requirement
- **README badge cleanup**: Removed the Ask DeepWiki badge from the published CLI package README; the repo root README still keeps it

## [0.13.6] - 2026-03-11

### Changed

- **Refreshed CLI Dashboard Wordmark**: Updated the dashboard wordmark/header styling for a cleaner splash and dashboard identity

### Fixed

- **OpenCode dashboard startup**: OpenCode DB-backed session discovery now resolves projects by worktree, sandboxes, and session directory instead of quietly behaving like no session exists
- **OpenCode runtime notices**: The CLI now prints an OpenCode-only actionable notice when `opencode.db` exists but `sqlite3` is missing, blocked, or otherwise unusable in the current shell environment

## [0.13.5] - 2026-03-10

### Added

- **`sidekick status` Command**: One-shot Claude API status check with color-coded text output and `--json` mode
- **Dashboard Status Banner**: Status bar shows a colored `● API minor/major/critical` indicator when Claude is degraded; Sessions panel Summary tab shows an "API Status" section with affected components and active incident details. Polls every 60s

## [0.13.4] - 2026-03-08

### Fixed

- **Onboarding Phrase Spam**: Splash screen and detail pane motivational phrases memoized — no longer flicker every render tick (fixes [#13](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/13))

### Changed

- **Simplified Logo**: Replaced 6-line ASCII robot art with compact text header in splash, help, and changelog overlays
- **Removed Dead Code**: Removed unused `getSplashContent()` and `HELP_HEADER` exports from branding module

## [0.13.3] - 2026-03-04

_No CLI-specific changes in this release._

## [0.13.2] - 2026-03-04

_No CLI-specific changes in this release._

## [0.13.1] - 2026-03-04

### Added

- **`sidekick quota` Command**: One-shot subscription quota check showing 5-hour and 7-day utilization with color-coded progress bars and reset countdowns — supports `--json` for machine-readable output
- **Quota Projections**: Elapsed-time projections shown in `sidekick quota` output and TUI dashboard quota section — displays projected end-of-window utilization next to current value (e.g., `40% → 100%`), included in `--json` output as `projectedFiveHour` / `projectedSevenDay`

## [0.13.0] - 2026-03-03

_No CLI-specific changes in this release._

## [0.12.10] - 2026-03-01

### Added

- **Events Panel** (key 7): Scrollable live event stream with colored type badges (`[USR]`, `[AST]`, `[TOOL]`, `[RES]`), timestamps, and keyword-highlighted summaries; detail tabs for full event JSON and surrounding context
- **Charts Panel** (key 8): Tool frequency horizontal bars, event type distribution, 60-minute activity heatmap using `░▒▓█` intensity characters, and pattern analysis with frequency bars and template text
- **Multi-Mode Filter**: `/` filter overlay now supports four modes — substring, fuzzy, regex, and date range — Tab cycles modes, regex mode shows red validation errors
- **Search Term Highlighting**: Active filter terms highlighted in blue within side list items
- **Timeline Keyword Coloring**: Event summaries in the Sessions panel Timeline tab now use semantic keyword coloring — errors red, success green, tool names cyan, file paths magenta

### Removed

- **Search Panel**: Removed redundant Search panel (previously key 7) — the `/` filter with multi-mode support serves the same purpose

## [0.12.9] - 2026-02-28

### Added

- **Standalone Data Commands**: `sidekick tasks`, `sidekick decisions`, `sidekick notes`, `sidekick stats`, `sidekick handoff` for accessing project data without launching the TUI
- **`sidekick search <query>`**: Cross-session full-text search from the terminal
- **`sidekick context`**: Composite output of tasks, decisions, notes, and handoff for piping into other tools
- **`--list` flag on `sidekick dump`**: Discover available session IDs before requiring `--session <id>`
- **Search Panel**: Search panel (panel 7) wired into the TUI dashboard

### Changed

- **`taskMerger` utility**: Duplicate `mergeTasks` logic extracted into shared `taskMerger` utility
- **Model constants**: Hardcoded model IDs extracted to named constants

### Fixed

- **`convention` icon**: Notes panel icon replaced with valid `tip` type
- **Linux clipboard**: Now supports Wayland (`wl-copy`) and `xsel` fallbacks, with error messages instead of silent failure
- **`provider.dispose()`**: Added to `dump` and `report` commands (prevents SQLite connection leaks)

## [0.12.8] - 2026-02-28

### Changed

- **Dashboard UI/UX Polish**: Visual overhaul for better hierarchy, consistency, and readability
  - Splash screen and help overlay now display the robot ASCII logo
  - Toast notifications show severity icons (✘ error, ⚠ warning, ● info) with inner padding
  - Focused pane uses double-border for clear focus indication
  - Section dividers (`── Title ────`) replace bare bold headers in summary, agents, and context attribution
  - Tab bar: active tab underlined in magenta, inactive tabs dimmed, bracket syntax removed
  - Status bar: segmented layout with `│` separators; keys bold, labels dim
  - Summary metrics condensed: elapsed/events/compactions on one line, tokens on one line with cache rate and cost
  - Sparklines display peak metadata annotations
  - Progress bars use blessed color tags for consistent coloring
  - Help overlay uses dot-leader alignment for all keybinding rows
  - Empty state hints per panel (e.g. "Tasks appear as your agent works.")
  - Session picker groups sessions by provider with section headers when multiple providers are present

## [0.12.7] - 2026-02-27

### Added

- **HTML Session Report**: `sidekick report` command generates a self-contained HTML report and opens it in the default browser
  - Options: `--session`, `--output`, `--theme` (dark/light), `--no-open`, `--no-thinking`
  - TUI Dashboard: press `r` to generate and open an HTML report for the current session

## [0.12.6] - 2026-02-26

### Added

- **Session Dump Command**: `sidekick dump` exports session data in text, markdown, or JSON format with `--format`, `--width`, and `--expand` options
- **Plans Panel Re-enabled**: Plans panel restored in CLI dashboard with plan file discovery from `~/.claude/plans/`
- **Enhanced Status Bar**: Session info display improved with richer metadata

### Fixed

- **Old snapshot format migration**: Restoring pre-0.12.3 session snapshots no longer shows empty timeline entries

### Changed

- **Phrase library moved to shared**: CLI-specific phrase formatting kept local, all phrase content now from `sidekick-shared`

## [0.12.5] - 2026-02-24

### Fixed

- **Update check too slow to notice new versions**: Reduced npm registry cache TTL from 24 hours to 4 hours so upgrade notices appear sooner after a new release

## [0.12.4] - 2026-02-24

### Fixed

- **Session crash on upgrade**: Fixed `d.timestamp.getTime is not a function` error when restoring tool call data from session snapshots — `Date` objects were serialized to strings by JSON but not rehydrated on restore, causing the session monitor to crash on first run after upgrading from 0.12.2 to 0.12.3

## [0.12.3] - 2026-02-24

### Added

- **Latest-node indicator**: The most recently added node in tree and boxed mind map views is now marked with a yellow indicator
- **Plan analytics in mind map**: Tree and boxed views now display plan progress and per-step metrics
  - Tree view: plan header shows completion stats; steps show complexity, duration, tokens, tool calls, and errors in metadata brackets
  - Box view: progress bar with completion percentage; steps show right-aligned metrics; subtitle shows step count and total duration
- **Cross-provider plan extraction**: Shared `PlanExtractor` now handles Claude Code (EnterPlanMode/ExitPlanMode) and OpenCode (`<proposed_plan>` XML) plans — previously only Codex plans were shown
- **Enriched plan data model**: Plan steps include duration, token count, tool call count, and error messages
- **Phase-grouped plan display**: When a plan has phase structure, tree and boxed views group steps under phase headers with context lines from the original plan markdown
- **Node type filter**: Press `f` on the Mind Map tab to cycle through node type filters (file, tool, task, subagent, command, plan, knowledge-note) — non-matching sections render dimmed in grey

### Fixed

- **Kanban board regression**: Subagent and plan-step tasks now correctly appear in the kanban board

### Changed

- **Plans panel temporarily disabled**: The Plans panel in the CLI dashboard is disabled until plan-mode event capture is reliably working end-to-end. Plan nodes in the mind map remain active.
- `DashboardState` now delegates to shared `EventAggregator` instead of maintaining its own aggregation logic

## [0.12.2] - 2026-02-23

### Added

- **Update notifications**: The dashboard now checks the npm registry for newer versions on startup and shows a yellow banner in the status bar when an update is available (e.g., `v0.13.0 available — npm i -g sidekick-agent-hub`). Results are cached for 24 hours to avoid repeated network requests.

## [0.12.1] - 2026-02-23

### Fixed

- **VS Code integration**: Fixed exit code 127 when the extension launches the CLI dashboard on systems using nvm or volta (node binary not found when shell init is bypassed)

## [0.12.0] - 2026-02-22

### Added

- **"Open CLI Dashboard" VS Code Integration**: New VS Code command `Sidekick: Open CLI Dashboard` launches the TUI dashboard in an integrated terminal
  - Install the CLI with `npm install -g sidekick-agent-hub`

## [0.11.0] - 2026-02-19

### Added

- **Initial Release**: Full-screen TUI dashboard for monitoring agent sessions from the terminal
  - Ink-based terminal UI with panels for sessions, tasks, kanban, mind map, notes, decisions, search, files, and git diff
  - Multi-provider support: auto-detects Claude Code, OpenCode, and Codex sessions
  - Reads from `~/.config/sidekick/` — the same data files the VS Code extension writes
  - Usage: `sidekick dashboard [--project <path>] [--provider <id>]`
