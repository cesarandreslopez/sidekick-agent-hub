# Substrate & Features Roadmap

Status: implemented for v0.23.0
Scope: `sidekick-shared`, `sidekick-vscode`, `sidekick-cli`
Sequencing: phases are ordered by dependency; Phase 0 unblocks everything else and ends in an npm publish of `sidekick-shared` and `sidekick-agent-hub`.

## Motivation

A full audit of the three packages (feature inventory, dropped-data audit, gap-signal scan, and competitor research across ccusage, Claudia/opcode, sniffly, claude-powerline, vibe-kanban, Conductor, claude-squad, tokscale, and the hook-notifier ecosystem) reached three conclusions:

1. **Sidekick's ingestion already captures far more than its UI shows.** Typed fields are parsed and then dropped downstream: per-call tool error categories, exact Codex compaction deltas, Codex diff churn, OpenCode error/retry taxonomy, per-step plan timing, per-turn attribution, MCP server usage. The cheapest features are the ones where only aggregation and surfacing are missing.
2. **Sidekick's durable value is as a provider-facts substrate.** It is the only tool that normalizes Claude Code, OpenCode, and Codex sessions behind one event model, with authoritative quota APIs for three vendors, multi-account management, and honest cost accounting — published as a reusable npm library. Generic agent command centers are commoditizing (provider-native apps now ship multi-session supervision and remote control), so the roadmap invests in facts, not fleets.
3. **Several editor/terminal-native conveniences have no other home** and are repeatedly loved in the ecosystem: a statusline provider, terminal quick capture, a doctor command, a daily brief, and onboarding.

Accordingly, this spec deliberately **excludes** capabilities that require an always-on host outside the editor and terminal: remote approval push (blocking PreToolUse → phone → Allow/Deny), escalating budget-alert delivery, model-routing UI, tray/menu-bar ambience, team/org dashboards, contribution-graph gamification, and MCP server config management. Those belong to downstream consumers of the `sidekick-shared` npm package; this repo's job is to make the substrate they build on complete, versioned, and safe to upgrade.

## Phase 0 — Substrate hardening

Goal: the published library reports true numbers, exposes one blessed API per concern, and can be upgraded by downstream consumers without archaeology. This phase gates the npm publish.

### 0.1 Real Codex compaction deltas (data integrity)

Current state: Codex emits exact `tokens_before`/`tokens_after` on context compaction (`CodexContextCompactedEvent` in `sidekick-shared/src/types/codex.ts`), but `handleContextCompacted`/`handleCompacted` in `sidekick-shared/src/parsers/codexParser.ts` keep only the summary string. The aggregator then *estimates* compaction as a 20% context drop.

Change: pass the reported token counts through the parser onto the emitted event; in `EventAggregator`, build the `CompactionEvent` from reported numbers when present and fall back to the heuristic otherwise. Extend `CompactionEvent` with `source: 'reported' | 'heuristic'` and bump `SNAPSHOT_SCHEMA_VERSION` (serialized snapshot shape changes).

Acceptance: a fixture Codex rollout with a `context_compacted` event produces a `CompactionEvent` whose before/after match the rollout exactly and whose `source` is `reported`.

### 0.2 Codex diff churn counted (data integrity)

Current state: `sidekick-vscode/src/utils/lineChangeCalculator.ts` computes additions/deletions from old/new strings and returns 0 for Codex synthetic Edit tools, even though `patch_applied`/`apply_patch` events carry `input.additions`/`input.deletions` (`sidekick-shared/src/parsers/codexParser.ts`).

Change: `calculateLineChanges` prefers `input.additions`/`input.deletions` when present. Per-session lines added/removed becomes correct for Codex sessions.

Acceptance: a Codex session fixture with two `patch_applied` events shows the summed additions/deletions in the dashboard file-changes stat instead of 0/0.

### 0.3 Tool error taxonomy computed at shared ingest

Current state: `ToolCall.errorCategory` is typed in `sidekick-shared/src/types/sessionEvent.ts` (permission / not_found / timeout / syntax / exit_code / tool_error / other) but only the VS Code extension computes it, privately: `categorizeError()` in `sidekick-vscode/src/services/SessionMonitor.ts` (~line 2668). The CLI and library consumers never see categories.

Change: move `categorizeError`/`extractErrorMessage` into a new `sidekick-shared/src/extractors/errorTaxonomy.ts`, call it from `sidekick-shared/src/extractors/toolCall.ts` so every ingest path populates `errorCategory`; the extension delegates to the shared implementation. Fold OpenCode's provider error types (`AuthError`/`APIError`/`OutputLengthError` from `parsers/openCodeParser.ts`) into the same taxonomy.

Acceptance: `ToolCall.errorCategory` is populated for Claude Code, OpenCode, and Codex fixtures via the shared path; the extension's error panel renders identically before/after.

### 0.4 Cleanup debts

- **Slug unification**: `getProjectSlug` (resolves symlinks) vs `getProjectSlugRaw` in `sidekick-shared/src/paths.ts` forces every reader to try both and still misses relocated projects. Introduce one blessed resolution helper used by writers and readers alike; keep a fallback read of the legacy variant.
- **One z.ai quota API**: stop exporting the deprecated observed-traffic estimator surface (`zaiQuota.ts`, `zaiQuotaWatcher.ts`, ~15 exports) from `index.ts`; `zaiQuotaApi.ts` is the single authoritative path. Mark a major-ish minor bump note in the changelog for any external users.
- **Safe SQL substitution**: `OpenCodeDatabase.query` uses first-match `replace('?', ...)` (a value containing `?` shifts later placeholders); switch to the index-based replacer already used by `CodexDatabase.query`.
- **Single source for DB row types**: `CodexDbThread` is defined divergently in `src/types/codex.ts` and `src/providers/codexDatabase.ts`; `DbProject` likewise for OpenCode. Keep one definition each.
- **Retire the `ClaudeSessionEvent` alias** internally (the deprecated re-export can remain one more release for external consumers).

Acceptance: `bash scripts/lint-all.sh` clean; all three test suites green; grep shows no internal imports of the deprecated names.

### 0.5 Public-API consumer fixtures

Current state: nothing pins the shape of the surface external consumers depend on; upgrades are leaps of faith.

Change: add a fixture test suite in `sidekick-shared` that locks the publicly consumed API: quota (`resolveCodexQuota`, `CodexQuotaWatcher`, `readQuotaHistoryDailyBuckets`, quota types), accounts (`ensureDefaultAccounts`, `getActiveAccountStatus`, account schemas), session monitoring (`SessionMonitor`, `extractSessionEvents`, `JsonlParser`, `SessionEvent`/`AggregatedMetrics` shapes), assets (`gatherAssetsForCwd`), cost (`calculateCost`, `getModelContextWindowSize`), and the turn/reasoning contracts (`reasoningSummary`, `turnSegmentation`, `turnSubagents`, `ContextAttribution`). Failures on these fixtures are release blockers.

Acceptance: deleting or reshaping any covered export fails the suite with a message naming the consumer-facing contract.

## Phase 1 — Restore the Plans pipeline

The loudest live TODO cluster in the repo: plan capture is disabled across all three packages while the Plans UI still ships (`sidekick-cli/src/commands/dashboard.ts:77` — commented `inferPlanStatus`/`toPersistedStep`/`persistPlan`; `sidekick-vscode/src/providers/DashboardViewProvider.ts:639` and `:2306` — plan history handlers disabled; changelog: "Plan UI surfaces temporarily disabled").

Work: a time-boxed investigation (why did EnterPlanMode/ExitPlanMode + Edit-tool capture break?) followed by re-enabling persistence end-to-end, and wiring the typed-but-never-populated per-step analytics (`PlanStep.startedAt/completedAt/durationMs/tokensUsed/toolCalls/costUsd`) in `EventAggregator.convertExtractedPlanToPlanState`.

Acceptance: a live plan-mode session in the Extension Development Host produces a plan visible in the Plans board and the CLI Plans panel, persisted under `~/.config/sidekick/plans/`, with per-step timing populated for at least started/completed steps.

## Phase 2 — Editor/terminal-native quick wins

### 2.1 `sidekick statusline` (effort M)

A one-line, cache-only status renderer for agent CLI footers (Claude Code `statusLine`, Codex footer): `acct:work · 5h 68% resets 14:00 · ~41min left`.

- New CLI command that reads **only caches** — `readQuotaSnapshot` (`sidekick-shared/src/quotaSnapshots.ts`), `getActiveAccountStatus` — and must bypass the commander `preAction` account bootstrap and the fire-and-forget pricing hydration in `sidekick-cli/src/cli.ts` so render cost is milliseconds, every prompt.
- Shared formatter in `sidekick-shared/src/statusline/` so any consumer can render the same line; move `BurnRateCalculator.estimateTimeToQuota` (currently only exercised by tests in `sidekick-vscode`) into shared as part of this.
- VS Code command "Install Statusline" that writes/merges the `statusLine` block into `~/.claude/settings.json` (new: today the extension never writes that file) with a clean uninstall path.

Acceptance: `time sidekick statusline` under 100ms warm; the installed statusline renders inside a live Claude Code prompt; uninstalling restores the previous settings block.

### 2.2 CLI quick capture (effort M)

Write parity for the terminal: `sidekick tasks add "…"` / `tasks done <id>` / `note add` / `decision add`.

- New `sidekick-shared/src/writers/` module mirroring `readers/`: atomic write (temp file + rename), preserve `schemaVersion`/`lastSaved`, reuse the decision fingerprint dedup semantics and the note-shape semantics the extension uses today.
- The atomic writer also becomes the safety net for the extension's debounced last-writer-wins saves (`TaskPersistenceService`, `DecisionLogService`) — adopt it there in the same change.
- CLI subcommands registered in `sidekick-cli/src/cli.ts`, reusing the existing slug resolution of the read commands.

Acceptance: `sidekick tasks add` from a terminal shows up in the VS Code kanban without restart; concurrent extension + CLI writes do not corrupt the store (test with interleaved writes).

### 2.3 `sidekick doctor` (effort M)

One command that answers "why is Sidekick showing nothing?": dual-slug mismatch detection (`paths.ts` raw vs resolved), OpenCode `sqlite3` availability (`OpenCodeDatabase.getRuntimeStatus`), account/credential status (`getActiveAccountStatus`), provider API health (`fetchProviderStatus`), session-folder discovery, and deprecated-settings detection in the extension variant.

- New `sidekick-shared/src/doctor.ts` producing a typed `HealthReport`; lift the aggregate logic of `getSessionDiagnostics` out of `sidekick-vscode` into shared so both surfaces share checks.
- `sidekick doctor` CLI command; `sidekick.doctor` VS Code command rendering the same report.

Acceptance: on a symlinked project directory, doctor names the slug mismatch and the repair; with `sqlite3` missing it prints the existing actionable OpenCode notice.

### 2.4 `sidekick today` (effort S)

One-screen daily brief: yesterday's `history.daily` row (reuse `stats.ts` formatting), open tasks + newest decision + latest handoff via `composeContext`, quota snapshot, peak-hours line. Explicitly **not** building the weekly HTML digest (needs a new cross-window aggregator and a redaction engine; not worth it now).

Acceptance: `sidekick today` renders in one screen with no network calls beyond the existing cached quota/peak paths.

### 2.5 VS Code onboarding walkthrough (effort M)

Current state: no `contributes.walkthroughs`, no first-run flow, ~55 commands and 9 views discoverable only by exploration.

Change: a four-step declarative walkthrough (detect a live session; open the dashboard; pin/read the status bar; capture a first knowledge note), completion events wired from existing session-start plumbing in `extension.ts`. Extend the existing `sidekick.showMenu` quick-pick as the single command hub — generate its catalog from the extension's own `contributes.commands` at runtime so it cannot drift; do not add a third overlapping surface.

Acceptance: fresh-install Extension Development Host shows the walkthrough in Get Started; all four steps complete by doing the described actions.

## Phase 3 — Shared analytics engines

Engine in `sidekick-shared`, compact views in Sidekick surfaces. Dense visualization is left to downstream consumers.

### 3.1 Failure forensics (effort L)

Persistent, queryable answer to "why do my sessions go sideways", built on Phase 0.3:

- Error-taxonomy rollup in `AggregatedMetrics` (per-tool × category counts, bucketed by hour/model), computed in `EventAggregator` alongside existing `toolStats`.
- Append-only cross-session error-history store under the config dir, modeled on `quotaHistory.ts`, written at session end.
- OpenCode retry attempts and finish reasons (parsed today, rendered as text only) folded into the rollup.
- Surfaces: a `sidekick stats` errors section and a dashboard panel extension of the existing grouped-error rendering.

Acceptance: after two sessions with induced tool failures, the history store contains categorized entries and the CLI can print "top failing tools, last 7 days".

### 3.2 Session quality score & durable trends (effort L)

- Pure scoring function in shared over `AggregatedMetrics` + session-end summary signals (latency, error rate, compactions, permission-mode time, goal-gate/task completion) producing a 0–100 composite with per-factor contributions.
- **Historical-data schema v3**: add a capped per-session records array plus provider and project dimensions to `historicalData.ts` (shared and the extension mirror), with retention limits. This is also the prerequisite for a future cross-provider efficiency bench (deferred).
- Week-over-week trend rendering in the dashboard History tab; factor breakdown as the per-session post-mortem.

Risks: score weights need calibration — ship as "beta" labeling until tuned; cap record growth.

### 3.3 Code impact meter (effort S, after 0.2)

`costPerChangedLine = totalCost / (additions + deletions)` plus a per-model churn×cost table. The inputs already exist (`SessionSummaryService._buildFileChanges`, `_buildCostByModel`); this is one derived layer, a dashboard tile, and a `stats` line. Depends on 0.2 so Codex sessions aren't divide-by-zero.

### 3.4 Honest compaction ledger (effort S, after 0.1)

Add "N compactions · X tokens evicted · ~$Y re-establishing context" to the existing compaction sections (dashboard Context Compactions list, CLI summary line), using reported deltas and `calculateCostWithPricing` for the re-establishment estimate, labeled by `source`.

## Phase 4 — Public substrate contracts

### 4.1 Read-only `sidekick mcp` facts server

Expose Sidekick's facts to the running agent so it can check its own budget mid-run: `get_quota_status`, `get_burn_rate`, `get_context_pressure`, `get_tasks`, `get_decisions`, `get_notes`, `get_project_context` — thin wrappers over the one-shot quota path in `sidekick-cli/src/commands/quota.ts`, `EventAggregator.getBurnRate()`, the session-context pressure helpers, the persistence readers, and `composeContext()`.

Deliberately **read-only**: no write-back tools. Mutation of the shared stores stays with hosts that can enforce policy; this server serves facts.

Implementation: `sidekick mcp` subcommand hosting a stdio MCP server (`@modelcontextprotocol/sdk`), plus a docs page showing the one-line registration for Claude Code and Codex.

Acceptance: a Claude Code session with the server registered can answer "how much of my 5-hour window is left?" from the tool, matching `sidekick quota` output.

### 4.2 Versioned observed-session contracts

New in `sidekick-shared`, designed for downstream consumers that build supervision or adoption flows on top of the substrate:

- `ProviderSessionAdapterV1` — uniform discover/read/watch interface over the three providers.
- `ObservedAgentSessionV1` — a session as observable facts (identity, cwd, model, activity, usage), independent of any UI.
- `ProviderCapabilitiesV1` — what a provider supports (resume, fork lineage, quota source, asset extraction) so consumers can feature-gate honestly.
- `PendingUserRequestV1` — a normalized "the agent is waiting on a human" record derived from transcripts.
- `SessionEvidenceRefV1` — stable references into transcripts/events for audit trails.
- Provenance and confidence fields on every derived value (`reported` / `estimated` / `inferred`), extending the pattern already used by cost provenance.

Each ships with Zod schemas under `src/schemas/` and fixtures under 0.5's suite.

### 4.3 Generic external-handoff deep link

A configurable URL-template setting (e.g. `sidekick.handoffUrlTemplate`) plus a VS Code command and CLI subcommand that render the template with identifiers only (session id, provider, project path) and open it. This lets any external tool register itself as a session-handoff target without Sidekick knowing its name.

## Release

Phases 0–2 constitute the publish milestone:

1. `bash scripts/lint-all.sh`, all three package test suites, `zensical build --strict` for docs.
2. Version bump via `bash scripts/bump-version.sh` + lockfile sync in all three workspaces (maintainer decides patch vs minor).
3. All five changelogs updated; no orphan `[Unreleased]` headings.
4. Tag `v*` on `main` → CI publishes the extension, `sidekick-shared`, and `sidekick-agent-hub`.

Phases 3–4 follow in subsequent releases; 4.2 warrants its own minor bump since it is new public API.
