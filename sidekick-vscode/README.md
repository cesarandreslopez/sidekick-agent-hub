# Sidekick for Max

AI-powered code completions, transforms, and commit messages using your Claude Max subscription.

![Sidekick demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/inline_transforms.gif)

**Claude Code is incredible for complex, multi-file refactoring and agentic workflows.** But sometimes you just want a quick inline completion while typing, or to transform a snippet of code without spinning up a full conversation. And you shouldn't have to pay for yet another subscription to get that.

If you're already paying for Claude Max, Sidekick lets you use those tokens for inline completions, code transforms, and AI commit messages--no extra cost, no separate account.

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

![Inline completions](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/inline_transforms.gif)

- Automatic suggestions after a brief pause in typing
- Manual trigger: `Ctrl+Shift+Space` (Cmd+Shift+Space on Mac)
- Toggle on/off via status bar or Command Palette

### Transform Selected Code

Transform selected code using natural language instructions.

![Code transforms](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/code_transforms.gif)

1. Select the code you want to modify
2. Press `Ctrl+Shift+M` (Cmd+Shift+M on Mac)
3. Enter your instruction (e.g., "Add error handling", "Convert to async/await", "Add TypeScript types")
4. The selection is replaced with the modified code

### AI Commit Messages

Generate intelligent commit messages from your staged changes with a single click.

![AI commit message generation](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/commit_generation.gif)

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

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Sidekick: Show Menu | Click status bar | Open the Sidekick menu |
| Sidekick: Toggle Inline Completions | - | Enable/disable completions |
| Sidekick: Trigger Completion | Ctrl+Shift+Space | Manually request a completion |
| Sidekick: Transform Selected Code | Ctrl+Shift+M | Transform selected code with instruction |
| Sidekick: Generate Commit Message | Click sparkle in SCM | Generate commit message from staged changes |
| Sidekick: View Logs | - | Open output channel for debugging |
| Sidekick: Set API Key | - | Set your Anthropic API key |
| Sidekick: Test Connection | - | Test API connectivity |

### Status Bar Menu

Click "Sidekick" in the status bar to access:

![Status bar menu](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/logs_and_configuration.gif)

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
| `sidekick.commitMessageModel` | `sonnet` | Model for commit messages: `haiku`, `sonnet`, or `opus` |
| `sidekick.commitMessageStyle` | `conventional` | Commit format: `conventional` or `simple` |
| `sidekick.commitMessageGuidance` | (empty) | Default guidance for all commit messages |
| `sidekick.showCommitButton` | `true` | Show commit message button in Source Control |
| `sidekick.claudePath` | (empty) | Custom path to Claude CLI (for pnpm/yarn/non-standard installs) |

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
