# MCP Facts Server

`sidekick mcp` runs a local, read-only [Model Context Protocol](https://modelcontextprotocol.io/) server over standard input/output. It lets the coding agent inspect the same provider-neutral quota, context, burn-rate, task, decision, note, and project-context facts shown by Sidekick.

## Register the server

Install the CLI globally first (`npm install -g sidekick-agent-hub`), then register the `sidekick` binary from the project where you want to use it.

=== "Claude Code"

    ```bash
    claude mcp add sidekick -- sidekick mcp
    ```

=== "Codex"

    ```bash
    codex mcp add sidekick -- sidekick mcp
    ```

Use `claude mcp list` or `codex mcp list` to verify registration. Both commands launch the server in the current project directory; pass Sidekick's global `--project <path>` or `--provider <id>` options before `mcp` when an explicit target is needed.

## Available tools

| Tool                   | Fact returned                                                     |
| ---------------------- | ----------------------------------------------------------------- |
| `get_quota_status`     | Current provider quota/rate-limit windows and reset times         |
| `get_burn_rate`        | Active session token burn-rate metrics                            |
| `get_context_pressure` | Context utilization, attribution, and compaction facts            |
| `get_tasks`            | Persisted tasks for the current project                           |
| `get_decisions`        | Persisted architectural decisions                                 |
| `get_notes`            | Persisted knowledge notes                                         |
| `get_project_context`  | Composed tasks, decisions, notes, handoff, and project statistics |

Every tool is annotated as read-only, non-destructive, and idempotent. The server exposes no capture or store-mutation tools. `get_quota_status` calls the same shared resolver as `sidekick quota` — a persisted sample under five minutes old, then session logs, then the provider API, then an older sample — so its numbers and `resolution` label match the CLI and the dashboards; the remaining facts come from local session and persistence data.

Example prompt after registration:

> How much of my current quota window remains, and is my session close to context compaction?
