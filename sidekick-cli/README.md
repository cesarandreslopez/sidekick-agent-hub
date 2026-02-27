# Sidekick CLI

Full-screen terminal dashboard for monitoring AI agent sessions — standalone, no VS Code required.

![Sidekick CLI Dashboard](https://raw.githubusercontent.com/cesarandreslopez/sidekick-agent-hub/main/assets/sidekick-cli.gif)

Sidekick CLI reads from `~/.config/sidekick/` — the same data files the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) writes. Browse sessions, tasks, decisions, knowledge notes, mind maps, and more in an interactive terminal UI.

## Installation

> **Note:** The npm package is `sidekick-agent-hub`, but the binary it installs is called `sidekick`.

```bash
npm install -g sidekick-agent-hub
```

Requires **Node.js 20+**.

## Quick Start

1. `cd` into your project directory
2. Run `sidekick dashboard`
3. The dashboard auto-detects your project and session provider
4. Press `?` to see all keybindings

## Usage

```bash
sidekick dashboard [options]
```

| Flag | Description |
|------|-------------|
| `--project <path>` | Override project path (default: current working directory) |
| `--provider <id>` | Session provider: `claude-code`, `opencode`, `codex`, or `auto` (default) |
| `--session <id>` | Follow a specific session by ID |
| `--replay` | Replay existing events from the beginning before streaming live |

## Session Dump

```bash
sidekick dump [options]
```

Export session data as text, markdown, or JSON.

| Flag | Description |
|------|-------------|
| `--format <fmt>` | Output format: `text` (default), `json`, or `markdown` |
| `--width <cols>` | Terminal width for text output (default: auto-detect) |
| `--expand` | Show all events including noise |
| `--session <id>` | Target a specific session (default: most recent) |

Global flags `--project` and `--provider` also apply.

## HTML Report

```bash
sidekick report [options]
```

Generate a self-contained HTML session report and open it in the default browser. Includes full transcript, token/cost stats, model breakdown, and tool-use summary.

| Flag | Description |
|------|-------------|
| `--session <id>` | Target a specific session (default: most recent) |
| `--output <path>` | Write to a specific file (default: temp file) |
| `--theme <theme>` | Color theme: `dark` (default) or `light` |
| `--no-open` | Write the file without opening the browser |
| `--no-thinking` | Omit thinking blocks from the transcript |

Global flags `--project` and `--provider` also apply.

You can also press `r` in the TUI dashboard to generate a report for the current session.

## Dashboard Panels

The dashboard is a two-pane terminal UI. The left side shows a navigable list, the right side shows details for the selected item.

| # | Panel | Description |
|---|-------|-------------|
| 1 | **Sessions** | Browse recent sessions with detail tabs: Summary, Timeline, Mind Map, Tools, Files, Agents, AI Summary |
| 2 | **Tasks** | View persisted tasks filtered by status |
| 3 | **Kanban** | Task board with status columns |
| 4 | **Notes** | Knowledge notes attached to files |
| 5 | **Decisions** | Architectural decisions from sessions |
| 6 | **Plans** | Discovered agent plans from `~/.claude/plans/` |

## Layout Modes

Press `z` to cycle through layout modes:

| Mode | Description |
|------|-------------|
| **Normal** | Default two-pane split |
| **Expanded** | Side list hidden, detail pane fills the screen |
| **Wide Side** | Wider side list for longer item labels |

## Keybindings

### Navigation

| Key | Action |
|-----|--------|
| `1`–`6` | Switch panel |
| `Tab` | Toggle focus between side list and detail pane |
| `j` / `↓` | Next item (side) or scroll down (detail) |
| `k` / `↑` | Previous item (side) or scroll up (detail) |
| `g` | Jump to first item / scroll to top |
| `G` | Jump to last item / scroll to bottom |
| `h` / `←` | Return focus to side list (from detail) |
| `Enter` | Move focus to detail pane (from side list) |

### Detail Tabs

| Key | Action |
|-----|--------|
| `[` | Previous detail tab |
| `]` | Next detail tab |

### Session Management

| Key | Action |
|-----|--------|
| `p` | Pin session (prevent auto-switching to newest) |
| `s` | Switch to pending session |
| `f` | Toggle session filter |

### Session Panel — Mind Map Tab

| Key | Action |
|-----|--------|
| `v` | Cycle mind map view: tree → boxed → flow |
| `f` | Cycle node filter: all → file → tool → task → subagent → command → plan → knowledge-note |

### Session Panel — AI Summary Tab

| Key | Action |
|-----|--------|
| `n` | Generate / retry AI narrative |

### General

| Key | Action |
|-----|--------|
| `z` | Cycle layout mode |
| `/` | Open filter overlay |
| `x` | Open context menu for selected item |
| `?` | Show help |
| `r` | Generate HTML report for the current session |
| `V` | Show version / changelog |
| `q` / `Ctrl+C` | Quit |

## Mouse Support

The dashboard supports mouse input in terminals with SGR 1006 extended mouse encoding:

- **Click** side list items to select them
- **Click** panel tabs or detail tabs to switch
- **Scroll wheel** in either pane to navigate
- **Click** anywhere to dismiss overlays

## Multi-Provider Support

Auto-detects the most recently active session provider:

- **Claude Code** — `~/.claude/projects/`
- **OpenCode** — `~/.local/share/opencode/`
- **Codex** — `~/.codex/`

Override with `--provider claude-code`, `--provider opencode`, or `--provider codex`.

## Documentation

Full documentation at [cesarandreslopez.github.io/sidekick-agent-hub](https://cesarandreslopez.github.io/sidekick-agent-hub/features/cli/).

## License

MIT
