# Changelog

All notable changes to the Sidekick Agent Hub CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.26.2] - 2026-09-06

### Fixed

- CLI live-only sessions no longer overwrite complete-history checkpoints. Older CLI checkpoints are invalidated and replayed once.
- OpenCode dashboards replay history instead of restoring timestamp-only snapshots, preventing duplicate token totals on reopen.
- Dashboard checkpoints save after complete event batches, use the current snapshot schema, and reject obsolete or incompatible consumer formats.
- Project-scoped search passes the workspace path through shared provider discovery, including Codex and database-only OpenCode sessions.
- Doctor honors `--provider`; unused integrations and missing saved accounts are informational when monitoring existing sessions.
- Shared watchers preserve partial UTF-8 lines and use OpenCode's platform-specific data directory.

## [0.26.1] - 2026-09-05

### Changed

- Direct OpenAI API dashboard summaries use GPT-5.6 Luna with reasoning disabled and a 1,024-token `max_completion_tokens` limit. Anthropic API summaries retain Haiku 4.5; native CLI summaries retain the user's model configuration.

### Fixed

- Shared model metadata verified on 2026-09-05 corrects fallback costs and context gauges for Fable 5.1, GPT-6 Astra, GPT-5.6, and GPT-5.4 mini/nano.
- Codex `quota`, `quota --provider codex`, `quota --all`, and MCP quota queries fetch live utilization and reset credits on every call. Local samples no longer prevent API refreshes, including with `--refresh`.
- Codex fallback output shows sample age and the failed API refresh reason; older logs no longer hide newer cached data.

## [0.26.0] - 2026-09-05

### Added

- `sidekick statusline` reads the JSON Claude Code pipes to its status-line command (`SIDEKICK_STATUSLINE_STDIN=0` disables it), appends context %, session cost, and prompt-cache hit rate, and persists the official five-hour and seven-day limits to the quota snapshot and history stores, so every other command and dashboard sees them without a network call. Cached quota older than five minutes is labelled with its age
- Global `--offline` (or `SIDEKICK_OFFLINE=1`) prices from the cached catalog only; global `--output-file <path>` writes a command's stdout to a file (not for `dashboard` or `mcp`)
- `stats --csv` prints every recorded day; `dump --list --csv` and `quota history --csv` print their tables as CSV
- `quota history --window 5h|7d|max` selects which limit the heatmap shows (default `5h`); the header names the window
- The global `--json` flag applies to `tasks add`, `tasks done`, `note add`, `decision add` (returning the stored record) and to `report` (returning the output path)
- The dashboard raises a toast when the five-hour window crosses 80% or 95%, or the seven-day window crosses 90%, once per reset window
- `sidekick blocks [--active | --recent | --since <time>] [--csv] [--no-cache]` shows five-hour billing blocks computed from session logs (a block opens at the first usage event aligned to the UTC hour, lasts five hours, and a longer gap opens a new one) with cache-inclusive totals, cost provenance, burn rate, and — for the open block — projected end-of-block tokens and cost. Sessions are read once and cached by size and mtime; the table is labelled a local estimate and the official status-line sample is shown beneath it when present. `--since` accepts an ISO date, `YYYY-MM-DD`, or a relative window such as `7d`
- The dashboard's Sessions summary shows the active five-hour billing block (local estimate from session logs), refreshed every minute
- `sidekick daily`, `weekly`, `monthly`, and `sessions` report usage computed straight from session logs, so CLI-only users no longer see "No historical data found". Every provider with session data is read by default (the global `--provider` narrows to one); rows are bucketed by the time of each usage event on the local calendar (`--utc` for UTC), so a session crossing midnight is split across both days; weeks start on Monday. Options: `--since` / `--until` (ISO date, `YYYY-MM-DD`, or relative windows such as `30d`), `--breakdown` (per-model sub-rows), `--by-project`, `--csv`, `--no-cache`; the global `--json` prints the full report. Defaults: 30 days, 12 weeks, 12 calendar months, 30 days
- `sidekick stats` points at `sidekick daily` when the history store is empty
- `sidekick import [--since <time>]` folds finished sessions from every detected provider (or the global `--provider`) into `historical-data.json`, the store behind `stats`, `today`, and the VS Code History tab, using the same importer and store mutation as the extension. Files already imported, sessions already persisted by the live monitor, and files modified in the last minute are skipped; session logs are read without holding the store lock and the summaries are applied in one short locked write that re-checks the on-disk store
- `sidekick statusline` writes `~/.config/sidekick/state.json` on every prompt (only when something changed) and the dashboard writes it on quota updates and billing-block ticks: a public, versioned (`schemaVersion: 1`) document with the active account, quota windows with freshness, context usage, session cost, and the active billing block, for tmux status bars, menu-bar apps, and scripts

### Changed

- Startup awaits bounded pricing-catalog hydration, so two runs of the same command price identically; a fresh cache is a local read and a refresh is capped by the catalog's 3 s timeout
- Every token total (`stats`, `today`, the dashboard session panel, `dump`, `report`) includes cache reads and writes and is labelled "Total (incl. cache)"; cost figures carry their provenance
- `sidekick today` looks up yesterday by local calendar day (the history store has always been keyed that way) and takes its peak-hours line from the shared schedule, so it agrees with `sidekick peak`
- `sidekick quota` shows the age of a cached snapshot and only colours it as a warning when it is older than five minutes; `quota history` reads providers in parallel
- The global `--json` flag applies to `dump` (same as `--format json`)
- Commands set `process.exitCode` instead of calling `process.exit(1)` on errors, so piped output is never truncated
- The status line no longer writes to the account registry on its hot path
- `sidekick quota`, `quota --all`, and `mcp get_quota_status` resolve quota through the shared `resolveQuota()` precedence (fresh persisted sample, then session logs, then the provider API, then an older sample), so a fresh status-line sample is never outranked by an older session-derived value and `--all` no longer forces Codex API-first; `--refresh` asks the API first for every provider, not only Codex
- Every quota table prints a `Source` row naming where the numbers came from (`cached status-line sample from … (3m ago)`, `local session logs`, `Anthropic usage API`, …); JSON output adds `resolution`, `capturedSource`, `freshness`, and `ageMs`
- `sidekick report` and the dashboard's report action read the session once through its provider reader and derive both the metrics and the transcript from those events, instead of replaying the session through a watcher and then parsing the file again; report metrics now come from the canonical event path (the same one `readSessionStats()` uses)
- Codex session discovery, listings, and the local quota scan use the shared capped walker, so the dashboard's session poll and `sidekick quota` no longer enumerate and re-read the whole rollout history on every call
- The dashboard detects new sessions by subscribing to the provider's session root (`fs.watch` with a 30 s catch-up poll) instead of walking the session corpus every 10 s; the followed session's own writes no longer trigger a lookup
- `DashboardState.getMetrics()` returns the same object until the next mutation, and the dashboard memoises panel items and detail rendering on that identity (plus each panel's `viewVersion`), so key presses, scrolling, and toasts no longer rebuild every panel
- Provider status polling is scoped to the active provider: status.claude.com for Claude Code, status.openai.com for Codex, nothing for OpenCode
- `sidekick dump --list` and the multi-provider session picker read the bounded async preview index; `--list` prints enumeration diagnostics to stderr and shows the "raise --limit" footer only when more sessions exist beyond the limit
- `sidekick stats` text mode: the Top Failing Tools block shows the last 7 and 30 days side by side with a trend arrow; `--json` output is unchanged

### Fixed

- `--offline` and `--output-file` given before the command are recognised by the command-token scan: `sidekick --offline stats` used to skip catalog hydration entirely and price from the static table, and `sidekick --offline statusline` fell off the fast path
- `--output-file` writes plain text: chalk's colour level is reset when the redirect is installed, unless `FORCE_COLOR` is set
- The dashboard's `state.json` keys quota by the sample's `providerId` when one is stamped

## [0.25.0] - 2026-08-18

### Changed

- The CLI advances in lockstep with `sidekick-shared` 0.25.0 and retains its existing commands and synchronous compatibility surface

## [0.24.5] - 2026-08-18

### Added

- `sidekick history` lists recent Codex user prompts across every workspace from `~/.codex/history.jsonl`, newest first, as an AGE / SESSION / PROMPT table sized to the terminal. `--limit <n>` bounds the count (default 20) and the underlying tail read scales with the limit, so large limits are not silently truncated. `--path <id-or-prefix>` resolves a full session id or unique prefix to its rollout transcript path — `less "$(sidekick history --path 0198a3c2)"` — and the global `--json` emits full ids and ISO timestamps. Codex-only for now; not to be confused with `sidekick quota history`
- `sidekick dump --list` gains `--limit <n>` (default 50). The listing and the interactive session picker both read the shared session-preview index, which stats first and content-reads only the sessions actually shown — listing a project with a large session history no longer reads every file

### Changed

- `dump --list` prints provider-canonical session ids — for Codex, the bare session UUID rather than the `rollout-…` file basename. The listed id now round-trips into `dump --session <id>` (the old basename never matched exact or prefix); scripts parsing `--list --json` should expect the new `id` form

## [0.24.4] - 2026-07-25

### Fixed

- The dashboard loaded persisted project data exactly once at startup and never again, so tasks, notes, decisions, and plans written by the VS Code extension or a second terminal never appeared until the dashboard was restarted
- Load and watcher failures were swallowed into empty catch blocks. A failed load was replaced with an all-zero object and both watcher error handlers were empty, producing a dashboard indistinguishable from a genuinely quiet project
- `sidekick dashboard` without a TTY rendered Ink's "Raw mode is not supported" panel into the middle of a partial frame and exited 0, so callers read the failure as success. It now fails with a message naming which stream is not a TTY, suggests a command that works when piped, and exits 1
- Mouse tracking escape sequences were written to stdout with no TTY check, polluting redirected output
- A bare `sidekick` printed full help to stderr with exit 1, breaking `sidekick | less` and any script checking the exit code. It now writes to stdout and exits 0
- `sidekick --help` and `sidekick --version` made a network request and created `~/.config/sidekick/accounts/` before printing anything, because the startup side effects ran at module scope
- `sidekick --no-color` was rejected as an unknown option, even though chalk already honored it, `NO_COLOR`, and a non-TTY stdout
- Printing help for a bare invocation ran before Commander parsed the argv, which skipped its validation too: `sidekick --provider bogus` and `sidekick --project` (missing its value) exited 0 with help instead of reporting the error. Help for a bare or flag-only invocation is now a root action handler, so `sidekick | less` still works without disarming the option checks, and `sidekick bogus` still reports an unknown command
- Switching to a pending session was impossible from the Plans panel: it bound `s` with no condition, so the panel's handler fired whenever an item was selected, which on Plans is always. The Sessions panel shadowed the global session filter on its Mind Map tab the same way
- When the item list shrank under the cursor — live event churn, or typing into the filter — the detail tab and scroll position jumped back to the top of the first tab
- The detail tab bar could highlight a tab whose content was not being rendered
- The detail pane could render empty beneath a "▲ (N more)" indicator. The scroll offset survives a list shrinking under the cursor, so it can outlive the content it was measured against; it is now clamped to whatever content it lands on
- On the splash screen, panel digits 1 and 2 did nothing while 3 through 8 entered the dashboard
- Only the newest toast was rendered, so a quota alert landing next to a context compaction showed one message and silently dropped the other
- `parseBlessedTags.test.tsx` had never run: the vitest include glob was `*.test.ts`, which does not match `.test.tsx`. That is 15 tests covering the tag parser every rendered string flows through
- `vitest.config.ts` declared `define` nested under `test`, where Vitest ignores it, so the `__CLI_VERSION__` injection its comment describes was inert and the next test importing `cli.ts` or `StatusBar.tsx` would have failed on a `ReferenceError`
- `sidekick extract -i --json` silently ignored `--json`; it is now rejected, and `extract -i` degrades to plain output when not attached to a terminal

### Added

- `R` refreshes persisted project data on demand, and data auto-refreshes every 15 seconds. The refresh is gated by a content fingerprint, so an unchanged project schedules no re-render at all. Plan progress is part of that fingerprint: a plan record is replaced in place and keeps its `createdAt` with no `completedAt` while it runs, so a timestamp-only signature could not see steps advancing and `R` would report "Project data is up to date" against a stale Plans panel
- A status-bar badge for data health, covering load failures, watcher errors, in-flight refreshes, and staleness. A watcher error expires from the badge 60 seconds after the last failure, matching the watcher's own treatment of these errors as recoverable — it closes the handle and degrades to catch-up polling — so one transient hiccup cannot latch the badge for the life of the process and hide the staleness signal behind it
- Toasts stack up to three
- `R`, `p`, and `s` are listed in the help overlay; `p` and `s` were previously documented only in the README

### Changed

- The Plans panel's source filter moved from `s` to `S`, and the Sessions panel's mind-map node filter from `f` to `F`, so the reserved global session-switch and session-filter keys work from every panel
- The pricing cache follows `SIDEKICK_CONFIG_DIR` rather than a hardcoded `~/.config/sidekick`

### Removed

- The dead ANSI mind-map renderer and its helpers, and the unused `getRandomPhraseColored()`

## [0.24.3] - 2026-07-24

### Fixed

- Dashboard costs for Claude Sonnet 5 ran 50% high, billed at $3/$15 instead of its actual $2/$10. Sonnet 5 is the `balanced` tier for the Claude API and OpenCode providers, so this shifted most totals shown before the pricing catalog was fetched
- Dashboard costs for GPT-5.6 Luna ran about 5× high until the pricing catalog was fetched, because Luna had no rate of its own and fell back to GPT-5.6 Sol's $5/$30 rather than its published $1/$6. GPT-5.5 Pro, GPT-5.4 Pro, and GPT-5.4 Nano shared the cause and are corrected too
- Twelve more models drew their cost from a similar model's rate. Mini and nano tiers read far too expensive (GPT-5 Nano 25× high, GPT-4.1 Nano 20×) and pro tiers far too cheap (GPT-5 Pro, GPT-5.2 Pro, o1-pro, o3-pro, and o3-deep-research all showed their base model's rate). GPT-5.3 Codex and o1-mini were on outdated rates
- GPT-5.6 Luna sizes its context gauge from an explicit 1,050,000-token window, still superseded by the window Codex reports for your tier

## [0.24.2] - 2026-07-24

### Added

- Context windows previously reported by a provider are loaded at startup and applied to historical views, so a Codex session shows the window its account tier actually gets rather than the model's published maximum. Local read, offline-safe, non-blocking
- Context windows also hydrate from the LiteLLM catalog, so newly released models size correctly without a CLI update

### Fixed

- The context gauge read roughly eight times fuller than reality on Claude Sonnet 4.7, which resolved to a 128K window against its real 1M. Sonnet 4 was affected by the same cause

## [0.24.1] - 2026-07-22

### Changed

- Session reads inherit the shared transcript provenance surface: entrypoint, meta/sidechain flags, original roles, cwd, and git branch flow through canonical transcripts

## [0.24.0] - 2026-07-22

### Changed

- Session reads inherit the shared discriminated event contract, normalized usage pricing, canonical transcripts, and isolated observed-session collection surface
- A provider-reported $0 session cost now displays as $0 rather than a catalog estimate

## [0.23.1] - 2026-07-21

### Security

- Clipboard and URL-opening helpers spawn platform tools with argument arrays instead of interpolated shell strings

### Fixed

- **2026-07 review backlog (CLI portion)**: quota-failure text wraps instead of rendering one character per line, the `today` date filter includes today in UTC-negative timezones, mouse clicks land on the clicked row, and configured model IDs reach the inference clients instead of being squashed to `haiku`
- Shared observed-session reads tolerate message-less summary/bookkeeping rows and retain unresolved top-level tool requests with stable fallback IDs

### Changed

- `sidekick quota` now exits non-zero when a requested provider's quota is unavailable (including `--all` and `--json` failure payloads), so scripts can detect failures
- The deprecated `quota --tier` flag (part of the removed z.ai observed-traffic estimator) is no longer accepted

## [0.23.0] - 2026-07-18

### Added

- **`sidekick statusline`** renders a warm, cache-only account/quota/burn footer without account bootstrap, pricing hydration, or quota network access
- **Quick capture** with `tasks add`, `tasks done`, `note add`, and `decision add`, using the shared atomic merge writers
- **`sidekick doctor` and `sidekick today`** provide cross-provider health diagnostics and a cache-only daily brief
- **`sidekick mcp`** exposes seven read-only facts tools for quota, burn rate, context pressure, tasks, decisions, notes, and composed project context over stdio MCP
- **Generic handoff deep links** through `handoff open --url-template`, with identifier-only placeholders and a no-open mode
- Failure-history, quality trend, code-impact, per-model churn/cost, and compaction-ledger summaries in terminal views

### Changed

- The Plans pipeline is active again: live plans persist to the shared plan store and carry per-step time, token, tool, and cost analytics into the dashboard
- Static readers use canonical symlink-aware project identity, including legacy-store fallback

## [0.22.0] - 2026-07-02

### Added

- **Date filter mode now actually filters by date**: The dashboard's `[D]ate` filter previously fell through to plain substring matching. It now parses `today`, `yesterday`, relative windows (`12h`, `2d`, `1w`), ISO days (`YYYY-MM-DD`), and `>`/`<` prefixes (`<2d` = older than two days); unparseable expressions show the red filter error while leaving the list unfiltered, and the overlay shows a grammar hint while empty
- **Mouse-capture toggle**: Press `M` in the dashboard (works on the splash screen too) or launch with `--no-mouse` to disable mouse tracking so terminal click-drag text selection and copy work again. The status bar shows `MOUSE OFF` while disabled; the interactive toggle persists to `cli-config.json`, the flag is per-run
- **Scrollable help overlay**: `?` help now windows its content with `j`/`k` scrolling and ▲/▼ indicators, so nothing is clipped on short terminals
- **Examples in `--help`**: The root command plus `quota`, `extract`, and `dump` append real invocation examples showcasing `quota --all`, `quota history`, `extract -i`, `dump --list`, and the global `--json` flag
- **Strict option validation**: `--provider` (root, `quota`, `quota history`, `peak`), `report --theme`, `tasks --status`, and `quota --tier` now reject unknown values at parse time with the allowed choices, instead of silently coercing typos to a default. `quota history` keeps its legacy `claude-code`/`z.ai` aliases
- **Confirmation before `account --remove`**: Both the Claude and Codex remove paths now print the resolved account and require an interactive y/N answer (default No). `-y`/`--yes` (or `--force`) skips the prompt; `--json` and non-TTY contexts require the flag and exit 1 otherwise — **unattended automation that removes accounts must add `--yes`**

### Fixed

- **`q` is typable in the filter box**: The quit key no longer swallows `q` while the filter overlay is open, so queries like `query` or `sqlite` work; `q` still closes the help/changelog/context-menu overlays and quits the dashboard otherwise
- **Panel keybindings are reachable**: Panel-declared bindings now win over the shadowable global keys while their condition holds — the Sessions panel's Mind Map `f` (filter nodes) binding works when the Mind Map tab is active, falling back to the global session filter elsewhere. Reserved keys (`q ? / M j k g G h` and digits) can never be shadowed by a panel
- **Overlays track terminal resize**: Filter, toast, context-menu, and changelog overlays reposition on resize and clamp their widths to narrow terminals; the splash `jump` hint reflects the real panel count instead of `1-5`; the Sessions summary tasks line no longer renders as `3/ completed`
- **Detail pane wraps to the actual layout**: Word-wrap now derives from the live side-panel width (narrow/normal/wide-side/expanded) instead of assuming the default 26-column panel, fixing under-/over-wrapping in three of the four layout modes
- **Overlay scroll clamps to content**: The `?` help and `V` changelog overlays no longer accumulate scroll past their last line — over-scrolling then reversing responds immediately, and the changelog overlay no longer shows a blank box when scrolled past the end

### Changed

- **Ctrl+C always quits the dashboard**, even while an overlay is open (previously it only closed the overlay)
- **`V` (changelog) and `r` (report) are inactive on the splash screen**; `q`, `?`, `M`, and panel digits still work there

## [0.21.6] - 2026-07-02

### Added

- **Codex reset credits in `sidekick quota`**: When Codex quota is fetched from the API (`--refresh`, or the API-first `--all` view), the Rate Limits output now includes a `Reset Credits: N available` line plus a per-credit `Expires` row (expiry timestamp and title) for each available reset grant

### Changed

- **Bundled `sidekick-shared` 0.21.6**: Picks up `fetchCodexResetCreditsFromApi()` and the reset-credits snapshot on Codex quota state

## [0.21.5] - 2026-06-30

### Fixed

- **`sidekick quota --all` no longer shows Codex at 0%**: Codex emits multiple rate-limit families per session (the aggregate plan quota plus per-model families like `codex_bengalfox`). A per-model family at 0% with a later reset window could mask the real plan quota in the local-data path; the aggregate family is now always preferred, so `--all` matches `--provider codex --refresh`. `quota --all` also fetches Codex API-first (with automatic local fallback), matching the live Claude/z.ai legs; the single-provider `quota --provider codex` stays local-by-default (live via `--refresh`)

### Changed

- **Bundled `sidekick-shared` 0.21.5**: Picks up the aggregate Codex rate-limit selection

## [0.21.4] - 2026-06-30

### Fixed

- **`sidekick quota` shows the logged-in account**: The account line now reflects the currently logged-in Claude/Codex account even after a native `claude /login` or `codex login`, instead of the stale saved registry pointer. The live Codex account is resolved once per invocation and reused across the fetch and the printed output

### Changed

- **Bundled `sidekick-shared` 0.21.4**: Picks up the live-first active-account resolvers

## [0.21.3] - 2026-06-23

### Changed

- **`sidekick quota` projects every provider**: Quota output is now rendered as a unified table with aligned `now` / `projected` / `resets` columns, and projected end-of-window utilization is shown for **all** providers (Claude, Codex, z.ai) — previously only Claude displayed a projection. A `—` placeholder appears when a projection is unavailable, and utilization bars are clamped to 0–100% so over-limit projections render cleanly. `sidekick quota --all` uses the same table for each provider section
- **Bundled `sidekick-shared` 0.21.3**: Picks up the quota projection helpers and the bounded synchronous CLI probes

### Security

- **npm audit**: Bumped `esbuild` to `^0.28.1` and `vitest` to `^4.1.9` to clear reported dev-dependency advisories

## [0.21.2] - 2026-06-22

### Changed

- **`sidekick quota --provider zai`** now renders authoritative z.ai plan utilization from z.ai's quota API (5-Hour / Weekly windows with real reset times) instead of estimating from observed OpenCode traffic, falling back to a cached snapshot when the API is unavailable. `sidekick quota --all` and `sidekick quota history --provider zai` use the same authoritative source
- **`--tier lite|pro|max|auto`** is deprecated and no longer affects the displayed utilization

## [0.21.1] - 2026-06-21

### Added

- **z.ai Coding Plan quota**: `sidekick quota --provider zai` derives and renders z.ai plan utilization from OpenCode traffic already on disk (5-Hour / Weekly windows with per-tier prompt budgets). `--tier lite|pro|max|auto` overrides the assumed plan tier (default `auto`). `sidekick quota --provider opencode` now auto-routes to z.ai quota when z.ai traffic is detected. `sidekick quota --all` includes the z.ai section when active
- **z.ai quota history heatmap**: `sidekick quota history --provider zai` renders a 13-week z.ai utilization heatmap for the current workspace, alongside the existing Claude and Codex heatmaps (now also in `--all`)

### Changed

- **Bundled `sidekick-shared` 0.21.1**: Picks up z.ai quota derivation and the OpenCode data directory resolution fix.

### Limitations

- z.ai quota is **estimated, not authoritative** — it reflects only the OpenCode traffic Sidekick observed on this machine/workspace (z.ai exposes no usage API) compared against provisional per-tier prompt budgets. z.ai is observed-only (no z.ai inference provider) and has no account management yet; with `--tier auto`, the tier is under-detected early in a cycle (use an explicit `--tier`); reset times are approximate unless a rate-limit error is trapped.

## [0.21.0] - 2026-06-21

### Added

- **Account login**: `sidekick account --login` starts the provider-isolated login flow for Claude Max or Codex and saves the authenticated profile without disturbing the active account until finalization
- **All-provider account view**: `sidekick account --provider all` lists Claude and Codex saved accounts together, including active state. JSON output returns provider-keyed account arrays and active ids
- **Terminal account helpers**: `sidekick account --launcher <name>` creates opt-in launchers for the selected account, and `--auto-switch <pct|off>` persists the CLI auto-switch threshold preference
- **Multi-provider quota output**: `sidekick quota --all` shows Claude and Codex quota state together — each provider degrades independently, so one provider's quota still prints even when the other is unavailable; `--all --json` emits a provider-keyed payload for automation

### Changed

- **Bundled `sidekick-shared` 0.21.0**: Picks up Account Management 2.0 acquisition, switching, terminal sync, quota auto-switch, and account schema exports.

## [0.20.0] - 2026-06-17

### Added

- **`sidekick extract`**: New one-shot command for pulling actionable assets out of recent Claude Code and Codex chats for exactly the current cwd. It extracts URLs, filesystem-validated file paths, commands the agent suggested for the user to run, and plan-mode plans. Output is grouped and colored by default, labels each item with its source agent, validates invalid `--type` and `--limit` values, preserves `inChat` and per-item provenance in `--json`, and offers `-i/--interactive` for a picker that opens URLs or copies selected paths, commands, and plans. `--provider claude-code` and `--provider codex` scope extraction to one agent; OpenCode is reported as unsupported for now

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing this feature in [#17](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/17), adapted from his MIT-licensed [`trawl`](https://github.com/B33pBeeps/trawl) project.

## [0.19.3] - 2026-06-17

### Changed

- **Bundled `sidekick-shared` projection contract**: The shared assistant-turn projection now exposes a v2 `timeline` array for interleaved reasoning, narration, and tool groups. This is a shared-library contract update for downstream consumers and does not change CLI behavior by itself

## [0.19.2] - 2026-06-15

### Changed

- **Bundled `sidekick-shared` 0.19.2**: The shared library gains a browser-safe assistant-turn projection module (`segmentAssistantTurn()`, `assistantTurnEventsFromSessionEvents()`, and mirrored Zod schemas) that segments an assistant turn into a compact Process + Answer shape, with Claude `Task` subagent refs surfaced without leaking prompt text — internal additions that don't change CLI behavior

## [0.19.1] - 2026-06-09

### Changed

- **Bundled `sidekick-shared` 0.19.1**: Model-ID pricing and context-window lookups (behind the dashboard's cost and context gauges) now tolerate padded or mixed-case IDs. The shared library also gains Zod boundary schemas, an `extractSessionEvents()` progress-unwrapping helper, and a `/schemas` subpath export for downstream consumers — internal additions that don't change CLI behavior

## [0.19.0] - 2026-06-09

### Added

- **Claude Opus 4.8 & Fable 5 support**: The dashboard's context-window gauge and cost estimates recognize `claude-opus-4-8` and `claude-fable-5` (both 1M-token context; Opus 4.8: $5/$25 per MTok, Fable 5: $10/$50 per MTok) via the shared model catalog

### Changed

- **Codex account switching now swaps `~/.codex/auth.json`**: `sidekick account --provider codex --switch-to <id>` (and `--add`) activates the account by atomically swapping its backed-up credentials into the system `~/.codex/` home, mirroring the Claude switch pattern — codex terminals outside Sidekick pick up the switch. Profile directories become pure credential backups, with a one-time startup migration for installs created under the old `CODEX_HOME`-redirection model. The command surfaces swap warnings on add, switch, and remove: a running codex process that needs restarting, stale credentials, or OS-keyring credential storage that Sidekick cannot swap

### Fixed

- **Opus 4.6/4.7 cost over-estimation**: Dashed model IDs fell back to the Opus 4.0 pricing tier ($15/$75 instead of $5/$25), inflating estimated costs 3×
- **Haiku 4.5 unpriced under dashed IDs**: Costs for `claude-haiku-4-5-*` sessions could render as "—" because no dashed static pricing key existed

## [0.18.5] - 2026-06-04

### Changed

- **Consistent Codex transcripts**: `sidekick dashboard` and `sidekick report` now parse Codex sessions via `parseTranscriptFromEvents()`, matching the canonical `SessionEvent` pipeline used by the other providers
- **Bundled `sidekick-shared` 0.18.5**: Picks up the new session context evidence snapshot API (`buildSessionContextSnapshot`, `readSessionContextSnapshot`, `SessionContextSnapshot` and related types) and the Codex session evidence gap closures — `system` audit events, normalized `token_count` rate limits, per-file `apply_patch` expansion, tool-emission dedupe, MCP server attribution, and the new `ProviderReaderSessionWatcher`

## [0.18.4] - 2026-05-27

### Added

- **`sidekick peak --provider <id>`**: New flag gates peak-hours output on the session provider. When the resolved provider is not `claude-code`, the command prints a "not applicable" message instead of calling the upstream endpoint

### Changed

- **Bundled `sidekick-shared` 0.18.4**: Picks up `scopePeakHoursToSessionProvider()`, `isClaudeCodeSessionProvider()`, `createPeakHoursNotApplicableState()` for peak-hours scoping, the improved Codex quota snapshot selection logic (`isPreferredQuotaHit`, `findAccountRolloutFiles`, `shouldKeepExistingSnapshot`), and the `notApplicable` field on `PeakHoursState`

## [0.18.3] - 2026-05-19

### Added

- **`sidekick quota history`**: New subcommand that renders a 13-week GitHub-contributions-style heatmap of quota utilization for the current workspace. Flags: `--weeks <n>` (1-26, default 13), `--provider claude|codex` (default both), `--workspace <path>` (default cwd). Bucketed glyphs (`· ░ ▒ ▓ █`) are color-coded by utilization band (≤0 / <25 / <50 / <75 / ≥75), with per-provider rows and a peak / avg / unavailable-days / samples footer. Days that hit `available: false` render as a red `×`. With `--json`, emits a `{ workspaceId, weeks, providers: { claude?, codex? }, generatedAt }` payload — the same shape consumed by the VS Code dashboard

### Changed

- **Bundled `sidekick-shared` 0.18.3**: Picks up the new per-workspace quota history surface (`appendQuotaHistorySample`, `readQuotaHistoryRange`, `readQuotaHistoryDailyBuckets`, `pruneQuotaHistory`, `getWorkspaceIdFromPath`) and the optional `workspaceId` / `appendHistorySample` hooks on `CodexQuotaWatcher`

## [0.18.2] - 2026-05-19

### Added

- **`sidekick quota --refresh`**: New flag on the `quota` command that, for Codex, explicitly refreshes from the ChatGPT usage API before falling back to local rollout data and cached snapshots. Without the flag, the Codex quota path stays fully local and makes no upstream network call

### Changed

- **Codex quota is local-only by default**: `sidekick quota --provider codex` now delegates to the new `resolveCodexQuota` orchestrator in `sidekick-shared`. It checks the current workspace's most recent rollout, then recent account-level rollouts under `CODEX_HOME/sessions`, then the active account's cached snapshot — no upstream network call unless `--refresh` is passed. Failure output continues to include structured `failureKind` / `httpStatus` / `retryAfterMs` fields under `--json`
- **Bundled `sidekick-shared` 0.18.2**: Picks up the new Codex quota orchestrator (`resolveCodexQuota`, `resolveCodexQuotaFromLocalSources`, `readLatestCodexQuotaFromRollouts`, `fetchCodexQuotaFromApi`), the relaxed `CodexRateLimits` shape (nullable `resets_at` / `window_minutes`), the rate-limit-only `token_count` event emission in `JsonlSessionWatcher`, and `state_N.sqlite` discovery in `CodexDatabase` + provider auto-detect

## [0.18.1] - 2026-05-08

### Changed

- **Shared dashboard formatting**: terminal dashboard `fmtNum()` and `formatDuration()` now delegate to `formatTokenCount()` and `formatDurationMs()` from `sidekick-shared`, keeping the existing CLI surface (uppercase `K`/`M` suffix, compact `1m5s` style) while removing forked rounding logic

## [0.18.0] - 2026-05-08

### Changed

- **Bundled `sidekick-shared` 0.18.0**: Picks up the new provider-aware quota orchestration surface — `MultiProviderQuotaService`, `CodexQuotaWatcher`, `getActiveAccountStatus()`, `extractToolCall()`, cost-provenance helpers (`calculateCostWithProvenance`, `mergeCostSources`), and model display helpers (`shortModelName`, `getModelDisplayInfo`, `compareModelIds`, `sortModelIds`). `parseModelId()` also now recognizes legacy Claude IDs such as `claude-3-opus-20240229` and `claude-3-5-sonnet-20241022`
- **No CLI runtime changes**: This release ships the shared library upgrade for downstream tooling alignment; `sidekick quota`, `sidekick status`, and the live dashboard keep using the existing polling path. Wiring the new orchestrator into the CLI will land in a follow-up release

## [0.17.7] - 2026-04-28

### Fixed

- **Quota snapshot write race**: Updated the bundled `sidekick-shared` snapshot writer so concurrent `sidekick quota` / Codex session updates no longer collide on `quota-snapshots.json.tmp` or throw `ENOENT`. Failed writes now also clean up their partial temp files instead of leaving orphans in `~/.config/sidekick/`

## [0.17.6] - 2026-04-19

### Added

- **`sidekick peak` command**: One-shot check for Claude's current peak-hours state — weekdays 13:00–19:00 UTC, when session limits drain faster on Free/Pro/Max/Team subscriptions. Prints a color-coded status block with a countdown to the next transition. Data comes from the public `promoclock.co/api/status` endpoint (third-party, unaffiliated with Anthropic) with a graceful fallback when unreachable. `--json` emits the full raw state
- **Peak-hours block in `sidekick status`**: When the active provider is `claude-code`, the Claude + OpenAI health blocks are now followed by a **Claude Peak Hours** block (off-peak or in-peak, with countdown). Gated on the provider so OpenCode / Codex users don't trigger an unnecessary third-party fetch. `--json` output includes the new `peak` field
- **Peak-hours summary in `sidekick quota`**: Claude subscription quota output now shows a **Peak** line under the 5-hour / 7-day bars — green dot off-peak, orange dot during an active peak, with a countdown to the next transition. `--json` output includes the new `peak` field

## [0.17.5] - 2026-04-18

### Added

- **Default account bootstrap at CLI startup**: The CLI now calls `ensureDefaultAccounts()` from `sidekick-shared` at module load and awaits the result inside a Commander `preAction` hook, so the first real subcommand blocks briefly on the bootstrap while `--version` and `--help` stay instant. When a system Claude Code or Codex credential exists and no saved account is active for that provider yet, the CLI registers it as "Default" — `sidekick quota`, `sidekick account`, and `sidekick stats` now reflect the active account on first run without requiring an explicit `sidekick account --add` first. Idempotent, never overwrites manually saved accounts, and all errors are swallowed so startup is never blocked

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing this feature in [#16](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/16).

## [0.17.4] - 2026-04-17

### Changed

- **Pricing hydration import migrated to `sidekick-shared/node`**: `cli.ts` now imports `hydratePricingCatalog` from the new Node-only subpath and keeps `detectProvider` on the package root. Runtime behavior is unchanged; the split makes the CLI's import surface self-documenting (hydration is explicitly a Node API) and aligns the CLI with the shared library's new versioned public API contract

## [0.17.3] - 2026-04-17

### Changed

- **Version sync with the VS Code extension**: Republished to keep CLI, extension, and shared-library versions aligned after a cosmetic changelog fix in 0.17.3. No CLI code changes — functionally identical to 0.17.2

## [0.17.2] - 2026-04-17

### Added

- **LiteLLM pricing hydration on startup**: The CLI now fetches the LiteLLM pricing catalog on startup and caches to `~/.config/sidekick/pricing-catalog.json` with a 24-hour TTL, 3s timeout, and stale-cache fallback — new model prices are picked up without a CLI upgrade
- **Expanded pricing coverage**: GPT-4o, GPT-4.1, GPT-5.x, o1, o3, and o3-mini families are now priced alongside the existing Claude entries
- **Real-dollar Codex / Claude Code costs**: `EventAggregator` computes cost from the pricing table when the session provider doesn't report one, so `sidekick` live dashboards now show actual dollars for Codex and Claude Code sessions
- **`stats` footer lists unpriced models**: `sidekick stats` prints any models encountered with no pricing entry so missing coverage is visible

### Fixed

- **Context-gauge % wrong for Opus 4.7 (1M) and other new models**: The dashboard's context gauge was dividing by 200K for Claude Opus 4.7 (native 1M), inflating the displayed %. The shared model → context-window map now includes Opus/Sonnet 4.7 (1M), GPT-5.4 (1.05M), GPT-5.3-Codex (400K), and GPT-5.3-Codex-Spark (128K). Claude Code's `[1m]` suffix is now also honored as an explicit 1M marker
- **Silent Sonnet-priced fallback for unknown models**: Codex, GPT-5.x, and o-series rows were being rendered at Sonnet rates. Unknown-model rows now render as `—` in yellow instead of inventing a dollar figure

### Changed

- **`historical-data.json` schema v2**: reads `priced` flag and `unpricedModelIds` from records written by the latest VS Code extension; v1 records still read correctly

## [0.17.1] - 2026-04-13

### Fixed

- **Codex multi-home session discovery**: Provider detection now scans all candidate Codex home directories, fixing missed sessions when the managed profile home is empty but the system `~/.codex/` has activity

## [0.17.0] - 2026-04-13

### Added

- **Multi-provider account management**: `sidekick account` now supports `--provider codex` for Codex profile management alongside Claude Code accounts
- **Codex account lifecycle**: `--add` prepares a profile and spawns `codex login`; `--switch-to` and `--remove` accept email, label, or profile ID
- **Quota snapshot fallback**: `sidekick quota` for Codex shows cached rate-limit snapshots when no active session exists, with "cached from" timestamp

### Fixed

- **Email normalization**: Claude account lookup normalizes email case for reliable matching

## [0.16.1] - 2026-03-27

### Fixed

- **Dashboard provider status scoping**: The TUI now shows degraded-service notices only for the monitored provider — Claude for Claude Code sessions, OpenAI for Codex sessions, and no status banner for OpenCode

## [0.16.0] - 2026-03-23

### Changed

- **Consistent cost formatting**: All cost displays (`stats`, `context`, Sessions panel, narrative prompt) now use shared `formatCost()` with intelligent decimal precision (4 places for < $0.01, 2 otherwise)
- **QuotaService**: Rewritten to wrap shared `QuotaPoller` with exponential backoff instead of manual polling loop
- **modelContext**: Now re-exports `getModelInfo` from shared library alongside `getContextWindowSize`

## [0.15.2] - 2026-03-18

### Fixed

- **CLI help descriptions**: Updated `quota` and `status` command descriptions to reflect provider-aware behavior
- **`sidekick quota --provider`**: Added local `--provider` option so `sidekick quota --provider codex` works naturally

## [0.15.0] - 2026-03-18

### Added

- **OpenAI status page monitoring**: CLI dashboard now shows OpenAI API status alongside Claude API status
- **Codex rate limits in dashboard**: Sessions panel displays Codex rate-limit data with "Rate Limits" header instead of "Quota"
- **Provider-aware `sidekick quota` command**: Detects active provider and shows Codex rate limits, Claude subscription quota, or an informational message for OpenCode

### Fixed

- **QuotaService polling for Codex**: Dashboard no longer starts Claude OAuth quota polling when the active provider is Codex

## [0.14.2] - 2026-03-16

### Fixed

- **Quota polling interval**: Reduced quota refresh from every 30 seconds to every 5 minutes to avoid unnecessary API calls
- **SessionsPanel `detailWidth()` call**: Removed unused parameter from `detailWidth()` in the Sessions panel quota rendering

## [0.14.1] - 2026-03-14

### Fixed

- **Per-model context window sizes**: Dashboard context gauge now shows correct utilization for Claude Opus 4.6 (1M context) and other models with non-200K windows

### Changed

- **Shared model context lookup**: CLI dashboard now uses the centralized `getModelContextWindowSize()` from `sidekick-shared` instead of a local duplicate map

## [0.14.0] - 2026-03-12

### Added

- **`sidekick account` Command**: Manage Claude Code accounts from the terminal — list saved accounts, add the current account with an optional label, switch to the next or a specific account, and remove accounts. Supports `--json` output for scripting
- **Quota Account Label**: `sidekick quota` now shows the active account email and label above the quota bars when multi-account is enabled
- **macOS Keychain Support**: `sidekick account` and `sidekick quota` now read and write credentials via the system Keychain on macOS, fixing account switching and quota checks on Mac

## [0.13.8] - 2026-03-12

### Changed

- **Structured quota failure output**: `sidekick quota` now renders consistent auth, rate-limit, server, network, and unexpected-failure copy from shared quota failure descriptors while preserving `--json` machine-readable output
- **Dashboard unavailable quota rendering**: The Sessions panel now shows Claude Code quota failures inline instead of hiding the quota section whenever subscription data is unavailable
- **Quota transition toasts**: The Ink dashboard now fires low-noise toast notifications only when Claude Code quota failure state changes, avoiding repeated alerts every polling interval

## [0.13.7] - 2026-03-11

### Changed

- **npm README sync**: Updated the published CLI package README to reflect current OpenCode monitoring behavior, platform-specific data directories, and the `sqlite3` runtime requirement
- **README badge cleanup**: Removed the Ask DeepWiki badge from the published CLI package README; the repo root README still keeps it

## [0.13.6] - 2026-03-11

### Changed

- **Refreshed CLI Dashboard Wordmark**: Updated the dashboard wordmark/header styling for a cleaner splash and dashboard identity

### Fixed

- **OpenCode dashboard startup**: OpenCode DB-backed session discovery now resolves projects by worktree, sandboxes, and session directory instead of quietly behaving like no session exists
- **OpenCode runtime notices**: The CLI now prints an OpenCode-only actionable notice when `opencode.db` exists but `sqlite3` is missing, blocked, or otherwise unusable in the current shell environment

## [0.13.5] - 2026-03-10

### Added

- **`sidekick status` Command**: One-shot Claude API status check with color-coded text output and `--json` mode
- **Dashboard Status Banner**: Status bar shows a colored `● API minor/major/critical` indicator when Claude is degraded; Sessions panel Summary tab shows an "API Status" section with affected components and active incident details. Polls every 60s

## [0.13.4] - 2026-03-08

### Fixed

- **Onboarding Phrase Spam**: Splash screen and detail pane motivational phrases memoized — no longer flicker every render tick (fixes [#13](https://github.com/cesarandreslopez/sidekick-agent-hub/issues/13))

### Changed

- **Simplified Logo**: Replaced 6-line ASCII robot art with compact text header in splash, help, and changelog overlays
- **Removed Dead Code**: Removed unused `getSplashContent()` and `HELP_HEADER` exports from branding module

## [0.13.3] - 2026-03-04

_No CLI-specific changes in this release._

## [0.13.2] - 2026-03-04

_No CLI-specific changes in this release._

## [0.13.1] - 2026-03-04

### Added

- **`sidekick quota` Command**: One-shot subscription quota check showing 5-hour and 7-day utilization with color-coded progress bars and reset countdowns — supports `--json` for machine-readable output
- **Quota Projections**: Elapsed-time projections shown in `sidekick quota` output and TUI dashboard quota section — displays projected end-of-window utilization next to current value (e.g., `40% → 100%`), included in `--json` output as `projectedFiveHour` / `projectedSevenDay`

## [0.13.0] - 2026-03-03

_No CLI-specific changes in this release._

## [0.12.10] - 2026-03-01

### Added

- **Events Panel** (key 7): Scrollable live event stream with colored type badges (`[USR]`, `[AST]`, `[TOOL]`, `[RES]`), timestamps, and keyword-highlighted summaries; detail tabs for full event JSON and surrounding context
- **Charts Panel** (key 8): Tool frequency horizontal bars, event type distribution, 60-minute activity heatmap using `░▒▓█` intensity characters, and pattern analysis with frequency bars and template text
- **Multi-Mode Filter**: `/` filter overlay now supports four modes — substring, fuzzy, regex, and date range — Tab cycles modes, regex mode shows red validation errors
- **Search Term Highlighting**: Active filter terms highlighted in blue within side list items
- **Timeline Keyword Coloring**: Event summaries in the Sessions panel Timeline tab now use semantic keyword coloring — errors red, success green, tool names cyan, file paths magenta

### Removed

- **Search Panel**: Removed redundant Search panel (previously key 7) — the `/` filter with multi-mode support serves the same purpose

## [0.12.9] - 2026-02-28

### Added

- **Standalone Data Commands**: `sidekick tasks`, `sidekick decisions`, `sidekick notes`, `sidekick stats`, `sidekick handoff` for accessing project data without launching the TUI
- **`sidekick search <query>`**: Cross-session full-text search from the terminal
- **`sidekick context`**: Composite output of tasks, decisions, notes, and handoff for piping into other tools
- **`--list` flag on `sidekick dump`**: Discover available session IDs before requiring `--session <id>`
- **Search Panel**: Search panel (panel 7) wired into the TUI dashboard

### Changed

- **`taskMerger` utility**: Duplicate `mergeTasks` logic extracted into shared `taskMerger` utility
- **Model constants**: Hardcoded model IDs extracted to named constants

### Fixed

- **`convention` icon**: Notes panel icon replaced with valid `tip` type
- **Linux clipboard**: Now supports Wayland (`wl-copy`) and `xsel` fallbacks, with error messages instead of silent failure
- **`provider.dispose()`**: Added to `dump` and `report` commands (prevents SQLite connection leaks)

## [0.12.8] - 2026-02-28

### Changed

- **Dashboard UI/UX Polish**: Visual overhaul for better hierarchy, consistency, and readability
  - Splash screen and help overlay now display the robot ASCII logo
  - Toast notifications show severity icons (✘ error, ⚠ warning, ● info) with inner padding
  - Focused pane uses double-border for clear focus indication
  - Section dividers (`── Title ────`) replace bare bold headers in summary, agents, and context attribution
  - Tab bar: active tab underlined in magenta, inactive tabs dimmed, bracket syntax removed
  - Status bar: segmented layout with `│` separators; keys bold, labels dim
  - Summary metrics condensed: elapsed/events/compactions on one line, tokens on one line with cache rate and cost
  - Sparklines display peak metadata annotations
  - Progress bars use blessed color tags for consistent coloring
  - Help overlay uses dot-leader alignment for all keybinding rows
  - Empty state hints per panel (e.g. "Tasks appear as your agent works.")
  - Session picker groups sessions by provider with section headers when multiple providers are present

## [0.12.7] - 2026-02-27

### Added

- **HTML Session Report**: `sidekick report` command generates a self-contained HTML report and opens it in the default browser
  - Options: `--session`, `--output`, `--theme` (dark/light), `--no-open`, `--no-thinking`
  - TUI Dashboard: press `r` to generate and open an HTML report for the current session

## [0.12.6] - 2026-02-26

### Added

- **Session Dump Command**: `sidekick dump` exports session data in text, markdown, or JSON format with `--format`, `--width`, and `--expand` options
- **Plans Panel Re-enabled**: Plans panel restored in CLI dashboard with plan file discovery from `~/.claude/plans/`
- **Enhanced Status Bar**: Session info display improved with richer metadata

### Fixed

- **Old snapshot format migration**: Restoring pre-0.12.3 session snapshots no longer shows empty timeline entries

### Changed

- **Phrase library moved to shared**: CLI-specific phrase formatting kept local, all phrase content now from `sidekick-shared`

## [0.12.5] - 2026-02-24

### Fixed

- **Update check too slow to notice new versions**: Reduced npm registry cache TTL from 24 hours to 4 hours so upgrade notices appear sooner after a new release

## [0.12.4] - 2026-02-24

### Fixed

- **Session crash on upgrade**: Fixed `d.timestamp.getTime is not a function` error when restoring tool call data from session snapshots — `Date` objects were serialized to strings by JSON but not rehydrated on restore, causing the session monitor to crash on first run after upgrading from 0.12.2 to 0.12.3

## [0.12.3] - 2026-02-24

### Added

- **Latest-node indicator**: The most recently added node in tree and boxed mind map views is now marked with a yellow indicator
- **Plan analytics in mind map**: Tree and boxed views now display plan progress and per-step metrics
  - Tree view: plan header shows completion stats; steps show complexity, duration, tokens, tool calls, and errors in metadata brackets
  - Box view: progress bar with completion percentage; steps show right-aligned metrics; subtitle shows step count and total duration
- **Cross-provider plan extraction**: Shared `PlanExtractor` now handles Claude Code (EnterPlanMode/ExitPlanMode) and OpenCode (`<proposed_plan>` XML) plans — previously only Codex plans were shown
- **Enriched plan data model**: Plan steps include duration, token count, tool call count, and error messages
- **Phase-grouped plan display**: When a plan has phase structure, tree and boxed views group steps under phase headers with context lines from the original plan markdown
- **Node type filter**: Press `f` on the Mind Map tab to cycle through node type filters (file, tool, task, subagent, command, plan, knowledge-note) — non-matching sections render dimmed in grey

### Fixed

- **Kanban board regression**: Subagent and plan-step tasks now correctly appear in the kanban board

### Changed

- **Plans panel temporarily disabled**: The Plans panel in the CLI dashboard is disabled until plan-mode event capture is reliably working end-to-end. Plan nodes in the mind map remain active.
- `DashboardState` now delegates to shared `EventAggregator` instead of maintaining its own aggregation logic

## [0.12.2] - 2026-02-23

### Added

- **Update notifications**: The dashboard now checks the npm registry for newer versions on startup and shows a yellow banner in the status bar when an update is available (e.g., `v0.13.0 available — npm i -g sidekick-agent-hub`). Results are cached for 24 hours to avoid repeated network requests.

## [0.12.1] - 2026-02-23

### Fixed

- **VS Code integration**: Fixed exit code 127 when the extension launches the CLI dashboard on systems using nvm or volta (node binary not found when shell init is bypassed)

## [0.12.0] - 2026-02-22

### Added

- **"Open CLI Dashboard" VS Code Integration**: New VS Code command `Sidekick: Open CLI Dashboard` launches the TUI dashboard in an integrated terminal
  - Install the CLI with `npm install -g sidekick-agent-hub`

## [0.11.0] - 2026-02-19

### Added

- **Initial Release**: Full-screen TUI dashboard for monitoring agent sessions from the terminal
  - Ink-based terminal UI with panels for sessions, tasks, kanban, mind map, notes, decisions, search, files, and git diff
  - Multi-provider support: auto-detects Claude Code, OpenCode, and Codex sessions
  - Reads from `~/.config/sidekick/` — the same data files the VS Code extension writes
  - Usage: `sidekick dashboard [--project <path>] [--provider <id>]`
