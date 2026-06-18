# Extract Session Assets

Your most useful artifacts are buried in chat history — the docs link your agent
pasted, the file it pointed you at, the command it told you to run, the plan it
laid out before editing. **Session asset extraction** pulls those actionable items
back out of your recent Claude Code and Codex sessions, scoped to exactly the
project you're working in.

It extracts four kinds of assets:

- **URLs** — links from messages and from `WebFetch` / `WebSearch` / `Bash` tool inputs
- **File paths** — on-disk paths (with optional `:line`), validated against the filesystem
- **Commands** — shell commands the agent *presented for you to run* (fenced shell blocks and `$`-prefixed lines), not the ones it ran itself
- **Plans** — plan-mode plans (Claude `ExitPlanMode` / plan files, Codex finalized `Plan` items)

Results are merged across supported agents, sorted by recency, deduped, and capped
per type. Extraction uses **exact-cwd scoping** — it does not walk up or down the
directory tree, so it never surfaces a different project's chat data. Claude Code
and Codex are supported; OpenCode is not supported yet.

The feature is available both inside VS Code and from the terminal.

## In VS Code

Run **`Sidekick: Extract Session Assets`** from the Command Palette (or the
Sidekick dashboard view's title menu). It opens a searchable QuickPick of the
assets found for the current workspace. Selecting an item runs its default action:

| Asset | Action on select |
|-------|------------------|
| **URL** | Opens externally in your browser |
| **File path** | Opens in the editor, jumping to the referenced line when available |
| **Command** | Copies to the clipboard, ready to paste into a terminal |
| **Plan** | Opens as a Markdown scratch document |

A workspace folder is required. If no assets are found, Sidekick distinguishes
"no recent sessions for this directory" from "sessions found, but no assets."

## In the terminal

```bash
sidekick extract [options]
```

See the [CLI Dashboard reference](cli.md#extract-session-assets) for the full
flag list. In short:

| Flag | Description |
|------|-------------|
| `--type <types>` | Comma list: `url`, `path`, `command`, `plan` (default: all). Aliases: `urls`, `files`, `cmds`, `plans` |
| `--limit <n>` | Positive integer maximum items per type |
| `-i`, `--interactive` | Interactive fuzzy picker; Enter opens URLs and copies paths, commands, or plans |
| `--json` | Emit grouped JSON (includes `inChat` and per-item `agent` / `sessionPath` / `source` provenance) for scripting |

Global flags `--project` and `--provider` apply: `--provider claude-code` reads
Claude Code only, `--provider codex` reads Codex only, and `auto` reads both.

```bash
# Grouped, colored text output
sidekick extract

# Only links and file paths
sidekick extract --type url,path

# JSON with at most 10 items of each requested type
sidekick extract --limit 10 --json

# Fuzzy picker with copy/open actions
sidekick extract -i
```

## For tool builders

The extractors are available from the [`sidekick-shared`](https://www.npmjs.com/package/sidekick-shared)
npm package as Node-only APIs: `gatherAssetsForCwd()` merges supported agents with
recency sorting, dedupe, and per-type caps, while `extractUrls()`,
`extractFilePaths()`, `extractCommands()`, `readClaudeAssets()`, and
`readCodexAssets()` are exported for custom tooling. These read the filesystem, so
they are safe for CLI and VS Code extension-host code but are intentionally **not**
exported from the browser-safe `sidekick-shared/browser` entry point.

## Credit

This feature was contributed by **[Juan Fourie (@B33pBeeps)](https://github.com/B33pBeeps)**
in [#17](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/17), adapted
from his MIT-licensed [`trawl`](https://github.com/B33pBeeps/trawl) project.
