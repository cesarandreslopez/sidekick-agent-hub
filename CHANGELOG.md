# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


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
- Fixed "Claude Code CLI not found" error for users who installed Claude CLI via pnpm, yarn, or other package managers ([#3](https://github.com/cesarandreslopez/sidekick-for-claude-max/issues/3))
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
