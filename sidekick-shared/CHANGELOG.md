# Changelog

All notable changes to sidekick-shared will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `summarizeTokens()`, `sumTokenTotals()`, `TOKEN_TOTAL_LABEL`, and `TOKEN_CONTEXT_LABEL` define the one token vocabulary every Sidekick surface uses: `total` is input + output + cache writes + cache reads, `context` is input + cache; browser-safe
- `AggregatedTokens` gains `costUsd`, `costProvenance` (`reported` | `estimated` | `mixed` | `unpriced` | `none`), `reportedCostUsd`, `estimatedCostUsd`, and `unpricedCalls`; `describeCostProvenance()` and `classifyCostProvenance()` are exported; `CanonicalSessionTranscript.usage` adds `pricedCostUsd` and `unpricedEvents` (schema updated)
- `parseClaudeStatuslinePayload()` and `quotaFromStatuslinePayload()` (also on the `sidekick-shared/statusline` subpath, which now exports `writeQuotaSnapshot`, `appendQuotaHistorySample`, and `getWorkspaceIdFromPath`) read the JSON Claude Code pipes to a status-line command; `QuotaState.source` and quota-history samples accept `statusline`
- `formatStatusline({ live })` renders context %, session cost, prompt-cache hit rate, the seven-day window, and the snapshot age when it is older than five minutes
- `readQuotaSnapshot()` reports `ageMs` and `freshness`; `classifyQuotaFreshness()`, `formatQuotaAge()`, `QUOTA_FRESH_MAX_AGE_MS`, and `QUOTA_AGING_MAX_AGE_MS` are exported and the quota schema accepts the new fields
- `getScheduledPeakHoursState()`, `PEAK_HOURS_DESCRIPTION`, `PEAK_HOURS_CACHE_MS`, and `PeakHoursState.source` (`promoclock` | `schedule`); `fetchPeakHoursStatus({ force })` bypasses the ten-minute cache
- `evaluateQuotaThresholds()`, `describeQuotaThresholdAlert()`, and `DEFAULT_QUOTA_THRESHOLDS` for once-per-reset-window threshold alerts
- `formatLocalDateKey()`, `parseLocalDateKey()`, and `addLocalDays()` (root and browser entry points); `hydratePricingCatalog({ offline })`; `pruneSnapshots()` and `MAX_SNAPSHOT_FILES`; `getActiveAccountStatus(error, { selfHeal })`, mirrored on `resolveActiveClaudeAccount()` and `resolveActiveCodexAccount()`; `_resetProviderDetectionCache()` and `_resetPeakHoursCache()` for tests
- `resolveQuota({ providerId, workspacePath, preferFresh, allowApi, … })` resolves Claude, Codex, or z.ai quota with one precedence — a persisted sample younger than `QUOTA_FRESH_MAX_AGE_MS` (any origin), then session logs, then the provider API (persisted on success), then an aging or stale sample with the API failure attached — returning `ResolvedQuota` with `resolution`, `source`, `capturedSource`, `freshness`, and `ageMs`; every side effect is injectable
- `QuotaState.capturedSource` (`api` | `session` | `statusline`) records where a cached sample came from; `readQuotaSnapshot()` fills it and `writeQuotaSnapshot()` preserves it instead of storing `cache`; the quota schema accepts it; `QuotaSnapshotRecord`, `enrichCodexQuota()`, and `enrichZaiQuota()` are exported; `fetchQuota(token, { fetchImpl })` accepts an injected fetch
- `computeSessionFileStats(events, options)` and `readSessionFileStats(provider, sessionPath, { resolveLabel })` compute `SessionFileStats` for every provider over the shared `EventAggregator`; `firstUserPrompt(events)` derives a session label from events already in memory. `SessionFileStats` gains `availability` (`full` | `partial` | `unavailable`), `unavailableReason`, `costUsd`, `costProvenance`, `unpricedCalls`, and `toolFailures`; `reportedCost` is deprecated (same value as `costUsd`)
- `collectUsageEvents({ providers, since, until, workspacePath })` reads every session touched in a window once through its provider reader and returns priced usage events, caching raw token counts per session under `<configDir>/usage-cache/` keyed by size and mtime (priced at load, so a catalog refresh never leaves stale costs); `pruneUsageCache()`, `getUsageCacheDir()`, `USAGE_CACHE_VERSION`, and `MAX_USAGE_CACHE_FILES` are exported
- `computeBillingBlocks(events, { now })` and `findActiveBillingBlock()` (root and browser entry points) group usage events into ccusage-style five-hour blocks aligned to the UTC hour, with cache-inclusive totals, cost provenance, per-model usage, burn rate, remaining time, and end-of-block projections; `BILLING_BLOCK_DURATION_MS` is exported

### Changed

- The HTML report and session dump label cost by provenance and render unpriced sessions as `—` with the unpriced call count; their "Total" row is cache-inclusive and labelled "Total (incl. cache)"
- `calculateCompactionLedger()` prices re-establishment through `calculateNormalizedUsageCost()` instead of the deprecated additive-reasoning path
- Codex `readSessionStats()` computes context as uncached + cached input, matching `CodexProvider.computeContextSize()`
- OpenCode `workspaceMatches` only matches sessions started in the workspace or a subdirectory of it
- `readQuotaHistoryDailyBuckets()` keys buckets by local calendar day
- `detectProvider()` and `getAllDetectedProviders()` share one implementation memoised for five seconds
- `loadObservedContextWindows()` ignores entries older than `OBSERVED_CONTEXT_WINDOW_TTL_MS` (30 days)
- `saveSnapshot()` writes through the fsynced atomic writer and prunes the directory to the newest 200 files every 25 saves; quota-history append and prune run under a per-file cross-process lock with fsync; the pricing catalog cache is written atomically
- `DEFAULT_PEAK_HOURS_TIMEOUT_MS` is 4 000 ms; `fetchPeakHoursStatus()` falls back to the schedule rather than returning `unavailable: true`
- `listSessionPreviews({ since })` throws `RangeError` on an unparseable cutoff
- `AggregatedTokens.reportedCost` is deprecated (same value as `costUsd`); `SNAPSHOT_SCHEMA_VERSION` is 5
- Claude Code, Codex, and OpenCode `readSessionStats()` share one implementation: per-model `tokens` are cache-inclusive (`summarizeTokens().total`) for every provider, Claude sessions report catalog-estimated cost and a tool success/failure split instead of `reportedCost: 0`, OpenCode compaction and truncation counts come from the aggregator instead of hardcoded zeros, a missing or unreadable source reports `availability: 'unavailable'` with a reason instead of silent zeros, and the label is taken from the events already read (Codex and OpenCode still prefer their database title) so the file is never opened twice
- OpenCode's file-backed reader implements `seekTo()` by message count (its `getPosition()` unit), so a reader restored from a snapshot emits only newer messages instead of replaying the whole session; the database-backed reader's `exists()` checks the session row (memoised for 30 s, treating a transient query failure as present) instead of always returning true

### Fixed

- `onAccountsChanged()` applies a later subscriber's faster `pollIntervalMs` and resets the interval after the last unsubscribe
- `OpenCodeProvider.dispose()` resets `dbStatus`; `CodexProvider.listSessionFilesAsync()` records its filesystem fallback for `getLastOperationStatus()`

## [0.25.0] - 2026-08-18

### Added

- `listSessionPreviewsAsync()` and `readSessionPreviewAsync()` provide bounded-concurrency, cooperative session preview reads while preserving the synchronous APIs and their signatures
- Async preview labeling batches Codex and OpenCode database work into at most one `sqlite3` subprocess per provider per few hundred sessions listed (ids are chunked clear of argv limits); when `sqlite3` is absent, the same bounded file-scan fallback remains available
- `OpenCodeProvider.listAllSessionFiles()` completes native preview enumeration across Claude Code, Codex, and OpenCode
- `ObservedSessionCollector.subscribe()` and `SessionMonitor.subscribe()` emit debounced, coalesced session changes with the previous and current fingerprints, backed by filesystem watching plus a documented catch-up poll for unreliable filesystems
- `createSessionProviders({ onDiagnostic })` constructs every usable provider independently and reports unavailable providers without aborting the host
- `SessionProviderBase.findSessionById()` has provider-native implementations: filename lookup for Claude Code and Codex, and a database lookup with a bounded file-scan fallback for OpenCode
- `exportResolvedModelCatalog()` and `importResolvedModelCatalog()` transfer serializable context-window and pricing resolutions between Node and browser realms without private hooks
- `registerModelAlias()` lets hosts resolve short model names to canonical ids, and catalog provenance marks prefix-inherited context and pricing matches so callers can reject them
- Stable provider-id arrays are exported as runtime values alongside their derived TypeScript unions
- `onAccountsChanged()` reports process-local and filesystem-observed login, logout, and account-switch changes without account-state polling in each host

### Changed

- Provider constructors are environment-independent and perform no filesystem, configuration, database, or binary probing; environmental failures are deferred to first use and returned as structured diagnostics
- Repeated identical provider degradations are coalesced in the factory diagnostic result, keeping first-use reporting bounded in long-lived hosts
- `ObservedSessionCollector.collect()` caches parsed sessions by fingerprint, so a second collection over unchanged files performs no content reads
- Observed sessions expose `fingerprintParts: { sizeBytes, mtimeMs }` alongside the compatible opaque fingerprint string
- Collector reads accept bounded-concurrency and cooperative-yield hooks; cached observations refresh `observedAt` and activity state while retaining `contentObservedAt` to make the age of cached usage/model data explicit
- `ObservedSessionDiagnostic` now includes `severity` and `phase` while retaining every existing `kind` value
- Account and quota entry points guarantee results that validate against the same-release exported schemas, including additive schema fields, and their contract tests enforce the boundary
- Every documented package subpath now declares explicit `types`, `import`, `require`, and `default` export conditions and resolves in both Vite and TypeScript's legacy `moduleResolution: node` mode without aliases
- `readCodexHistory()` retains raw epoch-second `ts`, adds normalized `tsMs`, and sizes its tail read from `limit` unless an explicit byte bound is supplied
- Observed-session projection accepts `observationOnly: true`, which reports transcripts as read-only observations with `capabilities.resume` disabled
- `QuotaPoller`, `MultiProviderQuotaService`, and `CodexQuotaWatcher` stay dormant when their account is absent and wake on account changes instead of issuing empty polls

### Fixed

- Codex and OpenCode database-backed operations attach an availability diagnostic when the external `sqlite3` binary is missing, so an unavailable runtime is distinguishable from an empty workspace
- A wrong session id resolves to `null` through every provider instead of surfacing discovery or environment errors
- Exact model pricing/context entries are considered before prefix inheritance across all sources, and prefix-only matches are explicit in provenance rather than silently trusted as exact

## [0.24.5] - 2026-08-18

### Added

- Session-preview index: `listSessionPreviews()` enumerates session files stat-first across providers, sorts by mtime, applies `since`/`limit`, and content-reads only the post-limit survivors — so cost tracks the size of the answer, not the size of the history. `readSessionPreview()` reads one file's bounded preview (label, first prompt, first timestamp, workspace path) and degrades to `null` fields instead of throwing. Both are exported from the root and `sidekick-shared/node`
- `readCodexHistory()` returns the newest entries of `~/.codex/history.jsonl` from a bounded tail read, dropping the leading partial line and tolerating multibyte characters straddling the boundary. `findCodexRolloutFile()` resolves a Codex session id to its `sessions/YYYY/MM/DD/rollout-*.jsonl` transcript by filename only, newest mtime winning across monitored Codex homes
- `parseMcpToolName()` is the canonical splitter for `mcp__<server>__<tool>` identifiers, exported browser-safe; the session-context projector's MCP-server inference delegates to it. The degenerate `mcp__server__` shape (empty tool part) now parses as `null` rather than yielding a server name
- Async account entry points: `getAccountLoginStatusAsync`, `finalizeAccountLoginAsync`, `switchAccountAsync`, `prepareCodexAccountAsync`, `finalizeCodexAccountAsync`, `switchToCodexAccountAsync`. Each runs the codex CLI probes through `execFile` so the caller's event loop stays free, and probes are resolved before any lock is taken — never while holding one. Sync entry points keep their exact signatures for CLI callers
- Synchronous locked writers: `withFileLockSync()`, `updateJsonStoreAtomicSync()`, and `atomicWriteFileSync()` share the async path's cross-process lock-file protocol (sync and async waiters exclude each other), with an absolute 15s wait ceiling because a sync waiter blocks its event loop
- `AutoSwitchController.switchAccount` accepts a Promise-returning callback and defaults to `switchAccountAsync`, so a threshold crossing no longer runs blocking codex probes on the caller's loop. Overlapping quota updates are skipped while a switch is in flight, and a switch that lands after `dispose()` records its cooldown state without emitting a stale transition
- `SessionProviderBase` gains an optional `listAllSessionFiles()` so providers can expose native session-file enumeration to the preview index

### Fixed

- The store lock's timeout is measured from the last time the lock changed hands rather than from a waiter's first attempt, so a burst of concurrent writers no longer manufactures "Timed out waiting for store lock" once the queue outlives the flat budget — a wedged holder still trips it in 3s
- A lock whose heartbeat mtime has been frozen past two minutes is reclaimed even when its recorded PID probes alive: PID recycling made `process.kill(pid, 0)` an unreliable liveness signal, and a crashed owner with a recycled PID used to wedge the store until a human deleted the lock
- The quota-snapshot store drops its private copy of the lock — which still had the flat 15s-from-first-attempt bug — and delegates to the shared one, keeping the same lock path so mixed-version processes still exclude each other. Snapshot writes pick up the shared writer's fsync and directory sync
- Four account modules each carried their own lock-free atomic writer with a fixed `.tmp` suffix, so cross-process account writes were last-writer-wins and two processes could interleave the same temp file. All account writes go through the shared fsynced writers, registry read-modify-write cycles hold the registry lock, and live credential swaps hold a per-provider auth-swap lock so two switchers cannot interleave a stash/restore of a rotated Codex refresh token
- `switchToAccount()` and `applyActiveClaudeToLiveHome()` threw on a held auth-swap lock where the Codex twins return a failed `AccountManagerResult`; they now keep the non-throwing contract their callers rely on
- Codex login-status and `pgrep` probes no longer freeze the caller's event loop for up to 4s; `ensureDefaultAccounts` and `spawnAccountLogin` run on the async path
- `AutoSwitchController`'s fire-and-forget update handler could surface a throwing registry read, snapshot read, or consumer `onTransition` as an unhandled promise rejection — process-fatal on modern Node. Those errors are now caught and logged
- `readCodexHistory()` rejects entries whose `ts` is not a finite number — `JSON.parse` yields `Infinity` for out-of-range literals, which later RangeErrored out of `Date` serialization in consumers. `readSessionPreview()` likewise returns `null` for a file whose mtime cannot be serialized, per its degrade-don't-throw contract
- `listRecentSessions()` sorts before labeling, so per-file content reads no longer scale with total session count, and a corrupt session beyond the limit no longer poisons the whole call

## [0.24.4] - 2026-07-25

### Fixed

- `fetchPeakHoursStatus()` had no request timeout. It was the only network call in the package without one, it targets a third-party host (promoclock.co), and `MultiProviderQuotaService` calls it on every poll, so a hung host stalled the caller indefinitely and repeatedly. It now uses the same abort-timeout shape as every other fetch here, configurable via `FetchPeakHoursOptions.timeoutMs` (default 10s)
- `recordObservedContextWindow()` deduplicated its write against the process-global override table from `modelContext`, which is not keyed by `cacheDir`. Two cache directories in one process — two temp dirs in a test suite, a multi-tenant host, a CLI and extension host sharing a process — meant the second store was silently never written. The same early return also swallowed retries: because the global was updated before the write was attempted, a transient `EACCES` left the value marked as recorded and no later call tried again. The persistence dedupe is now keyed by resolved store path and recorded only after a successful write
- `parseModelId()` reported version `"4"` for every hyphenated Anthropic model ID (`claude-sonnet-4-6-20260321`, `claude-sonnet-4-5-20250929`, `claude-opus-4-1-20250805`). The version pattern accepted dots but not hyphens, while the adjacent legacy pattern already normalized both. Pricing and context windows are unaffected — both resolve from the full ID by longest-prefix match — but `parseModelId().version`, `getModelInfo().version`, and the version ordering behind model comparison all change, where 4.5 and 4.6 previously tied at `"4"`

### Added

- The config directory is now overridable. `setConfigDir()` redirects it for the process and `SIDEKICK_CONFIG_DIR` does the same from the environment, with `getDefaultConfigDir()` exposing the unmodified platform default. Both routes trim their input, so a padded value resolves to the same root rather than to a relative path under the current directory. Every reader, writer, account-registry path, quota snapshot, and migration resolves the root lazily through `getConfigDir()`, so a single seam covers the whole package. Consumers previously had no way to point the library anywhere but `~/.config/sidekick`, which blocked test isolation, sandboxing, and multi-tenant use
- The published tarball ships `LICENSE` and `CHANGELOG.md`. `files: ["dist"]` excluded both, and npm only auto-includes a LICENSE from the package directory — so the MIT declaration in `package.json` shipped with nothing behind it
- `repository` (with `directory`, so npm's source link lands on this package), `homepage`, `bugs`, `keywords`, `author`, and `engines` are declared
- `typesVersions` maps every non-wildcard `exports` subpath for consumers whose tsconfig still uses `moduleResolution: "node"`, which cannot read `exports` maps at all. Modern resolvers ignore it entirely
- Every export of the legacy z.ai estimator (`zaiQuota`, `zaiQuotaWatcher`) is marked `@deprecated`. The deprecation was previously recorded in module prose only, so consumers reaching it through the `./dist/*` wildcard got no editor signal

### Changed

- `engines` declares Node >= 20, driven by zod 4 and matching the sibling CLI. It is advisory unless a consumer sets `engine-strict`, but it will surface an `EBADENGINE` warning on Node 18
- `HydrateOptions.cacheDir` is optional and defaults to the config directory, so pricing hydration follows the same override seam

### Documentation

- Four README examples were wrong and are corrected: `readTasks` was shown with the wrong first argument and no `await`; `readClaudeMaxCredentials` was shown without `await`, so the always-truthy Promise made `accessToken` undefined and surfaced later as an auth failure; the documented context window was 200000 rather than 1000000; and the documented cost output was never reachable from the stated inputs
- The headline cost example uses `normalizeProviderUsage` and `calculateNormalizedUsageCost` instead of the deprecated `calculateCost`
- The external `sqlite3` requirement is documented. `OpenCodeProvider` and `CodexProvider` shell out to it and return empty results rather than an error when it is missing, which is indistinguishable from an empty workspace unless the consumer knows to call `getRuntimeStatus()`

## [0.24.3] - 2026-07-24

### Fixed

- Static pricing for `gpt-5.6-luna` ($1/$6 in/out, $1.25/$0.10 cache write/read). Without an entry of its own, `getModelPricing('gpt-5.6-luna')` longest-prefix-matched `gpt-5.6` and returned `gpt-5.6-sol`'s $5/$30 — roughly 5× too high, and indistinguishable from a correct result at the call site
- Static pricing for `gpt-5.5-pro` and `gpt-5.4-pro` ($30/$180 each) and `gpt-5.4-nano` ($0.20/$1.25), which inherited `gpt-5.5` and `gpt-5.4` the same way. Rates verified against the LiteLLM catalog's bare top-level keys
- `getModelPricing('claude-sonnet-5')` returned $3/$15 against its actual $2/$10 (cache write $2.50, cache read $0.20). The entry assumed the $3/$15 shared by every earlier Sonnet; all eleven Sonnet 5 rows in the catalog agree on $2/$10
- A sweep of every bare catalog key against the static table found twelve more chat models resolving through a shorter prefix. New entries: `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-pro`, `gpt-5.3-chat-latest`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o-2024-05-13`, `o1-pro`, `o3-pro`, and `o3-deep-research`. Overstatements reached 25× (`gpt-5-nano`) and understatements 17× (`gpt-5.2-pro`)
- Corrected values on two keys that already existed: `gpt-5.3-codex` to $1.75/$14 and `o1-mini` to $1.10/$4.40. No bare catalog key settles `o1-mini` — Azure's $1.21/$4.84 is its standard 1.1× uplift on that rate, and Replicate's OpenAI passthrough reports it directly
- Because keys are matched longest-first, each new entry also captures its own dated and fine-tuned variants — `gpt-5.6-luna-20260501` now resolves to Luna rather than to `gpt-5.6`, and one `gpt-5.2` entry covers `gpt-5.2-codex` and the `gpt-5.2-chat*` ids, which bill at the same rate

### Added

- `MODEL_CONTEXT_SIZES` entry for `gpt-5.6-luna` at its published 1,050,000 maximum. The value equals what the `gpt-5.6` prefix already returned; it is pinned so a later edit to that entry cannot silently move Luna. Observed per-tier windows still outrank it

### Notes

- The `-tts`, `-transcribe`, and `-realtime-preview` variants of `gpt-4o`/`gpt-4o-mini` also bill above the key they inherit and are deliberately not carried in the static table: no coding agent routes to them, and catalog hydration prices them correctly. `gpt-5.3` keeps an estimated rate because the catalog ships no bare key for it

## [0.24.2] - 2026-07-24

### Added

- `hydratePricingCatalog()` also builds a context-window override map from the LiteLLM catalog's `max_input_tokens`, so new models resolve without a code change. `HydrateResult` gains `contextWindowEntries`
- `normalizeLiteLlmContextWindows()` — catalog payload to model → context-window map, exported alongside `normalizeLiteLlmCatalog()`
- `loadObservedContextWindows()`, `recordObservedContextWindow()`, and `getObservedContextWindowPath()` on `sidekick-shared/node` — a persisted record of the context window a provider actually reported, which outranks the catalog's published maximum. The Codex provider records it from `model_context_window` on `token_count` events
- Static pricing for `claude-opus-5`, `claude-sonnet-5`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.5`, and `gpt-5.4-mini`. Sonnet 5 carries the standard $3/$15 rather than the introductory rate, which arrives via hydration

### Changed

- `getModelContextWindowSize()` resolution is `[1m]` marker → observed → catalog → static, and tries every layer for an exact match before any layer's prefix match. `GPT-5.4` pricing is corrected to its published $2.50/$15
- Cache files written before this release have no `contextWindows` key and still load; they contribute no context overrides until the next refresh

### Fixed

- An exact entry in the static table is no longer shadowed by a catalog key that happens to be a prefix of the model ID. The catalog has no `claude-sonnet-4-7`, so Sonnet 4.7 was resolving through `claude-sonnet-4` to 128K instead of its real 1,000,000
- `normalizeLiteLlmContextWindows()` drops a bare-model alias when the `provider/model` entries behind it disagree, rather than taking whichever appeared first in the JSON. A `provider/model` entry describes that provider's deployment window — often a truncation — and the live catalog carries five conflicting windows for `claude-sonnet-4`, from GitHub Copilot's 128K to Vertex's 1M. A top-level catalog entry always wins over a derived alias

## [0.24.1] - 2026-07-22

### Added

- Canonical transcripts retain provider/session provenance for safe human-prompt filtering, including entrypoint, meta/sidechain flags, original message roles, cwd, and git branch
- Provider-backed observed-session collection sources expose their adapter's `ProviderCapabilitiesV1` record

## [0.24.0] - 2026-07-22

### Added

- `normalizeProviderUsage()`, `extractNormalizedUsage()`, and `calculateNormalizedUsageCost()` with explicit cache/reasoning semantics and pricing provenance
- `estimateTextTokens()` / `estimateSerializedTokens()`, canonical transcript/history APIs, transcript schemas, and `ObservedSessionCollector`

### Changed

- `SessionEvent` and its Zod schema are discriminated; valid message-less summaries and nested progress envelopes parse directly
- Claude Code, Codex, OpenCode, report transcripts, observed sessions, and EventAggregator share normalized usage and canonical projection paths
- Aggregator snapshots advance to schema v4 so older ambiguous-cost snapshots are replayed from source events
- Provider-reported session costs — including zero — are authoritative and skip catalog pricing, so subscription sessions that report $0 display $0 instead of a catalog estimate
- `ObservedAgentSessionV1` `usage.costUsd` is now nullable for unpriced usage (still `schemaVersion: 1`); validators built against the earlier number-only shape should accept `null`

### Deprecated

- `calculateCost()`, `calculateCostWithPricing()`, `calculateCostWithProvenance()`, `CostTokenUsage`, and `CostProvenanceInput` retain their legacy reasoning-additive behavior for compatibility

## [0.23.1] - 2026-07-21

### Security

- Markdown report links refuse `javascript:`/`data:` URLs, and browser opening spawns the platform opener with argument arrays instead of an interpolated shell string

### Fixed

- **2026-07 review backlog (shared portion)**: crash guards across parsers, watchers, and readers for malformed rows; index-safe SQL substitution; hardened atomic writers and quota snapshot persistence; and hardened quota polling and provider watchers
- **Observed-session message-less events**: `derivePendingUserRequestV1()` now tolerates Claude Code summary and other bookkeeping rows without a `message`, continues scanning for unresolved requests, and retains top-level tool requests with a stable event-index fallback ID
- Hyphenated `claude-opus-4-5` model IDs price at Opus 4.5 rates instead of falling back to legacy Opus pricing, and Codex cache tokens are counted once in usage rollups
- macOS keychain credential writes escape the secret correctly for the `security -i` tokenizer (single quotes and backslashes in stored JSON no longer corrupt the entry), and the secret is passed over stdin instead of argv

### Changed

- Token metric definitions are more truthful: Codex `input_tokens` excludes cached input, per-model totals include cache read/write tokens, and follow-event message counts include only user/assistant messages — dashboard numbers may shift after upgrade

## [0.23.0] - 2026-07-18

### Added

- **Observed-session V1 public API**: `ProviderSessionAdapterV1`, `ObservedAgentSessionV1`, `ProviderCapabilitiesV1`, `PendingUserRequestV1`, `SessionEvidenceRefV1`, provenance/confidence values, adapters for all session providers, and corresponding Zod schemas
- **Shared operational primitives**: atomic and lock-coordinated task/decision/note writers, canonical project identity, typed doctor reports, status-line and burn-rate formatting, identifier-only external-handoff URL rendering, and a public `SessionMonitor`
- **Analytics engines**: categorized per-tool/hour/model failure rollups and append-only error history, beta quality scoring with weekly trends, historical schema v3 session records, code-impact and per-model churn/cost metrics, and compaction-ledger estimates
- **Consumer contract tests** for quota, accounts, sessions, assets, costs, turn/reasoning, and observed-session APIs

### Changed

- Codex compaction events retain exact before/after counts with reported/heuristic provenance; aggregator snapshots advance to v3; heuristic compactions are recorded once and completed with the next observed context size instead of double-counting
- Shared ingest owns tool-error taxonomy across Claude Code, OpenCode, and Codex; OpenCode provider errors, retries, and finish reasons are normalized for analytics
- Canonical symlink-aware project identity replaces duplicated slug probing; OpenCode SQL substitution is index-safe; Codex/OpenCode database row shapes have one source
- Legacy raw-slug project stores migrate automatically to the canonical slug on first write (`migrateLegacyProjectStores`), so symlinked workspaces keep their existing tasks, decisions, notes, and handoffs
- Plan aggregation now records per-step start/completion time, duration, tokens, tool calls, and cost

### Removed

- **Potentially breaking**: deprecated observed-traffic z.ai estimator exports were removed from the package root. Use `resolveZaiQuota()` and the authoritative quota API surface instead

## [0.22.0] - 2026-07-02

### Changed

- **Version bump to 0.22.0**: No functional changes. This release only keeps the shared library in lockstep with the VS Code extension and CLI (which ship user-facing changes this cycle); the published API and behavior are identical to 0.21.6

## [0.21.6] - 2026-07-02

### Added

- **Codex reset credits**: New `fetchCodexResetCreditsFromApi()` reads ChatGPT's `wham/rate-limit-reset-credits` endpoint and returns a `CodexResetCreditsSnapshot` (available count plus per-credit title/status/expiry), with the new `CodexResetCredit` / `CodexResetCreditsSnapshot` types and `codexResetCreditSchema` / `codexResetCreditsSnapshotSchema` Zod validators. `fetchCodexQuotaFromApi()` now attaches this snapshot to the returned `QuotaState` (`resetCredits`), authenticating with the Codex `auth.json` `account_id` (sent as `ChatGPT-Account-ID`) when present. `writeQuotaSnapshot`, the `CodexQuotaWatcher`, and the Codex session provider preserve an existing reset-credits snapshot when a session-sourced write omits it (Codex-only), so local session updates never wipe API-fetched credits. Degrades gracefully — every reset-credit fetch failure is swallowed and leaves the quota otherwise intact

## [0.21.5] - 2026-06-30

### Added

- **`isAggregateCodexLimit(limitId)`**: Exported helper that identifies the aggregate Codex plan-quota family (`limit_id` `codex`, or absent on older payloads) versus model/feature-specific families (e.g. `codex_bengalfox`, `premium`)

### Fixed

- **Prefer the aggregate Codex rate-limit family over model-specific ones**: Codex emits multiple rate-limit families per session keyed by `limit_id` — the aggregate plan quota plus per-model/feature families that can read 0% while the plan is busy. Every local-data selector previously read "the latest `rate_limits`" without inspecting `limit_id`, so a freshly-used per-model family at 0% with a later-resetting window could win the newest-window comparison and mask the real plan quota. The aggregate family is now ranked first in every selection site — `readLatestQuotaFromRollout`, the live `CodexRolloutParser`, the cross-file `isPreferredQuotaHit` ranker, and the `shouldKeepExistingSnapshot` retention guard — falling back to a model-specific sample only when no aggregate one exists. No-op for Claude (no `limit_id`) and z.ai (`zai-*`), where every sample shares the same aggregate-ness

## [0.21.4] - 2026-06-30

### Fixed

- **Live-first active-account resolution**: New `resolveActiveClaudeAccount()` / `resolveActiveCodexAccount()` and the `ResolvedActiveAccount` type resolve the currently logged-in account from the live provider auth (`~/.claude/.claude.json` oauthAccount; the `~/.codex/auth.json` id_token JWT — a cheap JWT decode, never the slow `codex login status` subprocess) and fall back to the saved registry. On an unambiguous match they self-heal the stale active pointer (best-effort, never throwing, never creating or deleting profiles) so quota history and auto-switch track the real account. `getActiveAccountStatus()`, the multi-provider Claude path, and the Codex quota watcher now route through them

## [0.21.3] - 2026-06-23

### Added

- **Quota projection helpers**: New exported `projectQuotaWindow()` and `withQuotaProjections()`, plus the `FIVE_HOUR_WINDOW_MS` / `SEVEN_DAY_WINDOW_MS` constants and the `QuotaProjectionInput` type, generalize the previously Claude-only end-of-window utilization projection. Codex (`quotaFromCodexRateLimits`, using each window's real `window_minutes`) and z.ai (`quotaStateFromZaiQuotaLimitPayload`) quota states now populate `projectedFiveHour` / `projectedSevenDay`. Projection is idempotent (it only fills fields that are still null, so it never double-counts) and honors a `capturedAt` timestamp so cached snapshots project from capture time

### Fixed

- **Bounded synchronous CLI probes**: Every synchronous `execFileSync` / `spawnSync` / `execSync` probe — keychain reads/writes (`credentialIO`, `claudeProfiles`), Codex login status and `pgrep` (`codexProfiles`), `git rev-list` (`providers/openCode`), and `sqlite3` (`providers/codexDatabase`, `providers/openCodeDatabase`) — now runs with `timeout: 4000` and `killSignal: 'SIGKILL'`, so a hung CLI, keychain prompt, or database can no longer block the caller indefinitely

### Security

- **npm audit**: Bumped `vitest` to `^4.1.9` to clear reported dev-dependency advisories

## [0.21.2] - 2026-06-22

### Changed

- **Authoritative z.ai quota API**: new `zaiQuotaApi.ts` reads z.ai's `api/monitor/usage/quota/limit` endpoint and exports `resolveZaiQuota()`, `fetchZaiQuotaFromApi()`, `readZaiCredentials()`, and `quotaStateFromZaiQuotaLimitPayload()`, mapping the returned `TOKENS_LIMIT` percentages and `nextResetTime` values into the 5-Hour / Weekly `QuotaState` model. Credentials are discovered from OpenCode's stored `zai-coding-plan` → `zai` token, then `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`; API failures fall back to a cached snapshot
- **Deprecated observed-traffic estimator**: `zaiQuota.ts` and `zaiQuotaWatcher.ts` (and their exports — `accumulateZaiUsage`, `inferZaiQuotaState`, `resolveZaiTier`, `ZaiQuotaWatcher`, `ZAI_TIER_BUDGETS`, …) remain available for compatibility but are no longer used for product quota display

## [0.21.1] - 2026-06-21

### Added

- **z.ai Coding Plan quota derivation**: New `zaiQuota.ts` and `zaiQuotaWatcher.ts` modules derive an estimated `QuotaState` for z.ai coding plans from OpenCode assistant turns tagged `providerID ∈ {zai, zai-coding-plan}`. Because z.ai exposes no quota/usage HTTP API (verified against `docs.z.ai/openapi.json`), utilization is computed by accumulating per-turn tokens into 5-hour and 7-day rolling windows and comparing against the published per-tier prompt budgets (Lite 80/400, Pro 400/2000, Max 1600/8000 prompts per 5h/week). Authoritative reset timestamps are extracted from trapped `1308`/`1310`/`1313`/`1309` business error codes when present. Exports include `accumulateZaiUsage()`, `inferZaiQuotaState()`, `parseZaiQuotaError()`, `resolveZaiTier()`, `ZaiQuotaWatcher`, `ZAI_TIER_BUDGETS`, and `ZAI_PROMPT_INVOCATIONS`
- **`OpenCodeProvider.getZaiQuotaState()`**: The shared OpenCode provider now derives z.ai quota on demand from the on-disk `opencode.db`. `OpenCodeSessionProvider.getQuotaFromSession()` (VS Code wrapper) wires the derived state into the existing session-based quota pipeline so the dashboard, snapshot, and history see z.ai samples automatically
- **`OpenCodeDatabase.getAssistantMessagesByProviderId()`**: New query method returns assistant rows tagged with the given providerID(s), used by the z.ai accumulator to walk per-turn token records
- **Runtime quota provider `'zai'`**: `RuntimeQuotaProvider`, `QuotaHistoryRuntimeProvider`, `QuotaState.providerId`, `ProviderQuotaMap`, and the corresponding Zod schemas all accept `'zai'`. `MultiProviderQuotaService` accepts an optional `zaiWatcher` and a new `updateProviderQuota('zai', …)` overload. `QuotaSnapshotProviderId` widens the snapshot store key to `AccountProviderId | 'zai'` so the derived z.ai quota persists across sessions
- **`getOpenCodeDataDir()` exported**: Now a public helper

### Fixed

- **OpenCode data directory resolution**: `getOpenCodeDataDir()` (now exported) probes both the macOS-default `~/Library/Application Support/opencode` and Linux-style `~/.local/share/opencode` candidate paths and returns whichever actually contains `opencode.db`. Previously it returned the platform default unconditionally, which failed on machines where OpenCode writes to the Linux-style path even on macOS

### Limitations

- z.ai quota is **estimated, not authoritative**: it is derived only from OpenCode traffic observed on this machine (z.ai exposes no usage API) and compared against provisional per-tier prompt budgets (`ZAI_PROMPT_INVOCATIONS` is a midpoint estimate, not validated). z.ai is **observed-only** — there is no z.ai inference provider and no z.ai account management in this release (`zaiQuotaWatcher.ts`: "z.ai has no full account management in v1"). Auto-tier resolution under-reports early in a weekly cycle; reset times are approximate unless a `1308`/`1310`/`1313`/`1309` error is trapped

## [0.21.0] - 2026-06-21

### Added

- **Account Management 2.0 acquisition facade**: New provider-neutral helpers `beginAccountLogin()`, `getAccountLoginStatus()`, `finalizeAccountLogin()`, and `spawnAccountLogin()` let hosts acquire Claude Max and Codex accounts through isolated profile directories before activating them
- **Provider-neutral account switching**: `listAllAccounts()` and `switchAccount()` expose a single surface over Claude saved accounts and Codex saved profiles. Claude switching now applies canonical profile homes back to the live Claude home, with legacy flat-backup migration handled by `reconcileClaudeAuthState()`
- **Claude profile primitives**: `getClaudeProfilesDir()`, `getClaudeProfileHome()`, `claudeKeychainSuffix()`, `claudeKeychainService()`, `isClaudeProfileAuthenticated()`, and `readClaudeProfileIdentity()` are exported for hosts that need lower-level profile inspection
- **Terminal sync helpers**: Opt-in terminal account pointers, shell hook installation/removal, and launcher creation/removal are available through `setTerminalActiveProfile()`, `installShellHook()`, `uninstallShellHook()`, `isShellHookInstalled()`, `writeLauncher()`, and `removeLauncher()`
- **Quota auto-switch primitives**: `decideAutoSwitch()` and `AutoSwitchController` provide a default-off policy for switching to a healthier saved account after quota crosses a configured threshold
- **Account Zod schemas**: `sidekick-shared/schemas` and the package root now export `accountProviderIdSchema`, `beginAccountLoginResultSchema`, `accountLoginStatusSchema`, `accountManagerResultSchema`, `accountEntrySchema`, `savedAccountProfileSchema`, and `listAllAccountsResultSchema`

## [0.20.0] - 2026-06-17

### Added

- **Actionable session asset extraction**: New Node-only APIs for extracting URLs, filesystem-validated file paths, commands the agent suggested for the user to run, and plan-mode plans from recent Claude Code and Codex sessions for exactly one cwd. `gatherAssetsForCwd()` merges supported agents with recency sorting, dedupe, and per-type caps; `readClaudeAssets()`, `readCodexAssets()`, `claudeSessions()`, `codexSessions()`, `extractUrls()`, `extractFilePaths()`, and `extractCommands()` are exported for lower-level use. These APIs are safe for CLI and VS Code extension-host code, but not for browser/webview bundles
- **Session asset provenance**: `ExtractedAsset` now includes optional `agent`, `sessionPath`, and `source` metadata while keeping `type`, `text`, `display`, and `timestamp` stable for existing consumers
- **Test coverage**: Added extractor tests for command parsing, URL cleanup, filesystem-validated paths, message-text file paths, exact-cwd isolation, Codex `CODEX_HOME` discovery, merge caps, and packaging-contract exports

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing this feature in [#17](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/17), adapted from his MIT-licensed [`trawl`](https://github.com/B33pBeeps/trawl) project.

## [0.19.3] - 2026-06-17

### Added

- **Assistant turn timeline**: `segmentAssistantTurn()` now emits a required v2 `timeline` array that preserves reasoning, narration, and tool groups in original arrival order while keeping the final answer text excluded. The mirrored Zod schemas and public type exports include the new timeline contract for browser and IPC consumers

## [0.18.1] - 2026-05-08

### Added

- **Shared display formatting**: `formatTokenCount()` and `formatDurationMs()` are now public from the root, browser, and `formatting` entrypoints, giving CLI, webview, and downstream consumers a single source of truth for compact token and duration rendering
- **Raw JSONL tailing (`createJsonlTail()`)**: offset-tracked incremental JSONL reads with optional Zod validation, debounced `fs.watch` plus catch-up polling, and a post-batch callback for aggregation-driven consumers that need to defer expensive work until parsing for a chunk is complete

## [0.18.0] - 2026-05-08

### Added

- **Provider-aware quota orchestration**: `MultiProviderQuotaService` coordinates Claude polling, peak-hours enrichment, account labels, transient-failure fallback, and optional Codex quota watcher updates behind one typed `{ claude?, codex? }` event stream
- **Codex quota watcher**: `CodexQuotaWatcher` discovers the active Codex rollout for a workspace, watches it for live rate-limit updates, persists account-scoped snapshots, and falls back to cached or unavailable states when no live data exists
- **Account status helper**: `getActiveAccountStatus()` returns a single Claude/Codex account status shape for startup and setup flows
- **Tool-call extraction helper**: `extractToolCall()` extracts top-level `tool_use` events, complementing the existing `extractToolCalls()` assistant-content-block helper
- **Cost/model helpers**: `calculateCostWithProvenance()`, `mergeCostSources()`, `shortModelName()`, `getModelDisplayInfo()`, `compareModelIds()`, and `sortModelIds()` provide reusable UI and accounting primitives next to pricing
- **Phrase categories**: `PHRASE_CATEGORIES` exposes the category structure behind the existing flat `ALL_PHRASES`

### Changed

- **Model parsing**: `parseModelId()` now recognizes legacy Claude IDs such as `claude-3-opus-20240229` and `claude-3-5-sonnet-20241022`

## [0.17.7] - 2026-04-28

### Fixed

- **Quota snapshot write race**: `writeQuotaSnapshot()` now writes through a per-process unique temp suffix (PID + timestamp + 8 bytes from `crypto.randomBytes`) before atomically renaming to `quota-snapshots.json`, and best-effort removes the temp file if the rename fails. This eliminates fixed-temp collisions and `ENOENT` when multiple Node processes (e.g., the VS Code extension and the CLI) write cached Codex quota snapshots at the same time, and prevents partial writes from leaking orphan `.tmp` files into the config directory

## [0.17.6] - 2026-04-19

### Added

- **`fetchPeakHoursStatus()` API**: New top-level export from `sidekick-shared` that fetches Claude's current peak-hours state from the public `promoclock.co/api/status` endpoint (third-party, unaffiliated with Anthropic). Single-shot fetcher — callers own polling. Returns a fully-normalized `PeakHoursState` with a `unavailable: true` fallback on network errors, HTTP non-2xx, or parse failures, so call sites never need try/catch
- **`PeakHoursState` type**: Exported type covering `status` (`'peak' | 'off_peak' | 'unknown'`), `isPeak`, `sessionLimitSpeed` (`'normal' | 'faster' | 'unknown'`), `label`, `peakHoursDescription`, `nextChange`, `minutesUntilChange`, `note`, `updatedAt`, and `unavailable`. Unexpected upstream values collapse to `'unknown'` rather than widening the union
- **Test coverage**: `peakHours.test.ts` adds five vitest cases — peak, off-peak, HTTP 500, network error, and unexpected-enum-value handling — mirroring the existing `providerStatus.test.ts` pattern with `vi.stubGlobal('fetch', …)`

## [0.17.5] - 2026-04-18

### Added

- **`ensureDefaultAccounts()` API**: New top-level export from `sidekick-shared` that auto-registers the first system Claude Code and Codex credentials as a "Default" saved account when no active account exists for that provider. Idempotent across repeated calls; never overwrites accounts that were manually saved; cleans up orphaned Codex profile directories if `prepareCodexAccount` succeeds but still reports `needsLogin`. Accepts an optional `{ logger }` for diagnostic output — every failure path returns a `'error'` status and is routed through the logger rather than thrown
- **Account bootstrap types**: `EnsureDefaultAccountsResult`, `EnsureDefaultAccountStatus` (`'registered' | 'skipped' | 'error'`), and `EnsureDefaultAccountsOptions` exported from the package root
- **Packaging contract coverage**: `packagingContract.test.ts` now asserts `ensureDefaultAccounts` is reachable from the built `dist/index.js`, so the API can't silently drop out of the published artifact
- **Test coverage**: `ensureDefaultAccounts.test.ts` adds six vitest cases covering happy path, idempotency, Claude-only, Codex-only, respect-existing-accounts, and error-swallowing — using the existing `credentialIO` mock pattern so the suite stays portable across macOS and file-based platforms

Thanks to [@B33pBeeps](https://github.com/B33pBeeps) (Juan Fourie) for contributing this feature in [#16](https://github.com/cesarandreslopez/sidekick-agent-hub/pull/16).

## [0.16.1] - 2026-03-27

### Fixed

- **Account test portability**: `accounts.test.ts` now mocks credential storage through `credentialIO`, so the shared test suite passes consistently on macOS and file-based platforms

## [0.16.0] - 2026-03-23

### Added

- **Zod schemas for session events**: `sessionEventSchema`, `messageUsageSchema`, `sessionMessageSchema`, and `permissionModeSchema` for runtime JSONL validation
- **Token usage extractor**: Pure function `extractTokenUsage()` normalizes snake_case API usage fields from a single event
- **Tool call extractor**: Pure function `extractToolCalls()` extracts tool_use content blocks with `toolUseId` from a single event
- **Model info & pricing module**: `getModelInfo()`, `parseModelId()`, `getModelPricing()`, `calculateCost()`, `calculateCostWithPricing()`, and `formatCost()` — ported from VS Code extension with zero VS Code dependencies
- **Typed JSONL parser**: Optional `schema` parameter on `JsonlParser` for Zod-validated event parsing; invalid events route to `onError()`
- **QuotaPoller class**: Reusable polling service with exponential backoff, active/idle interval switching, cached fallback on transient errors, and automatic stop on auth failures

### Changed

- **ToolCall type**: Added optional `toolUseId` and `output` fields for tool result correlation

## [0.13.8] - 2026-03-12

### Added

- **Structured quota failure metadata**: `QuotaState` unavailable results now optionally include `failureKind`, `httpStatus`, and `retryAfterMs`, and `fetchQuota()` classifies `401`, `429`, `5xx`, other non-OK responses, and transport failures without changing its non-throwing contract
- **Quota failure presentation helper**: New `describeQuotaFailure()` export maps unavailable quota states to consistent first-party severity, title/message/detail copy, retryability hints, and stable alert keys for CLI and VS Code consumers

## [0.13.7] - 2026-03-11

_No shared-specific changes in this release._

## [0.13.6] - 2026-03-11

### Fixed

- **OpenCode DB-backed resolution**: OpenCode project discovery now matches DB projects by worktree, sandboxes, and session directory, and synthetic `db-sessions/<projectId>` folders are treated as monitorable paths
- **OpenCode runtime status**: DB-backed consumers can now distinguish `db_missing` from `sqlite_missing`, `sqlite_blocked`, and `query_failed`, enabling OpenCode-only actionable runtime notices instead of silent fallback to legacy file scanning

## [0.13.5] - 2026-03-10

### Added

- **Provider Status module**: `fetchProviderStatus()` for checking Claude API health via `status.claude.com` — returns indicator, affected components, active incidents, with graceful fallback on errors

## [0.13.4] - 2026-03-08

_No shared-specific changes in this release._

## [0.13.2] - 2026-03-04

### Added

- **Credentials module**: `readClaudeMaxCredentials()` and `readClaudeMaxAccessTokenSync()` for reading Claude Max OAuth credentials from `~/.claude/.credentials.json`
- **Quota module**: `fetchQuota()` for fetching Claude Max subscription quota (5-hour and 7-day windows)
- **Vitest config**: Added vitest configuration for shared library tests

## [0.13.1] - 2026-03-04

### Added

- **Quota types**: `QuotaWindow` and `QuotaState` types exported for CLI and extension consumption

## [0.13.0] - 2026-03-03

### Changed

- **Refactoring**: Removed dead code, cached hot paths, centralized constants across shared modules

## [0.12.10] - 2026-03-01

### Added

- **Event aggregation**: `EventAggregator` with frequency tracking, activity heatmaps, and pattern extraction
- **Analytics engines**: `FrequencyTracker`, `HeatmapTracker`, `PatternExtractor` for session analytics
- **Snapshot persistence**: `saveSnapshot` / `loadSnapshot` for aggregator state serialization

## [0.12.9] - 2026-02-28

### Added

- **Cross-session search**: `searchSessions()` for full-text search across session data
- **Advanced filter**: `FilterEngine` with substring, fuzzy, regex, and date range modes
- **Context composer**: `composeContext()` for assembling tasks, decisions, notes, and handoff into a single output

## [0.12.8] - 2026-02-28

_No shared-specific changes in this release._

## [0.12.7] - 2026-02-27

### Added

- **HTML report generation**: `generateHtmlReport()` produces self-contained HTML session reports with transcript, stats, and tool summaries
- **Plan extraction**: `PlanExtractor` for cross-provider plan capture (Claude Code, OpenCode, Codex)
- **Changelog parser**: `parseChangelog()` for reading Keep a Changelog formatted files

## [0.12.6] - 2026-02-26

### Added

- **Session dump formatters**: `formatSessionText`, `formatSessionMarkdown`, `formatSessionJson` for exporting session data
- **Noise classifier**: Event classification for filtering noise from session streams
- **Event highlighter**: Keyword coloring for session event summaries
- **Plans reader**: `readPlans`, `readClaudeCodePlanFiles` for plan file discovery
- **Phrase library**: Shared phrase content moved from CLI to shared library

## [0.12.5] - 2026-02-24

_No shared-specific changes in this release._

## [0.12.4] - 2026-02-24

_No shared-specific changes in this release._

## [0.12.3] - 2026-02-24

### Added

- **Subagent trace parser**: `scanSubagentTraces()` for parsing agent trace files
- **Session activity detector**: `detectSessionActivity()` for determining session state
- **Debug log parser**: `parseDebugLog`, `filterByLevel`, `discoverDebugLogs` for Claude Code debug log analysis

## [0.11.0] - 2026-02-19

### Added

- **Initial release**: Shared data access library extracted from the VS Code extension
  - Session event types and persistence schemas
  - JSONL, OpenCode, and Codex parsers
  - Claude Code, OpenCode, and Codex session providers
  - Task, decision, note, history, and handoff readers
  - Session path resolution and subagent scanning
  - Watcher framework for live session file monitoring
  - Tool summary formatter
