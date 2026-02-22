# Sidekick Agent Hub CLI

Full-screen TUI dashboard for monitoring AI agent sessions from the terminal.

The CLI reads from `~/.config/sidekick/` — the same data files the [Sidekick Agent Hub VS Code extension](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) writes. Browse sessions, tasks, decisions, knowledge notes, and more in an interactive Ink-based terminal UI.

## Installation

```bash
npm install -g sidekick-agent-hub
```

## Usage

```bash
sidekick dashboard [--project <path>] [--provider <id>]
```

### Options

| Option | Description |
|--------|-------------|
| `--project <path>` | Override project path (default: current working directory) |
| `--provider <id>` | Session provider: `claude-code`, `opencode`, `codex`, or `auto` (default) |

## Dashboard Panels

| Panel | Description |
|-------|-------------|
| Sessions | Browse and select from recent sessions |
| Tasks | View persisted tasks filtered by status |
| Kanban | Task board with status columns |
| Mind Map | Terminal-rendered session structure graph |
| Notes | Knowledge notes attached to files |
| Decisions | Architectural decisions from sessions |
| Search | Full-text search across session files |
| Files | Files touched during sessions |
| Git Diff | View diffs from session file changes |

## Multi-Provider Support

Auto-detects the most recently active session provider:

- **Claude Code** — `~/.claude/projects/`
- **OpenCode** — `~/.local/share/opencode/`
- **Codex** — `~/.codex/`

## Documentation

Full documentation at [cesarandreslopez.github.io/sidekick-agent-hub](https://cesarandreslopez.github.io/sidekick-agent-hub/features/cli/).

## License

MIT
