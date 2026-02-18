# Session Handoff

AI agents forget everything when a session ends. If you're building a feature across multiple sessions, the next one starts with zero context. Session handoff automatically captures what was accomplished, what's still in progress, and what decisions were made — so your next session can pick up where you left off instead of re-discovering everything.

Automatic context handoff between sessions for seamless continuation of work.

## How It Works

When a session ends, Sidekick can generate a handoff document summarizing:

- What was accomplished
- What's in progress
- Key decisions made
- Relevant context for the next session

On the next session start, Sidekick can notify you that a handoff is available.

!!! tip "New to context management?"
    Handoffs work by writing session context into files that your agent reads at the start of the next session. If you're not familiar with how agent context, instruction files, and session boundaries work, see the [Context Management primer](../getting-started/context-management.md).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.autoHandoff` | `off` | Handoff mode |

### Handoff Modes

| Mode | Behavior |
|------|----------|
| `off` | No handoff generation |
| `generate-only` | Generate handoff document at session end |
| `generate-and-notify` | Generate and show notification at next session start |

## Setup

Run **"Sidekick: Setup Handoff"** to add a reference to your agent instruction file (CLAUDE.md, AGENTS.md, etc.) that tells the agent where to find previous session context.

## Storage

Handoff documents are stored in `~/.config/sidekick/handoffs/` with project-specific naming.
