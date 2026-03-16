# Changelog

All notable changes to the Sidekick Agent Hub CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
