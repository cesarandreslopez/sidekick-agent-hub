# Changelog

All notable changes to the Sidekick Agent Hub CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
