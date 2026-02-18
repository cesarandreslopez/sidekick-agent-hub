# Session Monitor

When your coding agent runs autonomously, you're flying blind — tokens burn silently, context fills up, and tool errors pile up without warning. The session monitor gives you a real-time dashboard so you can catch problems early and understand where your budget is going.

Monitor your coding agent sessions in real-time with a comprehensive analytics dashboard. Supports Claude Code, OpenCode, and Codex CLI.

## Accessing the Dashboard

Click the **Agent Hub** icon in the activity bar (left sidebar) to access all monitoring views.

## Session Analytics Dashboard

![Session Analytics Dashboard](../images/session-analytics-dashboard.png)

The main dashboard panel provides:

- **Token Usage** — real-time input/output token tracking with model-specific pricing
- **Cost Tracking** — per-model cost breakdown with accurate pricing
- **Context Token Attribution** — stacked bar chart showing where your context budget goes (system prompt, CLAUDE.md, user messages, assistant responses, tool I/O, thinking)
- **Token Usage Tooltips** — hover for quota projections and estimated time to exhaustion
- **Context Window Gauge** — input/output token usage vs. limits
- **Compaction Detection** — timeline markers showing when context was compressed and how much was lost
- **Activity Timeline** — user prompts, tool calls, errors, and subagent spawns with full-text search
- **Timeline Search & Filtering** — filter by event type, noise classification (system reminders, sidechains)
- **Session Navigator** — collapsible panel to switch between active and recent sessions
- **Tool Analytics** — categorized tool usage with drill-down to individual calls
- **Session Summary** — AI narrative generation with progress notification

### Dashboard Sections

The dashboard organizes information into three collapsible groups:

![Session Activity — Context Attribution, Compactions, and Activity Timeline](../images/session-activity-timeline.png)

- **Session Activity** — Activity Timeline, File Changes, Errors
- **Performance & Cost** — Model Breakdown, Tool Analytics, Tool Efficiency, Cache Effectiveness, Advanced Burn Rate

![Performance & Cost — Model Breakdown, Tool Analytics, Tool Efficiency, Cache Effectiveness](../images/performance-and-cost.png)
- **Tasks & Recovery** — Task Performance, Recovery Patterns

![Tasks & Recovery — Task Performance and Completion Tracking](../images/tasks-and-recovery.png)

## Subscription Quota Display

For Claude Max users, the dashboard shows 5-hour and 7-day quota utilization with:

- Color-coded gauges (green/orange/red)
- Countdown timers showing reset times
- Auto-refresh every 30 seconds

## Session Discovery

The monitor automatically discovers sessions based on your configured provider. If the session is in a different directory:

- Use **"Sidekick: Browse Session Folders..."** to manually select a session folder
- Selection persists across VS Code restarts
- **"Sidekick: Reset to Auto-Detect Session"** clears manual selection

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.enableSessionMonitoring` | `true` | Enable/disable session monitoring |
| `sidekick.sessionProvider` | `auto` | Which agent to monitor: `auto`, `claude-code`, `opencode`, `codex` |
