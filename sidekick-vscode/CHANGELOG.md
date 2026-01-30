# Changelog

All notable changes to the Sidekick for Max VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.5] - 2026-01-30

### Fixed
- **Subdirectory session discovery**: Session monitoring now finds Claude Code sessions started from subdirectories of the workspace ([#7](https://github.com/cesarandreslopez/sidekick-for-claude-max/issues/7))
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
- **Session path encoding on Windows/Mac**: Fixed issue where session monitoring couldn't find Claude Code sessions on some systems ([#6](https://github.com/cesarandreslopez/sidekick-for-claude-max/issues/6))
  - Improved path encoding to handle colons, slashes, and underscores correctly
  - Added 3-strategy discovery fallback when computed path doesn't match
  - Added session directory to diagnostics command for debugging

## [0.7.1] - 2026-01-29

### Fixed
- **Silent timeout on inline completions**: Completions that timed out would silently fail with no user feedback ([#5](https://github.com/cesarandreslopez/sidekick-for-claude-max/issues/5))
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
- **Claude CLI path resolution**: Fixed "Claude Code native binary not found" error when Claude is in PATH but not in common installation directories ([#4](https://github.com/cesarandreslopez/sidekick-for-claude-max/issues/4))
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
