# Sidekick for Max

AI code completions and transformations powered by your Claude Max subscription.

**[Source Code & Server Installation](https://github.com/cesarandreslopez/sidekick-for-claude-max)** - This extension requires a local server. See the GitHub repo for full setup instructions.

**Claude Code is incredible for complex, multi-file refactoring and agentic workflows.** But sometimes you just want a quick inline completion while typing, or to transform a snippet of code without spinning up a full conversation. And you shouldn't have to pay for yet another subscription to get that.

If you're already paying for Claude Max, Sidekick lets you use those tokens for fast, Copilot-style completions—no extra cost, no separate account.

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

- **Claude Max subscription** ($100 or $200/month plan)
- **Claude Code CLI** installed and authenticated
- **Python 3.10+** (for the server)
- **Node.js 18+** (for building the extension)

## Installation

### Step 1: Install and Authenticate Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
claude auth
```

Follow the prompts to authenticate with your Claude Max subscription.

### Step 2: Install and Start the Server

Clone the repository and start the server:

```bash
git clone https://github.com/cesarandreslopez/sidekick-for-claude-max.git
cd sidekick-for-claude-max

# Start the server (creates venv and installs dependencies automatically)
./start-server.sh
```

The server runs on `http://localhost:3456` by default. Keep it running while using the extension.

**Server options:**
```bash
./start-server.sh              # Default (port 3456)
./start-server.sh --port 8080  # Custom port
./start-server.sh --dev        # Development mode with hot reload
```

### Step 3: Install the VS Code Extension

**Option A: Install from .vsix file (recommended)**

1. Download the latest `.vsix` file from the releases page
2. In VS Code, open the Command Palette (`Ctrl+Shift+P`)
3. Run "Extensions: Install from VSIX..."
4. Select the downloaded `.vsix` file

**Option B: Build from source**

```bash
cd sidekick-vscode
npm install
npm run compile
npx @vscode/vsce package --out dist/
code --install-extension dist/sidekick-for-max-*.vsix
```

### Step 4: Verify Installation

1. Check that the server is running (`./start-server.sh`)
2. Open VS Code - you should see "Sidekick" in the status bar (bottom right)
3. Start typing in any file - completions should appear as ghost text

## Features

### Inline Completions

Get intelligent code suggestions as you type. Completions appear as ghost text that you can accept with Tab.

- Automatic suggestions after a brief pause in typing
- Manual trigger: `Ctrl+Shift+Space` (Cmd+Shift+Space on Mac)
- Toggle on/off via status bar or Command Palette

### Transform Selected Code

Transform selected code using natural language instructions.

1. Select the code you want to modify
2. Press `Ctrl+Shift+M` (Cmd+Shift+M on Mac)
3. Enter your instruction (e.g., "Add error handling", "Convert to async/await", "Add TypeScript types")
4. The selection is replaced with the modified code

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Sidekick: Toggle Inline Completions | Click status bar | Enable/disable completions |
| Sidekick: Trigger Completion | Ctrl+Shift+Space | Manually request a completion |
| Sidekick: Transform Selected Code | Ctrl+Shift+M | Transform selected code with instruction |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.serverUrl` | `http://localhost:3456` | Server URL |
| `sidekick.enabled` | `true` | Enable inline completions |
| `sidekick.debounceMs` | `300` | Delay before requesting completion |
| `sidekick.inlineContextLines` | `30` | Lines of context before/after cursor for inline |
| `sidekick.transformContextLines` | `50` | Lines of context before/after selection for transform |
| `sidekick.multiline` | `false` | Enable multi-line completions |
| `sidekick.inlineModel` | `haiku` | Model for inline: `haiku` or `sonnet` |
| `sidekick.transformModel` | `opus` | Model for transform: `opus`, `sonnet`, or `haiku` |

## Troubleshooting

### No completions appearing
- Check that the server is running (`./start-server.sh`)
- Verify the status bar shows "Sidekick" (click to toggle if disabled)
- Check VS Code Output panel (View > Output > select "Sidekick")

### Server won't start
- Ensure Python 3.10+ is installed: `python3 --version`
- Check if port 3456 is in use: `lsof -i :3456`
- Try a different port: `./start-server.sh --port 3457`

### "Claude Code CLI not found" error
- Install the CLI: `npm install -g @anthropic-ai/claude-code`
- Authenticate: `claude auth`
- Verify: `claude --version`

### Rate limited
- Wait a moment and try again
- Consider using `haiku` model for more frequent completions

### Server connection failed
- Verify the server URL in settings matches your server
- Check firewall settings if using a non-localhost URL

## Architecture

```
VS Code Extension                    Local Server (port 3456)
     │                                      │
     │  POST /inline or /transform    ────► │
     │  {prefix, suffix, language, ...}     │
     │                                      │  Claude Code CLI
     │  {completion: "..."}           ◄──── │  (uses your Max subscription)
     │                                      │
```

## License

MIT
