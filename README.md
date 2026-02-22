<p align="center">
  <img src="images/icon-128.png" alt="Sidekick Agent Hub" width="128" height="128">
</p>

<h1 align="center">Sidekick Agent Hub</h1>

<p align="center">
  <a href="https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max"><img src="https://img.shields.io/open-vsx/v/cesarandreslopez/sidekick-for-max?label=Open%20VSX" alt="Open VSX"></a>
  <a href="https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max"><img src="https://img.shields.io/open-vsx/dt/cesarandreslopez/sidekick-for-max?label=Open%20VSX%20Downloads" alt="Open VSX Downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max"><img src="https://img.shields.io/visual-studio-marketplace/v/CesarAndresLopez.sidekick-for-max?label=VS%20Code%20Marketplace" alt="VS Code Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max"><img src="https://img.shields.io/visual-studio-marketplace/i/CesarAndresLopez.sidekick-for-max?label=VS%20Code%20Installs" alt="VS Code Installs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/cesarandreslopez/sidekick-agent-hub/actions/workflows/ci.yml"><img src="https://github.com/cesarandreslopez/sidekick-agent-hub/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center">
  AI coding assistant with real-time agent monitoring for VS Code.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/sidekick-agent-hub.gif" alt="Sidekick Agent Hub demo" width="800">
</p>

AI coding agents are powerful but opaque — tokens burn silently, context fills up without warning, and everything is lost when a session ends. Sidekick gives you visibility into what your agent is doing, AI features that eliminate mechanical coding work, and session intelligence that preserves context across sessions. Works with your existing **Claude Max** subscription, **Claude API**, **OpenCode**, or **Codex CLI**.

## Provider Support

| Provider | Inference | Session Monitoring | Cost |
|----------|-----------|-------------------|------|
| **[Claude Max](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/claude-max/)** | Yes | Yes | Included in subscription |
| **[Claude API](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/claude-api/)** | Yes | — | Per-token billing |
| **[OpenCode](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/opencode/)** | Yes | Yes | Depends on provider |
| **[Codex CLI](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/codex/)** | Yes | Yes | OpenAI API billing |

## Why Am I Building This?

AI coding agents are the most transformative tools I've used in my career. They can scaffold entire features, debug problems across files, and handle the mechanical parts of software engineering that used to eat hours of every day.

But they're also opaque. Tokens burn in the background with no visibility. Context fills up silently until your agent starts forgetting things. And when a session ends, everything it learned — your architecture, your conventions, the decisions you made together — is just gone. The next session starts from zero.

That bothers me. I want to see what my agent is doing. I want to review every tool call, understand where my tokens went, and carry context forward instead of losing it. Sidekick exists because I think the people using these agents deserve visibility into how they work — not just the output, but the process.

## Context Management Matters

Claude Code, OpenCode, and Codex all share the same fundamental limitation: they forget everything between sessions. Your agent's context window is finite — when it fills up, older content gets compacted and detail is lost. When the session ends, it's all gone. Without deliberate context management, every session starts from scratch: re-reading files, re-learning conventions, re-making decisions. Sidekick's session intelligence features — [handoff documents](https://cesarandreslopez.github.io/sidekick-agent-hub/features/session-handoff/), [decision logs](https://cesarandreslopez.github.io/sidekick-agent-hub/features/decision-log/), and [instruction file suggestions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/claude-md-suggestions/) — bridge that gap so your agent builds on previous work instead of rediscovering it. Learn more in the [Context Management guide](https://cesarandreslopez.github.io/sidekick-agent-hub/getting-started/context-management/).

## Features

### VS Code Extension

- **[Inline Completions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/inline-completions/)** — context-aware code suggestions that understand your project

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/inference.gif" alt="Inline Completions demo" width="800">
- **[Code Transforms](https://cesarandreslopez.github.io/sidekick-agent-hub/features/code-transforms/)** — select code, describe changes in natural language (`Ctrl+Shift+M`)
- **[AI Commit Messages](https://cesarandreslopez.github.io/sidekick-agent-hub/features/commit-messages/)** — meaningful messages generated from your actual diff
- **[Quick Ask](https://cesarandreslopez.github.io/sidekick-agent-hub/features/inline-chat/)** — inline chat for questions and code changes without switching context (`Ctrl+I`)
- **[Code Review](https://cesarandreslopez.github.io/sidekick-agent-hub/features/code-review/)** — catch bugs and security concerns before they reach your team
- **[PR Descriptions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/pr-descriptions/)** — structured summaries from branch diff, ready to paste
- **[Explain Code](https://cesarandreslopez.github.io/sidekick-agent-hub/features/explain-code/)** — AI explanations calibrated to your experience level (`Ctrl+Shift+E`)
- **[Error Analysis](https://cesarandreslopez.github.io/sidekick-agent-hub/features/error-analysis/)** — understand what went wrong, why, and how to fix it
- **[Generate Docs](https://cesarandreslopez.github.io/sidekick-agent-hub/features/generate-docs/)** — JSDoc/docstrings based on implementation, not just signatures (`Ctrl+Shift+D`)
- **[Session Handoff](https://cesarandreslopez.github.io/sidekick-agent-hub/features/session-handoff/)** — pick up where you left off instead of re-discovering everything
- **[CLAUDE.md Suggestions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/claude-md-suggestions/)** — learn from session patterns to improve agent effectiveness

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/claude-md-suggestions.png" alt="CLAUDE.md Suggestions" width="480">

### VS Code + CLI

These features are available in the VS Code extension and the [Sidekick CLI](https://cesarandreslopez.github.io/sidekick-agent-hub/features/cli/) terminal dashboard. The CLI works standalone — no VS Code extension required. Install with `npm install -g sidekick-agent-hub`.

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/sidekick-cli.gif" alt="Sidekick CLI Dashboard demo" width="800">

- **[Session Monitor](https://cesarandreslopez.github.io/sidekick-agent-hub/features/session-monitor/)** — see exactly where your tokens are going before you hit quota limits

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/session-analytics-dashboard.png" alt="Session Analytics Dashboard" width="480">

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/session-activity-timeline.png" alt="Session Activity Timeline" width="480">

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/performance-and-cost.png" alt="Performance & Cost" width="480">

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/tasks-and-recovery.png" alt="Tasks & Recovery" width="480">
- **[Mind Map](https://cesarandreslopez.github.io/sidekick-agent-hub/features/mind-map/)** — trace how your agent navigated the codebase during a session

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/mind-map.png" alt="Mind Map" width="480">
- **[Kanban Board](https://cesarandreslopez.github.io/sidekick-agent-hub/features/kanban-board/)** — track tasks and subagents at a glance during complex operations

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/kanban-board.png" alt="Kanban Board" width="480">
- **[Project Timeline](https://cesarandreslopez.github.io/sidekick-agent-hub/features/project-timeline/)** — chronological view of all sessions with duration, token usage, and expandable details

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/project-timeline.png" alt="Project Timeline" width="480">
- **[Knowledge Notes](https://cesarandreslopez.github.io/sidekick-agent-hub/features/knowledge-notes/)** — capture gotchas, patterns, guidelines, and tips attached to files, with lifecycle tracking and instruction file injection

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/knowledge-notes.gif" alt="Knowledge Notes" width="480">
- **[Decision Log](https://cesarandreslopez.github.io/sidekick-agent-hub/features/decision-log/)** — tracks architectural decisions and recovery patterns across sessions

  <img src="https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/decision-log.png" alt="Decision Log" width="480">

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

## Community

If Sidekick is useful to you, a [star on GitHub](https://github.com/cesarandreslopez/sidekick-agent-hub) helps others find it.

Found a bug or have a feature idea? [Open an issue](https://github.com/cesarandreslopez/sidekick-agent-hub/issues) — all feedback is welcome.

## License

MIT
