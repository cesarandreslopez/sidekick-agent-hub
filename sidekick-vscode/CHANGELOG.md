# Changelog

All notable changes to the Sidekick Agent Hub VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] - 2026-02-18

### Added

- **Multi-Provider Inference**: Support for OpenCode and Codex CLI as inference providers alongside Claude Max and Claude API
  - New `sidekick.inferenceProvider` setting with auto-detection based on installed CLI agents
  - Provider auto-detection picks the most recently active agent via filesystem timestamps
  - "Switch Inference Provider" command and status bar quick-pick
- **Multi-Provider Session Monitoring**: Monitor sessions from OpenCode (`~/.local/share/opencode/`) and Codex CLI (`~/.codex/sessions/`)
  - New `sidekick.sessionProvider` setting with auto-detection
  - Each provider normalizes raw data into a common `ClaudeSessionEvent` format
- **Model Resolver with Tier System**: Unified model selection via tiers (fast/balanced/powerful) with auto-detection per feature
  - `"auto"` resolves to a per-feature default tier (e.g., inline completions → fast, transforms → powerful)
  - Legacy names (haiku/sonnet/opus) map through `LEGACY_TIER_MAP`
  - Tiers map to provider-specific model IDs via `DEFAULT_MODEL_MAPPINGS`
- **Session Handoff System**: Provider-aware context handoff documents for seamless session continuation
  - Configurable via `sidekick.autoHandoff` setting: off, generate-only, generate-and-notify
  - Targets the correct instruction file per provider (CLAUDE.md, AGENTS.md, etc.)
  - Stored in `~/.config/sidekick/handoffs/`
- **Cross-Session Task Persistence**: Tasks from Kanban board persist across sessions in `~/.config/sidekick/tasks/{projectSlug}.json`
- **Decision Log Extraction**: Tracks and persists architectural decisions from sessions in `~/.config/sidekick/decisions/{projectSlug}.json`
- **Event Logging Audit Trail**: Optional JSONL event logging for debugging
  - New settings: `sidekick.enableEventLog`, `sidekick.eventLogMaxSizeMB`, `sidekick.eventLogMaxAgeDays`
  - Stored in `~/.config/sidekick/event-logs/`
- **Plan Visualization**: Step nodes with status indicators in mind map view
- **Documentation Site**: Material for MkDocs documentation with GitHub Pages deployment

### Changed

- Rebranded from "Sidekick for Max" to "Sidekick Agent Hub"
- Removed RSVP Speed Reader feature
- Deprecated `sidekick.authMode` in favor of `sidekick.inferenceProvider` (auto-migration on first activation)

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

- **Context Token Attribution**: Stacked bar chart in the dashboard showing where your context window budget goes
  - Classifies tokens into 7 categories: System Prompt, CLAUDE.md, User Messages, Assistant Responses, Tool Inputs, Tool Outputs, Thinking
  - Helps identify what's consuming context (e.g., large tool outputs, verbose CLAUDE.md)
  - Updates in real-time as the session progresses
- **Notification Triggers**: Configurable alerts for concerning Claude Code activity
  - Built-in triggers: `.env`/credential file access, destructive commands (`rm -rf`, `git push --force`), tool error bursts, context compaction
  - Token threshold alerts when cumulative usage exceeds a configurable limit
  - Fires VS Code notifications so you can monitor autonomous sessions
  - New settings: `sidekick.notifications.enabled`, `sidekick.notifications.triggers.*`, `sidekick.notifications.tokenThreshold`
- **Compaction Detection**: Context compaction events (`summary` type) are now processed and visualized
  - Shows compaction markers in the activity timeline
  - Tracks context size deltas so you know how much was lost
- **Timeline Search & Filtering**: Full-text search within the activity timeline
  - Search input with instant client-side filtering across all events
  - Timeline cap removed during search so all events are searchable
  - Filter toggles for message noise classification (system reminders, sidechain detection)
- **Conversation Viewer**: Full editor tab showing the complete session conversation
  - Chat-style rendering with user (blue), assistant (green), tool (collapsible), and compaction chunks
  - Built-in search for finding content within the conversation
  - New command: `Sidekick: View Session Conversation`
- **Cross-Session Search**: Search across all Claude Code sessions in `~/.claude/projects/`
  - VS Code QuickPick interface with debounced search and context snippets
  - Icons per event type (user, assistant, tool_use)
  - Click results to open the session file
  - New command: `Sidekick: Search Across Sessions`
- **Rich Tool Call Inspector**: Full editor tab with specialized tool call rendering
  - Read: file path with range info
  - Edit: inline diff-style display (red deletions, green additions)
  - Bash: formatted command with description
  - Grep/Glob: search parameters
  - Filter buttons by tool type, expandable detail panels
  - New command: `Sidekick: Open Tool Inspector`

### Improved

- **Message Noise Classification**: Timeline now respects the `isSidechain` flag and filters system metadata
  - Heuristic detection for system reminders, permission checks, and noise events
  - Filter toggles in the dashboard to show/hide noise
- **Enhanced Subagent Visualization**: Subagent tree now shows richer metrics
  - Per-agent token usage (input + output) with "42K tok" display
  - Duration tracking ("1m 23s")
  - Parallel execution detection (agents with overlapping timestamps shown with layers icon)
  - Stats enriched from `SubagentFileScanner` token extraction
- **Tool Analytics Drill-Down**: Clicking a tool analytics row now shows individual tool calls with timing and metadata

## [0.8.5] - 2026-02-14

### Fixed

- **Accurate cost estimation**: Session costs now use actual per-model input/output/cache token breakdown instead of a 50/50 approximation — affects Dashboard, Session Summary, and historical exports
- **Toggle command persistence**: `Sidekick: Toggle` now updates the `sidekick.enabled` config so the inline completion provider respects the toggle state
- **XSS hardening in RSVP reader**: Replaced `innerHTML` with DOM API in the word display to prevent injection from user-selected text
- **Session re-initialization**: `Stop Monitoring` now passes `workspaceState` when re-creating the SessionMonitor, preserving custom session path persistence
- **Overly broad completion filter**: The `however` conversational pattern no longer rejects valid code completions containing the word "however" mid-line — now only matches conversational "However," at the start of a line
- **COLUMN_ORDER mismatch**: Removed stale `'deleted'` column from the Task Board inline script that never received data from the extension
- **SVG in binary filter**: Removed `.svg` from `BINARY_EXTENSIONS` in the diff filter — SVG is text-based XML and should be included in diffs
- **JSDoc default mismatch**: Corrected `truncateDiffIntelligently` docs from "defaults to 3500" to the actual default of 8000
- **Timer leak on dispose**: Dashboard now clears `_richerPanelTimer` timeout on dispose

### Improved

- **Shared utilities extraction**: Consolidated 6 duplicate `getNonce()` implementations, 2 duplicate `extractTaskIdFromResult()` implementations, and scattered markdown fence-stripping regexes into shared modules (`utils/nonce.ts`, `utils/taskHelpers.ts`, `utils/markdownUtils.ts`)
- **Type safety**: Replaced `(block as any)` casts with a proper `isTypedBlock()` type guard in SessionMonitor; typed `handleTokenUsage` parameter in MonitorStatusBar; resolved `WebviewMessage` name collision by renaming to `DashboardWebviewMessage` and `RsvpWebviewMessage`
- **Dead code removal**: Removed always-true ternary in TaskBoard, unused `_pendingMode`/`_pendingComplexity` fields in RsvpViewProvider, and identical `if (language === 'python')` branch in DocumentationService
- **Dependency direction**: Moved analysis types (`AnalyzedError`, `ToolPattern`, etc.) from `services/SessionAnalyzer` to `types/analysis.ts` so utility modules no longer import from services
- **Event deduplication**: `seenHashes` pruning now retains 75% of entries (was 50%) to reduce re-processing window during high-throughput sessions
- **Polling guard**: TempFilesTreeProvider 2-second subagent scan now skips when no session is active

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
  - Added progress notification with time estimate when generating narratives (VS Code notification + inline spinner with "~15-30s" message)
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
  - Import token usage, costs, and tool statistics from completed sessions
  - Enables trend analysis across multiple sessions
- **Response Latency Tracking**: Real-time latency metrics in dashboard
  - Track request-to-response timing for Claude API calls
  - Visualize latency trends over the session
- **Task Nodes in Mind Map**: Task tool calls visualized as distinct nodes
  - Spawned Task agents appear as nodes with their descriptions
  - Shows task type and status in the mind map
- **Dashboard UX**: Improved metric button layout and sizing
  - Better visual hierarchy for metric controls
  - More consistent button sizing across the dashboard

## [0.7.9] - 2026-02-02

### Fixed

- **Custom folder session auto-discovery**: Fixed automatic detection of new sessions (e.g., after `/clean`) when monitoring a custom folder
  - `performNewSessionCheck()` now respects the custom session directory instead of always using the workspace path

## [0.7.8] - 2026-02-02

### Added

- **Mind Map: Directory & Command Nodes**: Grep/Glob and Bash tool calls now show their targets in the mind map
  - Directory nodes (brown) show paths searched by Grep/Glob tools
  - Command nodes (red) show command types executed by Bash (git, npm, docker, etc.)
  - Tooltips display detailed context:
    - Directory nodes show search patterns used (e.g., `*.ts`, `TODO`)
    - Command nodes show actual commands executed (e.g., `npm install`, `git status`)
  - Node sizes scale with usage frequency
- **Mind Map: Auto-Focus on Activity**: Mind map automatically pans to show new activity
  - Focuses on newly added nodes or the latest tool-to-file/URL connection
  - Preserves user's zoom level while adjusting pan position
  - Smooth easing animation for comfortable viewing

### Fixed

- **Custom folder new session detection**: Browsing to a custom folder now properly detects new sessions when Claude Code starts
  - Previously, discovery polling used the workspace path instead of the custom directory
  - Now correctly watches and polls the custom directory for new sessions
  - Entering discovery mode (waiting for session) works correctly with custom paths
- **Folder picker prioritization**: The "Browse Session Folders" list now prioritizes the current VS Code workspace
  - Exact workspace match appears first
  - Subdirectories of the workspace appear next
  - Other folders sorted by most recent activity
- **Session dropdown custom folder**: Session dropdown now correctly shows sessions from the selected custom folder instead of the workspace folder

## [0.7.7] - 2026-02-02

### Added

- **Browse Session Folders**: Manually select any Claude project folder to monitor, regardless of workspace path
  - New "Browse..." button in the Session Analytics dashboard next to the session dropdown
  - Command palette: "Sidekick: Browse Session Folders..." to browse all Claude project folders in `~/.claude/projects/`
  - Shows decoded human-readable paths, session counts, and last activity time
  - Selection persists across VS Code restarts (stored per-workspace)
  - Custom path indicator shows when using a manually selected folder
  - "Reset to Auto-Detect Session" command to clear custom selection and revert to workspace-based discovery
  - Useful when Claude Code is running in a subdirectory or different path than your VS Code workspace
- **Token Usage Tooltips**: Hover over token metrics to see quota projections and estimated time to exhaustion
- **Activity Timeline Enhancements**: Claude's text responses now visible in the activity timeline alongside tool calls
- **Mind Map Subagent Visibility**: Spawned Task agents now appear as distinct nodes in the mind map visualization
- **Dynamic Node Sizing**: Mind map nodes scale based on content length for better visual hierarchy
- **Latest Link Highlighting**: Most recent connections in the mind map are visually emphasized
- **Line Change Statistics**: Files Touched tree view and mind map now show +/- line change counts

### Fixed

- **Git Repository Detection**: Improved detection for nested git repositories

## [0.7.6] - 2026-01-31

### Added

- **Subscription Quota Display**: View Claude Max subscription usage limits directly in the Session Analytics dashboard
  - Two semi-circular gauges showing 5-hour and 7-day quota utilization
  - Color-coded thresholds: green (<50%), orange (50-79%), red (≥80%)
  - Countdown timers showing when each quota resets (e.g., "Resets in 2h 15m")
  - Reads OAuth token from Claude Code CLI credentials (`~/.claude/.credentials.json`)
  - Auto-refreshes every 30 seconds when dashboard is visible
  - Gracefully hidden when using API key mode or no OAuth token available

## [0.7.5] - 2026-01-30

### Fixed

- **Subdirectory session discovery**: Session monitoring now finds Claude Code sessions started from subdirectories of the workspace ([#7](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/7))
  - When VS Code workspace is `/project` but Claude Code starts from `/project/packages/app`, the extension now correctly discovers and monitors that session
  - Uses prefix-based matching with most-recently-active selection when multiple subdirectory sessions exist
  - Prevents false positives (e.g., `/project` won't match `/project-v2`)
  - Added `subdirectoryMatches` and `selectedSubdirectoryMatch` to session diagnostics for debugging

## [0.7.4] - 2026-01-30

### Added

- **Mind Map URL Nodes**: WebFetch and WebSearch calls now appear as clickable nodes in the session mind map
  - URLs display as cyan nodes showing the hostname (e.g., `example.com`)
  - Search queries display truncated query text
  - Click URL nodes to open in your default browser
  - Click search query nodes to search Google
  - File nodes remain clickable to open in VS Code editor
  - Visual feedback with pointer cursor and hover brightness effect

## [0.7.3] - 2026-01-29

### Added

- **Timeout Manager**: Centralized, context-aware timeout handling across all AI operations
  - Configurable timeouts per operation type (inline completion, transform, commit message, etc.)
  - Auto-adjustment based on context/prompt size
  - Progress indication with cancellation support
  - "Retry with longer timeout" option when requests timeout
- **New Settings**:
  - `sidekick.timeouts.inlineCompletion`: Timeout for inline completions (default: 15s)
  - `sidekick.timeouts.transform`: Timeout for code transforms (default: 60s)
  - `sidekick.timeouts.commitMessage`: Timeout for commit message generation (default: 30s)
  - `sidekick.timeouts.documentation`: Timeout for documentation generation (default: 30s)
  - `sidekick.timeouts.explanation`: Timeout for code explanations (default: 45s)
  - `sidekick.timeouts.errorExplanation`: Timeout for error explanations (default: 30s)
  - `sidekick.timeouts.inlineChat`: Timeout for inline chat (default: 60s)
  - `sidekick.timeouts.preCommitReview`: Timeout for pre-commit review (default: 60s)
  - `sidekick.timeouts.prDescription`: Timeout for PR description generation (default: 45s)

### Changed

- All AI services now use TimeoutManager for consistent timeout behavior
- Added AbortSignal support to completion options for proper request cancellation

## [0.7.2] - 2026-01-29

### Fixed

- **Session path encoding on Windows/Mac**: Fixed issue where session monitoring couldn't find Claude Code sessions on some systems ([#6](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/6))
  - Improved path encoding to handle colons, slashes, and underscores correctly
  - Added 3-strategy discovery fallback when computed path doesn't match
  - Added session directory to diagnostics command for debugging

## [0.7.1] - 2026-01-29

### Fixed

- **Silent timeout on inline completions**: Completions that timed out would silently fail with no user feedback ([#5](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/5))
  - Now shows a warning notification when requests timeout, with options to open settings or view logs
  - Added `TimeoutError` class that survives the error chain for proper identification
  - Other completion errors now also show user-friendly messages

### Added

- **New Setting**: `sidekick.inlineTimeout` - Configurable timeout for inline completions (default: 15s, was hardcoded 30s)
  - Increase if you frequently experience timeouts when Claude servers are slow
  - Range: 5-120 seconds

### Changed

- Reduced default inline completion timeout from 30s to 15s for faster feedback when servers are slow

## [0.7.0] - 2026-01-29

### Added

- **Claude Code Session Monitor**: A comprehensive real-time analytics dashboard for monitoring Claude Code sessions
  - **Session Analytics Dashboard**: Track token usage, costs, and session activity in a dedicated sidebar panel
    - Real-time token consumption and cost tracking with model-specific pricing
    - Context window gauge showing input/output token usage vs. limits
    - Session selector dropdown to switch between active and recent sessions
    - Activity timeline displaying user prompts, tool calls, errors, and subagent spawns
    - Tool analytics with categorization (file operations, search, bash commands, etc.)
    - Automatic session discovery when Claude Code starts new sessions
  - **Mind Map Visualization**: Interactive D3.js force-directed graph showing session structure
    - Visualizes conversation flow, tool usage, and file relationships
    - Interactive nodes for exploring how Claude navigates your codebase
    - Real-time updates as the session progresses
  - **Latest Files Touched**: Tree view showing files modified during Claude Code sessions
    - Quick access to recently edited files
    - Shows file status (created, modified, deleted)
  - **Subagents Tree**: Monitor spawned Task agents during complex operations
    - Track subagent status (running, completed, failed)
    - View subagent prompts and results
  - **Status Bar Metrics**: Real-time session status in the VS Code status bar
    - Shows active session indicator and quick access to dashboard
  - **New Commands**:
    - `Sidekick: Open Session Dashboard` - Open the analytics dashboard
    - `Sidekick: Start Session Monitoring` - Begin monitoring Claude Code sessions
    - `Sidekick: Stop Session Monitoring` - Pause monitoring
    - `Sidekick: Refresh/Find Session` - Discover new sessions
  - **Activity Bar Integration**: New "Session Monitor" icon in the activity bar with all monitoring views
- **New Setting**:
  - `sidekick.enableSessionMonitoring`: Enable/disable Claude Code session monitoring (default: true)

### Technical

- Added JSONL parser with line buffering for efficient session log parsing
- Added session path resolver for cross-platform Claude Code directory detection
- Added model pricing service with accurate per-token cost calculation
- Added burn rate calculator for token consumption tracking

## [0.6.0] - 2026-01-26

### Added

- **Generate Documentation**: Automatically generate JSDoc/docstrings for functions, classes, and methods

  - Press `Ctrl+Shift+D` (Cmd+Shift+D on Mac) with cursor in a function
  - Supports all major languages (TypeScript, JavaScript, Python, etc.)
  - Configurable model via `sidekick.docModel` (default: haiku)
- **Explain Code**: Get AI-powered explanations for selected code

  - Press `Ctrl+Shift+E` (Cmd+Shift+E on Mac) with code selected
  - Five complexity levels: ELI5, Curious Amateur, Imposter Syndrome, Senior, PhD Mode
  - Rich webview panel with markdown rendering
  - Regenerate with custom instructions
  - Configurable model via `sidekick.explainModel` (default: sonnet)
- **Error Explanations**: Understand and fix errors with AI assistance

  - Lightbulb quick action on diagnostics: "Explain Error with AI"
  - "Fix Error with AI" command applies suggested fixes directly
  - Five complexity levels for explanations
  - Configurable model via `sidekick.errorModel` (default: sonnet)
- **Quick Ask (Inline Chat)**: Ask questions about code without leaving the editor

  - Press `Ctrl+I` (Cmd+I on Mac) to open quick input
  - Ask questions or request code changes
  - Diff preview for proposed changes with Accept/Reject
  - Context-aware: uses selected code or cursor context
  - Configurable model via `sidekick.inlineChatModel` (default: sonnet)
- **Pre-commit AI Review**: Review your changes before committing

  - Click the eye icon in Source Control toolbar
  - AI analyzes staged/unstaged changes for issues
  - Highlights bugs, security concerns, code smells
  - Results shown as inline decorations in editor
  - Configurable model via `sidekick.reviewModel` (default: sonnet)
- **PR Description Generation**: Generate pull request descriptions automatically

  - Click the PR icon in Source Control toolbar
  - Analyzes all commits on your branch vs base branch
  - Generates summary, change list, and test plan
  - Copies to clipboard, ready to paste
  - Configurable model via `sidekick.prDescriptionModel` (default: sonnet)
- **Context Menu Submenu**: All Sidekick commands organized under "Sidekick" submenu

  - Quick Ask, Generate Docs, Explain Code, Explain Error, Fix Error, Transform, RSVP Reader
  - Complexity level submenus for Explain Code and RSVP Reader
- **Completion Hint**: Visual indicator suggesting AI completion shortcut

  - Shows hint at cursor after typing stops
  - Configurable delay via `sidekick.completionHintDelayMs` (default: 1500ms)
  - Toggle via `sidekick.showCompletionHint` (default: true)

### Fixed

- **Claude CLI path resolution**: Fixed "Claude Code native binary not found" error when Claude is in PATH but not in common installation directories ([#4](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/4))
  - Now uses `which` (Unix) or `where` (Windows) to resolve the absolute path
  - Better error messages with installation instructions

### Changed

- Shortened "Explain Code" command title for cleaner context menus
- Bidirectional integration between Explain Code and RSVP Reader (read explanations in RSVP mode)

## [0.5.0] - 2025-01-24

### Added

- **RSVP Reader**: Speed reading with AI-powered explanations for selected text
  - Select text and press `Ctrl+Shift+R` (Cmd+Shift+R on Mac) to open the RSVP Reader panel
  - Word-by-word display with ORP (Optimal Recognition Point) highlighting reduces eye movement and increases reading speed
  - Adjustable reading speed from 100-900 WPM with real-time controls
  - **Five AI explanation complexity levels**:
    - **ELI5** - Complete beginner explanations with simple analogies
    - **Curious Amateur** - Learning mode with defined technical terms
    - **Imposter Syndrome** - Fill knowledge gaps, assume basic familiarity (default)
    - **Senior** - High-level summary, skip basics, highlight key details
    - **PhD Mode** - Expert-level analysis without simplification
  - **Dual content modes**: Toggle between original text and AI-generated explanation
  - **Two reading modes**: RSVP (word-by-word) or full-text scrollable view
  - **Context menu integration**: Right-click selected text → "Sidekick: RSVP Reader" submenu
  - **Rich keyboard controls**:
    - Space: Play/Pause
    - Left/Right arrows: Navigate words
    - Up/Down arrows: Adjust speed (±50 WPM)
    - R: Restart from beginning
    - O: Toggle original/explanation
    - F: Toggle full-text mode
  - Regenerate explanations with custom instructions
  - Intelligent content classification (prose/technical/code) for tailored explanations
  - VS Code theme-aware UI with dark/light mode support
- **New Settings**:
  - `sidekick.rsvpMode`: Default reading mode (direct/explain-first)
  - `sidekick.explanationComplexity`: Default AI explanation level
  - `sidekick.explanationModel`: Model for explanations (haiku/sonnet/opus, default: sonnet)

## [0.4.0] - 2025-01-21

### Added

- **AI Commit Message Generation**: Generate commit messages from your staged changes with a single click
  - Sparkle button in Source Control toolbar triggers generation
  - Analyzes git diff to create contextual commit messages
  - Supports Conventional Commits format or simple descriptions (`sidekick.commitMessageStyle`)
  - Configurable model selection (`sidekick.commitMessageModel`, defaults to Sonnet)
  - Default guidance setting for consistent commit style (`sidekick.commitMessageGuidance`)
  - Regenerate with custom guidance (e.g., "focus on the bug fix", "make it shorter")
  - Automatically filters out binary files, lockfiles, and generated code from diff analysis
  - Intelligent diff truncation at file boundaries for large changesets
- **New Settings**:
  - `sidekick.commitMessageModel`: Model for commit messages (haiku/sonnet/opus, default: sonnet)
  - `sidekick.commitMessageStyle`: Format style (conventional/simple, default: conventional)
  - `sidekick.commitMessageGuidance`: Default guidance applied to all commit messages
  - `sidekick.showCommitButton`: Toggle visibility of the commit message button

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

- **Status Bar Menu**: Click the status bar to access all extension options
  - Enable/Disable completions
  - Configure Extension settings
  - View Logs
  - Test Connection
  - Set API Key
- **View Logs command**: Debug completion issues with the new output channel
- **Test Connection command**: Verify API connectivity before troubleshooting
- **Prose file support**: Markdown, plaintext, HTML, XML, LaTeX files now automatically use multiline mode with higher character limits
- **Model display**: Status bar now shows the current inline model (e.g., "Sidekick haiku")

### Changed

- **Debounce default**: Increased from 300ms to 1000ms for less aggressive completions
- **Improved prompts**: Better prompt engineering to reduce meta-responses and improve completion quality
- **Character limits**: Prose files allow up to 2000 chars (single-line) / 3000 chars (multiline); code files allow 500/800 chars

### Fixed

- Reduced "I'll complete this..." and other meta-commentary in completions
- Better handling of code fence removal in responses
- Improved truncation logic for long responses (truncates at logical boundaries)

## [0.2.0] - 2025-01-10

### Added

- **Code Transform feature**: Select code and press `Ctrl+Shift+M` / `Cmd+Shift+M` to transform it
- Independent model selection for inline completions and transforms
- Transform uses Opus by default for highest quality
- Context lines configuration for transforms (`sidekick.transformContextLines`)
- API key authentication mode as alternative to Max subscription

### Changed

- Rebranded from "Claude Code Max" to "Sidekick for Max"
- Inline completions use Haiku by default (fastest)
- Transforms use Opus by default (highest quality)

## [0.1.0] - 2025-01-09

### Added

- Initial release
- Inline code completions with ghost text
- Accept completions with Tab, dismiss with Escape
- Manual trigger: `Ctrl+Shift+Space` / `Cmd+Shift+Space`
- Toggle completions via status bar
- Support for Haiku, Sonnet, and Opus models
- Debounced completion requests
- Request cancellation for stale completions
- In-memory LRU cache for repeated contexts
- Claude Max subscription integration via Claude Code CLI
