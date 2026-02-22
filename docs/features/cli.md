# Sidekick CLI

The Sidekick CLI provides a full-screen TUI dashboard for monitoring agent sessions directly from the terminal. It reads from the same `~/.config/sidekick/` data files the VS Code extension writes — no VS Code instance or server required.

## Installation

```bash
npm install -g sidekick-agent-hub
```

Or build from source:

```bash
bash scripts/build-all.sh
```

This compiles `sidekick-shared` (the data access library) and `sidekick-cli` (the binary). The CLI is output to `sidekick-cli/dist/sidekick-cli.js`.

## Usage

```bash
sidekick dashboard [--project <path>] [--provider <id>]
```

Launch the TUI dashboard for the current project. The dashboard auto-detects your project path and session provider.

## Dashboard Panels

The dashboard is an Ink-based terminal UI with multiple panels for viewing session data:

| Panel | Description |
|-------|-------------|
| **Sessions** | Browse and select from recent sessions |
| **Tasks** | View persisted tasks filtered by status |
| **Kanban** | Task board with status columns |
| **Mind Map** | Terminal-rendered session structure graph |
| **Notes** | Knowledge notes attached to files |
| **Decisions** | Architectural decisions from sessions |
| **Search** | Full-text search across session files |
| **Files** | Files touched during sessions |
| **Git Diff** | View diffs from session file changes |

## Options

| Option | Description |
|--------|-------------|
| `--project <path>` | Override project path (default: current working directory) |
| `--provider <id>` | Session provider: `claude-code`, `opencode`, `codex`, or `auto` (default) |

## Multi-Provider Support

The CLI auto-detects which session provider is most recently active by checking filesystem presence and modification times:

- **Claude Code** — `~/.claude/projects/`
- **OpenCode** — `~/.local/share/opencode/`
- **Codex** — `~/.codex/`

Override with `--provider claude-code`, `--provider opencode`, or `--provider codex`.

## VS Code Integration

The VS Code extension provides a command to launch the dashboard without leaving the editor:

- **`Sidekick: Open CLI Dashboard`** — opens the TUI dashboard in an integrated terminal panel
