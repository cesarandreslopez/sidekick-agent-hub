# Code Transforms

Select code, describe the change in English, get the result. Ideal for mechanical refactoring — converting promise chains to async/await, adding error handling, renaming patterns across a block — without manually rewriting every line.

Transform selected code using natural language instructions.

## Usage

1. Select the code you want to modify
2. Press `Ctrl+Shift+M` (`Cmd+Shift+M` on Mac)
3. Enter your instruction (e.g., "Add error handling", "Convert to async/await", "Add TypeScript types")
4. The selection is replaced with the modified code

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.transformModel` | `auto` | Model tier — resolves to `powerful` for quality |
| `sidekick.transformContextLines` | `50` | Lines of context before/after selection |

## Tips

- Be specific in your instructions for better results
- The transform uses surrounding code context to understand the codebase style
- Uses the `powerful` tier by default for high-quality refactoring
