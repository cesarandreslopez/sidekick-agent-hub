# Event Logging

Optional JSONL audit trail for debugging and analysis.

## Enabling

Set `sidekick.enableEventLog` to `true` in your VS Code settings.

## Storage

Event logs are stored in `~/.config/sidekick/event-logs/` as JSONL files (one JSON object per line).

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.enableEventLog` | `false` | Enable event logging |
| `sidekick.eventLogMaxSizeMB` | `500` | Max total size before oldest files are cleaned up |
| `sidekick.eventLogMaxAgeDays` | `30` | Max age before cleanup |

## Use Cases

- Debugging session monitoring issues
- Auditing tool usage patterns
- Analyzing session behavior over time
