# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
