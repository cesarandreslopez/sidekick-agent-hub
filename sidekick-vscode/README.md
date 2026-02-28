# Sidekick Agent Hub

Multi-provider AI coding assistant for VS Code — inline completions, code transforms, commit messages, and agent session monitoring.

![Sidekick demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/sidekick-agent-hub.gif)

AI coding agents are powerful, but they run autonomously — tokens burn silently, context fills up without warning, and everything is lost when a session ends. Sidekick gives you real-time visibility into what your agent is doing, AI-powered coding features that eliminate mechanical work, and session intelligence that preserves context across sessions.

| Provider | Inference | Session Monitoring | Cost |
|----------|-----------|-------------------|------|
| **[Claude Max](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/claude-max/)** | Yes | Yes | Included in subscription |
| **[Claude API](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/claude-api/)** | Yes | — | Per-token billing |
| **[OpenCode](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/opencode/)** | Yes | Yes | Depends on provider |
| **[Codex CLI](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/codex/)** | Yes | Yes | OpenAI API billing |

## Quick Start

### [Claude Max](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/claude-max/) (Recommended)

1. Install and authenticate Claude Code CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth
   ```
2. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) or [Open VSX](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max)
3. Start typing — completions appear as ghost text

### [Claude API](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/claude-api/)

1. Install the extension
2. Run **"Sidekick: Set API Key"** from the Command Palette
3. Set `sidekick.inferenceProvider` to `claude-api`

### [OpenCode](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/opencode/)

1. Ensure OpenCode is running (`opencode` in a terminal)
2. Set `sidekick.inferenceProvider` to `opencode`

### [Codex CLI](https://cesarandreslopez.github.io/sidekick-agent-hub/providers/codex/)

1. Install Codex CLI: `npm install -g @openai/codex`
2. Set `OPENAI_API_KEY` or `CODEX_API_KEY`
3. Set `sidekick.inferenceProvider` to `codex`

## Features

### AI Coding

Let AI handle the mechanical work — boilerplate, commit messages, docs, PR descriptions — so you focus on design and logic.

- **[Inline Completions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/inline-completions/)** — context-aware suggestions that understand your project, not just syntax (`Ctrl+Shift+Space` to trigger manually)
- **[Code Transforms](https://cesarandreslopez.github.io/sidekick-agent-hub/features/code-transforms/)** — select code, describe changes in natural language (`Ctrl+Shift+M`)
- **[Generate Documentation](https://cesarandreslopez.github.io/sidekick-agent-hub/features/generate-docs/)** — auto-generate JSDoc/docstrings from implementation, not just signatures (`Ctrl+Shift+D`)
- **[Explain Code](https://cesarandreslopez.github.io/sidekick-agent-hub/features/explain-code/)** — five complexity levels from ELI5 to PhD Mode (`Ctrl+Shift+E`)
- **[Quick Ask](https://cesarandreslopez.github.io/sidekick-agent-hub/features/inline-chat/)** — inline chat for questions and code changes (`Ctrl+I`)
- **[AI Commit Messages](https://cesarandreslopez.github.io/sidekick-agent-hub/features/commit-messages/)** — generate meaningful messages from staged changes (sparkle icon in SCM toolbar)
- **[Pre-commit Review](https://cesarandreslopez.github.io/sidekick-agent-hub/features/code-review/)** — catch bugs, security concerns, and code smells before they reach your team (eye icon in SCM toolbar)
- **[PR Descriptions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/pr-descriptions/)** — auto-generate structured summaries from branch diff (PR icon in SCM toolbar)
- **[Error Analysis](https://cesarandreslopez.github.io/sidekick-agent-hub/features/error-analysis/)** — AI-powered error explanations and one-click fixes

### Agent Monitoring

When your AI agent runs autonomously, you need to know what it's doing. Real-time dashboards, visualizations, and alerts keep you in control.

- **[Session Analytics Dashboard](https://cesarandreslopez.github.io/sidekick-agent-hub/features/session-monitor/)** — real-time token usage, costs, context attribution, activity timeline

![Session Monitor](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/session-analytics-dashboard.png)

- **[Mind Map](https://cesarandreslopez.github.io/sidekick-agent-hub/features/mind-map/)** — interactive D3.js graph of session structure and file relationships

![Mind map](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/mind-map.png)

- **[Kanban Board](https://cesarandreslopez.github.io/sidekick-agent-hub/features/kanban-board/)** — task and subagent tracking with real-time updates

![Kanban board](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/kanban-board.png)

- **[Project Timeline](https://cesarandreslopez.github.io/sidekick-agent-hub/features/project-timeline/)** — chronological view of all sessions with duration, token usage, and expandable details

![Project Timeline](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/project-timeline.png)

- **[HTML Session Report](#html-session-report)** — self-contained HTML report with full transcript, token/cost stats, model breakdown, and tool-use summary — opens in a webview panel or browser

![HTML Session Report](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/session_html_report.png)

- **Conversation Viewer** — full session conversation with search
- **[Tool Inspector](https://cesarandreslopez.github.io/sidekick-agent-hub/features/tool-inspector/)** — per-tool rendering (diffs for Edit, commands for Bash, etc.)
- **Cross-Session Search** — search across all sessions
- **Notification Triggers** — alerts for credential access, destructive commands, compaction, token thresholds

### Session Intelligence

- **[Knowledge Notes](https://cesarandreslopez.github.io/sidekick-agent-hub/features/knowledge-notes/)** — capture gotchas, patterns, guidelines, and tips attached to files, with lifecycle tracking and instruction file injection

![Knowledge Notes](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/knowledge-notes.gif)

- **[Session Handoff](https://cesarandreslopez.github.io/sidekick-agent-hub/features/session-handoff/)** — automatic context documents for session continuity
- **[Decision Log](https://cesarandreslopez.github.io/sidekick-agent-hub/features/decision-log/)** — tracks architectural decisions from sessions
- **[CLAUDE.md Suggestions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/claude-md-suggestions/)** — AI-powered session analysis for optimizing agent instructions

![CLAUDE.md suggestions](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/claude-md-suggestions.png)

- **[Event Logging](https://cesarandreslopez.github.io/sidekick-agent-hub/configuration/event-logging/)** — optional JSONL audit trail for debugging

## Terminal Dashboard

All monitoring and intelligence features are also available as a standalone terminal dashboard — no VS Code required.

> **Note:** The npm package is `sidekick-agent-hub`, but the binary is called **`sidekick`**.

```bash
npm install -g sidekick-agent-hub    # requires Node.js 20+
sidekick dashboard
```

![Sidekick CLI Dashboard](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/sidekick-cli.gif)

Browse sessions, tasks, decisions, knowledge notes, mind maps, and more in a full-screen TUI. Press `?` for keybindings. Standalone commands (`sidekick tasks`, `sidekick decisions`, `sidekick notes`, `sidekick stats`, `sidekick handoff`, `sidekick search`, `sidekick context`) jump directly to a specific panel or run one-shot queries. See the [CLI Dashboard docs](https://cesarandreslopez.github.io/sidekick-agent-hub/features/cli/) for the full guide.

## [Key Settings](https://cesarandreslopez.github.io/sidekick-agent-hub/configuration/settings/)

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.inferenceProvider` | `auto` | Provider: `auto`, `claude-max`, `claude-api`, `opencode`, `codex` |
| `sidekick.sessionProvider` | `auto` | Session monitor: `auto`, `claude-code`, `opencode`, `codex` |
| `sidekick.inlineModel` | `auto` | Model for completions (fast tier) |
| `sidekick.transformModel` | `auto` | Model for transforms (powerful tier) |
| `sidekick.debounceMs` | `1000` | Completion delay (ms) |
| `sidekick.commitMessageStyle` | `conventional` | Commit format: `conventional` or `simple` |
| `sidekick.enableSessionMonitoring` | `true` | Enable agent session monitoring |
| `sidekick.autoHandoff` | `off` | Session handoff: `off`, `generate-only`, `generate-and-notify` |

Model settings accept `auto` (recommended), a tier (`fast`/`balanced`/`powerful`), a legacy name (`haiku`/`sonnet`/`opus`), or a full model ID. See [Model Resolution](https://cesarandreslopez.github.io/sidekick-agent-hub/configuration/model-resolution/) for details.

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Toggle Completions | — | Enable/disable inline completions |
| Trigger Completion | `Ctrl+Shift+Space` | Manually request completion |
| Transform Code | `Ctrl+Shift+M` | Transform selected code |
| Quick Ask | `Ctrl+I` | Inline chat |
| Generate Docs | `Ctrl+Shift+D` | Generate documentation |
| Explain Code | `Ctrl+Shift+E` | Explain selected code |
| Generate Commit Message | SCM sparkle icon | AI commit message |
| Review Changes | SCM eye icon | Pre-commit review |
| Generate PR Description | SCM PR icon | Auto-generate PR description |
| Switch Provider | — | Change inference provider |
| Open Dashboard | — | Open session analytics |
| Dump Session Report | — | Export session data as text/markdown/JSON/HTML |
| Generate HTML Report | — | Full transcript report in a webview panel |
| Set Session Provider | — | Switch session monitoring provider |
| Browse Session Folders | — | Select session folder to monitor |

## Troubleshooting

**No completions?** Click "Sidekick" in the status bar → "Test Connection" to verify provider connectivity.

**CLI not found?** Set `sidekick.claudePath` to the full path (find with `which claude`).

**OpenCode issues?** Ensure OpenCode is running and listening on port 4096.

**Codex issues?** Verify `OPENAI_API_KEY` or `CODEX_API_KEY` is set.

## Full Documentation

For detailed guides, configuration reference, and architecture docs, visit the [documentation site](https://cesarandreslopez.github.io/sidekick-agent-hub/).

## See Also

**[Sidekick Docker](https://github.com/cesarandreslopez/sidekick-docker)** — real-time Docker management dashboard as a [VS Code extension](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-docker-vscode) and [CLI](https://www.npmjs.com/package/sidekick-docker). Monitor containers, Compose projects, images, volumes, and networks with vi keybindings and live-streaming stats.

## Community

If Sidekick is useful to you, a [star on GitHub](https://github.com/cesarandreslopez/sidekick-agent-hub) helps others find it.

Found a bug or have a feature idea? [Open an issue](https://github.com/cesarandreslopez/sidekick-agent-hub/issues) — all feedback is welcome.

## License

MIT
