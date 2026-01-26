# Sidekick for Max

Your Claude Max, working harder: completions, transforms, commits, code review, and more.

![Sidekick demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/all_features.gif?v=2)

**Claude Code is incredible for complex, multi-file refactoring and agentic workflows.** But sometimes you just want a quick inline completion while typing, or to transform a snippet of code without spinning up a full conversation. And you shouldn't have to pay for yet another subscription to get that.

If you're already paying for Claude Max, Sidekick lets you use those tokens for inline completions, code transforms, AI commit messages, and speed reading with AI explanations--no extra cost, no separate account.

## Why Use This Extension?

**Maximize your Claude Max subscription value.**

Most Claude Max subscribers don't use their full 5-hour usage allocation. Sidekick helps you get more from what you're already paying for:

| Without This Extension | With This Extension |
|------------------------|---------------------|
| Pay $100-200/mo for Claude Max | Same subscription |
| Pay $10-19/mo extra for Copilot | No additional cost |
| Tokens sitting unused between CLI sessions | Continuous inline assistance |

**Designed to complement Claude Code CLI, not replace it:**
- Use **Claude Code CLI** for complex, multi-file refactoring and agentic tasks
- Use **Sidekick** for fast inline completions and quick code transforms

The extension uses Haiku by default for inline completions - it's fast, responsive, and uses minimal quota so you still have capacity for your CLI workflows.

## Prerequisites

- **Claude Max subscription** (Recommended) OR **Anthropic API key**
- **Claude Code CLI** installed and authenticated (for Max subscription mode)

> **Why Max subscription is recommended:** Inline completions fire frequently as you type. With an API key, these per-token costs add up quickly. With Max ($100-200/month), you're already paying for the tokens—Sidekick just helps you use your unused capacity. No surprise bills.

## Installation

### For Claude Max Subscribers (Recommended)

1. Install and authenticate Claude Code CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth
   ```
   Follow the prompts to authenticate with your Claude Max subscription.

2. Install the VS Code extension:
   - **VS Code**: Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max)
   - **Cursor/VSCodium**: Install from [Open VSX](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max)
   - **Manual**: Download `.vsix` from [GitHub Releases](https://github.com/cesarandreslopez/sidekick-for-claude-max/releases) → Extensions → "Install from VSIX..."

3. Start typing in any file - completions should appear as ghost text

### For API Key Users

1. Install the VS Code extension (same as above)

2. Set your API key:
   - Run "Sidekick: Set API Key" from the Command Palette
   - Enter your Anthropic API key

3. Change auth mode in settings:
   - Open Settings (`Ctrl+,`)
   - Search for "sidekick.authMode"
   - Select "api-key"

## Features

### Inline Completions

Get intelligent code suggestions as you type. Completions appear as ghost text that you can accept with Tab.

![Inline completions](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/inline_transforms.gif?v=2)

- Automatic suggestions after a brief pause in typing
- Manual trigger: `Ctrl+Shift+Space` (Cmd+Shift+Space on Mac)
- Toggle on/off via status bar or Command Palette

### Transform Selected Code

Transform selected code using natural language instructions.

![Code transforms](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/code_transforms.gif?v=2)

1. Select the code you want to modify
2. Press `Ctrl+Shift+M` (Cmd+Shift+M on Mac)
3. Enter your instruction (e.g., "Add error handling", "Convert to async/await", "Add TypeScript types")
4. The selection is replaced with the modified code

### Quick Ask (Inline Chat)

Ask questions about code or request changes without leaving your editor.

1. Press `Ctrl+I` (Cmd+I on Mac) to open quick input
2. Ask a question or request a change
3. For changes: review the diff preview and Accept/Reject

**Features:**
- Context-aware - uses selected code or cursor context
- Ask questions - "What does this function do?" or "Is this thread-safe?"
- Request changes - "Add error handling" or "Convert to async/await"
- Diff preview for proposed changes
- Uses Sonnet by default

### Generate Documentation

Automatically generate JSDoc/docstrings for functions, classes, and methods.

1. Place cursor in a function or select code
2. Press `Ctrl+Shift+D` (Cmd+Shift+D on Mac)
3. Documentation is inserted above the function

**Features:**
- Supports TypeScript, JavaScript, Python, and more
- Generates parameter descriptions, return types, and examples
- Uses Haiku by default for fast generation

### Explain Code

Get AI-powered explanations for selected code.

1. Select code you want to understand
2. Press `Ctrl+Shift+E` (Cmd+Shift+E on Mac)
3. Choose complexity level from the submenu

**Features:**
- Five complexity levels: ELI5, Curious Amateur, Imposter Syndrome, Senior, PhD Mode
- Rich webview panel with markdown rendering
- Regenerate with custom instructions
- Read explanations in RSVP mode
- Uses Sonnet by default

### Error Explanations & Fixes

Understand and fix errors with AI assistance.

- Click the lightbulb on any diagnostic → "Explain Error with AI" or "Fix Error with AI"
- Or right-click → Sidekick → Explain Error / Fix Error
- Five complexity levels for explanations
- Uses Sonnet by default

### AI Commit Messages

Generate intelligent commit messages from your staged changes with a single click.

![AI commit message generation](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/commit_generation.gif?v=2)

1. Stage your changes in the Source Control panel
2. Click the sparkle button in the Source Control toolbar
3. A commit message is generated based on your diff
4. Optionally regenerate with custom guidance (e.g., "focus on the bug fix", "make it shorter")

**Features:**
- Analyzes your git diff to create contextual commit messages
- Supports Conventional Commits format (`feat(scope): description`) or simple descriptions
- Configurable default guidance for consistent commit style across your team
- Automatically filters out lockfiles, binary files, and generated code
- Uses Sonnet by default for high-quality messages

### Pre-commit AI Review

Review your changes before committing. Click the eye icon in the Source Control toolbar.

**Features:**
- Bug detection - catches potential issues before they're committed
- Security concerns - highlights potential vulnerabilities
- Code smells - identifies maintainability issues
- Inline decorations - issues shown directly in the editor
- Uses Sonnet by default for thorough analysis

### PR Description Generation

Generate pull request descriptions automatically. Click the PR icon in the Source Control toolbar.

**Features:**
- Analyzes all commits on your branch vs the base branch
- Generates summary, change list, and test plan
- Copies to clipboard - ready to paste into GitHub/GitLab
- Uses Sonnet by default for comprehensive descriptions

### RSVP Reader

Speed read selected text with AI-powered explanations. [RSVP (Rapid Serial Visual Presentation)](https://en.wikipedia.org/wiki/Rapid_serial_visual_presentation) displays words one at a time at a fixed focal point, eliminating eye movement and enabling reading speeds of 2-3x normal.

![RSVP speed reading demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/document_rsvp_speed_reading.gif?v=2)

![AI code explanation with RSVP](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/explain_code_plus_rsvp.gif?v=2)

1. Select the text you want to speed read
2. Press `Ctrl+Shift+R` (Cmd+Shift+R on Mac) or right-click → "Sidekick: RSVP Reader"
3. Choose direct read or an AI explanation complexity level
4. Use playback controls to start reading

**Features:**
- **ORP Highlighting**: Optimal Recognition Point highlighting reduces eye movement for faster comprehension
- **Adjustable Speed**: 100-900 WPM with real-time controls (up/down arrows)
- **AI Explanations**: Five complexity levels tailored to your expertise:
  - **ELI5** - Complete beginner, simple analogies, no jargon
  - **Curious Amateur** - Learning mode, technical terms defined
  - **Imposter Syndrome** - Fill knowledge gaps, assume basic familiarity
  - **Senior** - High-level summary, skip basics
  - **PhD Mode** - Expert-level analysis without simplification
- **Dual Content**: Toggle between original text and AI explanation (O key)
- **Two Reading Modes**: RSVP word-by-word or full-text scrollable view (F key)
- **Keyboard Controls**: Space (play/pause), arrows (navigate/speed), R (restart)
- **Smart Classification**: Automatically detects prose, technical content, or code for tailored explanations
- Uses Sonnet by default for intelligent explanations

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Sidekick: Show Menu | Click status bar | Open the Sidekick menu |
| Sidekick: Toggle Inline Completions | - | Enable/disable completions |
| Sidekick: Trigger Completion | Ctrl+Shift+Space | Manually request a completion |
| Sidekick: Transform Selected Code | Ctrl+Shift+M | Transform selected code with instruction |
| Quick Ask | Ctrl+I | Ask questions or request code changes |
| Generate Documentation | Ctrl+Shift+D | Generate JSDoc/docstrings |
| Explain Code | Ctrl+Shift+E | Explain selected code with AI |
| Explain Error with AI | Lightbulb menu | Explain diagnostic error |
| Fix Error with AI | Lightbulb menu | Apply AI-suggested fix |
| Sidekick: RSVP Reader | Ctrl+Shift+R | Speed read selected text |
| Sidekick: Generate Commit Message | Click sparkle in SCM | Generate commit message from staged changes |
| Sidekick: Review My Changes | Click eye in SCM | AI review of staged changes |
| Sidekick: Generate PR Description | Click PR icon in SCM | Generate pull request description |
| Sidekick: View Logs | - | Open output channel for debugging |
| Sidekick: Set API Key | - | Set your Anthropic API key |
| Sidekick: Test Connection | - | Test API connectivity |

### Status Bar Menu

Click "Sidekick" in the status bar to access:

![Status bar menu](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/logs_and_configuration.gif?v=2)

- Enable/Disable completions
- Configure Extension settings
- View Logs
- Test Connection
- Set API Key

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.authMode` | `max-subscription` | Authentication mode: `max-subscription` or `api-key` |
| `sidekick.enabled` | `true` | Enable inline completions |
| `sidekick.debounceMs` | `1000` | Delay before requesting completion (ms) |
| `sidekick.inlineContextLines` | `30` | Lines of context before/after cursor for inline |
| `sidekick.transformContextLines` | `50` | Lines of context before/after selection for transform |
| `sidekick.multiline` | `false` | Enable multi-line completions (prose files always use multiline) |
| `sidekick.inlineModel` | `haiku` | Model for inline: `haiku`, `sonnet`, or `opus` |
| `sidekick.transformModel` | `opus` | Model for transform: `opus`, `sonnet`, or `haiku` |
| `sidekick.docModel` | `haiku` | Model for documentation generation |
| `sidekick.explainModel` | `sonnet` | Model for code explanations |
| `sidekick.errorModel` | `sonnet` | Model for error explanations and fixes |
| `sidekick.inlineChatModel` | `sonnet` | Model for Quick Ask |
| `sidekick.reviewModel` | `sonnet` | Model for pre-commit review |
| `sidekick.prDescriptionModel` | `sonnet` | Model for PR description generation |
| `sidekick.commitMessageModel` | `sonnet` | Model for commit messages: `haiku`, `sonnet`, or `opus` |
| `sidekick.commitMessageStyle` | `conventional` | Commit format: `conventional` or `simple` |
| `sidekick.commitMessageGuidance` | (empty) | Default guidance for all commit messages |
| `sidekick.showCommitButton` | `true` | Show commit message button in Source Control |
| `sidekick.claudePath` | (empty) | Custom path to Claude CLI (for pnpm/yarn/non-standard installs) |
| `sidekick.rsvpMode` | `direct` | RSVP default mode: `direct` or `explain-first` |
| `sidekick.explanationComplexity` | `imposter-syndrome` | AI explanation level: `eli5`, `curious-amateur`, `imposter-syndrome`, `senior`, `phd` |
| `sidekick.explanationModel` | `sonnet` | Model for RSVP explanations: `haiku`, `sonnet`, or `opus` |
| `sidekick.showCompletionHint` | `true` | Show visual hint at cursor suggesting AI completion |
| `sidekick.completionHintDelayMs` | `1500` | Delay before showing completion hint (ms) |

> **Note:** Prose files (Markdown, plaintext, HTML, XML, LaTeX, etc.) automatically use multiline mode regardless of the setting.

## Troubleshooting

### No completions appearing
1. Click status bar → "Test Connection" to verify API connectivity
2. Click status bar → "View Logs" to check for errors
3. Verify the status bar shows "Sidekick" is enabled

### "Claude Code CLI not found" error (Max subscription mode)
- Install the CLI: `npm install -g @anthropic-ai/claude-code`
- Authenticate: `claude auth`
- Verify: `claude --version`
- **If installed via pnpm/yarn/volta:** Set `sidekick.claudePath` in settings to the full path (find it with `which claude` on Linux/Mac or `where claude` on Windows)

### API key issues (API key mode)
- Run "Sidekick: Set API Key" to update your key
- Ensure your API key has sufficient credits
- Run "Sidekick: Test Connection" to verify connectivity

### Rate limited
- Wait a moment and try again
- Consider using `haiku` model for more frequent completions
- Increase `debounceMs` to reduce request frequency

## Architecture

The extension uses the Anthropic SDK directly:
- **Max subscription mode**: Uses Claude Agent SDK to leverage your existing CLI authentication
- **API key mode**: Uses Anthropic SDK with your API key

No local server required.

## License

MIT
