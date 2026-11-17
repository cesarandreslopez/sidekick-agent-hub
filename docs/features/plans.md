# Plans

The **Plans** view in the Agent Hub sidebar shows the plan your agent is working through right now and the plans from this project's earlier sessions, each with its steps and their status. Like the other monitoring views, it starts collapsed; click its header to expand it.

## Where plans come from

Sidekick picks plans out of the session as the agent writes them. Nothing has to be configured.

| Agent       | What counts as a plan                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Plan mode: the plan written between `EnterPlanMode` and `ExitPlanMode`, including the plan file Claude Code writes to `~/.claude/plans/` |
| Codex       | `update_plan` calls (the step list with each step's status), and `<proposed_plan>` blocks in replies                                     |
| OpenCode    | `<proposed_plan>` blocks in replies, and entering or leaving plan mode                                                                   |

Steps are read from the plan's markdown: checkboxes (`- [ ]`, `- [x]`), numbered lists, or bullets, grouped by phase headings such as `## Phase 1: Setup`. While the agent works, step status follows its updates (for Codex, the status of each step in `update_plan`), and the tokens and tool calls spent while a step is in progress are counted against it.

When a session ends, its plan is saved to the project's plan store. Steps still in progress are marked failed and steps never started are marked skipped, and the plan as a whole is recorded as completed, failed, or abandoned.

The view also lists Claude Code plan files from `~/.claude/plans/` that this project's sessions refer to, when no saved plan covers them. These have no recorded run, so they show their steps but no status.

## What the view shows

- **Header** — a status chip (**Live**, **Viewing**, or **No session**) for the attached session, and **Refresh**, which reloads the Claude Code plan files.
- **Active Plan** — the current session's plan: title, agent, an **In Progress** or **Completed** chip, percent complete, a progress bar, and the step list. When the plan has markdown, **Copy Markdown** copies it as the agent wrote it.
- **History** — one card per earlier plan, newest first, with its status (**Completed**, **Failed**, **Abandoned**, or **In Progress**), agent, percent complete, and date. Expand a card for its duration, tokens, cost, and tool calls, a progress bar, and the steps. **Copy** copies its markdown, when it has some.

Steps are marked ✓ completed, ▶ in progress, ○ pending, ✗ failed, and — skipped.

## Search and filters

The search box matches plan titles, agents, statuses, step text, and the plan markdown. The filter chips narrow the History list by date (**All**, **Today**, **7d**, **30d**), by agent (**Claude Code**, **OpenCode**, **Codex**), and by outcome (**Completed**, **Failed**, **Abandoned**). Date chips pick one range; click an active agent or outcome chip again to clear it. When nothing matches, **Clear filters** resets them. The view remembers your search, filters, and expanded cards.

## Related

- The Session Analytics dashboard shows the live plan as a **Plan Progress** card and a summary of saved plans as **Plan History**; see [Plan Progress and Plan History](session-monitor.md#plan-progress-and-plan-history).
- The CLI dashboard has the same plans in its [Plans panel](cli.md#plans-6) (key `6`).
- Session handoffs include the plan's completed and remaining steps; see [Session Handoff](session-handoff.md).

## Storage

Saved plans live in `~/.config/sidekick/plans/{projectSlug}.json` (under `SIDEKICK_CONFIG_DIR` when set), up to 50 per project, and are shared with the CLI.
