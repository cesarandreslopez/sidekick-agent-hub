# Changelog

All notable changes to the Sidekick Agent Hub CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
