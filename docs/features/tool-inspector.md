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
| **Write** | File path with operation status |
| **Bash** | Formatted command with description |
| **Grep/Glob** | Search parameters and patterns |

## Tool Result Pairing

Each tool call is paired with its output via `toolUseId` correlation. The inspector shows truncated tool results (up to 5,000 characters) directly below the call:

- **Read** — file content with line numbers
- **Bash** — stdout below the `$ command` line
- **Grep/Glob** — matched results
- **Edit/Write** — success or error message

Results that exceed 5,000 characters are truncated with a `...(truncated)` indicator. Error outputs are styled differently from successful results.

## Features

- Filter buttons by tool type
- Expandable detail panels for each call
- Chronological ordering
- Paired tool outputs inline with each call
