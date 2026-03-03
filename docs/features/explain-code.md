# Explain Code

Unfamiliar code is everywhere — legacy systems, open source libraries, a teammate's PR. Instead of spending time tracing logic manually, get an AI explanation calibrated to your experience level, from "explain like I'm five" to expert-level analysis.

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
- **Segmented control** for complexity selection — a unified pill-style bar replacing individual buttons, with smooth hover/active transitions
- **Keyboard navigation** — Arrow (Left/Right), Home, and End keys navigate between complexity levels; the selector uses proper `role="tablist"` semantics
- **Three-dot pulse loader** while the explanation generates
- Regenerate with custom instructions for different perspectives
- Configurable default complexity via `sidekick.explanationComplexity`

## Accessibility

- `prefers-reduced-motion` — all animations and transitions are disabled when the OS-level reduced motion setting is enabled
- Focus-visible outlines (2px) on all interactive elements for keyboard navigation
- ARIA landmarks: `<main>`, `role="region"`, `aria-live="polite"` on the explanation content area
- Toolbar wrapped in `<nav>` with `aria-label`
- Responsive layout for narrow sidebar panels (under 260px)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.explanationModel` | `auto` | Model tier — resolves to `balanced` |
| `sidekick.explanationComplexity` | `imposter-syndrome` | Default complexity level |
