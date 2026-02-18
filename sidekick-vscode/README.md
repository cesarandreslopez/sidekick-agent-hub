# Sidekick Agent Hub

Multi-provider AI coding assistant for VS Code — inline completions, code transforms, commit messages, and agent session monitoring.

![Sidekick demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/all_features.gif?v=4)

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

![Session Monitor](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/cost_session_context_quotas_claude_code.gif)

- **[Mind Map](https://cesarandreslopez.github.io/sidekick-agent-hub/features/mind-map/)** — interactive D3.js graph of session structure and file relationships

![Mind map](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/node_visualization_graph.gif)

- **[Kanban Board](https://cesarandreslopez.github.io/sidekick-agent-hub/features/kanban-board/)** — task and subagent tracking with real-time updates

![Kanban board](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/kanban_style_monitoring.gif)

- **Conversation Viewer** — full session conversation with search
- **[Tool Inspector](https://cesarandreslopez.github.io/sidekick-agent-hub/features/tool-inspector/)** — per-tool rendering (diffs for Edit, commands for Bash, etc.)
- **Cross-Session Search** — search across all sessions
- **Notification Triggers** — alerts for credential access, destructive commands, compaction, token thresholds

### Session Intelligence

Sessions end and context is lost — the next one starts from zero. Session intelligence captures what happened so you can pick up where you left off.

- **[Session Handoff](https://cesarandreslopez.github.io/sidekick-agent-hub/features/session-handoff/)** — automatic context documents for session continuity
- **[Decision Log](https://cesarandreslopez.github.io/sidekick-agent-hub/features/decision-log/)** — tracks architectural decisions from sessions
- **[CLAUDE.md Suggestions](https://cesarandreslopez.github.io/sidekick-agent-hub/features/claude-md-suggestions/)** — AI-powered session analysis for optimizing agent instructions

![CLAUDE.md suggestions](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/suggest_improvements_to_agent_claude_md.gif)

- **[Event Logging](https://cesarandreslopez.github.io/sidekick-agent-hub/configuration/event-logging/)** — optional JSONL audit trail for debugging

## Why Sidekick?

**Works with what you already have.** If you're on Claude Max, you're already paying for the AI — Sidekick uses that subscription for inline completions, code transforms, and more. No extra API costs, no separate accounts. It also supports Claude API, OpenCode, and Codex CLI, so you're never locked into one provider.

**See what your agent is doing.** When Claude Code or Codex runs autonomously, tokens burn silently and context fills up without warning. Sidekick's dashboards show real-time token usage, cost breakdowns, and quota projections — so you catch problems before you hit limits.

**Never lose session context.** Long sessions produce valuable context — decisions, progress, architectural choices — that vanishes when the session ends. Session handoff and decision logging preserve that context, so your next session picks up where you left off instead of re-discovering everything.

**Understand how your agent works.** Mind maps, tool inspectors, and conversation viewers let you trace exactly what happened during a session. Useful for debugging sessions that went off track, or learning from ones that went well.

## Why Am I Building This?

AI coding agents are the most transformative tools I've used in my career. They can scaffold entire features, debug problems across files, and handle the mechanical parts of software engineering that used to eat hours of every day.

But they're also opaque. Tokens burn in the background with no visibility. Context fills up silently until your agent starts forgetting things. And when a session ends, everything it learned — your architecture, your conventions, the decisions you made together — is just gone. The next session starts from zero.

That bothers me. I want to see what my agent is doing. I want to review every tool call, understand where my tokens went, and carry context forward instead of losing it. Sidekick exists because I think the people using these agents deserve visibility into how they work — not just the output, but the process.

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
| Browse Session Folders | — | Select session folder to monitor |

## Troubleshooting

**No completions?** Click "Sidekick" in the status bar → "Test Connection" to verify provider connectivity.

**CLI not found?** Set `sidekick.claudePath` to the full path (find with `which claude`).

**OpenCode issues?** Ensure OpenCode is running and listening on port 4096.

**Codex issues?** Verify `OPENAI_API_KEY` or `CODEX_API_KEY` is set.

## Full Documentation

For detailed guides, configuration reference, and architecture docs, visit the [documentation site](https://cesarandreslopez.github.io/sidekick-agent-hub/).

## Community

If Sidekick is useful to you, a [star on GitHub](https://github.com/cesarandreslopez/sidekick-agent-hub) helps others find it.

Found a bug or have a feature idea? [Open an issue](https://github.com/cesarandreslopez/sidekick-agent-hub/issues) — all feedback is welcome.

## License

MIT
