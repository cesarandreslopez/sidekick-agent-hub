# Changelog

All notable changes to sidekick-shared will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.5] - 2026-03-10

### Added

- **Provider Status module**: `fetchProviderStatus()` for checking Claude API health via `status.claude.com` — returns indicator, affected components, active incidents, with graceful fallback on errors

## [0.13.4] - 2026-03-08

_No shared-specific changes in this release._

## [0.13.2] - 2026-03-04

### Added

- **Credentials module**: `readClaudeMaxCredentials()` and `readClaudeMaxAccessTokenSync()` for reading Claude Max OAuth credentials from `~/.claude/.credentials.json`
- **Quota module**: `fetchQuota()` for fetching Claude Max subscription quota (5-hour and 7-day windows)
- **Vitest config**: Added vitest configuration for shared library tests

## [0.13.1] - 2026-03-04

### Added

- **Quota types**: `QuotaWindow` and `QuotaState` types exported for CLI and extension consumption

## [0.13.0] - 2026-03-03

### Changed

- **Refactoring**: Removed dead code, cached hot paths, centralized constants across shared modules

## [0.12.10] - 2026-03-01

### Added

- **Event aggregation**: `EventAggregator` with frequency tracking, activity heatmaps, and pattern extraction
- **Analytics engines**: `FrequencyTracker`, `HeatmapTracker`, `PatternExtractor` for session analytics
- **Snapshot persistence**: `saveSnapshot` / `loadSnapshot` for aggregator state serialization

## [0.12.9] - 2026-02-28

### Added

- **Cross-session search**: `searchSessions()` for full-text search across session data
- **Advanced filter**: `FilterEngine` with substring, fuzzy, regex, and date range modes
- **Context composer**: `composeContext()` for assembling tasks, decisions, notes, and handoff into a single output

## [0.12.8] - 2026-02-28

_No shared-specific changes in this release._

## [0.12.7] - 2026-02-27

### Added

- **HTML report generation**: `generateHtmlReport()` produces self-contained HTML session reports with transcript, stats, and tool summaries
- **Plan extraction**: `PlanExtractor` for cross-provider plan capture (Claude Code, OpenCode, Codex)
- **Changelog parser**: `parseChangelog()` for reading Keep a Changelog formatted files

## [0.12.6] - 2026-02-26

### Added

- **Session dump formatters**: `formatSessionText`, `formatSessionMarkdown`, `formatSessionJson` for exporting session data
- **Noise classifier**: Event classification for filtering noise from session streams
- **Event highlighter**: Keyword coloring for session event summaries
- **Plans reader**: `readPlans`, `readClaudeCodePlanFiles` for plan file discovery
- **Phrase library**: Shared phrase content moved from CLI to shared library

## [0.12.5] - 2026-02-24

_No shared-specific changes in this release._

## [0.12.4] - 2026-02-24

_No shared-specific changes in this release._

## [0.12.3] - 2026-02-24

### Added

- **Subagent trace parser**: `scanSubagentTraces()` for parsing agent trace files
- **Session activity detector**: `detectSessionActivity()` for determining session state
- **Debug log parser**: `parseDebugLog`, `filterByLevel`, `discoverDebugLogs` for Claude Code debug log analysis

## [0.11.0] - 2026-02-19

### Added

- **Initial release**: Shared data access library extracted from the VS Code extension
  - Session event types and persistence schemas
  - JSONL, OpenCode, and Codex parsers
  - Claude Code, OpenCode, and Codex session providers
  - Task, decision, note, history, and handoff readers
  - Session path resolution and subagent scanning
  - Watcher framework for live session file monitoring
  - Tool summary formatter
