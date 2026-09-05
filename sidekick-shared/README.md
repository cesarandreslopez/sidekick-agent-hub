# sidekick-shared

Shared data access library for [Sidekick Agent Hub](https://github.com/cesarandreslopez/sidekick-agent-hub).

[![npm version](https://img.shields.io/npm/v/sidekick-shared.svg)](https://www.npmjs.com/package/sidekick-shared)
[![license](https://img.shields.io/npm/l/sidekick-shared.svg)](https://github.com/cesarandreslopez/sidekick-agent-hub/blob/main/LICENSE)

Types, parsers, providers, readers, formatters, aggregation, search, reporting, credentials, and quota for AI agent session monitoring. Used by both the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) and the [CLI dashboard](https://www.npmjs.com/package/sidekick-agent-hub).

## Recent additions

- **One token vocabulary and cost provenance (unreleased)** — `summarizeTokens()` gives every surface the same `total` (input + output + cache writes + cache reads) and `context` (input + cache) figures; `AggregatedTokens.costUsd` carries `costProvenance` so reports can say whether a cost was provider-reported or estimated; `parseClaudeStatuslinePayload()` / `quotaFromStatuslinePayload()` turn Claude Code's status-line JSON into an official `statusline` quota source; `readQuotaSnapshot()` reports `ageMs` / `freshness`; `getScheduledPeakHoursState()` and `evaluateQuotaThresholds()` are shared by the CLI and extension dashboards.
- **Host-safe APIs (0.25.0)** — `listSessionPreviewsAsync()` / `readSessionPreviewAsync()` read previews with bounded concurrency and cooperative yielding; `ObservedSessionCollector.subscribe()` and `SessionMonitor.subscribe()` replace host polling loops with debounced change batches; `createSessionProviders({ onDiagnostic })` constructs every usable provider with structured diagnostics instead of throwing; `findSessionById()` resolves one session without scanning; `exportResolvedModelCatalog()` / `importResolvedModelCatalog()` and `registerModelAlias()` transfer context/pricing resolutions across realms; `onAccountsChanged()` reports login/logout/switch events; provider constructors perform no environment I/O, and quota pollers stay dormant without an account.
- **Native session-file helpers** — `encodeClaudeWorkspacePath()` / `getClaudeSessionDirectory()` locate Claude Code's `~/.claude/projects/` directories with the real on-disk encoding, `findCodexRolloutFile()` resolves a Codex session id to its rollout path, `readCodexHistory()` tail-reads `~/.codex/history.jsonl`, `listSessionPreviews()` / `readSessionPreview()` build a cheap stat-first recent-sessions index across providers, and `parseMcpToolName()` splits `mcp__<server>__<tool>` identifiers (browser-safe).
- **Non-blocking account APIs & locked sync writers** — every login/switch entry point gains an async variant (`switchAccountAsync()`, `getAccountLoginStatusAsync()`, `finalizeAccountLoginAsync()`, `prepareCodexAccountAsync()`, `finalizeCodexAccountAsync()`, `switchToCodexAccountAsync()`) that keeps `codex` CLI probes off the event loop, and synchronous callers get the same cross-process store lock via `atomicWriteFileSync()` / `updateJsonStoreAtomicSync()` / `withFileLockSync()`, with progress-based timeouts and abandoned-lock reclaim.
- **Canonical usage and pricing** — provider-specific counters normalize into disjoint input/cache/output/reasoning categories with `normalizeProviderUsage()`; `calculateNormalizedUsageCost()` prevents cache/reasoning double counting and reports pricing provenance.
- **Transcripts and resilient collection** — `projectSessionTranscript()` is browser-safe; Node consumers can use `listRecentSessions()`, `readSessionTranscript()`, and `ObservedSessionCollector` across Claude Code, Codex, and OpenCode readers.
- **Shared token estimation** — `estimateTextTokens()` / `estimateSerializedTokens()` provide an injectable exact-counter path and the stable tokenizer-free `sidekick-fallback-v1` heuristic.
- **Observed-session V1 contracts** — versioned provider-neutral `ObservedAgentSessionV1` / `ProviderCapabilitiesV1` / `PendingUserRequestV1` shapes with `createProviderSessionAdapterV1()` adapters and matching Zod schemas in [`sidekick-shared/schemas`](#supported-import-paths).
- **Atomic writers** — `addTask()`, `completeTask()`, `addDecision()`, and `addNote()` merge into the shared task/decision/note stores atomically, so concurrent CLI and extension captures are never lost.
- **Doctor report** — `runDoctor()` builds a typed cross-provider health report (project identity, sessions, accounts, providers, dependencies); `formatHealthReport()` renders it for terminals.
- **Analytics engines** — `scoreSessionQuality()` (beta) with weekly trends via `calculateQualityTrend()`, `calculateCodeImpact()` for cost per changed line and per-model churn, and `calculateCompactionLedger()` for reported-vs-heuristic compaction accounting.
- **Error taxonomy & history** — `categorizeError()` assigns one shared taxonomy at ingest, and `appendErrorHistory()` / `getTopFailingTools()` keep an append-only per-project failure history.
- **Statusline & burn rate** — `formatStatusline()` and `BurnRateCalculator` render a cache-only account/quota/burn footer, importable from the new [`sidekick-shared/statusline`](#supported-import-paths) subpath.
- **Codex reset credits** — `fetchCodexResetCreditsFromApi()` reads ChatGPT's reset-credit endpoint into a `CodexResetCreditsSnapshot`, and `fetchCodexQuotaFromApi()` attaches it to the returned quota state (preserved across session-sourced snapshot writes).

See the [full changelog](https://github.com/cesarandreslopez/sidekick-agent-hub/blob/main/CHANGELOG.md) for everything.

## Installation

```bash
npm install sidekick-shared
```

Requires Node 20 or newer. The only npm dependency is `zod` (v4) — if your app
also uses zod, keep it on `^4` so schemas from this package validate against
your instance.

### External runtime requirement: `sqlite3`

`OpenCodeProvider` and the database helpers behind it read their session store by
shelling out to an executable **`sqlite3` on `PATH`**. There is no bundled
driver. `CodexProvider` shells out to the same binary, but only for an optional
index.

Without it, database-backed reads still return results rather than throwing —
but as of 0.25.0 the missing binary is no longer invisible: Codex and OpenCode
attach a `sqlite_missing` diagnostic to affected operations, so an unavailable
runtime is distinguishable from an empty workspace. Construct providers through
`createSessionProviders({ onDiagnostic })` to receive those diagnostics, or ask
any provider directly — `getRuntimeStatus()` is implemented by all three:

```typescript
const status = provider.getRuntimeStatus?.();
// status.kind: 'available' | 'db_missing' | 'sqlite_missing'
//            | 'sqlite_blocked' | 'query_failed' | ...
if (status && status.kind !== 'available') {
  console.warn(`Session data degraded: ${status.kind}`);
}
```

`CodexProvider` uses the Codex `state.sqlite` database only as an index and
falls back to scanning rollout JSONL files, so it keeps working without
`sqlite3`. `ClaudeCodeProvider` reads JSONL transcripts directly and needs
nothing extra.

### Overriding the config directory

Every reader and writer resolves `~/.config/sidekick` (`%APPDATA%/sidekick` on
Windows) lazily through `getConfigDir()`. Redirect it with either:

```typescript
import { setConfigDir } from 'sidekick-shared';

setConfigDir('/tmp/sidekick-fixture'); // in-process; pass null to clear
```

or the `SIDEKICK_CONFIG_DIR` environment variable, which takes effect for the
whole process and is read fresh on every call. `setConfigDir()` wins when both
are set. `getConfigDir()` returns the resolved root, `getConfigDirOverride()`
returns the active in-process override or `null`, and `getDefaultConfigDir()`
returns the platform default that both overrides bypass.

## API Overview

| Module                          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Types**                       | Session events, OpenCode/Codex format types, persistence schemas (tasks, decisions, notes, plans, historical data)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Paths**                       | Config directory resolution, project data paths, workspace encoding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Readers**                     | Read tasks, decisions, notes, history, handoff, and plans from `~/.config/sidekick/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Writers**                     | Atomic persistence writers — `atomicWriteJson()` / `updateJsonStoreAtomic()` and their synchronous twins `atomicWriteJsonSync()` / `atomicWriteFileSync()` / `updateJsonStoreAtomicSync()` / `withFileLockSync()` (same cross-process lock file, progress-based timeouts, abandoned-lock reclaim), plus lock-coordinated capture helpers `addTask()`, `completeTask()`, `addDecision()`, `addNote()` that merge into the shared stores without clobbering concurrent writers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Providers**                   | Session provider abstraction with Claude Code, OpenCode, and Codex implementations; auto-detection via filesystem. As of 0.25.0 constructors perform no environment I/O — build them all with `createSessionProviders({ onDiagnostic })`, which reports unavailable providers as structured diagnostics instead of failing; `findSessionById()` resolves one session through provider-native indexes; stable provider-id const arrays (`SESSION_PROVIDER_IDS`, `ACCOUNT_PROVIDER_IDS`, `QUOTA_PROVIDER_IDS`, `MODEL_PROVIDER_IDS`) accompany the derived unions                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Observed Sessions (V1)**      | Versioned provider-neutral observation contracts — `createProviderSessionAdapterV1()` / `derivePendingUserRequestV1()` with `ObservedAgentSessionV1`, `ProviderCapabilitiesV1`, `PendingUserRequestV1`, `SessionEvidenceRefV1`, and provenance/confidence wrapper types (Zod schemas in `sidekick-shared/schemas`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Parsers**                     | JSONL event parsing, OpenCode/Codex format normalization, subagent scanning, session path resolution, debug log parsing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Watchers**                    | Live session file watching with event bridging, plus `createJsonlTail()` for raw incremental JSONL consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Formatters**                  | Display helpers (`formatTokenCount()`, `formatDurationMs()`), tool summary, noise classification, session dump (text/markdown/JSON), event highlighting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Search**                      | Cross-session full-text search, advanced filtering (substring, fuzzy, regex, date)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Aggregation**                 | Event aggregation, frequency tracking, activity heatmaps, pattern extraction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Analytics**                   | Session-quality scoring (beta) with factor contributions and weekly trends (`scoreSessionQuality()`, `calculateQualityTrend()`), code-impact metrics including cost per changed line and per-model churn/cost (`calculateCodeImpact()`), and reported-vs-heuristic compaction accounting (`calculateCompactionLedger()`, `formatCompactionLedger()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Error History**               | Shared error taxonomy (`categorizeError()`, `extractErrorMessage()`) plus append-only per-project failure history (`appendErrorHistory()`, `readErrorHistory()`, `getTopFailingTools()`) behind per-tool/hour/model error rollups                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Session Context**             | Provider-neutral context evidence snapshots (`buildSessionContextSnapshot()`, `calculateSessionContextPressure()`, `createSessionContextProjector()`, `readSessionContextSnapshot()`): layered evidence sources, low/medium/high context pressure, and observed capabilities (tools, MCP servers, permission mode, rate limits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Assistant Turns**             | Browser-safe timeline/process/answer projection for provider-normalized assistant turns (`segmentAssistantTurn()`, `assistantTurnEventsFromSessionEvents()`), including interleaved reasoning, compact tool groups, and Claude `Task` subagent refs without prompt leakage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Report**                      | Self-contained HTML session report generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Credentials**                 | Claude Max OAuth credential reading from `~/.claude/.credentials.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Quota**                       | Claude Max subscription quota fetching (5-hour and 7-day windows), Codex rate-limit extraction from event streams (plus Codex reset credits via `fetchCodexResetCreditsFromApi()`, attached to quota state by `fetchCodexQuotaFromApi()`), and authoritative z.ai Coding Plan quota fetching via `resolveZaiQuota()` / `fetchZaiQuotaFromApi()` (reads z.ai's `api/monitor/usage/quota/limit` endpoint with cached-snapshot fallback). The observed-traffic z.ai estimator was removed from the package root exports in 0.23.0 and every remaining export of it is `@deprecated` — `resolveZaiQuota()` is the single supported z.ai quota API                                                                                                                                                                                                                                                                                                                                    |
| **Provider Status**             | API health checking via status.claude.com and status.openai.com (indicator, components, incidents)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Doctor**                      | Typed cross-provider health diagnostics — `runDoctor()` checks project identity, sessions, accounts, providers, and dependencies into a `HealthReport`; `formatHealthReport()` renders it and `getSessionDiagnostics()` exposes the per-provider session probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Schemas**                     | Zod schemas for runtime validation of data crossing process/IPC boundaries — JSONL session events (`sessionEventSchema`, `messageUsageSchema`, `sessionMessageSchema`), assistant turns, observed-session V1 records, quota, account status, account management, and quota history — plus `extractSessionEvents()` to unwrap `progress`-wrapped events. Account and quota APIs guarantee results valid against the same-release schemas. Also published fs-free via the [`sidekick-shared/schemas`](#supported-import-paths) subpath                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Extractors**                  | Pure functions for single-event processing: `extractTokenUsage()`, `extractToolCall()` (top-level `tool_use`), `extractToolCalls()` (assistant content blocks), plus Node-only session asset extraction (`gatherAssetsForCwd()`, `readClaudeAssets()`, `readCodexAssets()`) for URLs, file paths, commands, and plans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Model Info & Pricing**        | Model family parsing (Anthropic / OpenAI / Google, including legacy `claude-3-opus-…` and `claude-3-5-sonnet-…` IDs), context-window lookup (including Fable 5 / Opus 4.8 / Opus 4.7 / Sonnet 4.7 1M and GPT-5.x variants), pricing tables with optional LiteLLM hydration, normalized non-double-counting cost (`calculateNormalizedUsageCost()`, fed by `normalizeProviderUsage()` / `extractNormalizedUsage()`), legacy cost helpers retained but deprecated (`calculateCost()`, `calculateCostWithProvenance()`), `mergeCostSources()`, display helpers (`shortModelName()`, `getModelDisplayInfo()`, `compareModelIds()`, `sortModelIds()`, `formatCost()`), and cross-realm catalog transfer — `exportResolvedModelCatalog()` / `importResolvedModelCatalog()` move resolved context windows and pricing (with provenance, prefix inheritance explicit) between Node and browser realms, and `registerModelAlias()` resolves short or host-specific names to canonical ids |
| **Quota Polling**               | `QuotaPoller` class with exponential backoff, active/idle intervals, and cached fallback. Stays dormant while no account exists and wakes through the account-change signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Multi-Provider Quota**        | `MultiProviderQuotaService` orchestrates Claude polling + peak-hours + account labels + Codex/z.ai quota updates behind one typed event stream. `CodexQuotaWatcher` watches the active Codex rollout for live rate limits with snapshot fallback; z.ai quota uses the API resolver with snapshot fallback. All three stay dormant without a matching account and wake on account changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Accounts**                    | Multi-provider account registry (v2) with per-provider active account, save/switch/remove, v1 migration, `ensureDefaultAccounts()` for first-run bootstrap of the active system Claude/Codex credentials as a "Default" saved account, `getActiveAccountStatus()` for a single-pass active-account read across providers, `onAccountsChanged()` for push-based login/logout/switch notification (process-local mutations, filesystem watches, and a catch-up poll), and live-first `resolveActiveClaudeAccount()` / `resolveActiveCodexAccount()` that report the currently logged-in account (self-healing the saved pointer) for display                                                                                                                                                                                                                                                                                                                                       |
| **Account Management 2.0**      | Provider-neutral acquisition + switching: `beginAccountLogin()` / `getAccountLoginStatus()` / `finalizeAccountLogin()` / `spawnAccountLogin()` drive a TTY-less, profile-isolated login that doesn't disturb the active account until finalization; `listAllAccounts()` and `switchAccount()` expose a shared switcher across Claude and Codex. Every status/finalize/switch entry point also has an `-Async` variant (`getAccountLoginStatusAsync()`, `finalizeAccountLoginAsync()`, `switchAccountAsync()`, …) that keeps `codex` CLI probes off the event loop — prefer those from hosts with a UI loop. Claude accounts get canonical profile homes with account-scoped macOS keychain suffixes and startup migration from legacy flat backups                                                                                                                                                                                                                               |
| **Terminal sync & auto-switch** | Opt-in terminal profile pointers, shell-hook/launcher helpers, and a default-off `AutoSwitchController` (`decideAutoSwitch()`) that moves to a healthier saved account when quota crosses a configured threshold; its `switchAccount` callback may return a Promise and defaults to `switchAccountAsync()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Codex Profiles**              | Codex account lifecycle — prepare, finalize, switch, remove — switching atomically swaps the profile's backed-up credentials into the system `~/.codex/auth.json`, with rotated-token staleness protection, one-time dual-home migration, and legacy multi-home session monitoring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Quota Snapshots**             | Persistent quota caching per provider/account for offline fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Statusline**                  | Cache-only one-line account/quota/burn footer — `formatStatusline()`, `selectStatuslineAccount()`, `BurnRateCalculator`, and `estimateTimeToQuota()`, also published via the [`sidekick-shared/statusline`](#supported-import-paths) subpath for fast per-prompt rendering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Phrases**                     | Curated humorous phrases for loading/idle states, available as a flat `ALL_PHRASES` array or grouped via `PHRASE_CATEGORIES` for category-aware UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Supported import paths

`sidekick-shared` ships three public entry points plus a few convenience subpaths. Pick the one that matches your runtime. As of 0.25.0 every documented subpath declares explicit `types` / `import` / `require` / `default` export conditions and resolves under Vite and TypeScript's legacy `moduleResolution: node` without consumer-side aliases.

| Path                           | Runtime                    | What it exposes                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidekick-shared`              | Node (CLI, extension host) | Full public API (readers, providers, parsers, pricing, …).                                                                                                                                                                                                                                                                                                                                                                    |
| `sidekick-shared/browser`      | **Browser / webview**      | Pure helpers: usage normalization/pricing, token estimation, transcript and assistant-turn projection, model/context math, `parseMcpToolName()`.                                                                                                                                                                                                                                                                              |
| `sidekick-shared/node`         | Node only                  | LiteLLM pricing and context-window hydration, observed context-window persistence, recent-session/transcript reads, session previews (`listSessionPreviews()` / `readSessionPreview()` plus the bounded-concurrency `listSessionPreviewsAsync()` / `readSessionPreviewAsync()`), Codex history/rollout lookup (`readCodexHistory()`, `findCodexRolloutFile()`), and resilient observed-session collection (`fs` + providers). |
| `sidekick-shared/phrases`      | Any runtime                | Phrase arrays + `getRandomPhrase()`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `sidekick-shared/modelContext` | Any runtime                | Direct access to the context-window module.                                                                                                                                                                                                                                                                                                                                                                                   |
| `sidekick-shared/modelInfo`    | Any runtime                | Direct access to model parsing and cost math.                                                                                                                                                                                                                                                                                                                                                                                 |
| `sidekick-shared/formatting`   | Any runtime                | Direct access to pure token and duration display helpers.                                                                                                                                                                                                                                                                                                                                                                     |
| `sidekick-shared/schemas`      | Any runtime                | Pure Zod boundary schemas (session events, assistant turns, observed-session V1, quota, account status, account management, quota history) — fs-free, no Node builtins.                                                                                                                                                                                                                                                       |
| `sidekick-shared/statusline`   | Node only                  | Cache-only statusline surface: account status + quota snapshot readers, `formatStatusline()`, and burn-rate estimates.                                                                                                                                                                                                                                                                                                        |

### Browser / webview runtimes

Import from `sidekick-shared/browser`. **Do not import the package root from browser code** — the root re-exports Node-only pricing hydration and can drag `node:fs` / `node:path` into your bundle.

```typescript
import {
  getModelContextWindowSize,
  DEFAULT_CONTEXT_WINDOW,
  parseModelId,
  normalizeProviderUsage,
  calculateNormalizedUsageCost,
  estimateTextTokens,
  projectSessionTranscript,
  formatCost,
  formatTokenCount,
  formatDurationMs,
  segmentAssistantTurn,
} from 'sidekick-shared/browser';
```

### Node / CLI / extension host

Hydrate the model catalog from the `node` subpath. One fetch covers both prices and context window sizes:

```typescript
import { hydratePricingCatalog, loadObservedContextWindows } from 'sidekick-shared/node';

// cacheDir defaults to the Sidekick config dir, which honors
// SIDEKICK_CONFIG_DIR and setConfigDir(). Pass it only to place the cache
// somewhere else — and pass a real path, since `~` is not expanded.
const { entries, contextWindowEntries } = await hydratePricingCatalog();

// Context windows a provider reported on an earlier run. These outrank the
// catalog, which only knows each model's published maximum — Codex reports the
// window your account tier actually gets. Local read, offline-safe.
await loadObservedContextWindows();
```

Both calls always resolve; a network failure, missing cache, or malformed store leaves lookups on the static tables. To record a window a provider reports at runtime, call `recordObservedContextWindow(modelId, window)` — it persists only when the value changes.

### Transfer resolved model data across realms

A realm that can hydrate (extension host, CLI) can hand its resolved context
windows and pricing to one that cannot (webview, browser bundle) as one
serializable snapshot — no private hooks, no re-hydration:

```typescript
// Node side (after hydratePricingCatalog / loadObservedContextWindows):
import { exportResolvedModelCatalog } from 'sidekick-shared';
const snapshot = exportResolvedModelCatalog(); // or pass specific model ids

// Browser side:
import { importResolvedModelCatalog, registerModelAlias } from 'sidekick-shared/browser';
const { imported, diagnostics } = importResolvedModelCatalog(snapshot);
```

Entries carry provenance (`source`, `match`, `matchedModelId`, and
`inheritedByPrefix` for pricing), so consumers can reject prefix-inherited
guesses. Unresolved entries (`default` window / `none` pricing) are skipped on
import rather than pinned, successive partial imports merge, and imported data
ranks below anything the importing realm has observed first-hand.
`registerModelAlias('sonnet', 'claude-sonnet-5')` resolves short or
host-specific names everywhere lookups happen; data recorded under the alias id
itself keeps winning over the canonical fallback.

### Normalize and price provider usage

```typescript
import { normalizeProviderUsage, calculateNormalizedUsageCost } from 'sidekick-shared/browser';

const usage = normalizeProviderUsage({
  semantics: 'openai',
  provider: 'openai',
  model: 'gpt-4o',
  inputTokens: 1_000,
  cacheReadTokens: 300,
  outputTokens: 200,
  reasoningTokens: 40,
});

// uncached=700, cacheRead=300, billableOutput=200, total=1200.
// Reasoning remains visible but is not counted twice because OpenAI includes it in output.
const priced = calculateNormalizedUsageCost({ usage });
// { costUsd: number | null, source: 'provider-reported' | 'model-catalog' | ... }
```

For `SessionEvent`s, `extractNormalizedUsage(event)` prefers the parser-attached `message.normalizedUsage` and falls back to normalizing the event's raw `usage` with `sidekick` semantics.

Anthropic cache-read and cache-write counters are additive to `inputTokens`. OpenAI/Codex cached input is a subset of `inputTokens`. Provider-reported costs, including zero, are authoritative; an unknown model returns `costUsd: null` with `source: 'unpriced'`.

`calculateCost()`, `calculateCostWithPricing()`, `calculateCostWithProvenance()`, `CostTokenUsage`, and `CostProvenanceInput` remain available for compatibility but are deprecated. Their legacy contract always adds `reasoningTokens` to output and cannot express inclusion semantics.

### Estimate tokens without a base tokenizer dependency

```typescript
import { estimateTextTokens } from 'sidekick-shared/browser';

const estimate = estimateTextTokens(sourceCode, {
  model: 'claude-sonnet-4-6',
  exactCounter: optionalModelCounter,
});
```

`sidekick-fallback-v1` counts Latin/source-code text at 3.5 characters per token, CJK code points at one token, emoji at two, and other non-ASCII code points at one. Empty input is zero. An injected finite, nonnegative exact result takes precedence.

### Read canonical session history

```typescript
import { CodexProvider, listRecentSessions, readSessionTranscript } from 'sidekick-shared';

const provider = new CodexProvider();
const [recent] = listRecentSessions(provider, workspacePath, { limit: 10 });
const transcript = readSessionTranscript(provider, recent.sessionPath, {
  fidelity: 'full', // default is bounded 2,000-character snippets
});
```

The same API works with `ClaudeCodeProvider` and `OpenCodeProvider`. It covers provider sessions discoverable by those readers. Remote Claude SDK-only history and Codex history entries whose rollout file has disappeared are not synthesized.

Canonical transcript messages retain provider-origin facts on `message.source`, including the original role, entrypoint, meta/sidechain flags, and source identifiers. Transcript-level `cwd` and `gitBranch` use the latest non-empty value reported by the provider. Consumers can therefore distinguish a human Claude Code CLI prompt without reparsing JSONL:

```typescript
const humanCliPrompts = transcript.messages.filter(
  (message) =>
    message.source.originalRole === 'user' &&
    message.source.entrypoint === 'cli' &&
    message.source.isMeta !== true &&
    message.source.isSidechain !== true,
);
```

For an already-open incremental Codex rollout, keep one `CodexRolloutParser` per stream and pass each parsed `SessionEvent[]` batch to `projectSessionTranscript()` (or append the events to an existing projection). This preserves parser state for paired tool calls, model context, and cumulative token deltas; consumers should not convert raw `response_item` rows themselves.

### Locate provider-native session files

The library exports the same primitives its providers use to find session files on disk, so consumers never need to hand-roll path encoding or directory walks:

```typescript
import {
  getClaudeSessionDirectory, // ~/.claude/projects/<encoded workspace>
  encodeClaudeWorkspacePath, // the encoding itself, if you need the raw string
  discoverSessionDirectory, // mismatch-tolerant lookup — prefer this for reads
  findAllClaudeSessions,
  findCodexRolloutFile, // Codex session id -> rollout file path
  readCodexHistory, // bounded tail of ~/.codex/history.jsonl, newest first
} from 'sidekick-shared';

const sessions = findAllClaudeSessions('/home/user/code/my-project');

const [latest] = readCodexHistory({ limit: 1 });
const rolloutPath = latest ? findCodexRolloutFile(latest.sessionId) : null;
```

> **Naming trap:** the top-level `encodeWorkspacePath` export is Sidekick's own config-store slug (it keeps dots) and does **not** match Claude Code's directory scheme. For `~/.claude/projects/` paths always use `encodeClaudeWorkspacePath` — or better, `getClaudeSessionDirectory` / `discoverSessionDirectory`, which tolerate encoding drift.

For a cross-provider "recent sessions" surface, `listSessionPreviews()` enumerates stat-only, sorts by mtime, applies `since`/`limit`, and only then does bounded content reads for the survivors — so cost tracks the size of the answer, not the size of the history:

```typescript
import { ClaudeCodeProvider, CodexProvider, listSessionPreviews } from 'sidekick-shared';

const previews = listSessionPreviews([new ClaudeCodeProvider(), new CodexProvider()], {
  limit: 10,
  since: lastRefreshTime, // optional incremental refresh
});
// -> [{ provider, sessionId, filePath, modifiedAt, sizeBytes,
//       firstUserPrompt, firstTimestamp, workspacePath }, ...]
```

`readSessionPreview(provider, filePath)` reads the same bounded preview for one known session file — `null` when the file is missing or unreadable, `null` fields when its content is malformed.

Hosts with a UI loop should prefer the async variants from `sidekick-shared/node`. They read with bounded concurrency, yield between files, batch Codex/OpenCode label lookups into non-blocking `sqlite3` subprocesses, and — unlike their sync twins — return degradation status alongside the data:

```typescript
import { listSessionPreviewsAsync, readSessionPreviewAsync } from 'sidekick-shared/node';

const { previews, diagnostics } = await listSessionPreviewsAsync(providers, { limit: 10 });
const { preview } = await readSessionPreviewAsync(provider, filePath);
```

To resolve one session id to its file without scanning, every bundled provider implements `findSessionById(workspacePath, sessionId)` — a filename join for Claude Code and Codex, a database lookup for OpenCode — returning `null` for misses instead of reading transcripts. (It is optional on the `SessionProviderBase` interface so pre-0.25 external implementations keep compiling; fall back to `findAllSessions()` when absent.)

MCP tool identifiers (`mcp__<server>__<tool>`) split with `parseMcpToolName(name)` — first-double-underscore rule, `null` for malformed names, safe in browser bundles.

### Collect observed sessions with isolation and retry

```typescript
import { ObservedSessionCollector, observedSessionSourceFromProvider } from 'sidekick-shared/node';

const collector = new ObservedSessionCollector({
  sources: providers.map((provider) => observedSessionSourceFromProvider(provider, workspacePath)),
  onObservation: ({ value }) => consume(value),
  onDiagnostic: (diagnostic) => log(diagnostic),
});

await collector.collect(); // scheduling remains the host's responsibility
```

Each provider-backed source also exposes the same adapter's `ProviderCapabilitiesV1` record used for its reads and lifecycle:

```typescript
const source = observedSessionSourceFromProvider(provider, workspacePath);
applyReadOnlyProjection(source.capabilities);
```

Discovery and reads are isolated, retries use bounded 30-second-to-5-minute exponential backoff, file changes bypass delay, duplicate identical failures are suppressed, and recovery emits a content-free diagnostic. Clock and fingerprint callbacks are injectable for deterministic hosts/tests.

As of 0.25.0, parses are cached by fingerprint — a second `collect()` over unchanged files performs no content reads (cache hits refresh `observedAt` and activity state; `contentObservedAt` reports how old the cached usage/model data actually is, and `cacheHit` marks them). Observations expose structured `fingerprintParts: { sizeBytes, mtimeMs }` alongside the opaque fingerprint string, and diagnostics carry `severity` and `phase` in addition to their existing `kind`.

Instead of a host polling loop, subscribe to debounced change batches. Each change carries the previous and current fingerprints; filesystem watching is combined with a catch-up poll for filesystems that drop events:

```typescript
const subscription = collector.subscribe(
  (batch) => {
    for (const change of batch.changes) {
      // change.type: 'added' | 'changed' | 'removed'
      console.log(batch.providerId, change.type, change.reference.sessionId);
      console.log(change.previousFingerprint, '→', change.fingerprint);
    }
    void collector.collect(); // consume changed sessions through the parse cache
  },
  { debounceMs: 250, pollIntervalMs: 30_000 },
);
// later: subscription.dispose();
```

`SessionMonitor.subscribe()` offers the same push model at the session-event level.

## Usage Examples

### Construct session providers for a long-lived host

`createSessionProviders()` builds every requested provider without probing the
filesystem or binaries — constructors are I/O-free as of 0.25.0, so one
unavailable provider cannot abort host startup. Environmental failures surface
on first use as structured diagnostics instead:

```typescript
import { createSessionProviders } from 'sidekick-shared';

const { providers, diagnostics } = createSessionProviders({
  onDiagnostic: (diagnostic) => {
    // e.g. { providerId: 'opencode', kind: 'sqlite_missing',
    //        severity: 'warning', phase: 'query', message: '...' }
    log(diagnostic);
  },
});
```

Repeated identical degradations are coalesced, so the diagnostic stream stays
bounded across long-lived polling and subscription cycles.

### Detect the active session provider

For a single-provider surface, auto-detect and construct just one:

```typescript
import {
  detectProvider,
  ClaudeCodeProvider,
  OpenCodeProvider,
  CodexProvider,
} from 'sidekick-shared';

const providerId = detectProvider(); // 'claude-code' | 'opencode' | 'codex'
const provider =
  providerId === 'opencode'
    ? new OpenCodeProvider()
    : providerId === 'codex'
      ? new CodexProvider()
      : new ClaudeCodeProvider();

console.log(`Active provider: ${provider.displayName}`);
const sessions = provider.findAllSessions('/path/to/project');
```

### Read persisted tasks

```typescript
import { readTasks, resolveProjectIdentity } from 'sidekick-shared';

// A bare string is treated as an already-encoded slug. Pass a project
// identity to resolve a working directory — that also gets you the
// legacy-slug fallback for stores written before symlink resolution.
const project = resolveProjectIdentity('/path/to/project');
const tasks = await readTasks(project, { status: 'pending' });
console.log(`Found ${tasks.length} tasks`);
```

### Check provider status

```typescript
import { fetchProviderStatus } from 'sidekick-shared';

const status = await fetchProviderStatus();
if (status.indicator !== 'none') {
  console.log(`Claude API: ${status.description}`);
  for (const c of status.affectedComponents) {
    console.log(`  ${c.name}: ${c.status}`);
  }
}
```

### Check Claude peak-hours state

```typescript
import { fetchPeakHoursStatus } from 'sidekick-shared';

// Third-party endpoint: promoclock.co/api/status (unaffiliated with Anthropic).
// Returns a `unavailable: true` fallback on any network or parse error.
const peak = await fetchPeakHoursStatus();
if (!peak.unavailable && peak.isPeak) {
  console.log(`${peak.label} — off-peak in ${peak.minutesUntilChange}m`);
}
```

### Fetch subscription quota

```typescript
import { fetchQuota, readClaudeMaxCredentials } from 'sidekick-shared';

// Returns a Promise — without `await`, the object is always truthy and
// `accessToken` is undefined, which surfaces later as an auth failure.
// Use `readClaudeMaxAccessTokenSync()` from a synchronous call site.
const creds = await readClaudeMaxCredentials();
if (creds) {
  const quota = await fetchQuota(creds.accessToken);
  if (quota.available) {
    console.log(`5-hour utilization: ${quota.fiveHour.utilization}%`);
  } else {
    console.log(quota.failureKind, quota.httpStatus, quota.retryAfterMs);
  }
}
```

Unavailable quota responses remain non-throwing and may include:

- `failureKind`: `auth | network | rate_limit | server | unknown`
- `httpStatus`: HTTP response status when available
- `retryAfterMs`: retry delay in milliseconds for `429` responses when the API provides `Retry-After`

For first-party style messaging, `describeQuotaFailure()` maps unavailable quota states to stable alert keys plus display-ready severity/title/message/detail fields for CLI and VS Code consumers.

### Model info and cost calculation

```typescript
import {
  getModelInfo,
  normalizeProviderUsage,
  calculateNormalizedUsageCost,
  formatCost,
} from 'sidekick-shared';

const info = getModelInfo('claude-sonnet-4-6-20260321');
console.log(info.family, info.version, info.contextWindow); // "sonnet" "4.6" 1000000

// Normalize first: providers disagree about whether cached and reasoning
// tokens are already counted in the input/output totals.
const usage = normalizeProviderUsage({
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 200,
  cacheWriteTokens: 0,
  semantics: 'anthropic',
});
const { costUsd } = calculateNormalizedUsageCost({
  usage,
  modelId: 'claude-sonnet-4-6-20260321',
});
console.log(formatCost(costUsd)); // "$0.01"
```

`calculateCost()` still works but is deprecated — it predates the
cache/reasoning normalization above and misprices OpenAI-style usage, where
cached tokens are already included in the input count.

### Extract token usage and tool calls from events

```typescript
import { extractTokenUsage, extractToolCall, extractToolCalls } from 'sidekick-shared';

const usage = extractTokenUsage(event); // TokenUsage | null
const tools = extractToolCalls(event); // ToolCall[]    — assistant content blocks
const toolFromEvent = extractToolCall(event); // ToolCall | null — top-level `tool_use` events
```

### Extract actionable assets from recent sessions

Use the Node-only root API to collect URLs, filesystem-validated paths, commands the agent suggested for the user to run, and plan-mode plans from recent Claude Code and Codex sessions for exactly one working directory.

This API powers `sidekick extract` and was contributed by [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie), adapted from his MIT-licensed [`trawl`](https://github.com/B33pBeeps/trawl) project.

```typescript
import { gatherAssetsForCwd } from 'sidekick-shared';

const assets = gatherAssetsForCwd({
  cwd: '/path/to/project',
  agents: ['claude', 'codex'],
  caps: { url: 20, path: 20, command: 20, plan: 10 },
});

console.log(assets.urls);
console.log(assets.paths);
console.log(assets.commands);
console.log(assets.plans);

// Each item keeps stable text/display fields plus optional provenance:
// { agent: 'claude' | 'codex', sessionPath, source }
console.log(assets.urls[0]?.agent);
```

The extractor is safe for CLI and VS Code extension-host code, but not for browser or webview bundles because it reads session files and validates paths with Node filesystem APIs.

### Project session context evidence

Build a provider-neutral snapshot of what an assistant has "seen" in a session — layered evidence sources, context pressure, and observed capabilities. Read it through any session provider, or build it directly from a canonical `SessionEvent[]`.

```typescript
import { ClaudeCodeProvider, readSessionContextSnapshot } from 'sidekick-shared';

const provider = new ClaudeCodeProvider();
const snapshot = readSessionContextSnapshot(provider, '/path/to/session.jsonl');

console.log(snapshot.pressure); // 'low' | 'medium' | 'high'
console.log(snapshot.contextTokens, '/', snapshot.contextWindow);
console.log(snapshot.capabilities.observedTools, snapshot.capabilities.mcpServers);
console.log(snapshot.sources.length, 'evidence sources');
```

Use `createSessionContextProjector()` for incremental updates as new events stream in, or `calculateSessionContextPressure(contextTokens, contextWindow)` for the pressure band alone.

### Project an assistant turn into Timeline + Process + Answer

Build a compact UI-safe projection from provider-normalized turn events. The final contiguous text run becomes `answer`; earlier narration, tools, and reasoning stay in `process` / `reasoningBlocks`, and `timeline` preserves their interleaved arrival order for rendering.

```typescript
import {
  assistantTurnEventsFromSessionEvents,
  segmentAssistantTurn,
} from 'sidekick-shared/browser';

const projection = segmentAssistantTurn(assistantTurnEventsFromSessionEvents(sessionEvents));

console.log(projection.answer);
console.log(projection.timeline);
console.log(projection.process.steps);
console.log(projection.subagents); // Claude Task spawns, prompt text omitted
```

### Format shared dashboard values

```typescript
import { formatTokenCount, formatDurationMs, formatCost } from 'sidekick-shared';

console.log(formatTokenCount(15_000)); // "15.0k"
console.log(formatDurationMs(330_000)); // "5m 30s"
console.log(formatCost(0.0045)); // "$0.0045"
```

### Validate JSONL events with Zod schemas

```typescript
import { JsonlParser, sessionEventSchema } from 'sidekick-shared';

const parser = new JsonlParser(
  { onEvent: (e) => console.log(e), onError: (e) => console.warn(e) },
  { schema: sessionEventSchema },
);
parser.processChunk(rawData);
```

The boundary schemas — `sessionEventSchema` plus the quota, account-status, account-management, and quota-history schemas — are also importable fs-free from `sidekick-shared/schemas`, which keeps Zod out of bundles that only need the pure math/formatting helpers. Account and quota APIs are guaranteed to return values valid against the schemas exported in the same release, so consumers do not need to parse those library results again. Additive account or quota fields are added to the matching exported schema in the same release. `extractSessionEvents()` from the same subpath unwraps Claude Code `progress`-wrapped events into canonical `SessionEvent[]`.

### Tail raw JSONL events incrementally

Use `createJsonlTail()` when a consumer needs raw parsed events and owns its own aggregation lifecycle. `onBatchComplete` fires once after each drained byte chunk, which lets callers defer expensive UI or metrics updates until parsing for that chunk is complete.

```typescript
import { createJsonlTail, sessionEventSchema } from 'sidekick-shared';

const tail = createJsonlTail({
  path: '/path/to/session.jsonl',
  schema: sessionEventSchema,
  onEvent: (event) => aggregator.processEvent(event),
  onBatchComplete: () => renderMetrics(aggregator.getMetrics()),
  onError: (error) => console.warn(error.message),
});

tail.start();
```

### Poll quota with backoff

```typescript
import { QuotaPoller } from 'sidekick-shared';

const poller = new QuotaPoller({
  activeIntervalMs: 300_000,
  idleIntervalMs: 300_000,
  getAccessToken: async () => token,
});
poller.onUpdate((state) => console.log(state));
poller.start();
```

### Orchestrate quota across Claude and Codex

```typescript
import { MultiProviderQuotaService } from 'sidekick-shared';

const service = new MultiProviderQuotaService({
  // Optional — when set, an internal CodexQuotaWatcher is created and managed.
  codexWorkspacePath: '/path/to/project',
});

service.onUpdate(({ claude, codex }) => {
  if (claude) console.log('Claude:', claude.fiveHour.utilization, claude.peakHours?.label);
  if (codex) console.log('Codex:', codex.fiveHour.utilization, codex.accountLabel);
});

service.startPolling();
// service.setPollingMode('active'); // tighter cadence while a session is live
// service.updateProviderQuota('codex', codexQuota); // externally push Codex quota snapshots
// service.dispose();
```

Or run the Codex watcher standalone (e.g. inside an existing polling loop):

```typescript
import { CodexQuotaWatcher } from 'sidekick-shared';

const watcher = new CodexQuotaWatcher('/path/to/project');
watcher.onUpdate((state) => console.log(state.fiveHour.utilization, state.accountLabel));
watcher.start();
```

### Read active account status across providers

```typescript
import { getActiveAccountStatus } from 'sidekick-shared';

const status = getActiveAccountStatus();
if (!status.ok) console.log('No saved account active');
console.log(status.claude.present, status.claude.email);
console.log(status.codex.present, status.codex.label);
```

To react to logins, logouts, and switches without polling that status yourself,
subscribe to `onAccountsChanged()`. It combines process-local mutation signals,
filesystem watches on the account stores, and a low-frequency catch-up poll —
and only emits when the status actually changed:

```typescript
import { onAccountsChanged } from 'sidekick-shared';

const subscription = onAccountsChanged(
  ({ reason, status }) => {
    // reason: 'local' | 'filesystem' | 'poll'
    render(status.claude, status.codex);
  },
  { emitCurrent: true },
);
// later: subscription.dispose();
```

`QuotaPoller`, `MultiProviderQuotaService`, and `CodexQuotaWatcher` use the same
signal internally: they stay dormant while no matching account exists and wake
when one appears.

For display surfaces that must reflect the **currently logged-in** account — even after a native `claude /login` or `codex login` outside Sidekick — use the live-first resolvers. They prefer the live provider auth (`~/.claude/.claude.json` oauthAccount; the `~/.codex/auth.json` id_token JWT) over the saved `activeByProvider` pointer, fall back to the registry, and self-heal the saved pointer on an unambiguous match (best-effort, never creating or deleting profiles):

```typescript
import { resolveActiveClaudeAccount, resolveActiveCodexAccount } from 'sidekick-shared';
import type { ResolvedActiveAccount } from 'sidekick-shared';

const claude: ResolvedActiveAccount = resolveActiveClaudeAccount();
// source: 'live'  → identity came from the live provider auth (label filled when it matches a saved profile)
// source: 'registry' → no usable live identity; fell back to the saved active pointer
// source: 'none'  → neither a live identity nor a saved active account
console.log(claude.email, claude.label, claude.source);

const codex = resolveActiveCodexAccount();
```

### Track cost provenance for honest UI rollups

```typescript
import { calculateCostWithProvenance, mergeCostSources, formatCost } from 'sidekick-shared';

const a = calculateCostWithProvenance({
  usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  modelId: 'claude-sonnet-4-20250514',
  reportedCostUsd: 1.23, // provider-reported when available — wins over local estimate
});
const b = calculateCostWithProvenance({
  usage: { inputTokens: 200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  modelId: 'unknown-model', // no pricing → { source: 'unpriced' }
});

const total = (a.costUsd ?? 0) + (b.costUsd ?? 0);
const totalSource = mergeCostSources(a.source, b.source); // 'unpriced' wins (least certain)
console.log(formatCost(total), totalSource);
```

## Building

```bash
npm run build
```

Compiles TypeScript to `dist/` via `tsc`.

## Testing

```bash
npm test
```

Uses Vitest. Run `npm run test:watch` for watch mode.

## See Also

- [Sidekick for Max](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) — VS Code extension
- [Sidekick CLI](https://www.npmjs.com/package/sidekick-agent-hub) — Terminal dashboard (`npm install -g sidekick-agent-hub`)

## License

MIT
