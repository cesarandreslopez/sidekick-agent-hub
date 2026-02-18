# CLAUDE.md Suggestions

Your agent instruction file (CLAUDE.md, AGENTS.md, etc.) shapes how effectively your agent works in your project, but it's hard to know what to put in it. This analyzes your actual session patterns — where your agent gets stuck, what recovery strategies work, what context it needs — and suggests concrete improvements.

AI-powered analysis of your session patterns to optimize your agent instruction file.

## How It Works

Sidekick analyzes your coding sessions to:

1. **Detect recovery patterns** — identifies when the agent gets stuck and how it recovers
2. **Generate best practices** — suggests instructions based on actual usage
3. **Surface patterns** — highlights recurring behaviors worth codifying

!!! tip "What are instruction files?"
    Instruction files (CLAUDE.md, AGENTS.md, etc.) are project-level documents your agent reads at the start of every session. They tell your agent about your project's conventions, architecture, and preferences — so it doesn't rediscover the same things every time. See the [Context Management primer](../getting-started/context-management.md) for more.

## Accessing Suggestions

![CLAUDE.md Suggestions](../images/claude-md-suggestions.png)

Suggestions appear in a collapsible panel within the Session Analytics dashboard, with progress indicators during analysis.

## What It Analyzes

- Tool usage patterns and frequencies
- Error recovery strategies
- Common file access patterns
- Repeated instruction patterns
