# Inline Completions

Context-aware completions that understand your project. Unlike generic autocomplete, these suggestions factor in surrounding code, imports, and patterns — so you spend less time typing boilerplate and more time thinking about architecture.

Completions appear as ghost text that you can accept with Tab.

![Inline Completions demo](../images/inference.gif)

## Usage

- **Automatic**: Suggestions appear after a brief pause in typing (configurable via `sidekick.debounceMs`)
- **Manual trigger**: `Ctrl+Shift+Space` (`Cmd+Shift+Space` on Mac)
- **Accept**: Press `Tab`
- **Dismiss**: Press `Escape`
- **Toggle**: Click "Sidekick" in the status bar or run "Sidekick: Toggle Inline Completions"

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.enabled` | `true` | Enable/disable inline completions |
| `sidekick.inlineModel` | `auto` | Model tier — resolves to `fast` for low latency |
| `sidekick.debounceMs` | `1000` | Delay before requesting completion (ms) |
| `sidekick.inlineContextLines` | `30` | Lines of context before/after cursor |
| `sidekick.multiline` | `false` | Enable multi-line completions (up to 10 lines) |
| `sidekick.showCompletionHint` | `true` | Show visual hint at cursor |
| `sidekick.completionHintDelayMs` | `1500` | Delay before showing hint (ms) |

!!! note
    Prose files (Markdown, plaintext, HTML, XML, LaTeX) automatically use multiline mode regardless of the `multiline` setting.

## Multiple Windows

Each VS Code window runs its own extension instance with independent caches. Completions cached in one window are not available in another. All windows share the same authentication.
