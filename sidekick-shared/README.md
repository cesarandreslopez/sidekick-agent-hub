# sidekick-shared

Shared data access library for [Sidekick Agent Hub](https://github.com/cesarandreslopez/sidekick-agent-hub).

[![npm version](https://img.shields.io/npm/v/sidekick-shared.svg)](https://www.npmjs.com/package/sidekick-shared)
[![license](https://img.shields.io/npm/l/sidekick-shared.svg)](https://github.com/cesarandreslopez/sidekick-agent-hub/blob/main/LICENSE)

Types, parsers, providers, readers, formatters, aggregation, search, reporting, credentials, and quota for AI agent session monitoring. Used by both the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) and the [CLI dashboard](https://www.npmjs.com/package/sidekick-agent-hub).

## Recent additions

- **0.30.0: Codex subagents, agents that never report, and compressed rollouts**
  - **Codex subagents:** `EventAggregator` follows a `spawn_agent` child from its `{"task_name"}` launch to its `completed` record or `FINAL_ANSWER` report; `followup_task` reopens it, `interrupt_agent` stops it, and a failed spawn is `failed`. `CodexRolloutParserOptions.includeSubagentActivity` (on in the Codex reader) turns Codex's `SubAgentActivity` records and `FINAL_ANSWER` messages into `system` events that `subagentActivityFromEvent()` reads. `isSubagentSpawnTool()` now also matches `spawn_agent`; `isCodexSubagentSpawnTool()` and `parseCodexSpawnLaunch()` are new, and `SUBAGENT_SPAWN_TOOL_NAMES` / `isAssistantTurnSubagentTool()` stay Claude Code-only.
  - **Discovery:** Codex `scanSubagents()` returns every spawned thread below a session, and `SubagentStats` gains `filePath`, `spawnToolUseId`, `agentNickname`, `agentPath`, `parentAgentId`, `depth`, and `endedCleanly`. A forked child's stats no longer count the parent history its rollout embeds.
  - **Settling:** `applySubagentEvidence()` applies Claude Code meta flags, and `agents_killed` lines, stop notices, and post-compaction `task_status` attachments settle running agents; `SubagentLifecycle.settledBy` records which. `resolveSubagentDisplayState()` reads a still-running agent as `finished-unreported` or `ended` without changing its lifecycle.
  - **Compressed rollouts:** `includeCompressedRollouts` reads Codex `.jsonl.zst` rollouts where `zlib.zstdDecompressSync` exists (Node 22.15+) and skips them with a diagnostic elsewhere. `readRolloutText()` and `resolveRolloutPath()` are on the root and `/node`.
  - **Readers:** the Claude Code and Codex readers restart from offset 0 when the file was rewritten or replaced, not only when it shrank. `wasTruncated()` reports any restart and optional `lastReset()` says why. `SessionMonitor.poll()` and the Codex watcher now read first and reset before delivering the replay, so a truncated file's events are no longer counted twice.
  - **Also:** `PermissionMode` adds `auto` and `dontAsk`; `includeTaskNotifications` also emits `task_status` events; `classifyTool()` maps `wait` to `other` and `interrupt_agent` to `subagent`; saved aggregator snapshots (schema 7) replay once.
- **0.29.1: background agents, `Agent` spawns, and verified resume**
  - **Subagents:** Claude Code's `Agent` tool (the new name of `Task`) is tracked wherever `Task` was; `isSubagentSpawnTool()` / `SUBAGENT_SPAWN_TOOL_NAMES` name both. A background agent stays running until its `<task-notification>`, and `SubagentLifecycle` records `agentId`, `background`, and `outcome` (`completed`, `failed`, `killed`, `stopped`). `parseTaskNotification()`, `taskNotificationFromEvent()`, and `isTaskNotificationSystemEvent()` read the notices.
  - **Traces:** `SubagentTrace` gains `filePath`, `spawnToolUseId`, `parentAgentId`, `background`, `finished`, and `stoppedByUser` from Claude Code's meta file (`readAgentMeta()`). Traces are linked by that metadata before the heuristics run, and `parentToolUseId` now holds the spawning tool-use id when the meta file records one.
  - **Events:** `extractSessionEvents(raw, { includeTaskNotifications: true })` and `createWatcher({ includeTaskNotifications: true })` turn mid-turn task-notification attachments into `system` events. A `permissionMode` this release doesn't know (Claude Code's `auto`) no longer drops the line.
  - **Resume:** `captureJsonlCheckpoint()` / `verifyJsonlCheckpoint()`, `SessionSnapshot.sourceCheckpoint` / `readerState`, `isSnapshotValid(snapshot, size, sourcePath)`, and optional `getResumeState()` / `restoreResumeState()` on readers and watchers. A resumed session counts a split Claude response once and keeps its Codex parser context.
  - **Lookups:** pricing, context-window, model-info, tool-name, and z.ai error tables read only their own keys, so an id such as `constructor` or `__proto__` is treated as unknown instead of matching an `Object.prototype` member.
- **0.29.0: lean entries, usage attribution, and honest pricing**
  - **New subpaths:**
    - `sidekick-shared/pricing`: pure, 8 modules. Pricing, model identity, usage cost, cost provenance, formatting and token estimates.
    - `sidekick-shared/codex`: Node, no Zod, 13 modules. Codex homes and env, `auth.json` helpers, rollout lookup and origin, auth-status parsers.
    - `sidekick-shared/providerFailure`: pure.
    - `sidekick-shared/statusline/payload`: pure. The status-line stdin parser without account or quota code.
  - **Usage events:** `collectUsageEvents()` events carry reasoning tokens, the `promptOrdinal` they answered (the same ordinals as prompt history), the provider message id, and `subagent` attribution. The cache is v3, written as `*.v3.json` so 0.28 readers sharing the folder are unaffected.
  - **`bucketUsage()`** gains a `session` dimension, `pricedCostUsd` (null when nothing was priced), `reasoningTokens`, `excludeSynthetic`, and `modelKey: 'canonical'`.
  - **`findToolCallOrigins()`** maps tool-call ids to their session, time and prompt ordinal.
  - **Pricing:**
    - `canonicalModelId()` merges spellings of one model id.
    - `registerModelPricing()` adds local prices that survive catalog hydration.
    - `getPricingCatalogInfo()` reports which catalog priced a cost, with a stable digest.
    - `formatCost(value, { source })` renders null and unpriced costs as "—" and estimates with " (est.)".
  - **Provider failures:** `diagnoseProviderFailure()` decodes Codex `codexErrorInfo` and sets `retryable`.
  - **Also new:**
    - `parseClaudeAuthStatus()` and `parseCodexLoginStatus()`
    - `collectPromptHistory({ includeText: false })`
    - `createJsonlTail()` checkpoints, `onRewrite: 'end'`, `noFollow` and async `read()`
    - Codex parser `maxPendingBytes` and `metadataOnly`
    - transcript projections expose `rawToolName` and `mcpServerName` without leaking internal keys
    - `installCredentialGuard({ preserveEnv })`
- **0.28.3: plans without a 5-hour window** — a null `five_hour` from the Claude usage endpoint (Ultra, since 2026-10-30) becomes `fiveHour.absent` instead of 0% used. The endpoint's server-driven `limits[]` meters, `extra_usage`, and the credential plan land on `QuotaState.limits` / `extraUsage` / `planLabel` (`quotaStateFromClaudeUsagePayload()`, `fetchQuota(token, { plan })`). Pure helpers `quotaWindowApplies()` / `quotaWindowHasData()` / `quotaWindowLabel()` / `quotaWindowShortLabel()` / `extraQuotaRows()` / `formatExtraUsage()` / `claudePlanLabel()` are on the root and browser entries, and `quotaHistoryWindow()` is on the root and statusline entries. `writeQuotaSnapshot()` no longer freezes once a window disappears or resets, and `resolveQuota()` reports a fully expired cache as unavailable.
- **0.28.1: credential guard keeps `promisify(execFile)`** — after `installCredentialGuard()`, `promisify(execFile)` and `promisify(exec)` resolve to `{ stdout, stderr }` again (0.28.0 dropped Node's `util.promisify.custom`, so they returned the bare stdout string), and the promisified calls are guarded too.
- **0.28.0: ES modules, narrow entries, and new readers** — a `module` export condition gives bundlers a tree-shakable ES-module build (Node keeps CommonJS); browser-safe parsers and helpers move onto `/browser` and the provider-home helpers onto `/node`; `sidekick-shared/testing` publishes the credential guard; `providerFailureDiagnosisSchema` joins `/schemas`; prompt history reports `changed` / `progressed` / `roots` and takes `sessionRefs`; signals carry `toolCategory` and `mcpServer`; `collectUsageEvents()` takes `workspacePaths`; `createJsonlTail()` is bounded and reports resets; and Claude sessions follow `CLAUDE_CONFIG_DIR` while Codex lookups include `archived_sessions/`.
- **0.27.6: one usable copy per login** — Claude Code and Codex rotate refresh tokens, so a second usable copy of a login invalidates the first ("Not logged in · Please run /login"). The live account now keeps no profile-home credential, only a private backup; `syncLiveAccountState()` demotes a leftover copy (installing it first when it is newer) and reports `demoted`, `repaired`, and `journal`. Live writes pass `decideLiveClaudeWrite()` or the Codex equivalent: a switch captures the outgoing login first even with `force`, holds Claude Code's refresh lock, is journaled so the next sync finishes or rolls it back, and keeps live MCP tokens. Claude Keychain writes use Claude Code's hex method and are read back (`ClaudeCredentialWriteError`), so blobs over about 4 KB are no longer truncated. New root APIs: `readClaudeCredentialStore()`, `inspectClaudeCredentialStores()` / `repairClaudeCredentialStores()`, `inspectCodexCredentialStores()` / `repairCodexCredentialStores()`, `readClaudeCredentialLedger()`, `readStoredCodexAccount()`, `syncCodexLiveStateAsync()`, `discardAccountLogin()`, `writeAccountLauncher()`, and non-persisting health inspection (`persist: false`). `writeActiveCredentials()` now requires a config directory; `writeLauncher()`, `applyActiveClaudeToLiveHome()`, and `resolveActiveClaudeHome()` are deprecated.
- **0.27.5: whole-session prompt history** — `collectSessionPromptHistory()` (root and Node) returns every human prompt of each matching Claude Code or Codex session, grouped by session and read from the start with the `collectPromptHistory()` scanners, so text, scope, model and usage, and ordinals are identical. Select with `sessionIds`, `since` (file mtime), or `limit`; each session carries `startedAt` / `lastActivityAt`, `cwds`, `gitBranches`, `models`, and `complete` / `truncated` / `droppedPrompts` / `excludedRecords`. `include.replies` adds the agent's last text for each prompt, and `include.signals` adds `interrupt`, `toolRejected`, `toolError`, `compaction`, `apiError`, and `rollback` signals. Sessions that `maxSessions`, `maxTotalBytes`, the deadline, or an abort cut off are listed in `unread` instead of being returned partially.
- **0.27.4: usage events from the Node entry** — `sidekick-shared/node` now exports `createSessionProviders()`, `SYNTHETIC_MODEL`, and the `ProviderId` / `SessionProviderBase` / `SessionProviderDiagnostic` / `CreateSessionProviders*` types, so `collectUsageEvents()` callers never import the package root (a CommonJS barrel that bundlers cannot tree-shake). `collectUsageEvents()` accepts an optional `signal` that stops the collection before listing and between sessions.
- **0.27.3: honest session totals** — Claude Code split lines are counted once: `ClaudeUsageDeduper` keeps a `message.id`'s first usage, strips identical repeats, and turns streamed growth into a `usageKind: 'correction'` delta that `EventAggregator` adds to tokens and cost without counting another call. `resolveCodexCallUsage()` drops duplicate Codex `token_count` events. `collectSessionTokenTotals()` (root and Node) returns `mainThread`, per-`subagents`, `subagentTotal`, and `combined` in the `summarizeTokens()` vocabulary, and `formatTokenBreakdown()` renders one line whose parts add up to the headline. `TokenSummary` gains `reasoning` / `billedOutsideBuckets`, and `SubagentStats` from every provider now carries cache, reasoning, and total tokens. The session dumps and `HtmlReportOptions` accept `subagents`, `readSessionReportInputs()` returns them, `collectUsageEvents()` reads Claude Code subagent transcripts, and `USAGE_CACHE_VERSION` 2 re-reads caches built with the old counting.
- **0.27.2: streamed prompt history** — `collectPromptHistory()` reads session logs of any size in bounded, resumable passes instead of skipping files over `maxFileBytes`: every call keeps what it read, the cursor (`version: 3`) continues where each file stopped, and a pending prompt keeps its answer state so a far-away answer still settles it. Adds `maxRecordBytes` and `maxEntries` bounds, `hasMore`, permanently skipped records in `exclusions`, and rewrite detection.
- **0.27.1: late prompt metadata** — `collectPromptHistory()` returns a prompt again, with the same provider, sessionId, ordinal, timestamp, and text, when its first answering call is written after an earlier collection, and entries gain `metadataStatus` (`pending` / `provisional` / `final`). The cursor becomes `version: 2`, keeps a replay offset and metadata digest for the one open prompt per file (no prompt text), and still accepts 0.27.0 cursors.
- **0.27.0: human prompt history** — `collectPromptHistory()` (Node-only) returns the prompts a person typed in Claude Code and Codex sessions under a set of workspace roots (plus git worktree siblings), with fail-closed cwd scoping, untruncated text, stable per-session ordinals, the answering model and usage, a JSON-serializable resume cursor, and bounds that stop cleanly and report themselves in `boundsHit`. `isHumanPrompt()` / `humanPromptText()` expose the same classification for any canonical transcript message, and transcript provenance now keeps Claude Code's `isCompactSummary`, `originKind`, and `promptSource`. Claude Opus 5.5 gets its own pricing and context entries.
- **0.26.6: verified account switching** — `syncLiveAccountState()` reconciles the live Claude Code and Codex logins with saved profiles (registers unknown logins under their email, folds rotated tokens, merges duplicate Codex profiles, re-points the active pointer) and runs at startup, on account-change events, and as phase one of every switch; `getAccountHealth()` / `listAccountsWithHealth()` report secret-free `fresh | expiring | expired | unknown | missing` health; `switchAccount[Async]()` returns a `SwitchAccountResult` with verification, `runningConsumers`, `needsLogin`, and an `undoToken` for `undoLastSwitch()`; `detectRunningAccountConsumers()`, `getAccountLaunchEnv()`, `refreshInactiveAccounts()`, and `getCodexCredentialStoreMode()` are new. Claude logins run `claude auth login`, the Keychain suffix follows Claude Code 2.1.x, and the unused shell-hook helpers were removed.
- **0.26.5: event-scoped collection** — `ObservedSessionCollector.subscribe()` reconciles each watch event with one `statWatchedSessionFile()` stat and runs a full `discover()` only for unknown paths, catch-up polls, and the initial pass, gated by `minReconcileGapMs`; `discover({ limit, since })` / `collect({ limit, since })` bound a pass, `maxCacheEntries` / `maxCacheBytes` bound the parse cache, `DirectoryListingCache` makes a full pass one stat per unchanged directory, and the info-severity `provider-discovery-completed` diagnostic reports what each pass cost.
- **0.26.3–0.26.4: provider failure diagnosis and service status** — `diagnoseProviderFailure()` (root and browser) classifies caller-designated terminal errors into bounded diagnosis and recovery identifiers with evidence provenance; `fetchProviderServiceStatus()` (root and Node) returns explicit observed/unavailable public status with component and incident associations. 0.26.4 recognizes expired-login and re-authentication messages, gives explicit refresh-token rejection precedence over conversation-expiry wording, and classifies `denied by policy` as `execution_policy_denied`.
- **0.26.2: reliable monitoring and search** — complete-line JSONL cursors preserve Unicode and Codex parser context; watcher `onBatchComplete` signals a delivered batch. `searchSessions()` adds workspace-path filtering and cancellation, and Doctor accepts an explicit session provider.
- **One token vocabulary and cost provenance (0.26.0–0.26.1)** — `summarizeTokens()` gives every surface the same `total` (input + output + cache writes + cache reads) and `context` (input + cache) figures; `AggregatedTokens.costUsd` carries `costProvenance` so reports can say whether a cost was provider-reported or estimated; `parseClaudeStatuslinePayload()` / `quotaFromStatuslinePayload()` turn Claude Code's status-line JSON into an official `statusline` quota source; `readQuotaSnapshot()` reports `ageMs` / `freshness` and keeps the sample's origin as `capturedSource`; `resolveQuota()` shares quota resolution across CLI, MCP, and dashboard startup, with default local-sample preferences and an API-first option used by one-shot Codex queries; `readSessionFileStats()` / `computeSessionFileStats()` give every provider one `readSessionStats()` over the shared aggregator, with `availability`, `costProvenance`, and `toolFailures` on `SessionFileStats`; `collectUsageEvents()` reads priced usage events from session logs with a per-session cache, `computeBillingBlocks()` groups them into five-hour billing blocks, and `bucketUsage()` turns them into day, week, month, or session rows; `applySessionSummary()` and `importSessionHistory()` let any host fold finished sessions into `historical-data.json` the way the extension does; observed sessions are read once per discovery, re-read only when their fingerprint changes, and classified from events by `classifySessionActivity()`; `readSessionReportInputs()` derives report metrics and transcript from one read; `writeStateFile()` / `readStateFile()` (also on the `statusline` subpath) maintain the public, versioned `state.json` for external tools, validated by `sidekickStateFileSchema` from `sidekick-shared/schemas`; `getScheduledPeakHoursState()` and `evaluateQuotaThresholds()` are shared by the CLI and extension dashboards.
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
- **Statusline & burn rate** — `formatStatusline()` and `BurnRateCalculator` render a cache-only account/quota/burn footer, importable from the [`sidekick-shared/statusline`](#supported-import-paths) subpath.
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

| Module                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Types**                         | Session events, OpenCode/Codex format types, persistence schemas (tasks, decisions, notes, plans, historical data)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Paths**                         | Config directory resolution, project data paths, workspace encoding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Readers**                       | Read tasks, decisions, notes, history, handoff, and plans from `~/.config/sidekick/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Writers**                       | Atomic persistence writers — `atomicWriteJson()` / `updateJsonStoreAtomic()` and their synchronous twins `atomicWriteJsonSync()` / `atomicWriteFileSync()` / `updateJsonStoreAtomicSync()` / `withFileLockSync()` (same cross-process lock file, progress-based timeouts, abandoned-lock reclaim), plus lock-coordinated capture helpers `addTask()`, `completeTask()`, `addDecision()`, `addNote()` that merge into the shared stores without clobbering concurrent writers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Providers**                     | Session provider abstraction with Claude Code, OpenCode, and Codex implementations; auto-detection via filesystem. As of 0.25.0 constructors perform no environment I/O — build them all with `createSessionProviders({ onDiagnostic })`, which reports unavailable providers as structured diagnostics instead of failing; `findSessionById()` resolves one session through provider-native indexes; stable provider-id const arrays (`SESSION_PROVIDER_IDS`, `ACCOUNT_PROVIDER_IDS`, `QUOTA_PROVIDER_IDS`, `MODEL_PROVIDER_IDS`) accompany the derived unions. As of 0.26.5 Claude Code and Codex enumerate through a per-instance `DirectoryListingCache` (one stat per unchanged directory) and implement `statWatchedSessionFile()` so a watch event resolves with one stat; `splitWatchedPath()` and the `ListSessionFilesOptions` / `WatchedSessionFile` / `SessionEnumerationCounters` types are exported alongside. As of 0.30.0 `includeCompressedRollouts` (on `createSessionProviders()` and `CodexProviderOptions`) reads Codex `.jsonl.zst` rollouts, Codex `scanSubagents()` returns every spawned thread below a session (`isCodexSubagentThread()`, `CodexDatabase.getSpawnedDescendantThreads()`), and the Claude Code and Codex readers restart on a rewritten or replaced file (`wasTruncated()`, optional `lastReset()`) |
| **Observed Sessions (V1)**        | Versioned provider-neutral observation contracts — `createProviderSessionAdapterV1()` / `derivePendingUserRequestV1()` with `ObservedAgentSessionV1`, `ProviderCapabilitiesV1`, `PendingUserRequestV1`, `SessionEvidenceRefV1`, and provenance/confidence wrapper types (Zod schemas in `sidekick-shared/schemas`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Parsers**                       | JSONL event parsing, OpenCode/Codex format normalization, subagent scanning (`scanSubagentDir()`, `scanSubagentTraces()`, `readAgentMeta()`), Codex subagent activity events (`includeSubagentActivity`, `subagentActivityFromEvent()`), session path resolution, debug log parsing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Watchers**                      | Live session file watching with event bridging (`createWatcher()`, with `includeTaskNotifications` for Claude Code mid-turn task notifications, stop notices, final `task_status` attachments, and `agents_killed` lines) and optional `getResumeState()` / `restoreResumeState()`, plus `createJsonlTail()` for raw incremental JSONL consumers and `captureJsonlCheckpoint()` / `verifyJsonlCheckpoint()` for readers that keep their own offset                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Formatters**                    | Display helpers (`formatTokenCount()`, `formatDurationMs()`), the shared token vocabulary (`summarizeTokens()`, `formatTokenBreakdown()`, `TOKEN_*_LABEL`s) and session totals incl. subagents (`collectSessionTokenTotals()`), tool summary, noise classification, session dump (text/markdown/JSON), event highlighting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Search**                        | Cross-session full-text search, advanced filtering (substring, fuzzy, regex, date)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Aggregation**                   | Event aggregation (including subagent lifecycles that follow Claude Code background agents and Codex `spawn_agent` children until a notification, stop marker, task status, or host evidence (`applySubagentEvidence()`) settles them, recorded in `settledBy`, and `resolveSubagentDisplayState()` for display), frequency tracking, activity heatmaps, pattern extraction, and session snapshots (`saveSnapshot()`, `loadSnapshot()`, `isSnapshotValid()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Analytics**                     | Session-quality scoring (beta) with factor contributions and weekly trends (`scoreSessionQuality()`, `calculateQualityTrend()`), code-impact metrics including cost per changed line and per-model churn/cost (`calculateCodeImpact()`), and reported-vs-heuristic compaction accounting (`calculateCompactionLedger()`, `formatCompactionLedger()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Error History**                 | Shared error taxonomy (`categorizeError()`, `extractErrorMessage()`) plus append-only per-project failure history (`appendErrorHistory()`, `readErrorHistory()`, `getTopFailingTools()`) behind per-tool/hour/model error rollups                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Session Context**               | Provider-neutral context evidence snapshots (`buildSessionContextSnapshot()`, `calculateSessionContextPressure()`, `createSessionContextProjector()`, `readSessionContextSnapshot()`): layered evidence sources, low/medium/high context pressure, and observed capabilities (tools, MCP servers, permission mode, rate limits)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Assistant Turns**               | Browser-safe timeline/process/answer projection for provider-normalized assistant turns (`segmentAssistantTurn()`, `assistantTurnEventsFromSessionEvents()`), including interleaved reasoning, compact tool groups, and Claude Code `Agent` / `Task` subagent refs without prompt leakage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Report**                        | Self-contained HTML session report generation; `readSessionReportInputs()` returns metrics, transcript, and `subagents` for the session total                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Credentials**                   | Claude subscription (Pro / Max / Ultra) OAuth credential reading (macOS Keychain with a `~/.claude/.credentials.json` fallback; the file on Linux and Windows). `readClaudeCredentialStore()` returns `ok` / `absent` / `corrupt` / `error`; `writeActiveCredentials()` requires a config directory and reads every write back (`ClaudeCredentialWriteError`). `decideLiveClaudeWrite()`, `claudeRefreshFingerprint()`, `claudeLoginOnly()`, and `mergeClaudeLoginIntoLive()` expose the live-write policy. As of 0.27.6, `inspectClaudeCredentialStores()` / `repairClaudeCredentialStores()` and `inspectCodexCredentialStores()` / `repairCodexCredentialStores()` find and repair unused, duplicate, and unreadable stores Sidekick provably owns (repairs are dry runs unless `dryRun: false`), with Claude ownership recorded by `readClaudeCredentialLedger()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Quota**                         | Claude subscription quota fetching (5-hour and 7-day windows; `fiveHour.absent` on plans without a 5-hour limit such as Ultra; server meters in `limits`, `extraUsage`, and `planLabel`), Codex rate-limit extraction from event streams (plus Codex reset credits via `fetchCodexResetCreditsFromApi()`, attached to quota state by `fetchCodexQuotaFromApi()`), and authoritative z.ai Coding Plan quota fetching via `resolveZaiQuota()` / `fetchZaiQuotaFromApi()` (reads z.ai's `api/monitor/usage/quota/limit` endpoint with cached-snapshot fallback). The observed-traffic z.ai estimator was removed from the package root exports in 0.23.0 and every remaining export of it is `@deprecated` — `resolveZaiQuota()` is the single supported z.ai quota API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Provider Status**               | `fetchProviderServiceStatus()` returns explicit observed/unavailable public status with components and unresolved incidents from status.claude.com and status.openai.com; `fetchProviderStatus()` / `fetchOpenAIStatus()` remain as lossy legacy projections (`toLegacyProviderStatus()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Doctor**                        | Typed cross-provider health diagnostics — `runDoctor()` checks project identity, sessions, accounts, providers, and dependencies into a `HealthReport`; `formatHealthReport()` renders it and `getSessionDiagnostics()` retains the legacy Claude Code path probe; `runDoctor({ provider })` diagnoses the selected session provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Schemas**                       | Zod schemas for runtime validation of data crossing process/IPC boundaries — JSONL session events (`sessionEventSchema`, `messageUsageSchema`, `sessionMessageSchema`), assistant turns, observed-session V1 records, quota, account status, account management, quota history, and the public `state.json` contract (`sidekickStateFileSchema`, exported only from `sidekick-shared/schemas`) — plus `extractSessionEvents()` to unwrap `progress`-wrapped events (and, with `{ includeTaskNotifications: true }`, mid-turn task-notification attachments and background agents' final `task_status` attachments). Account and quota APIs guarantee results valid against the same-release schemas. Also published fs-free via the [`sidekick-shared/schemas`](#supported-import-paths) subpath                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Extractors**                    | Pure functions for single-event processing: `extractTokenUsage()`, `extractToolCall()` (top-level `tool_use`), `extractToolCalls()` (assistant content blocks), plus Node-only session asset extraction (`gatherAssetsForCwd()`, `readClaudeAssets()`, `readCodexAssets()`) for URLs, file paths, commands, and plans                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Model Info & Pricing**          | Model family parsing (Anthropic / OpenAI / Google, including legacy `claude-3-opus-…` and `claude-3-5-sonnet-…` IDs), context-window lookup (including Fable 5.1 / Opus 5.5 / Opus 5 / Opus 4.8 / Opus 4.7 1M and GPT-5.x / GPT-6 variants), pricing tables with optional LiteLLM hydration, normalized non-double-counting cost (`calculateNormalizedUsageCost()`, fed by `normalizeProviderUsage()` / `extractNormalizedUsage()`), legacy cost helpers retained but deprecated (`calculateCost()`, `calculateCostWithProvenance()`), `mergeCostSources()`, display helpers (`shortModelName()`, `getModelDisplayInfo()`, `compareModelIds()`, `sortModelIds()`, `formatCost()`), and cross-realm catalog transfer — `exportResolvedModelCatalog()` / `importResolvedModelCatalog()` move resolved context windows and pricing (with provenance, prefix inheritance explicit) between Node and browser realms, and `registerModelAlias()` resolves short or host-specific names to canonical ids                                                                                                                                                                                                                                                                                                                                             |
| **Quota Polling**                 | `QuotaPoller` class with exponential backoff, active/idle intervals, and cached fallback. Stays dormant while no account exists and wakes through the account-change signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Multi-Provider Quota**          | `MultiProviderQuotaService` orchestrates Claude polling + peak-hours + account labels + Codex/z.ai quota updates behind one typed event stream. `CodexQuotaWatcher` watches the active Codex rollout for live rate limits with snapshot fallback; z.ai quota uses the API resolver with snapshot fallback. All three stay dormant without a matching account and wake on account changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Accounts**                      | Multi-provider account registry (v2) with per-provider active account, save/switch/remove, v1 migration, `ensureDefaultAccounts()` for startup bootstrap (migrations, abandoned-login cleanup, then `syncLiveAccountState()`), `syncLiveAccountState()` to register live logins the registry has never seen under their email, fold rotated tokens into a private backup (the live account keeps no profile-home copy; `ProviderSyncReport` reports `demoted`, `repaired`, and switch-`journal` recovery), and merge duplicate Codex profiles, `getAccountHealth()` / `listAccountsWithHealth()` for secret-free `fresh`/`expiring`/`expired`/`unknown`/`missing` health with access/refresh expiry, `getActiveAccountStatus()` for a single-pass active-account read across providers, `onAccountsChanged()` for push-based login/logout/switch notification (process-local mutations, filesystem watches, and a catch-up poll), and live-first `resolveActiveClaudeAccount()` /`resolveActiveCodexAccount()` that report the currently logged-in account (self-healing the saved pointer) for display                                                                                                                                                                                                                                       |
| **Account Management 2.0**        | Provider-neutral acquisition + switching: `beginAccountLogin()` / `getAccountLoginStatus()` / `finalizeAccountLogin()` / `spawnAccountLogin()` drive a TTY-less, profile-isolated login that doesn't disturb the active account until finalization; `listAllAccounts()` and `switchAccount()` expose a shared switcher across Claude and Codex; as of 0.26.6 switches are two-phase and verified, return a `SwitchAccountResult` with `runningConsumers`, `needsLogin`, and an `undoToken` (`undoLastSwitch()`), refuse expired or missing credentials unless forced, and `beginAccountLogin(provider, label, { existingAccountId })` re-authenticates a saved profile in place. As of 0.27.6 a switch always captures the outgoing login first (even with `force`), and `discardAccountLogin()` releases an abandoned login home. Every status/finalize/switch entry point also has an `-Async` variant (`getAccountLoginStatusAsync()`, `finalizeAccountLoginAsync()`, `switchAccountAsync()`, …) that keeps `codex` CLI probes off the event loop — prefer those from hosts with a UI loop. Claude accounts get canonical profile homes with account-scoped macOS keychain suffixes (the live account's home holds no credential) and startup migration from legacy flat backups                                                           |
| **Isolated launch & auto-switch** | `getAccountLaunchEnv()` builds an isolated `CLAUDE_CONFIG_DIR` / `CODEX_HOME` environment (plus `envUnset`) for running a CLI as a saved account without switching — the live account gets the live home, and an inactive profile is restored from its backup first unless `restoreBackup: false` — `writeAccountLauncher()` / `removeLauncher()` write POSIX launcher scripts that resolve the account's home when they run (`writeLauncher()` is deprecated), `detectRunningAccountConsumers()` / `findRunningProcesses()` find CLIs and desktop apps that hold a login (`ps` / `tasklist`), `refreshInactiveAccounts()` is an opt-in keep-alive through the official CLIs, and a default-off `AutoSwitchController` (`decideAutoSwitch()`) moves to a healthier saved account when quota crosses a configured threshold; its `switchAccount` callback may return a Promise and defaults to `switchAccountAsync()`                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Codex Profiles**                | Codex account lifecycle — prepare, finalize, switch, remove — switching atomically swaps the profile's backed-up credentials into the system `~/.codex/auth.json`, with rotated-token staleness protection, one-time dual-home migration, and legacy multi-home session monitoring. As of 0.27.6 every account keeps a private byte-preserved backup, the live account keeps no profile copy, switches are journaled and refuse while Codex consumers run or keep-alive holds the account (`force` bypasses neither), file-mode credential storage is required, and `readStoredCodexAccount()` / `syncCodexLiveStateAsync()` are public                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Quota Snapshots**               | Persistent quota caching per provider/account for offline fallback                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Statusline**                    | Cache-only one-line account/quota/burn footer — `formatStatusline()`, `selectStatuslineAccount()`, `BurnRateCalculator`, and `estimateTimeToQuota()`, also published via the [`sidekick-shared/statusline`](#supported-import-paths) subpath for fast per-prompt rendering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Phrases**                       | Curated humorous phrases for loading/idle states, available as a flat `ALL_PHRASES` array or grouped via `PHRASE_CATEGORIES` for category-aware UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Supported import paths

`sidekick-shared` ships three main entry points (the root, `/browser`, `/node`) plus narrower single-purpose subpaths. Pick the one that matches your runtime. As of 0.25.0 every documented subpath declares explicit `types` / `import` / `require` / `default` export conditions and resolves under Vite and TypeScript's legacy `moduleResolution: node` without consumer-side aliases.

| Path                                 | Runtime                    | What it exposes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidekick-shared`                    | Node (CLI, extension host) | Full public API (readers, providers, parsers, pricing, …).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sidekick-shared/browser`            | **Browser / webview**      | Pure helpers: usage normalization/pricing, token estimation, transcript and assistant-turn projection, model/context math, `parseMcpToolName()`, the `CodexRolloutParser` with the Codex rollout and session-event types, human-prompt detection (`isHumanPrompt()` / `humanPromptText()`), `renderHandoffUrlTemplate()`, the subagent helpers: spawns (`isSubagentSpawnTool()`, `isCodexSubagentSpawnTool()`, `parseCodexSpawnLaunch()`), task notifications (`parseTaskNotification()`, `taskNotificationFromEvent()`, `isTaskNotificationSystemEvent()`), settling records (`parseAgentsStoppedNotice()`, `agentsStoppedNoticeFromEvent()`, `isAgentsKilledSystemEvent()`, `taskStatusFromAttachment()`, `taskStatusFromEvent()`, `isTaskStatusSystemEvent()`), Codex subagent activity (`subagentActivityFromEvent()`, `isSubagentActivitySystemEvent()`, `describeSubagentActivity()`, `parseCodexAgentMessageText()`), and display state (`resolveSubagentDisplayState()`, `subagentDisplayLabel()`), `ClaudeUsageDeduper`, and the quota window helpers (`quotaWindowApplies()`, `quotaWindowHasData()`, `quotaWindowLabel()`, `quotaWindowShortLabel()`, `extraQuotaRows()`, `formatExtraUsage()`, `claudePlanLabel()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sidekick-shared/node`               | Node only                  | LiteLLM pricing and context-window hydration, public provider service status (`fetchProviderServiceStatus()`), observed context-window persistence, recent-session/transcript reads, human prompt history (`collectPromptHistory()`, and whole sessions with `collectSessionPromptHistory()`), tool-call origins (`findToolCallOrigins()`), usage events from session logs (`collectUsageEvents()` with `createSessionProviders()` and `SYNTHETIC_MODEL`), session previews (`listSessionPreviews()` / `readSessionPreview()` plus the bounded-concurrency `listSessionPreviewsAsync()` / `readSessionPreviewAsync()`), Codex history/rollout lookup (`readCodexHistory()`, `findCodexRolloutFile()`, `walkRolloutFiles()`), compressed Codex rollouts (`readRolloutText()`, `readRolloutBuffer()`, `resolveRolloutPath()`, `isCompressedRolloutPath()`, `isZstdDecompressionAvailable()`, `COMPRESSED_ROLLOUT_SUFFIX`), the Codex subagent-activity readers (`subagentActivityFromEvent()`, `isSubagentActivitySystemEvent()`, `describeSubagentActivity()`, `parseCodexAgentMessageText()`), resilient observed-session collection (`fs` + providers), the provider homes the CLIs read (`getLiveClaudeHome()`, `getClaudeProjectsDir()`, `getSystemCodexHome()`, `getCodexMonitoringHomes()`, `getCodexExecutionEnv()`), Codex `auth.json` and credential-store helpers (`codexRefreshFingerprint()`, `compareCodexAuthFreshness()`, `getCodexCredentialStoreMode()`, `forceFileCredentialStore()`), the bounded JSONL tail and its checkpoints (`createJsonlTail()`, `captureJsonlCheckpoint()`, `verifyJsonlCheckpoint()`), the atomic JSON writers, Claude session-directory encoding (`encodeClaudeWorkspacePath()`, `getClaudeSessionDirectory()`), and the config root (`getConfigDir()`, `CONFIG_DIR_ENV_VAR`). |
| `sidekick-shared/phrases`            | Any runtime                | Phrase arrays + `getRandomPhrase()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `sidekick-shared/modelContext`       | Any runtime                | Direct access to the context-window module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sidekick-shared/modelInfo`          | Any runtime                | Direct access to model parsing and cost math.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sidekick-shared/formatting`         | Any runtime                | Direct access to pure cost, token, and duration display helpers (`formatCost()`, `formatTokenCount()`, `formatDurationMs()`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sidekick-shared/schemas`            | Any runtime                | Pure Zod boundary schemas (session events, assistant turns, observed-session V1, quota, account status, account management, quota history, the `state.json` contract) — fs-free, no Node builtins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sidekick-shared/statusline`         | Node only                  | Cache-only statusline surface: account status + quota snapshot readers and writers, `formatStatusline()`, burn-rate estimates, quota freshness and window helpers (`quotaWindowApplies()`, `quotaWindowHasData()`, `quotaWindowShortLabel()`, `quotaHistoryWindow()`), `parseClaudeStatuslinePayload()` / `quotaFromStatuslinePayload()`, and `readStateFile()` / `writeStateFile()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sidekick-shared/testing`            | Node test runners          | `installCredentialGuard()` keeps a test process away from the real `security` / `claude` / `codex` binaries and the real Claude, Codex, and Sidekick homes, and the Claude Code / Codex session-log builders (`createSessionLogFixtures()`, `writeJsonl()`, …). Framework-free.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sidekick-shared/pricing`            | Any runtime                | Pure, 9 modules, no Zod: model pricing and identity (`canonicalModelId()`, `parseModelId()`, `compareModelIds()`, `resolveModelPricing()`, `registerModelPricing()`, `getPricingCatalogInfo()`), usage normalization and cost (`normalizeProviderUsage()`, `calculateNormalizedUsageCost()`), cost provenance (`costSourceFromPricingProvenance()`, `mergeCostComponents()`, `mergeCostSources()`), `formatCost()` / `formatTokenCount()` / `formatDurationMs()`, and `estimateTextTokens()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sidekick-shared/codex`              | Node only                  | 14 modules, no Zod: Codex homes and the child-process env (`getSystemCodexHome()`, `resolveSidekickCodexHome()`, `getCodexExecutionEnv()`), `auth.json` helpers (`parseCodexAuthJson()`, `codexRefreshFingerprint()`, `compareCodexAuthFreshness()`), `getCodexCredentialStoreMode()` / `forceFileCredentialStore()`, `findCodexRolloutFile()` (with `includeCompressed`), `codexRolloutOrigin()`, `parseCodexLoginStatus()` / `parseClaudeAuthStatus()`, and `atomicWriteJson()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sidekick-shared/providerFailure`    | Any runtime                | Pure, 1 module: `diagnoseProviderFailure()`, `decodeCodexErrorInfo()`, and the identifier lists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sidekick-shared/statusline/payload` | Any runtime                | Pure, 2 modules: `parseClaudeStatuslinePayload()` / `quotaFromStatuslinePayload()` without the account, credential, or snapshot code the full `statusline` entry loads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Since 0.28.0 every subpath also has a `module` condition pointing at an ES-module build in `dist/esm/`. Bundlers that read it (esbuild, Vite, Rollup, webpack) tree-shake unused exports, so importing one helper from `sidekick-shared/node` bundles a few hundred bytes instead of the whole entry. Node itself never reads `module` and keeps loading the CommonJS build for both `require` and `import`, so a process never holds two copies of module state.

Prefer these paths over `sidekick-shared/dist/*` deep imports. The `dist/*` wildcard still resolves for compatibility, but module files behind it can move between releases without notice.

### Test suites

`sidekick-shared/testing` is for test suites that run sidekick-shared code against session data. Install the guard once per test process, before anything reads a home or spawns a CLI, and check it after each test:

```typescript
// vitest setupFiles entry (with `globals: true`)
import { installCredentialGuard } from 'sidekick-shared/testing';

const guard = installCredentialGuard();
afterEach(() => guard.assertNoViolations());
```

The guard points `HOME` (and `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`) at a temp directory it removes on exit, unsets `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CODEX_HOME`, and `SIDEKICK_CONFIG_DIR` (pass `preserveEnv: ['SIDEKICK_CONFIG_DIR', …]` to keep any of these four when they point at a fixture; one pointing at a real home throws), and patches the real `child_process` and `fs` modules. Spawning `security`, `claude`, or `codex` throws (a promisified `execFile` or `exec` rejects instead, and otherwise keeps Node's `{ stdout, stderr }` result), writing under the real `~/.claude`, `~/.claude.json`, `~/.codex`, or `~/.config/sidekick` throws, and reads there are recorded. Production code often swallows errors, so `assertNoViolations()` reports what was recorded even when nothing threw. A `vi.mock('child_process')` factory replaces the module and bypasses the guard for that file.

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

// uncachedInputTokens=700, cacheReadTokens=300, billableOutputTokens=200, totalTokens=1200.
// Reasoning remains visible but is not counted twice because OpenAI includes it in output.
const priced = calculateNormalizedUsageCost({ usage });
// { costUsd: number | null, source: 'provider-reported' | 'model-catalog' | 'explicit-pricing' | 'unpriced' }
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

### Read session stats for any provider

```typescript
import { createSessionProviders, readSessionFileStats } from 'sidekick-shared';

const { providers } = createSessionProviders();
for (const provider of providers) {
  for (const sessionPath of provider.findAllSessions(process.cwd())) {
    const stats = provider.readSessionStats(sessionPath); // same as readSessionFileStats(provider, sessionPath)
    if (stats.availability === 'unavailable') {
      console.warn(`${provider.id}: ${stats.unavailableReason}`);
      continue;
    }
    console.log(
      stats.label,
      stats.modelUsage,
      stats.costUsd,
      stats.costProvenance,
      stats.toolFailures,
    );
  }
}
```

Every provider computes `SessionFileStats` the same way — one reader pass through the shared `EventAggregator` — so per-model `tokens` are cache-inclusive, `costUsd` carries `costProvenance`, `toolFailures` splits out failed calls, and compaction and truncation counts are real for Claude Code, Codex, and OpenCode alike. `computeSessionFileStats(events, options)` does the same for events you already hold, and `firstUserPrompt(events)` derives the label.

`readSessionStats()` covers the session's own transcript. Subagents run in their own transcripts, so for a session total that includes them use `collectSessionTokenTotals()` (pass `{ mainThread }` when you already aggregated the transcript to skip re-reading it):

```typescript
import {
  ClaudeCodeProvider,
  collectSessionTokenTotals,
  formatTokenBreakdown,
  formatTokenCount,
  TOKEN_SESSION_TOTAL_LABEL,
} from 'sidekick-shared';

const provider = new ClaudeCodeProvider();
const totals = collectSessionTokenTotals(provider, '/path/to/session.jsonl');
// { mainThread, subagents: [{ agentId, agentType?, description?, summary }], subagentTotal, combined }
console.log(TOKEN_SESSION_TOTAL_LABEL, formatTokenBreakdown(totals.combined, formatTokenCount));
for (const agent of totals.subagents) console.log(agent.agentId, agent.summary.total);
```

Every `TokenSummary` reports `total`, `context`, the four buckets, `reasoning`, and `billedOutsideBuckets` (reasoning billed outside `output`), and `formatTokenBreakdown()` shows that part only when it is non-zero, so the parts always add up to `total`.

### Read canonical session history

```typescript
import { CodexProvider, listRecentSessions, readSessionTranscript } from 'sidekick-shared';

const provider = new CodexProvider();
const [recent] = listRecentSessions(provider, workspacePath, { limit: 10 });
const transcript = readSessionTranscript(provider, recent.sessionPath, {
  fidelity: 'full', // default is bounded 2,000-character snippets
});
```

The same API works with `ClaudeCodeProvider` and `OpenCodeProvider`. It covers provider sessions discoverable by those readers. Remote Claude SDK-only history and Codex history entries whose rollout file has disappeared are not synthesized. A rollout Codex compressed to `.jsonl.zst` is read only with `includeCompressedRollouts` (see [Read compressed Codex rollouts](#read-compressed-codex-rollouts)).

Canonical transcript messages retain provider-origin facts on `message.source`, including the original role, entrypoint, meta/sidechain flags, and source identifiers. Transcript-level `cwd` and `gitBranch` use the latest non-empty value reported by the provider. Claude Code messages also carry `isCompactSummary`, `originKind` (`origin.kind`), and `promptSource`. Consumers can therefore pick out the prompts a person typed without reparsing JSONL, using the same rule `collectPromptHistory()` applies:

```typescript
import { isHumanPrompt, humanPromptText } from 'sidekick-shared/node';

const humanPrompts = transcript.messages
  .filter((message) => isHumanPrompt(message, 'claude-code')) // or 'codex'
  .map((message) => humanPromptText(message, 'claude-code')); // `/review foo` for slash commands
```

A Claude Code message is a human prompt when it has the user role, an entrypoint in `HUMAN_CLAUDE_ENTRYPOINTS` (`cli`, `claude-desktop`, `sdk-cli` — Agent SDK programs report `sdk-ts` / `sdk-py` and are excluded), is not meta, sidechain, or a compaction summary, has no non-human `origin.kind` (task notifications, coordinator messages, auto-continuations) or `promptSource: 'system'`, and is not tool-result-only, local-command output or caveat, bash-mode input or output, a hook or task notification, a system reminder, a continued-session summary, or an interrupt marker. A Codex message is one when it has the user role and some text is left after injected `AGENTS.md`, `<environment_context>`, `<user_instructions>`, permissions and collaboration-mode, recommended-plugin, user-shell-command, turn-aborted, skill, subagent-notification, and internal-context blocks and `<image>` wrappers are dropped. Codex session source is a session-level rule: `collectPromptHistory()` reads only sessions whose `session_meta.source` is in `HUMAN_CODEX_SOURCES` (`cli`, `vscode`, `exec`) and skips subagent and forked sessions.

### Collect human prompt history for workspace roots

```typescript
import { collectPromptHistory, type PromptHistoryCursor } from 'sidekick-shared/node';

let cursor: PromptHistoryCursor | undefined = loadCursor(); // your own JSON store
const result = await collectPromptHistory({
  workspacePaths: ['/Users/me/code/app'], // realpath-normalized; worktree siblings added
  providers: ['claude-code', 'codex'], // default: both
  since: new Date('2026-09-01'),
  cursor,
  bounds: {
    maxSessions: 1000,
    maxFileBytes: 16 << 20, // per file per call; the rest is read next call
    maxTotalBytes: 256 << 20,
    maxRecordBytes: 16 << 20, // one longer record is skipped and reported
    maxEntries: 10_000,
    deadlineMs: 30_000,
  },
  signal: AbortSignal.timeout(60_000),
});

for (const entry of result.entries) {
  // { provider, sessionId, ordinal, timestamp, text, cwd, gitBranch?, model?, usage?, metadataStatus, sessionKey }
  // Upsert by (provider, sessionId, ordinal): a prompt comes back when its answer metadata changes.
}
saveCursor(result.cursor); // sensitive local state; fully read unchanged files are skipped next time
if (result.hasMore) scheduleAnotherCall(); // a bound stopped the pass; the cursor resumes it
// result.changed: sessions whose cursor entry moved this call; result.progressed: anything new was read;
// result.roots: the realpaths scanned after worktree expansion
for (const exclusion of result.exclusions) console.warn('record left out', exclusion); // permanent
```

- **Scope fails closed.** A prompt is returned only when its recorded working directory (the Claude line's `cwd`; the Codex `session_meta` / `turn_context` cwd) realpath-resolves to a root or somewhere inside one. Missing or unresolvable cwds are excluded and counted in `stats.promptsOutOfScope`; Codex scope never comes from the rollout's location. `cwd` is the only path in entries. Cursor keys hold no paths, but cursor values can (Codex resume state keeps the session's cwd and branch), so store the cursor as sensitive, local-only state.
- **Parse-only.** No redaction and no network I/O; text is untruncated.
- **Ordinals are stable.** Every human prompt in a file consumes one ordinal, even when it is out of scope, older than `since`, or lacks a timestamp (such lines are skipped and counted, never given a synthesized time). Entries are ordered by provider, session, then ordinal.
- **Model and usage** come from the first model call that answered the prompt (Claude: the first non-synthetic assistant message, with split records of that call replacing rather than adding usage; Codex: the first `token_count` with the model from `turn_context`). Later tool-loop calls never replace it. `inputTokens` is uncached input, and missing usage stays `undefined`, never zero.
- **Late answers enrich the same prompt.** A prompt can be collected before its answer is written. `metadataStatus` is `pending` (no answering call yet), `provisional` (Claude call still being written, `stop_reason: null`), or `final`. While a file's last prompt is not final, the cursor keeps the byte offset and length of its line, its timestamp, and its answer state so far (first-answer message id, model, and usage, never prompt or answer text). The next call continues from where the file stopped, however far the answer is, and returns the prompt again with the same provider, sessionId, ordinal, timestamp, and text only when its model, usage, or status changed; the text comes from re-reading that one line. A prompt closed by the next prompt without an answer comes back once as `final` with no usage. Consumers should upsert by identity.
- **Large files are streamed and resumable.** Files are read in 1 MiB chunks and every pass stops after a complete line, so memory stays near one chunk plus one record whatever the file size. `maxFileBytes` is the most one file may read in one call: a file with more left keeps what it returned, records `backlog` in its cursor, is counted in `stats.filesOverSizeLimit`, and continues on the next call even if its size and mtime have not changed. `maxSessions`, `maxTotalBytes`, `maxEntries`, the deadline, and an abort stop the whole call the same way, and `cursor.next` makes the next call start with the file that was stopped, so a large or busy session cannot starve the others. The first file of a call always finishes its first record, so a record larger than the budget still moves forward. Bytes appended during a call and a half-written final line wait for the next call. `boundsHit` lists these resumable stops and `hasMore` says whether calling again would read more. No bound throws.
- **Permanent exclusions are reported.** A record over `maxRecordBytes` is skipped as it streams past without being buffered, even when it is still being written, and a complete line that is not JSON is skipped. Each is counted (`stats.recordsOverSizeLimit`, `stats.recordsMalformed`) and listed in `exclusions` with its byte offset. A prompt inside such a record is lost and does not consume an ordinal. Ordinals are therefore only comparable across runs and consumers that use the default bound, exported as `PROMPT_HISTORY_ORDINAL_MAX_RECORD_BYTES` (16 MiB). A file that shrank or whose first 4 KiB changed is treated as rewritten: it is read again from the start with fresh ordinals and counted in `stats.sessionsRewritten`.
- **Change reporting.** `changed` lists the sessions (provider, sessionId, `sessionKey`) whose cursor entry this call added, advanced, moved, or dropped after a rewrite, so a consumer never has to diff cursor internals. `progressed` is false when nothing new was read, which tells a stalled `hasMore` loop apart from one that is moving. `sessionKey` is opaque and equal to the cursor key; it tells apart two files that carry the same session id. `isPromptHistorySessionSettled(cursor.sessions[key])` says whether a cursor entry is fully read with no prompt waiting for its answer, and `parsePromptHistoryCursor(stored)` validates a stored cursor (versions 1 to 3) and returns it as `version: 3` with malformed entries dropped, or `undefined`.
- **Moved files.** A session whose file is listed again under another path (Codex moves an archived thread's rollout to `archived_sessions/`) keeps its cursor entry and ordinals instead of being read again as a new session.
- **Cursor versions.** Output is `version: 3`. Cursors from 0.27.0 (`version: 1`) and 0.27.1 (`version: 2`) are accepted: each file is re-verified once, and a 0.27.1 pending prompt is replayed from its line in resumable passes, so it now settles even when its answer is far away. Files 0.27.1 skipped for size were never in its cursor and are read in full on the first call. Metadata that 0.27.1 already gave up on (a pending replay that exceeded `maxFileBytes`) was not saved and cannot be recovered, and a 0.27.0 cursor still cannot recover prompts it returned without metadata.

- **Metadata only.** `includeText: false` returns the same entries, ordinals, cursors and exclusions with `text: ''` and `textOmitted: true`, for callers that only need ordinals and timestamps. A cursor written in either mode resumes in the other.

### Find where a tool call came from

`findToolCallOrigins()` (Node-only) maps Claude Code `tool_use` ids and Codex `call_id`s to the record that issued them. It uses the scope, listing and session keys of `collectPromptHistory()`, so results join with prompt entries:

```typescript
import { findToolCallOrigins } from 'sidekick-shared/node';

const origins = await findToolCallOrigins({
  ids: ['toolu_01…', 'call_4df5…'],
  workspacePaths: ['/Users/me/code/app'],
  since: new Date('2026-10-01'), // prunes by file modification time
});
for (const [id, origin] of origins) {
  // { provider, sessionId, sessionKey, filePath, timestamp, afterOrdinal, toolName?, subagent? }
}
```

Only lines containing a wanted id are parsed, Claude Code subagent transcripts are searched too, and the walk stops once every id is found. `afterOrdinal` counts in the prompt history of `sessionId`. For a Codex subagent or fork, that is the parent session; the call's own rollout is in `filePath` and `subagent.agentId`. Ids that are not found are absent from the map.

### Collect whole sessions of prompts

`collectSessionPromptHistory()` (Node-only) returns every human prompt of each matching session, grouped by session, for consumers that classify a session as a whole. It reads each session from the start with the same scanners as `collectPromptHistory()`, so text, scope, model and usage, and ordinals are identical. The replies and interaction signals that the prompt filter leaves out are opt-in.

```typescript
import { collectSessionPromptHistory } from 'sidekick-shared/node';

const result = await collectSessionPromptHistory({
  workspacePaths: ['/Users/me/code/app'], // plus git worktree siblings
  providers: ['claude-code', 'codex'], // default: both
  since: new Date('2026-09-01'), // sessions whose file changed since then, returned whole
  // sessionIds: ['…'],             // or exact session ids (any provider)
  // sessionRefs: result.changed,   // or (provider, sessionId), pinned to one file by sessionKey
  // limit: 20,                     // most recent sessions with prompts
  include: { signals: true, replies: true }, // default: prompts only
  bounds: {
    maxSessions: 1000,
    maxSessionBytes: 256 << 20,
    maxTotalBytes: 256 << 20,
    deadlineMs: 60_000,
  },
});

for (const session of result.sessions) {
  // { provider, sessionId, sessionKey, startedAt, lastActivityAt, cwds, gitBranches, models,
  //   prompts: [{ ordinal, timestamp, text, cwd, gitBranch?, model?, usage?, metadataStatus, reply? }],
  //   signals?: [{ kind, timestamp, afterOrdinal, tool?, toolCategory?, mcpServer?, text?, textTruncated? }],
  //   complete, truncated, droppedPrompts, excludedRecords }
}
if (result.unread.length > 0) {
  // A bound stopped the call, or a session changed while it was read:
  // pass these back as `sessionRefs` to continue.
}
```

- **Whole sessions, no cursor.** Every call reads each session from its first line and never resumes one mid-file. `since` selects files by modification time and never drops older prompts from a returned session. A long-lived consumer can keep a `collectPromptHistory()` cursor, then fetch the sessions in its result's `changed` whole with `sessionRefs: result.changed`. `sessionRefs` match on provider and id, or on one file when `sessionKey` is set; `sessionIds` match on id alone across providers.
- **Bounds.** `maxSessions`, `maxTotalBytes`, the deadline, and an abort stop the call. Any session they interrupt is listed in `unread` rather than returned partially, and `boundsHit` names the bound. A session that changed while it was being read is also listed in `unread`, with no `boundsHit` entry. A session longer than `maxSessionBytes` is returned with `truncated: true`, and `boundsHit` includes `maxSessionBytes`; keep `maxSessionBytes` at or below `maxTotalBytes`, or a session larger than `maxTotalBytes` is never read. A record over `maxRecordBytes` (default 16 MiB) is skipped and counted in `excludedRecords`.
- **Completeness.** `complete` is false when the session was truncated, when `droppedPrompts` > 0 (prompts out of scope or without a timestamp, visible as gaps in `ordinal`), or when `excludedRecords` > 0 (oversized or malformed records).
- **Replies** (`include.replies`): the agent's last text for the prompt's turn. For Claude Code this is the last assistant message with text before the next prompt, with split records joined. For Codex it is `task_complete.last_agent_message`, falling back to the last agent message.
- **Signals** (`include.signals`), in log order, each with the ordinal of the prompt it followed (`afterOrdinal`, -1 before the first):
  - `interrupt`: Claude `[Request interrupted by user…]`, or Codex `turn_aborted`.
  - `toolRejected`: Claude only. Carries the rejection reason the person typed, in full. A rejection without a reason and the interrupt Claude Code writes after it count as one signal.
  - `toolError`: a failed tool call, with the tool name and the error text cut to 1024 characters (`textTruncated`).
  - Signals that name a tool also carry `toolCategory` (`shell`, `file_read`, `file_edit`, `search`, `web`, `subagent`, `planning`, `mcp`, or `other`, from `classifyTool()`) and, for MCP calls, `mcpServer`. Claude Code names MCP tools `mcp__<server>__<tool>`; Codex names the bare tool and records the server separately, so `mcpServer` is the only way to tell a Codex MCP tool from a built-in one. `classifyTool(name, { mcpServer })` is exported from the root, `/browser`, and `/node`. Since 0.30.0 Codex's bare `wait` (a code-mode cell wait; the subagent wait is `wait_agent`) is `other`, and `interrupt_agent` is `subagent`.
  - `compaction`, `apiError` (including Codex usage-limit errors), and `rollback` (Codex `thread_rolled_back`).
- **Scope fails closed.** Sessions with no prompt inside the roots are omitted. Replies and signals that follow an out-of-scope prompt are dropped.

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

const { previews, diagnostics, hasMore } = await listSessionPreviewsAsync(providers, { limit: 10 });
const { preview } = await readSessionPreviewAsync(provider, filePath);
```

To resolve one session id to its file without scanning, every bundled provider implements `findSessionById(workspacePath, sessionId)` — a filename join for Claude Code and Codex, a database lookup for OpenCode — returning `null` for misses instead of reading transcripts. (It is optional on the `SessionProviderBase` interface so pre-0.25 external implementations keep compiling; fall back to `findAllSessions()` when absent.)

MCP tool identifiers (`mcp__<server>__<tool>`) split with `parseMcpToolName(name)` — first-double-underscore rule, `null` for malformed names, safe in browser bundles.

### Read compressed Codex rollouts

Codex compresses older rollouts in place to `rollout-<ts>-<id>.jsonl.zst`, and its state database keeps the `.jsonl` path. Since 0.30.0 they are read when you opt in:

```typescript
import {
  createSessionProviders,
  isZstdDecompressionAvailable,
  readRolloutText,
  resolveRolloutPath,
} from 'sidekick-shared/node';

// Or new CodexProvider({ includeCompressedRollouts: true }) from the package root.
const { providers } = createSessionProviders({
  includeCompressedRollouts: true,
  onDiagnostic: (diagnostic) => log(diagnostic), // reports .jsonl.zst rollouts it had to skip
});

isZstdDecompressionAvailable(); // zlib.zstdDecompressSync exists (Node 22.15+)
// A path as the Codex state database stores it: still `.jsonl` after compression.
const current = resolveRolloutPath(storedPath, { includeCompressed: true }); // .jsonl, else .jsonl.zst, else null
const text = current ? readRolloutText(current) : null; // either form, whole; null when unreadable
```

- **Coverage.** A Codex provider with the option includes compressed rollouts in listings, session lookups, labels, search, `scanSubagents()` stats, and `createReader()`. That reader reads a `.jsonl.zst` whole: Codex compresses only rollouts it no longer writes, so live tailing stays `.jsonl`-only. `collectUsageEvents()` reads them through such a provider. `collectPromptHistory()`, `collectSessionPromptHistory()`, and `findToolCallOrigins()` take their own `includeCompressedRollouts`; cursor offsets and sizes are then those of the decompressed content.
- **Older runtimes.** Without `zlib.zstdDecompressSync` (Node 20, older VS Code Electron builds) compressed rollouts are skipped and reported once per process as an info-severity `read_failed` diagnostic. A corrupt frame is a warning-severity `read_failed`. The option defaults to off, so session and history counts do not change.
- **No duplicates.** A `.jsonl` is preferred over its `.zst` twin. `walkRolloutFiles(dirs, { includeCompressed })` skips a `.jsonl.zst` listed beside its `.jsonl`, and `findCodexRolloutFile(id, { includeCompressed })` matches a compressed rollout only when no `.jsonl` for the id exists. Do not share one walk `cache` between calls that differ in `includeCompressed`.
- **Helpers.** `readRolloutBuffer()` is the `Buffer` form of `readRolloutText()`, and both take `{ onDiagnostic }`. `isCompressedRolloutPath(path)` tests for `COMPRESSED_ROLLOUT_SUFFIX` (`.jsonl.zst`). All are on the root and `/node`.

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

As of 0.26.5, the parse cache is bounded (`maxCacheEntries`, default 20,000; `maxCacheBytes`, default 128 MiB — keep both above your session count) and a pass can be bounded with `discover({ limit, since })` / `collect({ limit, since })`. Every discovery emits an info-severity `provider-discovery-completed` diagnostic with `trigger`, `durationMs`, `referenceCount`, `partial`, and the `directoriesListed` / `directoriesStatted` / `filesStatted` counters, so a host can see what each pass cost; hosts that surface every diagnostic should branch on `severity`.

Instead of a host polling loop, subscribe to debounced change batches. Each change carries the previous and current fingerprints. A recursive-watch event is reconciled with one stat when the provider implements `statWatchedSessionFile()`; a full `discover()` runs only for unknown paths, the catch-up poll (for filesystems that drop events), and the initial pass, at most once per `minReconcileGapMs` (2 s ceiling, scaled down to four times the last walk's duration for cheap sources):

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

### Collect usage events from the Node entry

Everything `collectUsageEvents()` needs is exported from `sidekick-shared/node`,
which never loads the package root, so bundlers keep only what you use:

```typescript
import { collectUsageEvents, createSessionProviders, SYNTHETIC_MODEL } from 'sidekick-shared/node';

const { providers } = createSessionProviders({ providerIds: ['claude-code', 'codex'] });
const { events } = await collectUsageEvents({
  providers,
  since: '2026-09-01',
  workspacePath: '/path/to/repo',
  signal: AbortSignal.timeout(30_000), // optional: stop before listing and between sessions
});
const priced = events.filter((event) => event.model !== SYNTHETIC_MODEL);
```

On abort the promise rejects with the signal's reason (an `AbortError` by
default); sessions read before the abort keep their cache entries.

To cover several workspaces in one call, pass `workspacePaths` instead of
`workspacePath`. Each root is realpath-resolved and, unless
`includeWorktrees: false`, expanded with its main checkout and git
worktrees (`resolveWorkspaceRoots()`, also on `sidekick-shared/node`). Each
root is listed, and a session file found under several overlapping roots
is read and counted once. The result's `roots` names what was listed, and
every event carries the `filePath` of its session. When no root resolves,
no session is read.

#### Attribute usage to prompts and subagents

Since 0.29.0 each event says which prompt it answered and who made the call:

- **`promptOrdinal`** is the ordinal of the last human prompt at or before the call. These are the same ordinals `collectPromptHistory()` returns with default bounds, so usage joins with prompt entries on `(provider, sessionId, ordinal)`. It is `null` before the first prompt, and for a Codex fork or subagent, which has no prompts of its own. It is absent for OpenCode, which has no prompt history.
- **`tokens.reasoningTokens`** is set when the provider reported reasoning. It is informational: cost is unchanged because it is already priced from the billable output. Codex counts reasoning inside `outputTokens`; OpenCode reports it separately.
- **`requestId`** is the provider's message id (Claude Code, OpenCode). Codex records none.
- **`subagent: { agentId, parentSessionId }`** marks calls made by Claude Code subagent transcripts and by Codex spawned subagents or forks.

```typescript
import { bucketUsage } from 'sidekick-shared/browser';

// Per session per day, model spellings merged, placeholders dropped.
const rows = bucketUsage(events, {
  granularity: 'day',
  groupBy: ['session', 'model'],
  modelKey: 'canonical', // claude-opus-5-5-20261001 and claude-opus-5-5 share a row
  excludeSynthetic: true,
});
// row.pricedCostUsd is null when no call in the row was priced; row.costUsd keeps 0 for compatibility.

// Cost per prompt:
const perPrompt = new Map<string, number>();
for (const event of events) {
  if (event.promptOrdinal == null || event.costUsd == null) continue;
  const key = `${event.provider}:${event.sessionId}:${event.promptOrdinal}`;
  perPrompt.set(key, (perPrompt.get(key) ?? 0) + event.costUsd);
}
```

The cache is versioned (`USAGE_CACHE_VERSION` 3, files named `*.v3.json`), so the first collection after upgrading re-reads each session once.

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

### Diagnose terminal provider failures

`diagnoseProviderFailure()` is a pure, synchronous helper exported from `sidekick-shared`, `sidekick-shared/browser`, and `sidekick-shared/providerFailure`. The caller decides whether an SDK event is terminal: a Codex `ErrorItem`, including a reconnect notice, must not become terminal merely because its message can be classified.

The identifier lists behind the result types are exported alongside it as readonly arrays (`PROVIDER_FAILURE_CODES`, `PROVIDER_RECOVERY_ACTIONS`, `PROVIDER_CREDENTIAL_KINDS`, `PROVIDER_AUTHENTICATION_STATES`, `PROVIDER_AUTHENTICATION_SOURCES`, `PROVIDER_FAILURE_EVIDENCE_SOURCES`, and since 0.29.0 `CODEX_ERROR_INFO_KINDS`). To validate a diagnosis that crossed a process boundary, use `providerFailureDiagnosisSchema` from `sidekick-shared/schemas`; it is built from the same arrays, so it accepts every value a given release can return.

```typescript
import { diagnoseProviderFailure } from 'sidekick-shared/browser';

function diagnoseTerminalError(error: unknown) {
  return diagnoseProviderFailure({
    provider: 'codex', // AccountProviderId: 'claude-code' | 'codex'
    credentialKind: 'oauth', // 'oauth' | 'api-key' | 'unknown'
    error,
    authentication: {
      credentialKind: 'oauth',
      state: 'authenticated',
      source: 'local-check',
      checkedAt: '2026-09-09T12:00:00.000Z',
    },
  });
}
```

Authentication evidence is optional. Its states are `authenticated`, `missing`, `signed-out`, `expired`, `rejected`, and `unknown`; sources are `local-check` and `provider-response`. The caller owns the observation's freshness and relevance. File presence alone does not establish authenticated request success.

The result contains `provider`, caller-supplied `credentialKind`, `diagnosis`, `recovery`, and `evidence`. Evidence records a bounded rule and its source (`structured-error`, `http-status`, `message`, or `authentication-check`); authentication-check evidence includes `checkedAt`. Valid supplied authentication evidence is preserved separately. Optional `httpStatus` and `retryAfter` retain request information; retry-after is `{ kind: 'delay', delayMs }` or `{ kind: 'date', at }`, without a clock-dependent conversion.

| Diagnosis                                                      | Recovery identifier                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `missing_credentials`                                          | `sign_in`, `update_credentials`, or `check_authentication`, according to credential kind |
| `oauth_reauthentication_required`                              | `sign_in`                                                                                |
| `api_credentials_rejected`                                     | `update_credentials`                                                                     |
| `authentication_rejected` (credential kind unknown)            | `check_authentication`                                                                   |
| `invalid_provider_session`                                     | `start_new_session`                                                                      |
| `service_unavailable`, `timeout`, `rate_limited`, `overloaded` | `retry_later`                                                                            |
| `connection_failed`                                            | `check_connection`                                                                       |
| `execution_policy_denied`                                      | `review_execution_policy`                                                                |
| `runtime_unavailable`                                          | `repair_runtime`                                                                         |
| `context_overflow`                                             | `reduce_context`                                                                         |
| `unknown`                                                      | `inspect_error`                                                                          |

Recognized structured request codes take precedence over HTTP status, followed by narrow message patterns. A bare 401 establishes credential rejection, with recovery chosen from the credential kind; a bare 403 does not distinguish authentication from execution policy and remains unknown, while a message containing `denied by policy` is `execution_policy_denied` regardless of status. An explicit OAuth or refresh-token rejection (`refresh token is invalid`) outranks overlapping thread/conversation-expiry wording; `login has expired` and `please re-authenticate` resolve according to the credential kind. Ambiguous phrases such as `Session expired` or `Permission denied` on their own remain unknown. Explicit credential rejection from the request overrides a successful local OAuth check. OAuth observations never validate API keys. Thread/conversation failures, 5xx responses, DNS failures, and connection resets do not establish rejected account credentials. The reported `Reconnecting... 2/5 (unexpected status 503 Service Unavailable: upstream connect error or disconnect/reset before headers. reset reason: connection termination)` is classified as `service_unavailable`, with message provenance and HTTP 503, if the caller supplies it as a terminal error.

Since 0.29.0 every diagnosis also carries `retryable`. It is true when sending the same request again, after any `retryAfter`, can reasonably succeed: a rate limit that lifts, overload, 5xx, timeouts and failed connections, but not a Codex `usageLimitExceeded` with no known reset. The field is optional in the type and the schema, so diagnoses from older producers stay valid. Codex's structured `codexErrorInfo` is decoded on the error or any nested `error`, `cause`, `response`, `data`, `body` or `errors` entry, in string or object form (`usageLimitExceeded`, `serverOverloaded`, `httpConnectionFailed: { httpStatusCode }`, `unauthorized`, `contextWindowExceeded`, …). The evidence entry records it as `codexErrorInfo`, and `decodeCodexErrorInfo()` exposes the decoder. `parseClaudeAuthStatus()` and `parseCodexLoginStatus()` are pure parsers for `claude auth status --json` and `codex login status` output.

The projection contains no raw errors, stacks, credentials, or request URLs. Product wording belongs to consumers. The helper performs no I/O, credential reads, SDK calls, stream control, retries, or UI actions. Existing transcript/tool `ErrorCategory` and quota-specific guidance contracts remain unchanged.

### Check public provider service status

```typescript
import { fetchProviderServiceStatus } from 'sidekick-shared/node';
import type { ProviderServiceStatus } from 'sidekick-shared/browser';

const controller = new AbortController();
const status: ProviderServiceStatus = await fetchProviderServiceStatus('codex', {
  signal: controller.signal,
});

if (status.availability === 'unavailable') {
  console.log('Public status unavailable', status.reason, status.checkedAt);
} else {
  console.log(status.severity, status.checkedAt, status.providerUpdatedAt);
  // null means the feed omitted incident evidence; [] explicitly reports none unresolved.
  console.log(status.incidents === null ? 'Incident information unavailable' : status.incidents);
}
```

The fetcher is exported from root and Node, with pure result types also exported from browser. It requests the official [Claude summary](https://status.claude.com/api/v2/summary.json) or [OpenAI summary](https://status.openai.com/api/v2/summary.json) without credentials. Every call has a ten-second deadline covering headers and body consumption, supports caller cancellation, and performs one request with no retries or cache.

- `observed` results contain provider, source URL, check timestamp, reported severity/description, provider page update timestamp, all reported components, and unresolved incidents. Supported severity values are `none`, `minor`, `major`, `critical`, and `maintenance`.
- Components retain IDs, names, and reported states. Incidents retain IDs, titles, status, impact, HTTP(S) links, provider update timestamps, and component IDs. Unknown associations are `null`; unmatched IDs are preserved. Resolved and postmortem incidents are excluded.
- Omitted incident data is represented as `incidents: null`, preserving a partial observation without claiming zero incidents. Missing provider timestamps and links remain `null`; the check timestamp never substitutes for a provider update.
- `unavailable` results contain no severity. Reasons are `http_error`, `network_error`, `timeout`, `cancelled`, or `invalid_response`, with optional HTTP status and no raw error text. Malformed supplied fields are rejected rather than defaulted to operational.

Request failure, authentication, CLI readiness, and public service status are separate observations. Public incidents supplement a diagnosis but do not prove a failed request's cause. An operational public page does not prove that the user's connection works. Preserve component associations to avoid attributing unrelated vendor incidents to Claude Code or Codex; unknown component mappings and custom provider endpoints remain uncorrelated. The result's `provider` identifies the selected public feed, not a verified request-backend mapping.

Consumers own caching, stale-evidence presentation, polling, and request coalescing. Neither API initiates sign-in, modifies credentials, switches providers, requests a model response, or replays a turn.

`fetchProviderStatus()`, `fetchOpenAIStatus()`, and `ProviderStatusState` remain compatible. Their historical fallback combines `indicator: 'none'` with `Status unavailable`; migrate to the new API for reliable availability semantics. `toLegacyProviderStatus()` is a lossy compatibility projection for older output contracts, not an availability check. Doctor includes optional `serviceStatus` evidence alongside legacy `providerStatus`; its new `fetchServiceStatuses` injection takes precedence over legacy `fetchStatuses`, which remains supported without additional network requests.

### Check Claude peak-hours state

```typescript
import { fetchPeakHoursStatus } from 'sidekick-shared';

// Third-party endpoint: promoclock.co/api/status (unaffiliated with Anthropic).
// Falls back to the published weekday schedule (source: 'schedule') on any network,
// timeout, or parse error; unavailable: true only if the schedule itself cannot be
// evaluated. Cached 10 min; pass { force: true } to bypass.
const peak = await fetchPeakHoursStatus();
if (!peak.unavailable && peak.isPeak) {
  console.log(`${peak.label} — off-peak in ${peak.minutesUntilChange}m`);
}
```

### Resolve quota with shared source policies

```typescript
import { resolveQuota } from 'sidekick-shared';

// Default: fresh persisted sample (status line, session, or API; under five minutes) →
// session logs (Codex rollouts) → provider API → older sample labelled by age
// (one whose every window has already reset resolves as 'unavailable').
const quota = await resolveQuota({ providerId: 'claude-code' });
console.log(quota.resolution); // 'snapshot-fresh' | 'session' | 'api' | 'snapshot-aging' | 'snapshot-stale' | 'unavailable'
console.log(quota.source, quota.capturedSource, quota.freshness, quota.ageMs);

// Ask the API before any local sample: used by every one-shot Codex query
// and by --refresh for other providers. API failures retain local fallbacks.
await resolveQuota({ providerId: 'codex', workspacePath: process.cwd(), preferFresh: false });
// Paint from local samples only (a poller will fetch live data next).
await resolveQuota({ providerId: 'claude-code', allowApi: false });
```

`resolveQuota()` is shared by `sidekick quota`, `quota --all`, the MCP `get_quota_status` tool, and dashboard startup. CLI and MCP Codex queries pass `preferFresh: false` to fetch live utilization and reset credits every time; dashboard schedules and default cache preferences are unchanged. After a failed live query, the newer session or persisted sample wins by `capturedAt`, with ties going to the persisted sample and missing timestamps treated as oldest. Only a selected session sample is persisted. Fallback results keep their source and age plus the API `failure` descriptor. `allowApi: false` always prevents network access, including when `preferFresh` is false. Claude results carry `planLabel` from the stored credentials (not when `getClaudeAccessToken` is injected), and a snapshot whose every window has reset resolves as `unavailable` with an error naming its date and age. Every side effect is injectable (`readSnapshot`, `writeSnapshot`, `fetchImpl`, `getClaudeAccessToken`, the account resolvers) for tests.

### Fetch subscription quota

```typescript
import { extraQuotaRows, fetchQuota, readClaudeMaxCredentials } from 'sidekick-shared';

// Returns a Promise — without `await`, the object is always truthy and
// `accessToken` is undefined, which surfaces later as an auth failure.
// Use `readClaudeMaxAccessTokenSync()` from a synchronous call site.
const creds = await readClaudeMaxCredentials();
if (creds) {
  // Passing the credentials as `plan` stamps planLabel ('Pro' | 'Max' | 'Ultra' | …).
  const quota = await fetchQuota(creds.accessToken, { plan: creds });
  if (quota.available) {
    if (quota.fiveHour.absent) console.log(`No 5-hour limit on ${quota.planLabel ?? 'this plan'}`);
    else console.log(`5-hour utilization: ${quota.fiveHour.utilization}%`);
    console.log(`7-day utilization: ${quota.sevenDay.utilization}%`);
    // Extra meters beyond the two headline windows, e.g. "7-Day (Fable)".
    for (const row of extraQuotaRows(quota)) console.log(`${row.label}: ${row.utilization}%`);
  } else {
    console.log(quota.failureKind, quota.httpStatus, quota.retryAfterMs);
  }
}
```

Unavailable quota responses remain non-throwing and may include:

- `failureKind`: `auth | network | rate_limit | server | unknown`
- `httpStatus`: HTTP response status when available
- `retryAfterMs`: retry delay in milliseconds for `429` responses when the API provides `Retry-After`

`fiveHour` and `sevenDay` are always present; `absent: true` marks a window the plan does not have (Claude Ultra's five-hour limit, a Codex plan's missing second window), with `0` / `''` placeholders so older readers keep working. Use `quotaWindowApplies()` / `quotaWindowHasData()` instead of testing `resetsAt` yourself, and `quotaStateFromClaudeUsagePayload()` to normalize a usage-endpoint body you fetched elsewhere.

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

#### Model identity, local prices, and the pricing basis

```typescript
import {
  canonicalModelId,
  registerModelPricing,
  getPricingCatalogInfo,
  formatCost,
  mergeCostComponents,
  costSourceFromPricingProvenance,
} from 'sidekick-shared/pricing';

canonicalModelId('us.anthropic.claude-opus-5-5-20261001-v1:0'); // 'claude-opus-5-5'
canonicalModelId('azure/us/gpt-6.1-terra'); // 'gpt-6.1-terra'

// Fill a gap the catalogs do not price yet (never overrides an exact price)...
registerModelPricing(
  {
    'gpt-7-sol': {
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      cacheWriteCostPerMillion: 3.75,
      cacheReadCostPerMillion: 0.3,
    },
  },
  { onlyIfMissing: true },
);
// ...or, without onlyIfMissing, set prices that win over every catalog (e.g. negotiated rates).

getPricingCatalogInfo();
// { source: 'litellm' | 'stale-cache' | 'imported' | 'static', fetchedAt?, digest: 'fnv1a64:…', catalogEntries, registeredEntries }

formatCost(null); // '—'
formatCost(1.5, { source: 'estimated' }); // '$1.50 (est.)'
mergeCostComponents([
  { source: 'reported', tokens: 1200 },
  { source: 'unpriced', tokens: 0 }, // zero-token unpriced parts do not taint the total
]); // 'reported'
```

Registered prices survive `hydratePricingCatalog()` and are reported with provenance `source: 'registered'`. They are local configuration, so `exportResolvedModelCatalog()` never includes them. Store `getPricingCatalogInfo().digest` next to a synced cost so a later re-price can be told apart from a usage change. `isMovingModelAlias()` names agent-CLI aliases (`default`, `auto`, `sonnet`, `opus`, …) whose concrete model changes over time; don't apply dollar caps to them. `parseModelId()` reports a `variant` for GPT tier names, and `compareModelIds()` ranks astra > sol > terra > luna within a version.

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
console.log(projection.subagents); // Claude Code Agent / Task spawns, prompt text omitted
```

### Follow subagents and background agents

Claude Code spawns subagents with its `Agent` tool (`Task` is the earlier name, and OpenCode's `task` normalizes to it), and Codex with `spawn_agent` (parsed as `Spawn_agent`). `SUBAGENT_SPAWN_TOOL_NAMES` lists the Claude Code names. `isCodexSubagentSpawnTool(name, input?)` recognizes Codex's spawn by name or by the raw tool name the Codex parser keeps in the input, and since 0.30.0 `isSubagentSpawnTool(name, input?)` matches both kinds. `EventAggregator` and the trace scanner use `isSubagentSpawnTool()`. `formatToolSummary()` and `isAssistantTurnSubagentTool()` know only `Agent` and `Task`, so Codex assistant turns project as before.

```typescript
import {
  resolveSubagentDisplayState,
  scanSubagentTraces,
  subagentDisplayLabel,
} from 'sidekick-shared';

const traces = scanSubagentTraces(sessionDir, sessionId); // top-level traces; children nested
// { agentId, agentType?, description?, filePath?, spawnToolUseId?, parentToolUseId?, parentAgentId?,
//   background?, finished?, stoppedByUser?, lastActivityAt?, endedCleanly?, events, children, stats }
for (const agent of aggregator.getMetrics().subagents) {
  // { id, description, subagentType, spawnTime, status, completionTime?, durationMs?, agentId?,
  //   agentPath?, background?, outcome?, settledBy? }
  const trace = traces.find((t) => t.agentId === agent.agentId);
  const display = resolveSubagentDisplayState(agent, trace, {
    now: Date.now(),
    parentLastActivity: aggregator.getLastEventTime(),
  });
  console.log(agent.description, subagentDisplayLabel(display.state)); // e.g. 'finished (no report)'
}
```

- **Background agents.** Since 0.29.1 a spawn whose result is `Async agent launched successfully.` stays `running` with `background: true` and the reported `agentId`. Its `<task-notification>` completes it with an `outcome` of `completed`, `failed`, `killed`, or `stopped`. A foreground spawn ends on its result, with `failed` when that result is an error. An interim notification, sent when the agent is waiting on background work of its own, keeps it `running` or puts it back.
- **Task notifications.** Most arrive as their own user line. One that lands mid-turn is recorded only as a `queued_command` attachment. `extractSessionEvents(raw, { includeTaskNotifications: true })` and `createWatcher({ …, includeTaskNotifications: true })` turn that attachment into a `system` event with `origin: { kind: 'task-notification' }`. Since 0.30.0 the option also turns a background agent's final `task_status` attachment (written after a compaction) into a `system` event with `origin: { kind: 'task-status' }`. A plain-text stop notice arrives as a task-notification event, which `agentsStoppedNoticeFromEvent()` reads. The Claude Code watcher now also emits stop notices, final `task_status` attachments, and `agents_killed` lines. The option is off by default, and the Claude Code provider's reader always turns it on. Transcripts, context snapshots, and the aggregator's counters skip the task-notification and task-status events. `parseTaskNotification(text)` returns `{ taskId, toolUseId?, status?, summary?, interim }`, `taskNotificationFromEvent(event)` finds a notification in a user or system event, and `isTaskNotificationSystemEvent(event)` recognizes the synthetic event. These helpers and the `TaskNotification` / `SubagentOutcome` types are on the root and `/browser`.
- **Traces.** `readAgentMeta()` reads Claude Code's `agent-<id>.meta.json` and returns an `AgentMeta` with `agentType`, `description`, `toolUseId`, `parentAgentId`, `requestShape`, `finished`, and `stoppedByUser`. `scanSubagentTraces()` places a trace under the agent its meta file names, then under the trace that holds its spawn call, and falls back to heuristics only after that. `parentToolUseId` is the spawning tool-use id when the meta file records one. A heuristic link stores the parent's agent id there, as before, and also sets `parentAgentId`.
- **Codex subagents.** Since 0.30.0 `EventAggregator` tracks `spawn_agent` calls. The description comes from the input's `description` or `task_name`, and the type from `agent_type`, else `default`. A `{"task_name": "/root/x"}` result is a background launch (`parseCodexSpawnLaunch()` returns `{ agentPath }`), and an error result such as `collab spawn failed: …` ends the agent as `failed`. The child's `started` record sets `agentId` (the child thread id, which is its rollout's session id) and `agentPath`. A `completed` record (matched by thread id, else agent path) or a `FINAL_ANSWER` report (matched by agent path) completes it, `interrupt_agent` settles it as `stopped`, and `followup_task` puts a settled child back to `running` (`send_message` does not). These records reach the aggregator only as subagent-activity events, so feed it events from the Codex reader or from a parser built with `includeSubagentActivity`.
- **Codex activity events.** `new CodexRolloutParser({ includeSubagentActivity: true })` turns `SubAgentActivity` items and `FINAL_ANSWER` agent messages into `system` events with `origin: { kind: 'subagent-activity' }` (`SUBAGENT_ACTIVITY_ORIGIN_KIND`), each carrying one `subagent_activity` content block. `subagentActivityFromEvent(event)` returns `{ kind, callId?, tool?, turnId?, agentThreadId?, agentPath?, recipient?, model?, reasoningEffort?, parentThreadId?, parentTurnId?, text? }` or `null`. `kind` is one of:
  - `started`: a spawn started the child.
  - `completed`: one child turn finished (Codex 0.150+).
  - `interacted`: `followup_task` or `send_message`, named in `tool`.
  - `interrupted`: `interrupt_agent`.
  - `final-answer`: the child's report, in `text` (empty with `metadataOnly`).

  `isSubagentActivitySystemEvent()` recognizes the event, `describeSubagentActivity()` returns a content-free line such as `Subagent /root/review started`, and `parseCodexAgentMessageText(text)` splits an inter-agent message into `{ messageType, taskName?, sender?, payload }`. The option is off by default, and the Codex provider's readers turn it on. Transcripts, context sources, and the aggregator's counters skip these events. All of these are on the root, `/browser`, and `/node`.

- **Codex discovery.** `CodexProvider.scanSubagents(sessionDir, sessionId)` returns every spawned thread below the session: the state database's spawn tree (up to 8 levels) plus older `forked_from_id` forks, or, without the database, the 50 newest rollouts linked by their `session_meta`. Each `SubagentStats` carries:
  - `filePath`: the child's rollout.
  - `spawnToolUseId`: the parent's `spawn_agent` call id, from its `started` record or, on older Codex, from the spawn whose output named the child's agent path.
  - `agentNickname` and `agentPath`.
  - `parentAgentId`: the session id for its own children.
  - `depth`: 1 for the session's own children.
  - `endedCleanly`: its last own turn ended with `task_complete`.

  Tool calls, tokens, and times come from the child's own records. A forked child's rollout embeds the parent's history before `subagent_history_start_ordinal`, and that prefix is no longer counted. `collectSessionTokenTotals()` therefore covers every depth for Codex. Claude Code subagent stats and traces carry `endedCleanly` too: the last assistant turn stopped with `end_turn` or `stop_sequence` and left no tool call unanswered, and a later prompt clears it. `CodexDatabase.getSpawnedDescendantThreads(rootId, maxDepth?)` and `isCodexSubagentThread(thread)` are on the root, and Codex active-session detection now skips subagent threads.

- **Agents that never report.** Since 0.30.0 these records settle a lifecycle that is still `running`; an agent already settled keeps its outcome. `settledBy` records what settled it:
  - `notification`: a final task notification, or a Codex `completed` record or `FINAL_ANSWER`.
  - `meta`: host evidence (see the next paragraph).
  - `stop-marker`: an `agents_killed` line (every running background agent), a stop notice (the running agents with the quoted descriptions), or Codex `interrupt_agent`.
  - `task-status`: a final `task_status` attachment, matched by agent id.

  `settledBy` is absent while the agent runs and when its spawn's own result settled it. The parsers behind these are exported: `parseAgentsStoppedNotice(text)` returns `{ descriptions }` for `2 background agents were stopped by the user: "A", "B".` or `Background agent "A" was stopped by the user.`; `agentsStoppedNoticeFromEvent(event)` reads one from a task-notification event; `isAgentsKilledSystemEvent(eventOrRawLine)`; `taskStatusFromAttachment(rawLine)` and `taskStatusFromEvent(event)` return `{ taskId, taskType, status, description? }` and ignore background shell tasks; and `isTaskStatusSystemEvent(event)`.

  `aggregator.applySubagentEvidence({ agentId?, toolUseId?, finished?, stoppedByUser? }, timestamp)` applies what a host read from Claude Code's `agent-<id>.meta.json` (`readAgentMeta()`, or a trace's `finished` / `stoppedByUser`). `stoppedByUser` settles a running agent as `stopped`, `finished` settles it as `completed`, and `finished: false` reopens an agent that only meta settled. It matches by `toolUseId`, then by the newest agent with that `agentId`, records the agent id, uses `timestamp` as the completion time, and returns whether a lifecycle changed. `getLastEventTime()` returns `getMetrics().lastEventTime` without building the metrics.

- **Display state.** `resolveSubagentDisplayState(lifecycle, trace, { now, parentLastActivity })` decides how to show an agent without changing its lifecycle. A settled lifecycle shows its outcome (`reason: 'settled'`). A running one shows:
  - `stopped` or `completed` when the trace's meta flags say so (`meta`).
  - `finished-unreported` when the transcript ended cleanly and has been quiet for `SUBAGENT_UNREPORTED_QUIET_MS` (2 minutes; `clean-end`).
  - `ended` when neither the parent nor the transcript has been active for `SUBAGENT_PARENT_IDLE_ENDED_MS` (6 hours; `parent-idle`; needs `parentLastActivity`).
  - `running` otherwise.

  Silence alone never gives `finished-unreported`, and the state is recomputed on every call, so an agent that resumes reads as `running` again. For Codex, pass a `scanSubagents()` entry as `{ endedCleanly: stats.endedCleanly, lastActivityAt: stats.endTime }`, matched to the lifecycle by `spawnToolUseId` (the lifecycle's `id`) or `agentId`. `subagentDisplayLabel(state)` returns `running`, `finished (no report)`, `ended`, `completed`, `failed`, `stopped`, or `killed`. The two helpers and the two constants are on the root and `/browser`.

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

The boundary schemas — `sessionEventSchema` plus the quota, account-status, account-management, and quota-history schemas — are also importable fs-free from `sidekick-shared/schemas`, which keeps Zod out of bundles that only need the pure math/formatting helpers. Account and quota APIs are guaranteed to return values valid against the schemas exported in the same release, so consumers do not need to parse those library results again. Additive account or quota fields are added to the matching exported schema in the same release. `extractSessionEvents()` from the same subpath unwraps Claude Code `progress`-wrapped events into canonical `SessionEvent[]`; its second argument is still the starting depth or, since 0.29.1, `ExtractSessionEventsOptions` (`{ includeTaskNotifications }`). Since 0.29.1 `sessionEventSchema` drops a `permissionMode` it does not know instead of rejecting the line (in 0.29.1 that included Claude Code's `auto`, while `permissionModeSchema` and `PermissionMode` were unchanged). Since 0.30.0 `PermissionMode` and `permissionModeSchema` are `default`, `acceptEdits`, `bypassPermissions`, `plan`, `auto`, and `dontAsk`. Modes added later are still dropped, and `EventAggregator` now tracks the mode from followed events as well. System lines keep the provider's `subtype` (`agents_killed`, `turn_duration`, …) on `SystemSessionEvent.subtype`.

### Tail raw JSONL events incrementally

Use `createJsonlTail()` when a consumer needs raw parsed events and owns its own aggregation lifecycle. `onBatchComplete` fires once after each drained byte chunk, which lets callers defer expensive UI or metrics updates until parsing for that chunk is complete.

```typescript
import { createJsonlTail } from 'sidekick-shared/node';
import { sessionEventSchema } from 'sidekick-shared/schemas';

const tail = createJsonlTail({
  path: '/path/to/session.jsonl',
  schema: sessionEventSchema,
  onEvent: (event) => aggregator.processEvent(event),
  onBatchComplete: () => renderMetrics(aggregator.getMetrics()),
  onError: (error) => console.warn(error.message),
});

tail.start();
```

A poll reads from the last position to the end of the file in chunks of `maxReadBytes` (default 1 MiB), so a cold start on a large file never allocates more than one chunk plus one line. `onEvent` receives each line's `{ offset, length }` as its second argument. A line longer than `maxLineBytes` (default 16 MiB) is skipped as it streams past, even while it is still being written, and reported to `onError`. The tail also checks that it is still reading the same content. When the path now names another file (`replaced`), the file shrank (`truncated`), or its first 4 KiB or the byte before the resume point changed (`rewritten`), it starts over (from offset 0 by default; see `onRewrite`) and calls `onReset({ reason, previousOffset })` before the events from the start arrive. `createJsonlTail()` is also exported from the package root.

Since 0.29.0:

- `onRewrite: 'end'` continues from the rewritten file's last complete line instead of replaying it, and `onReset` then also receives the `offset` reading continues from. The default is `'restart'`.
- `noFollow: true` refuses a symlinked path (`JsonlTailSymlinkError`, code `JSONL_TAIL_SYMLINK`) instead of following it.
- `checkpoint()` returns a JSON-serializable `{ version: 1, offset, identity, prefixDigest }`. A new tail's `resumeFrom(checkpoint)` continues from it after a restart, and returns false (applying the rewrite policy) when the file is no longer the one checkpointed.
- `read()` is an async pull that returns the new complete lines.

#### Resume readers and snapshots

Since 0.29.1, readers that keep their own byte offset can use the same check without a tail: `captureJsonlCheckpoint(path, offset)` returns a checkpoint for a resume-safe offset (or `null`), and `verifyJsonlCheckpoint(path, checkpoint)` reports whether it still matches the file. Store one as `SessionSnapshot.sourceCheckpoint` when you save a snapshot (`saveSnapshot()` writes what it is given); `isSnapshotValid(snapshot, size, sourcePath)` then rejects a snapshot whose file was replaced or rewritten, or that has no checkpoint for its `readerPosition`; without `sourcePath` it keeps the size-only check.

Also since 0.29.1, a position alone does not resume every reader correctly: Claude Code writes one response as several lines that repeat its usage, so a reader resumed between them would count it again. `SessionReader` and `SessionWatcher` gain optional `getResumeState()` / `restoreResumeState(state)`: persist the state with the position (snapshots carry it as `readerState`), call `restoreResumeState()` right after `seekTo()` (for a watcher, before `start()`), and replay from the start when it returns false. The Claude Code reader and watcher carry their `ClaudeUsageDeduper` state (`exportState()` / `importState()`, a `ClaudeUsageDedupeState`); the Codex reader, and the reader-backed watcher `createWatcher()` builds for Codex, carry `CodexRolloutParser.exportResumeState()` / `importResumeState()` (a `CodexRolloutResumeState`). The Codex reader's `seekTo()` now waits until the first read to re-parse the rollout prefix, and a successful `restoreResumeState()` skips that re-parse.

`SessionWatcherCallbacks.onBatchComplete` is also available through `createWatcher()`. Save aggregation state only after a complete event batch and only when the state includes the full history (a completed replay or a compatible restored checkpoint). Live-only state is incomplete and must not replace a full-history checkpoint. JSONL positions end at complete lines; a Codex reader rebuilds parser context from the rollout prefix on its first read after seeking, unless `restoreResumeState()` supplied it. OpenCode's SQLite timestamp cursor does not persist row-version deduplication, so the dashboards replay OpenCode history instead of restoring a snapshot.

#### Reader restarts

Since 0.30.0 the Claude Code and Codex readers check on every `readNew()` that the open file is still the one their offsets refer to, using the rules `createJsonlTail()` applies, and start over from offset 0 when it is not:

- `replaced`: another file has the path (device and inode, read from the open descriptor).
- `truncated`: the file is shorter than the read position.
- `rewritten`: the mtime changed, and either the first 4 KiB differ from what was read or the byte before the resume point is no longer a newline.

`wasTruncated()` is now true after any of the three; before 0.30.0 the built-in readers reported only a file that shrank. The optional `lastReset()` returns a `SessionReaderReset`, `{ reason, previousPosition }` (the committed position before the restart), or `null`. The events that `readNew()` returned are then the session from the beginning, so check after reading and discard what you built before processing them:

```typescript
const events = reader.readNew();
if (reader.wasTruncated()) {
  console.warn('session restarted', reader.lastReset?.()); // { reason: 'rewritten', previousPosition }
  aggregator.reset();
}
for (const event of events) aggregator.processEvent(event);
```

`SessionMonitor.poll()` and the reader-backed watcher that `createWatcher()` builds for Codex now do exactly this; the watcher calls `onReset()` before delivering the replay. Before 0.30.0 both checked before reading and counted a truncated file's events twice. `lastReset()` is optional: the Claude Code and Codex readers implement it, and OpenCode's does not.

Known limits:

- A rewrite that keeps the mtime (coarse mtime resolution, or an mtime restored on purpose), or that changes only bytes past the first 4 KiB while the resume point still follows a newline, goes unnoticed.
- On filesystems without stable inode numbers (some SMB mounts, Windows) an unchanged file can read as `replaced`, which costs a replay.
- After `seekTo()` a reader adopts whatever file it finds on its next read, so only a file now shorter than the position is caught. Check a stored position with `verifyJsonlCheckpoint()` first.

### Search a workspace and diagnose its provider

```typescript
import { CodexProvider, searchSessions, runDoctor } from 'sidekick-shared';

const provider = new CodexProvider();
const controller = new AbortController();
const matches = await searchSessions(provider, 'authentication', {
  projectPath: '/path/to/project',
  signal: controller.signal,
  maxResults: 20,
});
const report = await runDoctor({ cwd: '/path/to/project', provider: 'codex' });
console.log(matches, report.sessionProvider, report.checks);
```

`projectPath` resolves the workspace canonically and takes precedence over the legacy `projectSlug`. Cancellation is checked between session reads; it does not interrupt an in-progress synchronous provider read. `HealthReport.sessionProvider` is optional for compatibility. `getSessionDiagnostics()` remains a Claude Code path diagnostic; use `runDoctor()` for provider-aware checks.

### Poll quota with backoff

```typescript
import { QuotaPoller, readClaudeMaxCredentials } from 'sidekick-shared';

const poller = new QuotaPoller({
  activeIntervalMs: 300_000,
  idleIntervalMs: 300_000,
  // Return the token, or the credentials record to also stamp planLabel.
  getAccessToken: async () => readClaudeMaxCredentials(),
});
poller.onUpdate((state) => console.log(state));
poller.start();
```

### Orchestrate quota across Claude and Codex

```typescript
import { MultiProviderQuotaService, quotaWindowApplies } from 'sidekick-shared';

const service = new MultiProviderQuotaService({
  // Optional — when set, an internal CodexQuotaWatcher is created and managed.
  codexWorkspacePath: '/path/to/project',
});

service.onUpdate(({ claude, codex }) => {
  // Ultra has no five-hour window (`fiveHour.absent`); show the weekly one instead.
  if (claude) {
    const fiveHour = quotaWindowApplies(claude.fiveHour)
      ? `${claude.fiveHour.utilization}%`
      : 'no 5-hour limit';
    console.log('Claude:', fiveHour, `7d ${claude.sevenDay.utilization}%`, claude.peakHours?.label);
  }
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

`npm test` builds first (`pretest` runs `npm run build`), so a cold run includes the `tsc` step.

Uses Vitest. Run `npm run test:watch` for watch mode.

## See Also

- [Sidekick for Max](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) — VS Code extension
- [Sidekick CLI](https://www.npmjs.com/package/sidekick-agent-hub) — Terminal dashboard (`npm install -g sidekick-agent-hub`)

## License

MIT
