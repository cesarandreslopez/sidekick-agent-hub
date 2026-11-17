# Error Analysis

When your code hits an error, you want to understand it quickly — not just what went wrong, but why, and how to fix it. Error analysis provides AI-powered explanations at your preferred complexity level, from beginner-friendly to expert, with one-click fix suggestions.

Understand and fix errors with AI assistance.

Works in any language that reports diagnostics (squiggles), for errors and warnings.

## Explain Error

1. Put the cursor on an error or warning; no selection is needed
2. Press `Ctrl+.` (`Cmd+.` on Mac) and choose **"Explain Error with AI"** (or **"Explain Warning with AI"**), or run **Sidekick: Explain Error with AI** from the Command Palette
3. To choose a complexity level, right-click and pick **Sidekick › Explain Error with AI**, then a level

### Complexity Levels

| Level                 | Description                                   |
| --------------------- | --------------------------------------------- |
| **ELI5**              | Complete beginner explanations                |
| **Curious Amateur**   | Learning mode with defined terms              |
| **Imposter Syndrome** | Fill knowledge gaps, assume basic familiarity |
| **Senior**            | High-level summary, skip basics               |
| **PhD Mode**          | Expert-level analysis                         |

## Fix Error

1. Put the cursor on an error or warning
2. Press `Ctrl+.` (`Cmd+.` on Mac) and choose **"Fix Error with AI"**, or run **Sidekick: Fix Error with AI** from the Command Palette or the right-click **Sidekick** menu
3. Review the suggested fix in the Sidekick panel, then click **Apply Fix** to change your code

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

| Setting               | Default | Description                         |
| --------------------- | ------- | ----------------------------------- |
| `sidekick.errorModel` | `auto`  | Model tier — resolves to `balanced` |
