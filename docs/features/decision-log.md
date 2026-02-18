# Decision Log

Tracks and persists architectural decisions extracted from coding sessions.

## How It Works

Sidekick monitors session activity for decision-related patterns and extracts them into a persistent log stored per-project.

## Storage

Decision logs are stored in `~/.config/sidekick/decisions/{projectSlug}.json` and persist across sessions.
