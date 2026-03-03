# Error Analysis

When your code hits an error, you want to understand it quickly — not just what went wrong, but why, and how to fix it. Error analysis provides AI-powered explanations at your preferred complexity level, from beginner-friendly to expert, with one-click fix suggestions.

Understand and fix errors with AI assistance.

## Explain Error

1. Click the lightbulb on any diagnostic
2. Select **"Explain Error with AI"**
3. Choose a complexity level from the submenu

### Complexity Levels

| Level | Description |
|-------|-------------|
| **ELI5** | Complete beginner explanations |
| **Curious Amateur** | Learning mode with defined terms |
| **Imposter Syndrome** | Fill knowledge gaps, assume basic familiarity |
| **Senior** | High-level summary, skip basics |
| **PhD Mode** | Expert-level analysis |

## Fix Error

1. Click the lightbulb on any diagnostic
2. Select **"Fix Error with AI"**
3. The suggested fix is applied directly to your code

The **Apply Fix** button shows animated state feedback — "Applying..." while the fix runs, and a green "Applied" confirmation on success.

## Panel Design

Explanation sections (Root Cause / Why It Happens / How to Fix) are displayed as cards with:

- **Color-coded left borders** — red for root cause, orange for why it happens, green for how to fix
- **Section icons** and padded card-like backgrounds
- **Staggered slide-in** entrance animations (disabled when OS-level reduced motion is enabled)
- **Three-dot pulse loader** while the analysis generates

## Accessibility

- `prefers-reduced-motion` — all animations and transitions are disabled when the OS-level reduced motion setting is enabled
- Focus-visible outlines (2px) on all interactive elements for keyboard navigation
- ARIA landmarks: `<main>`, `role="alert"` for error states, `role="status"` for loading, `aria-label` on copy buttons
- Responsive layout for narrow sidebar panels (under 260px)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.errorModel` | `auto` | Model tier — resolves to `balanced` |
