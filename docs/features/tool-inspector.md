# Tool Inspector

Sometimes you need to see exactly what a tool call did — the precise edit, the exact bash command, the search pattern. The tool inspector renders each tool type with specialized formatting (diffs for edits, syntax-highlighted commands for bash, etc.) instead of raw JSON.

Full editor tab with specialized rendering per tool type for detailed inspection of tool calls.

## Usage

Run **"Sidekick: Open Tool Inspector"** from the Command Palette.

## Per-Tool Rendering

| Tool | Display |
|------|---------|
| **Read** | File path with range information |
| **Edit** | Inline diff display (red deletions, green additions) |
| **Bash** | Formatted command with description |
| **Grep/Glob** | Search parameters and patterns |

## Features

- Filter buttons by tool type
- Expandable detail panels for each call
- Chronological ordering
