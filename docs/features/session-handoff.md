# Session Handoff

Automatic context handoff between sessions for seamless continuation of work.

## How It Works

When a session ends, Sidekick can generate a handoff document summarizing:

- What was accomplished
- What's in progress
- Key decisions made
- Relevant context for the next session

On the next session start, Sidekick can notify you that a handoff is available.

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
