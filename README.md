<p align="center">
  <img src="images/icon-256.png" alt="Sidekick for Max" width="128" height="128">
</p>

<h1 align="center">Sidekick for Max</h1>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max"><img src="https://img.shields.io/visual-studio-marketplace/v/CesarAndresLopez.sidekick-for-max?label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/cesarandreslopez/sidekick-for-claude-max/actions/workflows/ci.yml"><img src="https://github.com/cesarandreslopez/sidekick-for-claude-max/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python 3.10+">
</p>

<p align="center">
  AI-powered inline code completions and transformations for VS Code, powered by your Claude Max subscription.
</p>

<!-- TODO: Add demo GIF showing completions in action -->

**Claude Code is incredible for complex, multi-file refactoring and agentic workflows.** But sometimes you just want a quick inline completion while typing, or to transform a snippet of code without spinning up a full conversation. And you shouldn't have to pay for yet another subscription to get that.

If you're already paying for Claude Max, Sidekick lets you use those tokens for fast, Copilot-style completions—no extra cost, no separate account.

## Why Sidekick for Max?

**Get more value from your Claude Max subscription.** You're paying $100-200/month for Claude Max, but likely have unused capacity in your 5-hour usage windows. Sidekick puts those tokens to work:

- **No additional cost** - Uses your existing Claude Code CLI authentication
- **Complements Claude Code CLI** - CLI excels at agentic multi-file tasks; Sidekick handles quick inline completions and transforms
- **Replace paid alternatives** - Skip the $10-19/month GitHub Copilot subscription; use tokens you're already paying for
- **Lightweight token usage** - Haiku-powered completions are fast and consume minimal quota, leaving room for your CLI workflows

## How It Works

The extension sends your code context to a local server, which calls Claude Code CLI to generate completions. Your subscription handles the billing - no API keys or separate accounts needed.

```
VS Code Extension                    Local Server (port 3456)
     │                                      │
     │  Code context (prefix/suffix)  ────► │
     │                                      │  Claude Code CLI
     │  Completion suggestion         ◄──── │  (uses your Max subscription)
     │                                      │
```

## Components

- **[sidekick-server](./sidekick-server/)** - FastAPI server that calls Claude Code CLI
- **[sidekick-vscode](./sidekick-vscode/)** - VS Code extension for inline completions and transforms

## Quick Start

### Prerequisites

- Claude Max subscription ($100 or $200/month plan)
- Claude Code CLI installed and authenticated

### Setup

1. Install and authenticate Claude Code CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth
   ```

2. Start the server:
   ```bash
   ./start-server.sh
   ```

3. Install the [VS Code extension from the Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max)

4. Start coding - completions appear automatically as you type

## Features

### Inline Completions
Get intelligent code suggestions as you type. Uses Haiku by default for fast, lightweight completions that won't drain your quota.

### Code Transforms
Select code, press `Ctrl+Shift+M`, and describe how to transform it. Uses Opus by default for high-quality refactoring.

## Token Efficiency

| Feature | Default Model | Token Impact |
|---------|---------------|--------------|
| Inline completions | Haiku | Minimal - fast and cheap |
| Code transforms | Opus | Higher - worth it for quality |

This design lets you use inline completions freely throughout the day while preserving quota for heavier CLI workflows and transforms.

## Contributing

Contributions are welcome! Whether it's bug fixes, new features, or documentation improvements—all help is appreciated.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

MIT
