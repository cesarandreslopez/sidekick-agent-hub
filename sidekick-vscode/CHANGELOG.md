# Changelog

All notable changes to the Sidekick for Max VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
