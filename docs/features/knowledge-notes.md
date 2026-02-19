# Knowledge Notes

Capture reusable knowledge about your codebase — gotchas, patterns, guidelines, and tips — attached to specific files. Notes persist across sessions and can be injected into your agent's instruction file so it benefits from what you've learned.

![Knowledge Notes](../images/knowledge-notes.gif)

## Why Knowledge Notes?

AI agents rediscover the same things every session. That configuration file with a subtle gotcha? The pattern you've established for error handling? The guideline about never calling a particular API directly? Without knowledge notes, your agent will stumble into the same problems repeatedly.

Knowledge notes let you capture these insights once and surface them automatically — in the editor gutter, in the sidebar tree, and directly in your agent's instruction file.

## Note Types

| Type | Icon | Use For |
|------|------|---------|
| **Gotcha** | Warning | Non-obvious pitfalls, tricky behavior, common mistakes |
| **Pattern** | Symbol | Established approaches, conventions, idioms in your codebase |
| **Guideline** | Law | Rules and constraints that should be followed |
| **Tip** | Lightbulb | Helpful shortcuts, performance tricks, best practices |

## Creating a Note

1. Select code in the editor (the lines the note should be attached to)
2. Right-click and choose **Add Knowledge Note**
3. Pick a note type (gotcha, pattern, guideline, or tip)
4. Enter the note content

The note is immediately visible as a gutter icon next to the annotated lines, and appears in the Knowledge Notes tree view.

## Managing Notes

Right-click any note in the **Knowledge Notes** tree view to:

- **Edit** — change the content, note type, or importance level
- **Confirm** — reset a stale or needs-review note back to active status
- **Delete** — remove the note permanently (with confirmation)

## Where Notes Appear

### Editor Gutter

Each note type gets a distinct icon in the editor gutter next to the annotated lines. Hover over the icon to see the full note content, type, status, and importance.

### Sidebar Tree View

The **Knowledge Notes** panel in the Agent Hub sidebar groups notes by file. Click any note to jump to its location in the editor.

### Mind Map

Active knowledge notes appear as amber nodes in the session mind map, linked to their associated file nodes.

## Lifecycle and Staleness

Notes have a lifecycle that helps you keep knowledge current:

| Status | Meaning |
|--------|---------|
| **Active** | Current and relevant |
| **Needs Review** | The annotated file has been modified and the note may be outdated (30+ days) |
| **Stale** | Significantly outdated (90+ days since last review) |
| **Obsolete** | The annotated file has been deleted from the workspace |

Importance level affects how quickly a note ages — critical notes decay slower than low-importance ones. Use the **Confirm** action to reset a note back to active after reviewing it.

## Injecting Notes into Your Agent

Run **Sidekick: Inject Knowledge Notes** from the Command Palette to append all active notes to your instruction file (CLAUDE.md or AGENTS.md, depending on your agent provider). This generates a `## File-Specific Knowledge` section that your agent reads at the start of every session.

## Auto-Extraction

When the session analytics dashboard detects patterns that could be useful as knowledge notes, it surfaces them as candidates for your review:

- **Repeated errors** on the same file suggest a gotcha
- **Recovery patterns** (tried approach A, switched to B) suggest a pattern note
- **Guidance suggestions** mentioning specific files suggest a guideline

Candidates appear in the dashboard for you to accept or dismiss.

## Auto-Surfacing

Active knowledge notes for files touched in the current session are automatically included in the GuidanceAdvisor analysis context. This means the AI analysis avoids duplicating advice you've already captured and can reference your existing notes when making suggestions.

## Storage

Notes are persisted per-project in `~/.config/sidekick/knowledge-notes/{projectSlug}.json` and survive across sessions and VS Code restarts.
