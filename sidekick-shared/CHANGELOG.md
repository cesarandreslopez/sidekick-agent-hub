# Changelog

All notable changes to sidekick-shared will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
