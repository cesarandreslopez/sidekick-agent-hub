# Context Management

AI agents are powerful, but they have a fundamental limitation: they forget everything between sessions. Understanding how context works — and how to preserve it — is the difference between an agent that rediscovers your project every time and one that builds on previous work.

## Context Lifecycle

```mermaid
flowchart LR
    Start["Session start"] --> Load["Load instruction files<br/><small>CLAUDE.md · AGENTS.md</small>"]
    Load --> Work["Work<br/><small>Read files · Run commands · Generate</small>"]
    Work --> Full{"Context\nfull?"}
    Full -->|Yes| Compact["Compaction<br/><small>Compress older content</small>"]
    Compact --> Work
    Full -->|No| Work
    Work --> End["Session end"]
    End --> Handoff["Generate handoff doc"]

    Handoff -.->|"Persists on disk"| Start
    Load -.->|"Persists on disk"| Load
```

## What Is Context?

Context is your agent's working memory. It includes your code, conversation history, tool results, and instruction files. Every time your agent reads a file, runs a command, or generates a response, that information takes up space in the context window.

When the context window fills up, the agent **compacts** — it compresses older content to make room for new work. Compaction preserves the gist but loses detail. That function signature the agent read 20 minutes ago? After compaction, it might only remember that the file exists, not the specifics.

This is why long sessions can feel like the agent is "forgetting" things — it is. Not because it's broken, but because that's how context windows work.

## Instruction Files

Instruction files (CLAUDE.md, AGENTS.md, or equivalent for your provider) are project-level documents that your agent reads at the start of every session. They persist on disk, outside the context window, so they survive compaction and session boundaries.

A good instruction file tells your agent:

- **Project conventions** — build commands, test commands, coding style
- **Architecture** — how the codebase is organized, key abstractions
- **Preferences** — things you've told the agent before that you don't want to repeat

Without an instruction file, your agent starts every session knowing nothing about your project. With one, it starts with the essentials already loaded.

Sidekick can analyze your session patterns and [suggest improvements](../features/claude-md-suggestions.md) to your instruction file automatically.

## Handoff Documents

When a session ends, everything in context is gone. If you were halfway through a feature, your next session has no idea what was done, what's left, or what decisions were made along the way.

Handoff documents solve this by capturing session state before it's lost:

- What was accomplished
- What's still in progress
- Key decisions and their rationale
- Relevant context for continuing the work

Your next session reads the handoff document and starts with context instead of from scratch.

Sidekick can [generate handoff documents automatically](../features/session-handoff.md) at the end of each session, and the [decision log](../features/decision-log.md) persistently tracks architectural decisions across sessions.

## Learn More

- [Session Handoff](../features/session-handoff.md) — automatic context capture between sessions
- [Decision Log](../features/decision-log.md) — persistent tracking of architectural decisions
- [CLAUDE.md Suggestions](../features/claude-md-suggestions.md) — AI-powered improvements to your instruction file
