# Sidekick CLI

The Sidekick CLI provides a full-screen terminal dashboard for monitoring agent sessions — standalone, no VS Code required. It reads from the same `~/.config/sidekick/` data files the VS Code extension writes.

![Sidekick CLI Dashboard](../images/sidekick-cli.gif)

!!! warning "Package name vs binary name"
    The npm package is `sidekick-agent-hub`, but the binary it installs is called **`sidekick`**. After installation, run `sidekick dashboard` — not `sidekick-agent-hub`.

## Installation

```bash
npm install -g sidekick-agent-hub
```

Requires **Node.js 20+**.

Or build from source:

```bash
bash scripts/build-all.sh
```

This compiles `sidekick-shared` (the data access library) and `sidekick-cli` (the binary). The CLI is output to `sidekick-cli/dist/sidekick-cli.mjs`.

## Quick Start

1. `cd` into your project directory
2. Run `sidekick dashboard`
3. The dashboard auto-detects your project path and session provider
4. Press `?` to see all keybindings

If you have sessions from multiple providers, the most recently active one is selected automatically. Override with `--provider`.

## Command Reference

```bash
sidekick dashboard [options]
```

| Flag | Description |
|------|-------------|
| `--project <path>` | Override project path (default: current working directory) |
| `--provider <id>` | Session provider: `claude-code`, `opencode`, `codex`, or `auto` (default) |
| `--session <id>` | Follow a specific session by ID (default: most recent or session picker) |
| `--replay` | Replay existing events from the beginning before streaming live |

### Examples

```bash
# Launch for the current directory
sidekick dashboard

# Monitor a specific project
sidekick dashboard --project ~/code/my-app

# Force Claude Code as the provider
sidekick dashboard --provider claude-code

# Follow a specific session with full replay
sidekick dashboard --session abc123 --replay
```

## Dashboard Overview

The dashboard is a two-pane Ink-based terminal UI. The left pane shows a navigable list of items (sessions, tasks, notes, etc.), and the right pane shows details for the selected item.

### Layout Modes

Press `z` to cycle through three layout modes:

| Mode | Description |
|------|-------------|
| **Normal** | Default two-pane split — side list and detail pane side by side |
| **Expanded** | Side list hidden, detail pane fills the entire screen |
| **Wide Side** | Wider side list for longer item labels |

Minimum terminal size: 60 columns wide, 15 rows tall.

## Dashboard Panels

Switch panels with number keys `1`–`5`.

### Sessions (1)

Browse and select from recent agent sessions. The detail pane has seven tabs:

| Tab | Description |
|-----|-------------|
| **Summary** | Token usage, cost, duration, model, and session metadata |
| **Timeline** | Chronological activity feed with tool calls, messages, and events |
| **Mind Map** | Terminal-rendered graph of session structure — files, tools, tasks, and relationships. Press `v` to cycle views (tree/boxed/flow), `f` to filter node types |
| **Tools** | Breakdown of tool usage with counts and categories |
| **Files** | Files touched during the session |
| **Agents** | Subagent activity and delegation chain |
| **AI Summary** | AI-generated narrative of the session. Press `n` to generate |

### Tasks (2)

View persisted tasks filtered by status. Tasks carry over across sessions from `~/.config/sidekick/tasks/`.

### Kanban (3)

Task board with status columns — a visual view of the same task data.

### Notes (4)

Knowledge notes attached to files. Each note has Content and Related detail tabs. Notes persist in `~/.config/sidekick/` and can be injected into agent instruction files.

### Decisions (5)

Architectural decisions extracted from sessions. Stored in `~/.config/sidekick/decisions/`.

## Keybindings

### Navigation

| Key | Action |
|-----|--------|
| `1`–`5` | Switch panel |
| `Tab` | Toggle focus between side list and detail pane |
| `j` / `↓` | Next item (side list) or scroll down (detail pane) |
| `k` / `↑` | Previous item (side list) or scroll up (detail pane) |
| `g` | Jump to first item / scroll to top |
| `G` | Jump to last item / scroll to bottom |
| `h` / `←` | Return focus to side list (from detail pane) |
| `Enter` | Move focus to detail pane (from side list) |

### Detail Tabs

| Key | Action |
|-----|--------|
| `[` | Previous detail tab |
| `]` | Next detail tab |

### Session Management

| Key | Action |
|-----|--------|
| `p` | Pin session — prevent auto-switching to the newest session |
| `s` | Switch to pending session (when a newer session arrives while pinned) |
| `f` | Toggle session filter — filter the side list to the selected session |

### Session Panel — Mind Map Tab

| Key | Action |
|-----|--------|
| `v` | Cycle mind map view: tree → boxed → flow |
| `f` | Cycle node filter: all → file → tool → task → subagent → command → plan → knowledge-note |

### Session Panel — AI Summary Tab

| Key | Action |
|-----|--------|
| `n` | Generate or retry AI narrative for the session |

### Actions

| Key | Action |
|-----|--------|
| `/` | Open filter overlay — type to filter the side list |
| `x` | Open context menu for the selected item |
| `z` | Cycle layout mode (Normal → Expanded → Wide Side) |

### General

| Key | Action |
|-----|--------|
| `?` | Show help overlay |
| `V` | Show version / changelog |
| `Esc` | Clear filter, close overlay, or return focus to side list |
| `q` / `Ctrl+C` | Quit (or close overlay if one is open) |

## Mouse Support

The dashboard supports mouse input in terminals with SGR 1006 extended mouse encoding (most modern terminals):

- **Click** side list items to select them
- **Click** panel tabs or detail tabs to switch
- **Scroll wheel** in either pane to navigate (scrolls 3 items/lines at a time)
- **Click** anywhere to dismiss overlays (help, filter, context menu)

## Session Management

### Auto-Detection

The CLI auto-detects which session provider is most recently active by checking filesystem presence and modification times:

- **Claude Code** — `~/.claude/projects/`
- **OpenCode** — `~/.local/share/opencode/`
- **Codex** — `~/.codex/`

Override with `--provider claude-code`, `--provider opencode`, or `--provider codex`.

### Session Pinning

By default, the dashboard auto-switches to the newest session when one starts. Press `p` to pin the current session — the dashboard stays on it even when new sessions appear. Press `s` to switch to a pending session that arrived while pinned.

### Session Filter

Press `f` to toggle session filtering, which limits the side list to items from the currently selected session. Useful when you have many sessions and want to focus on one.

## Shared Data Layer

The CLI reads from the same `~/.config/sidekick/` directory as the VS Code extension:

| File | Contents |
|------|----------|
| `historical-data.json` | Token/cost/tool usage statistics |
| `tasks/{projectSlug}.json` | Kanban board task data |
| `decisions/{projectSlug}.json` | Decision log entries |

Any data written by the VS Code extension is immediately visible in the CLI, and vice versa.

## VS Code Integration

The VS Code extension provides a command to launch the dashboard without leaving the editor:

- **`Sidekick: Open CLI Dashboard`** — opens the TUI dashboard in an integrated terminal panel
