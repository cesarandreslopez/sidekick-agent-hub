# Explain Code

Get AI-powered explanations for selected code at your preferred complexity level.

## Usage

1. Select code you want to understand
2. Press `Ctrl+Shift+E` (`Cmd+Shift+E` on Mac)
3. Choose complexity level from the submenu (or use the default)

## Complexity Levels

| Level | Best For |
|-------|----------|
| **ELI5** | Complete beginners, simple analogies |
| **Curious Amateur** | Learners, defines technical terms |
| **Imposter Syndrome** | Filling knowledge gaps (default) |
| **Senior** | Experienced devs, key points only |
| **PhD Mode** | Expert-level analysis |

## Features

- Rich webview panel with markdown rendering
- Regenerate with custom instructions for different perspectives
- Configurable default complexity via `sidekick.explanationComplexity`

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.explanationModel` | `auto` | Model tier — resolves to `balanced` |
| `sidekick.explanationComplexity` | `imposter-syndrome` | Default complexity level |
