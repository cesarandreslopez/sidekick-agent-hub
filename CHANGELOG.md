# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
