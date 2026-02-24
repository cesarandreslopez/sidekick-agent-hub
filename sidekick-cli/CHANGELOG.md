# Changelog

All notable changes to the Sidekick Agent Hub CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.12.3] - 2026-02-23

### Added

- **Plan analytics in mind map**: Tree and boxed views now display plan progress and per-step metrics
  - Tree view: plan header shows completion stats; steps show complexity, duration, tokens, tool calls, and errors in metadata brackets
  - Box view: progress bar with completion percentage; steps show right-aligned metrics; subtitle shows step count and total duration
- **Cross-provider plan extraction**: Shared `PlanExtractor` now handles Claude Code (EnterPlanMode/ExitPlanMode) and OpenCode (`<proposed_plan>` XML) plans — previously only Codex plans were shown
- **Enriched plan data model**: Plan steps include duration, token count, tool call count, and error messages
- **Phase-grouped plan display**: When a plan has phase structure, tree and boxed views group steps under phase headers with context lines from the original plan markdown
- **Node type filter**: Press `f` on the Mind Map tab to cycle through node type filters (file, tool, task, subagent, command, plan, knowledge-note) — non-matching sections render dimmed in grey

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
