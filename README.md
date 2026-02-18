<p align="center">
  <img src="images/icon-256.png" alt="Sidekick Agent Hub" width="128" height="128">
</p>

<h1 align="center">Sidekick Agent Hub</h1>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max"><img src="https://img.shields.io/visual-studio-marketplace/v/CesarAndresLopez.sidekick-for-max?label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max"><img src="https://img.shields.io/open-vsx/v/cesarandreslopez/sidekick-for-max?label=Open%20VSX" alt="Open VSX"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/cesarandreslopez/sidekick-agent-hub/actions/workflows/ci.yml"><img src="https://github.com/cesarandreslopez/sidekick-agent-hub/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  Multi-provider AI coding assistant for VS Code — inline completions, code transforms, commit messages, and agent session monitoring.
</p>

<p align="center">
  <img src="assets/all_features.gif?v=4" alt="Sidekick Agent Hub demo" width="800">
</p>

Sidekick Agent Hub brings AI coding features and agent monitoring to VS Code using your existing subscriptions. It supports **Claude Max**, **Claude API**, **OpenCode**, and **Codex CLI** — pick whichever provider you already use.

## Provider Support

| Provider | Inference | Session Monitoring | Cost |
|----------|-----------|-------------------|------|
| **Claude Max** | Yes | Yes | Included in subscription |
| **Claude API** | Yes | — | Per-token billing |
| **OpenCode** | Yes | Yes | Depends on provider |
| **Codex CLI** | Yes | Yes | OpenAI API billing |

## Features

- **Inline Completions** — ghost text suggestions as you type
- **Code Transforms** — select code, describe changes (`Ctrl+Shift+M`)
- **AI Commit Messages** — generate from staged changes
- **Session Monitor** — real-time token usage, costs, activity timeline
- **Mind Map** — interactive session structure graph
- **Kanban Board** — task and subagent tracking
- **Quick Ask** — inline chat (`Ctrl+I`)
- **Code Review** — pre-commit AI analysis
- **PR Descriptions** — auto-generate from branch diff
- **Explain Code** — five complexity levels (`Ctrl+Shift+E`)
- **Error Analysis** — AI-powered error explanations and fixes
- **Generate Docs** — auto-generate JSDoc/docstrings (`Ctrl+Shift+D`)
- **Session Handoff** — context continuity between sessions
- **CLAUDE.md Suggestions** — optimize agent instructions from session patterns

## Quick Install

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) or [Open VSX](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max).

For manual installation, download the `.vsix` from [Releases](https://github.com/cesarandreslopez/sidekick-agent-hub/releases).

## Documentation

Full documentation is available at the [docs site](https://cesarandreslopez.github.io/sidekick-agent-hub/), including:

- [Getting Started](https://cesarandreslopez.github.io/sidekick-agent-hub/getting-started/installation/)
- [Provider Setup](https://cesarandreslopez.github.io/sidekick-agent-hub/getting-started/provider-setup/)
- [Feature Guide](https://cesarandreslopez.github.io/sidekick-agent-hub/features/inline-completions/)
- [Configuration Reference](https://cesarandreslopez.github.io/sidekick-agent-hub/configuration/settings/)
- [Architecture](https://cesarandreslopez.github.io/sidekick-agent-hub/architecture/overview/)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and guidelines.

## License

MIT
