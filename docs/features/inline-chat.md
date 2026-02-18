# Quick Ask (Inline Chat)

Ask questions about code or request changes without leaving your editor.

## Usage

1. Press `Ctrl+I` (`Cmd+I` on Mac) to open the quick input
2. Ask a question or request a change
3. For changes: review the diff preview and Accept/Reject

## Capabilities

- **Context-aware** — uses selected code or cursor context
- **Ask questions** — "What does this function do?" or "Is this thread-safe?"
- **Request changes** — "Add error handling" or "Convert to async/await"
- **Diff preview** — review proposed changes before accepting

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.inlineChatModel` | `auto` | Model tier — resolves to `balanced` |
