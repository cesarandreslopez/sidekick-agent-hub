# Sidekick Agent Hub

<p align="center">
  <img src="images/social-preview.png" alt="Sidekick Agent Hub — AI coding assistant with real-time agent monitoring" width="100%" style="max-width: 800px; border-radius: 8px;">
</p>

**AI coding assistant with real-time agent monitoring — VS Code extension and terminal dashboard.**

![Sidekick Agent Hub demo](images/sidekick-agent-hub.gif)

[![Open VSX](https://img.shields.io/open-vsx/v/cesarandreslopez/sidekick-for-max?label=Open%20VSX)](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/cesarandreslopez/sidekick-for-max?label=Open%20VSX%20Downloads)](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/CesarAndresLopez.sidekick-for-max?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max)
[![VS Code Installs](https://img.shields.io/visual-studio-marketplace/i/CesarAndresLopez.sidekick-for-max?label=VS%20Code%20Installs)](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max)
[![npm](https://img.shields.io/npm/v/sidekick-agent-hub?label=npm)](https://www.npmjs.com/package/sidekick-agent-hub)
[![npm Downloads](https://img.shields.io/npm/dt/sidekick-agent-hub?label=npm%20Downloads)](https://www.npmjs.com/package/sidekick-agent-hub)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/cesarandreslopez/sidekick-agent-hub/blob/main/LICENSE)

## What Sidekick Does For You

**Code faster.** AI handles the mechanical work — boilerplate, commit messages, docs, PR descriptions, error explanations — so you focus on design and logic. Inline completions understand your project context, not just syntax.

![Inline Completions demo](images/inference.gif)

**Stay in control.** When AI agents run autonomously, tokens burn silently and context fills up without warning. Sidekick's real-time dashboards, mind maps, and notification triggers give you visibility into what your agent is doing, so you can catch problems before you hit limits.

![Session Analytics Dashboard](images/session-analytics-dashboard.png)

**Track project momentum.** The Project Timeline shows every session your agent has run — durations, token costs, tasks completed — so you can see progress at a glance and understand how your project is evolving across sessions.

![Project Timeline](images/project-timeline.png)

**Build a knowledge base.** Capture gotchas, patterns, guidelines, and tips attached to specific files. Knowledge notes persist across sessions and can be injected into your agent's instruction file so it stops rediscovering the same things.

![Knowledge Notes](images/knowledge-notes.gif)

**Never lose context.** Sessions end and everything is lost — decisions, progress, architectural choices. Session handoff and decision logging preserve that context automatically, so your next session picks up where you left off instead of re-discovering everything.

![CLAUDE.md Suggestions](images/claude-md-suggestions.png)

**Monitor from the terminal.** The [Sidekick CLI](features/cli.md) provides a full-screen TUI dashboard for monitoring agent sessions without leaving the terminal. Browse sessions, tasks, decisions, knowledge notes, and more — all rendered in an Ink-based terminal UI. Install with `npm install -g sidekick-agent-hub` and run `sidekick dashboard`. Works with Claude Code, OpenCode, and Codex sessions.

![Sidekick CLI Dashboard](images/sidekick-cli.gif)

## Why Am I Building This?

AI coding agents are the most transformative tools I've used in my career. They can scaffold entire features, debug problems across files, and handle the mechanical parts of software engineering that used to eat hours of every day.

But they're also opaque. Tokens burn in the background with no visibility. Context fills up silently until your agent starts forgetting things. And when a session ends, everything it learned — your architecture, your conventions, the decisions you made together — is just gone. The next session starts from zero.

That bothers me. I want to see what my agent is doing. I want to review every tool call, understand where my tokens went, and carry context forward instead of losing it. Sidekick exists because I think the people using these agents deserve visibility into how they work — not just the output, but the process.

## Supported Providers

| Provider | Inference | Session Monitoring | Cost |
|----------|-----------|-------------------|------|
| **Claude Max** | :white_check_mark: | :white_check_mark: | Included in subscription |
| **Claude API** | :white_check_mark: | :x: | Per-token billing |
| **OpenCode** | :white_check_mark: | :white_check_mark: | Depends on configured provider |
| **Codex CLI** | :white_check_mark: | :white_check_mark: | OpenAI API billing |

## Feature Highlights

### VS Code Extension

- **Inline Completions** — context-aware suggestions that understand your project, not just syntax
- **Code Transforms** — select code, describe changes in natural language
- **AI Commit Messages** — meaningful messages generated from your actual diff
- **Quick Ask** — inline chat for questions and code changes without switching context
- **Code Review** — catch bugs and security concerns before they reach your team
- **PR Descriptions** — structured summaries from branch diff, ready to paste
- **Error Analysis** — understand what went wrong, why, and how to fix it
- **Session Handoff** — pick up where you left off instead of re-discovering everything
- **CLAUDE.md Suggestions** — learn from session patterns to improve agent effectiveness
- **Context Health** — track how much information your agent has lost to context compaction
- **Truncation Detection** — know when tool outputs are silently cut short
- **Cycle Detection** — get alerted when your agent enters repetitive loops

### VS Code + [CLI Dashboard](features/cli.md)

Available in the VS Code extension and the [CLI Dashboard](features/cli.md). The CLI works standalone — no VS Code extension required.

- **Session Monitor** — see exactly where your tokens are going before you hit quota limits
- **Mind Map** — trace how your agent navigated the codebase, with cycling file and goal-gate indicators
- **Kanban Board** — track tasks and subagents at a glance, with goal-gate badges on critical tasks
- **Project Timeline** — chronological view of all sessions with duration, token usage, and expandable details
- **Knowledge Notes** — capture gotchas, patterns, guidelines, and tips attached to files, with lifecycle tracking
- **HTML Session Report** — self-contained HTML report with full transcript, token/cost stats, and tool-use breakdown

## Quick Install

### VS Code Extension

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) or [Open VSX](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max). Then see [Getting Started](getting-started/installation.md) for provider setup.

### CLI Terminal Dashboard

> **Note:** The npm package is `sidekick-agent-hub`, but the binary is called **`sidekick`**.

```bash
npm install -g sidekick-agent-hub
sidekick dashboard
```

Requires Node.js 20+. Works standalone — no VS Code required. See [CLI Dashboard](features/cli.md) for the full guide.

## See Also

**[Sidekick Docker](https://github.com/cesarandreslopez/sidekick-docker)** — a sibling project that brings the same real-time dashboard experience to Docker management. Monitor containers, Compose projects, images, volumes, and networks from a keyboard-driven TUI or VS Code panel. Available as a [VS Code extension](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-docker-vscode), [Open VSX extension](https://open-vsx.org/extension/CesarAndresLopez/sidekick-docker-vscode), and [CLI](https://www.npmjs.com/package/sidekick-docker).

## Contributing

Contributions welcome! See the [Contributing Guide](contributing.md).

## Community

If Sidekick is useful to you, a [star on GitHub](https://github.com/cesarandreslopez/sidekick-agent-hub) helps others find it.

Found a bug or have a feature idea? [Open an issue](https://github.com/cesarandreslopez/sidekick-agent-hub/issues) — all feedback is welcome.

## License

MIT
