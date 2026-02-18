# Sidekick Agent Hub

Multi-provider AI coding assistant for VS Code — inline completions, code transforms, commit messages, and agent session monitoring.

![Sidekick demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/all_features.gif?v=4)

Sidekick Agent Hub brings AI coding features and real-time agent monitoring to VS Code. It supports multiple providers — use whichever AI coding agent you already have.

| Provider | Inference | Session Monitoring | Cost |
|----------|-----------|-------------------|------|
| **Claude Max** | Yes | Yes | Included in subscription |
| **Claude API** | Yes | — | Per-token billing |
| **OpenCode** | Yes | Yes | Depends on provider |
| **Codex CLI** | Yes | Yes | OpenAI API billing |

## Quick Start

### Claude Max (Recommended)

1. Install and authenticate Claude Code CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth
   ```
2. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) or [Open VSX](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max)
3. Start typing — completions appear as ghost text

### Claude API

1. Install the extension
2. Run **"Sidekick: Set API Key"** from the Command Palette
3. Set `sidekick.inferenceProvider` to `claude-api`

### OpenCode

1. Ensure OpenCode is running (`opencode` in a terminal)
2. Set `sidekick.inferenceProvider` to `opencode`

### Codex CLI

1. Install Codex CLI: `npm install -g @openai/codex`
2. Set `OPENAI_API_KEY` or `CODEX_API_KEY`
3. Set `sidekick.inferenceProvider` to `codex`

## Features

### AI Coding

- **Inline Completions** — ghost text suggestions as you type (`Ctrl+Shift+Space` to trigger manually)
- **Code Transforms** — select code, describe changes in natural language (`Ctrl+Shift+M`)
- **Generate Documentation** — auto-generate JSDoc/docstrings (`Ctrl+Shift+D`)
- **Explain Code** — five complexity levels from ELI5 to PhD Mode (`Ctrl+Shift+E`)
- **Quick Ask** — inline chat for questions and code changes (`Ctrl+I`)
- **AI Commit Messages** — generate from staged changes (sparkle icon in SCM toolbar)
- **Pre-commit Review** — AI code review with inline annotations (eye icon in SCM toolbar)
- **PR Descriptions** — auto-generate from branch diff (PR icon in SCM toolbar)
- **Error Analysis** — AI-powered error explanations and one-click fixes

### Agent Monitoring

- **Session Analytics Dashboard** — real-time token usage, costs, context attribution, activity timeline

![Session Monitor](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/cost_session_context_quotas_claude_code.gif)

- **Mind Map** — interactive D3.js graph of session structure and file relationships

![Mind map](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/node_visualization_graph.gif)

- **Kanban Board** — task and subagent tracking with real-time updates

![Kanban board](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/kanban_style_monitoring.gif)

- **Conversation Viewer** — full session conversation with search
- **Tool Inspector** — per-tool rendering (diffs for Edit, commands for Bash, etc.)
- **Cross-Session Search** — search across all sessions
- **Notification Triggers** — alerts for credential access, destructive commands, compaction, token thresholds

### Session Intelligence

- **Session Handoff** — automatic context documents for session continuity
- **Decision Log** — tracks architectural decisions from sessions
- **CLAUDE.md Suggestions** — AI-powered session analysis for optimizing agent instructions

![CLAUDE.md suggestions](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/suggest_improvements_to_agent_claude_md.gif)

- **Event Logging** — optional JSONL audit trail for debugging

## Key Settings

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

Model settings accept `auto` (recommended), a tier (`fast`/`balanced`/`powerful`), a legacy name (`haiku`/`sonnet`/`opus`), or a full model ID.

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

## License

MIT
