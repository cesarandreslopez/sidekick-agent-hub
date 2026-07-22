# Phase 4 — Session Pipeline, Watchers & Webviews

> Part of the [Sidekick Agent Hub review backlog](./README.md). Read the README first for methodology, trust levels, conventions, and the working loop.

**Goal.** Performance, leaks, and correctness in the session-monitoring pipeline (shared watchers/aggregation/context + the extension SessionMonitor and view providers), plus resolving the dead dashboard-webview UI. Touches the hottest code paths — profile before/after.

**This phase:** 34 findings — 3 high, 23 medium, 8 low.

## Progress tracker

Update the Status box as you go: `[ ]` todo → `[~]` in progress → `[x]` done (or `[-]` if dropped after re-verification). Keep the one-line note current.

| ID | Sev | Trust | Location | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| P4-01 | 🔴 | ✅ | `providers/DashboardViewProvider.ts:1824` | Quota history / context health / truncation UI is dead: handlers live in a never-loaded bundle | `[x]` |
| P4-02 | 🔴 | ✅ | `providers/MindMapViewProvider.ts:212` | Mind map rebuilds full graph and posts it on every token/tool event, undebounced | `[x]` |
| P4-03 | 🔴 | ✅ | `services/SessionMonitor.ts:3079` | stats.toolCalls grows unbounded with full inputs/outputs and is sync-written to disk every 30s | `[x]` |
| P4-04 | 🟠 | ✅ | `parsers/sessionActivityDetector.ts:52` | Active Claude sessions flip to 'ended' while the model is thinking after a tool result | `[x]` |
| P4-05 | 🟠 | 🟡 | `parsers/subagentTraceParser.ts:157` | subagentTraceParser: tool summaries and positional parent linking are dead code | `[x]` |
| P4-06 | 🟠 | 🟡 | `webview/dashboard.ts:691` | src/webview/dashboard.ts is a 940-line dead bundle that has also drifted (CSP-broken, drops zai) | `[x]` |
| P4-07 | 🟠 | ⚠️ | `aggregation/EventAggregator.ts:996` | contextTimeline grows unbounded and is copied on every getMetrics/serialize | `[x]` |
| P4-08 | 🟠 | ⚠️ | `aggregation/EventAggregator.ts:576` | processFollowEvent inflates messageCount by counting per-content-block events | `[x]` |
| P4-09 | 🟠 | ⚠️ | `context/sessionContext.ts:244` | SessionContextProjector rebuilds the entire snapshot from scratch on every event | `[x]` |
| P4-10 | 🟠 | ⚠️ | `providers/codex.ts:712` | getAllProjectFolders runs a full recursive rollout scan per distinct cwd | `[x]` |
| P4-11 | 🟠 | ⚠️ | `providers/detect.ts:147` | Provider auto-detect compares incompatible activity signals, biasing against Claude Code | `[x]` |
| P4-12 | 🟠 | ⚠️ | `watchers/jsonlWatcher.ts:258` | fs.watch error handler silently kills the watcher including catch-up polling | `[x]` |
| P4-13 | 🟠 | ⚠️ | `watchers/sqliteWatcher.ts:269` | SQLite watcher cursor uses time_created, so in-place part updates are never re-emitted | `[x]` |
| P4-14 | 🟠 | ⚠️ | `watchers/sqliteWatcher.ts:257` | SQLite watcher re-reads the whole session via a blocking sqlite3 subprocess every poll | `[x]` |
| P4-15 | 🟠 | ⚠️ | `providers/DashboardViewProvider.ts:374` | No webviewView.onDidDispose handling: stale _view throws on every event, disposables accumulate | `[x]` |
| P4-16 | 🟠 | ⚠️ | `providers/DashboardViewProvider.ts:1635` | Stale compactions/attribution from previous session shown after session switch | `[x]` |
| P4-17 | 🟠 | ⚠️ | `providers/DashboardViewProvider.ts:2331` | _sendStateToWebview does plan aggregation + 4 postMessages on every token-usage event | `[x]` |
| P4-18 | 🟠 | ⚠️ | `providers/MindMapViewProvider.ts:1424` | D3 link join key breaks after first render: all links exit/re-enter each update | `[x]` |
| P4-19 | 🟠 | ⚠️ | `providers/TempFilesTreeProvider.ts:131` | TempFiles provider re-parses every subagent JSONL synchronously every 2 seconds | `[x]` |
| P4-20 | 🟠 | ⚠️ | `providers/CodexSessionProvider.ts:33` | Codex quota path does unthrottled sync snapshot reads/writes on every event batch | `[x]` |
| P4-21 | 🟠 | ⚠️ | `services/SessionMonitor.ts:2021` | File-truncation reset zeroes stats but seenHashes dedup swallows the re-read, leaving 0s and stale maps | `[x]` |
| P4-22 | 🟠 | ⚠️ | `services/SessionMonitor.ts:797` | Pinned session is ignored by the OpenCode inactivity auto-switch path | `[x]` |
| P4-23 | 🟠 | ⚠️ | `services/SessionMonitor.ts:2240` | Dedup hash collides for user/tool_result events without IDs, silently dropping events | `[x]` |
| P4-24 | 🟠 | ⚠️ | `services/SessionMonitor.ts:767` | OpenCode activity poll spawns sqlite3 synchronously on the extension host every 1.5s | `[x]` |
| P4-25 | 🟠 | ⚠️ | `webview/error.ts:571` | Error panel never shows fix preview after an explanation was displayed | `[x]` |
| P4-26 | 🟠 | ⚠️ | `webview/explain.ts:580` | Complexity change fires two duplicate AI explanation requests | `[x]` |
| P4-27 | ⚪ | ✅ | `parsers/subagentScanner.ts:176` | Subagent inputTokens counts cache tokens for Claude but not for OpenCode/Codex | `[x]` |
| P4-28 | ⚪ | 🟡 | `aggregation/EventAggregator.ts:860` | Aggregator restore() fails silently on version mismatch; version constant duplicated | `[x]` |
| P4-29 | ⚪ | 🟡 | `providers/DashboardViewProvider.ts:1177` | Knowledge-notes pipeline and 8 other message types are dead protocol on the dashboard | `[x]` |
| P4-30 | ⚪ | 🟡 | `providers/MindMapViewProvider.ts:482` | In-progress task nodes never get their highlight: CSS class uses hyphen, data uses underscore | `[x]` |
| P4-31 | ⚪ | ⚠️ | `providers/DashboardViewProvider.ts:8217` | Session Activity summary reads t.count but ToolAnalyticsDisplay only has totalCalls — always 0 | `[x]` |
| P4-32 | ⚪ | ⚠️ | `providers/SubagentTreeProvider.ts:185` | SubagentTreeProvider worker IDs can collide and completion heuristic marks wrong agent | `[x]` |
| P4-33 | ⚪ | ⚠️ | `services/HistoricalDataService.ts:183` | Hourly buckets mix UTC date with local hour, skewing peak-hours data for non-UTC users | `[x]` |
| P4-34 | ⚪ | ⚠️ | `services/SessionMonitor.ts:1719` | dispose() leaks three event emitters: _onTruncation, _onCycleDetected, _onReplayStateChange | `[x]` |

---

## Findings

### P4-01 — Quota history / context health / truncation UI is dead: handlers live in a never-loaded bundle

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:1824`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** The provider posts 'updateQuotaHistory' (also 'updateContextHealth' at line 1910 and 'updateTruncations' at line 1933), and the dashboard HTML contains fully-styled sections for them (quota-history-section at line 5716, context-health at 5675, truncation-info at 5676, all display:none). But the inline webview script's message switch (lines 8652-8998) has no case for any of these types. The only handlers exist in src/webview/dashboard.ts (renderQuotaHistory at line 805, updateContextHealthDisplay at 795, updateTruncationDisplay at 798), which is compiled to out/webview/dashboard.js by esbuild.js but never referenced by any <script> tag — the HTML only loads chartjs-vendor.js (verified via grep: no provider loads dashboard.js). Result: the 13-week quota heatmap, context-health score, and truncation breakdown never render for any user, while the provider still burns disk I/O producing the payload.

**Evidence.**

```ts
this._postMessage({ type: 'updateQuotaHistory', payload });  // provider — and the inline script's switch ends at: case 'updateAnalytics': ... with no 'updateQuotaHistory' | 'updateContextHealth' | 'updateTruncations' cases; HTML loads only: <script nonce="${nonce}" src="${chartjsUri}"></script>
```

**Fix.** Either add 'updateQuotaHistory', 'updateContextHealth', and 'updateTruncations' cases to the inline webview script (porting renderQuotaHistory/updateContextHealthDisplay/updateTruncationDisplay from dashboard.ts), or load out/webview/dashboard.js in the HTML. Then delete the unused copy so there is exactly one webview implementation.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-02 — Mind map rebuilds full graph and posts it on every token/tool event, undebounced

- **Location:** `sidekick-vscode/src/providers/MindMapViewProvider.ts:212`
- **Severity / category:** 🔴 high · perf
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** MindMapViewProvider subscribes _updateGraph() to both onTokenUsage and onToolCall (lines 78-80) with no debounce, unlike EventStreamTreeProvider's 300ms scheduleRefresh. Each call runs MindMapDataService.buildGraph, which iterates stats.toolCalls at least 8 times (extractFiles/Urls/Directories/Commands + four addToolTargetLinks passes) plus detectCycle twice, then structured-clones the entire node/link graph over postMessage. stats.toolCalls grows unbounded during a session, so per-event cost is O(n) and cumulative cost is O(n^2). Worse, _syncFromSessionMonitor runs even when this._view is undefined (view never opened) or hidden — all that work is thrown away because _postMessage is a no-op. In a long agent session with thousands of tool calls this measurably loads the extension host on every single event.

**Evidence.**

```ts
private _updateGraph(): void {
    this._syncFromSessionMonitor();
    this._sendStateToWebview();
    this._postMessage({ type: 'updatePhrase', phrase: getRandomPhrase() });
  }  // constructor: this._sessionMonitor.onTokenUsage(() => this._updateGraph()); this._sessionMonitor.onToolCall(() => this._updateGraph());
```

**Fix.** Early-return from _updateGraph when !this._view or !this._view.visible (resend on onDidChangeVisibility, which already exists), and coalesce updates with a ~300-500ms trailing-edge debounce like EventStreamTreeProvider.scheduleRefresh.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-03 — stats.toolCalls grows unbounded with full inputs/outputs and is sync-written to disk every 30s

- **Location:** `sidekick-vscode/src/services/SessionMonitor.ts:3079`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** Every tool call is pushed to this.stats.toolCalls with no cap, retaining the FULL input object (a Write/Edit input embeds entire file contents) plus up to 5000 chars of output per call (lines 3409-3418). Unlike timeline (capped 100), turnAttributions (200), and contextTimeline (500), this array grows for the life of the session. It is deep-copied by getStats() (line 1082), which every dashboard/tree provider calls on each update, and the whole array is serialized into the snapshot sidecar (persistSnapshot line 1957 `toolCalls: this.stats.toolCalls`) via fs.writeFileSync every 30 seconds (throttledSnapshotSave). A long agentic session with thousands of tool calls means tens/hundreds of MB retained in the extension host, multi-MB synchronous JSON writes on the watcher hot path, and O(n) `this.stats.toolCalls.find(...)` per tool_result (line 3399) making result-matching O(n^2) over the session.

**Evidence.**

```ts
this.stats.toolCalls.push(toolCall);
...
          modelUsage: Array.from(this.stats.modelUsage.entries()),
          toolCalls: this.stats.toolCalls,
```

**Fix.** Cap stats.toolCalls (e.g., ring buffer of a few hundred) and store truncated inputs (bounded string summary instead of the raw input object); keep an index Map<toolUseId, ToolCall> for O(1) result matching; persist only the bounded window (or aggregates) in the snapshot; and have getStats() return the array by reference or a bounded slice instead of copying everything per call.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-04 — Active Claude sessions flip to 'ended' while the model is thinking after a tool result

- **Location:** `sidekick-shared/src/parsers/sessionActivityDetector.ts:52`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** In Claude Code JSONL, tool results are user-type events ({"type":"user","message":{"content":[{"type":"tool_result",...}]}}). Such a line matches both AI_ACTIVITY_PATTERNS ('"type":"tool_result"') and ENDING_PATTERNS ('"type":"user"') at the same index, so lastAiActivityIndex === lastEndingIndex and the strict 'lastAiActivityIndex > lastEndingIndex' ongoing check fails. Whenever the last written line is a tool result and the model then thinks/generates for more than the 5s grace period (very common with extended thinking or long tool batches), detectSessionActivity returns 'ended' — the dashboard spinner/status incorrectly shows the session as done, then flickers back when the assistant event lands.

**Evidence.**

```ts
const ENDING_PATTERNS = [
  '"stop_reason":"end_turn"',
  '"type":"result"',
  '"type":"user"', // User typing means AI is done with its turn
];
```

**Fix.** Only treat a '"type":"user"' line as an ending signal when it does NOT also contain '"tool_result"' (or check patterns per-line with tool_result taking precedence), and/or make the tie (equal indexes) resolve to 'ongoing'.

<details><summary>Verifier notes</summary>

- Verified against real Claude Code JSONL: tool-result lines contain both "type":"user" and "type":"tool_result" as exact substrings, so a trailing tool_result line sets lastAiActivityIndex === lastEndingIndex; the strict > check at line 138 fails and after the 5s grace period the function returns 'ended' (reason 'ending-event') while the model is still thinking — confirmed by simulating the pattern loops. No guard elsewhere prevents this; the function is a pure self-contained heuristic. However, the function has zero in-repo callers (only a public export from sidekick-shared/src/index.ts), so the claimed dashboard-spinner consequence applies only to external consumers of the published package, and the "resolve ties to ongoing" fix variant would break the intentional assistant+end_turn tie that the existing test (test file lines 90-99) depends on.
- Traced the classification loop and confirmed the tie: real Claude Code tool-result lines (verified against actual ~/.claude/projects JSONL) contain both '"type":"tool_result"' and '"type":"user"' on one line, so lastAiActivityIndex === lastEndingIndex and the strict '>' check at line 138 fails, yielding 'ended' after the 5s grace. Empirically, 39.4% of 855 real tool_result-to-next-assistant gaps exceed 5s (p90 13.4s), so an active session is misclassified 'ended' routinely during tool loops. The only inaccuracy is the consequence: detectSessionActivity has no in-repo caller (dashboard/CLI never invoke it; it is only exported from sidekick-shared's public index), so the described spinner flicker is not currently observable in this product — the defect is in a newly published shared-library API whose documented purpose is exactly this status classification.

</details>

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-05 — subagentTraceParser: tool summaries and positional parent linking are dead code

- **Location:** `sidekick-shared/src/parsers/subagentTraceParser.ts:157`
- **Severity / category:** 🟠 medium · bug
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** rawToSessionEvent only sets 'tool' when mappedType === 'assistant' (line 341), and Claude JSONL has no top-level 'tool_use' event type. Therefore 'sessionEvent.type === tool_use && sessionEvent.tool' (line 157) and phase-3's 'evt.type === tool_use && evt.tool?.name === Task' (line 301) can never both hold: toolSummary is never populated for any trace event, and the positional parent-child fallback never links a single child. Nested subagent traces silently render flat and without tool summaries. Additionally, phase-2 linking (lines 277-280) never checks child.parentToolUseId before pushing, so a child mentioned in multiple teammate-message blocks is appended to children arrays multiple times.

**Evidence.**

```ts
if (sessionEvent.type === 'tool_use' && sessionEvent.tool) {
          toolSummary = formatToolSummary(sessionEvent.tool.name, sessionEvent.tool.input);
        }
...
if (evt.type === 'tool_use' && evt.tool?.name === 'Task') {
```

**Fix.** Change both conditions to match assistant events carrying tool blocks: "if (sessionEvent.tool)" for the summary, and in phase 3 test "evt.type === 'assistant' && evt.tool?.name === 'Task'". In phase 2, skip children whose parentToolUseId is already set before pushing.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

<details><summary>Verifier notes</summary>

- Verified by construction: rawToSessionEvent sets `tool` only when mappedType === 'assistant' (line 341), so both `type === 'tool_use' && tool` (line 157) and phase-3's identical conjunction (line 301) are unsatisfiable for every event this parser produces — toolSummary is never populated and the positional fallback never links, independent of the JSONL format. Phase 2 (lines 274-281) indeed pushes without checking child.parentToolUseId or deduping, so repeated mentions produce duplicate children entries. trace.children is consumed by SubagentTreeProvider.traceToItem, so the linking defects are user-visible; no tests cover this parser.

</details>

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-06 — src/webview/dashboard.ts is a 940-line dead bundle that has also drifted (CSP-broken, drops zai)

- **Location:** `sidekick-vscode/src/webview/dashboard.ts:691`
- **Severity / category:** 🟠 medium · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** esbuild.js builds src/webview/dashboard.ts to out/webview/dashboard.js, but no provider ever loads it (grep across src finds only chartjs-vendor.js in the dashboard HTML). The real UI lives duplicated inside the 9.5k-line provider's inline script, and the two copies have diverged: dashboard.ts uses inline onclick handlers ('onclick="copySuggestion(...)"') that the dashboard CSP (script-src 'nonce-...' without 'unsafe-inline') would block if it were ever loaded, and its local QuotaHistoryPayload type omits the 'zai' provider that the extension now sends (renderQuotaHistory at line 897 only reads providers.claude/providers.codex). Payoff of fixing: removes ~940 lines of shipping dead code (or restores it as the single source of truth), eliminating the class of divergence bugs already visible here.

**Evidence.**

```ts
<button class="copy-btn" onclick="copySuggestion(${i})" aria-label="Copy suggestion to clipboard">Copy</button>  // inline handler; and: providers: { claude?: {...}; codex?: {...} };  // no zai — while the provider sends ...(zaiHasData ? { zai: { cells: toCells(zai) } } : {})
```

**Fix.** Decide on one implementation: either delete src/webview/dashboard.ts and its esbuild entry, or make it the loaded bundle (add the script tag, replace onclick with addEventListener, add zai support) and strip the duplicated inline script from the provider.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-07 — contextTimeline grows unbounded and is copied on every getMetrics/serialize

- **Location:** `sidekick-shared/src/aggregation/EventAggregator.ts:996`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** Every usage-bearing event pushes a ContextSizePoint into contextTimeline with no cap, unlike timeline (timelineCap=200) and latencyRecords (latencyCap=100). getMetrics() spreads the whole array (`contextTimeline: [...this.contextTimeline]`, line 721) and serialize() copies it into every snapshot write. A multi-day session with tens of thousands of assistant events means each dashboard poll copies tens of thousands of objects and each periodic saveSnapshot JSON-serializes them, with snapshot sidecar files growing without bound. burnSamples-style trimming exists two screens up, so the omission is clearly accidental.

**Evidence.**

```ts
// Context timeline tracking
    this.contextTimeline.push({
      timestamp,
      inputTokens: contextSize,
      turnIndex: this.contextTurnIndex++,
    });
```

**Fix.** Cap contextTimeline (e.g., configurable contextTimelineCap defaulting to a few thousand points, shifting the oldest, or downsample older points) the same way timeline and latencyRecords are capped.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-08 — processFollowEvent inflates messageCount by counting per-content-block events

- **Location:** `sidekick-shared/src/aggregation/EventAggregator.ts:576`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** processEvent counts one message per non-system JSONL row, but processFollowEvent increments messageCount for every non-system FollowEvent. The normalizers split one row into multiple FollowEvents: an assistant row with text plus N tool_use blocks yields N+1 events (jsonlWatcher.ts:67-99), and a user row's tool_result blocks each yield an event. So the CLI DashboardState (which feeds processFollowEvent, DashboardState.ts:409) reports a 'messages' figure several times higher than the VS Code/SessionEvent path for the exact same session -- and the two disagree after a snapshot handoff, since snapshots persist messageCount.

**Evidence.**

```ts
// Message count (skip system events)
    if (event.type !== 'system') {
      this.messageCount++;
    }
```

**Fix.** Count only 'user' and 'assistant' FollowEvents (excluding tool_use/tool_result/summary) toward messageCount, or have the normalizers tag the first event derived from each source row and count only those.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-09 — SessionContextProjector rebuilds the entire snapshot from scratch on every event

- **Location:** `sidekick-shared/src/context/sessionContext.ts:244`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** createSessionContextProjector keeps an unbounded `events` array and every processEvent call constructs a brand-new EventAggregator and re-runs buildSessionContextSnapshot over the full history -- full re-aggregation, source extraction, sorting, and layer breakdown per event. Feeding a live session of n events costs O(n^2) total; at a few thousand events each incoming event re-processes the whole transcript, which is exactly the workload the streaming EventAggregator was built to avoid. This is exported public API of the npm package, so external consumers hit it too.

**Evidence.**

```ts
processEvent(event: SessionEvent): SessionContextSnapshot {
      events.push(event);
      return buildSessionContextSnapshot(events, options);
    },
```

**Fix.** Hold one persistent EventAggregator plus incremental SourceExtractionState in the closure; processEvent should aggregate the single new event, append its sources, and assemble the snapshot from the accumulated state. Cap or window the retained sources instead of keeping every event forever.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-10 — getAllProjectFolders runs a full recursive rollout scan per distinct cwd

- **Location:** `sidekick-shared/src/providers/codex.ts:712`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** Inside the DB loop, 'dir: getSessionsDir()' is evaluated once per distinct cwd row. getSessionsDir() calls findRolloutFiles(dir) for each configured Codex home, which recursively walks the entire YYYY/MM/DD tree and stats every rollout file just to test non-emptiness. With N projects and years of daily rollouts this does N full recursive scans (thousands of statSync calls) on every project-list refresh. getSessionsDir() additionally has no early exit — it collects every file before checking .length > 0.

**Evidence.**

```ts
for (const stat of cwdStats) {
        seenCwds.set(stat.cwd, {
          dir: getSessionsDir(),
```

**Fix.** Hoist 'const sessionsDir = getSessionsDir();' above the loop, and make getSessionsDir() short-circuit (return the first home whose sessions dir contains any rollout file, stopping at the first hit rather than materializing the full list).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-11 — Provider auto-detect compares incompatible activity signals, biasing against Claude Code

- **Location:** `sidekick-shared/src/providers/detect.ts:147`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** Claude recency is getMostRecentMtime(~/.claude/projects), which stats only the top-level project directories; a directory's mtime changes when files are created/deleted in it, not when an existing session .jsonl is appended to. OpenCode recency is the opencode.db file mtime, which updates on every write. So during an ongoing Claude Code session (file created hours ago, actively appended), Claude's signal stays stale while any background OpenCode write wins, and detectProvider()/getAllDetectedProviders() select 'opencode' even though Claude is the live agent. Codex has the same flaw (stats year-level dirs under sessions/).

**Evidence.**

```ts
if (hasClaude) {
    available.push({ id: 'claude-code', mtime: getMostRecentMtime(claudeBase) });
  }
```

**Fix.** For Claude, compute recency from session file mtimes (e.g. max mtime over *.jsonl in the most recently modified project dirs, bounded to a few dirs), and for Codex stat the newest rollout file (reuse findLatestStateDatabase-style scan or the deepest YYYY/MM/DD dir) so all three providers compare file-level write times.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-12 — fs.watch error handler silently kills the watcher including catch-up polling

- **Location:** `sidekick-shared/src/watchers/jsonlWatcher.ts:258`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** JsonlSessionWatcher (and identically ProviderReaderSessionWatcher, providerReaderWatcher.ts:57-59) reacts to any FSWatcher 'error' by calling this.stop(), which also clears the 30s catch-up interval, and it never invokes callbacks.onError. fs.watch errors can be transient (EMFILE/ENOSPC watch limits, the file being atomically replaced, network/virtual filesystems), and the class explicitly supports a polling-only mode when fs.watch is unavailable at start (the catch around fs.watch). So a watcher error mid-session silently freezes the live dashboard even though polling alone would keep it working, with no signal to the consumer. Contrast jsonlTail.ts:172, which reports the error and keeps its catch-up interval running.

**Evidence.**

```ts
this.fsWatcher.on('error', () => {
        // File may have been deleted; stop gracefully
        this.stop();
      });
```

**Fix.** On watcher error: close and null out only fsWatcher, keep the catch-up interval alive (it already stats the path and no-ops if the file is gone), and forward the error to callbacks.onError. Apply the same change to ProviderReaderSessionWatcher.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-13 — SQLite watcher cursor uses time_created, so in-place part updates are never re-emitted

- **Location:** `sidekick-shared/src/watchers/sqliteWatcher.ts:269`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** pollNewData filters strictly on `time_created > lastPartTime`. OpenCode rows carry a separate `time_updated` column and OpenCodeDatabase even provides `getPartsNewerThan(sessionId, afterTimeUpdated)` keyed on it -- evidence that message/part rows are updated in place (e.g., a tool part transitions state running -> result, an assistant message's `data` gains tokens/cost while streaming). Because time_created never changes on update, the watcher emits each row exactly once in whatever state it was first observed: a tool part first seen as running never produces a tool_result event, and an assistant message first seen mid-stream never delivers its final tokens/cost. Additionally the strict `>` drops a second row committed later within the same millisecond as the cursor.

**Evidence.**

```ts
const newParts = parts.filter((p) => p.time_created > this.lastPartTime);
      for (const part of newParts) {
        const events = normalizePart(part);
        for (const e of events) this.callbacks.onEvent(e);
        if (part.time_created > this.lastPartTime) this.lastPartTime = part.time_created;
```

**Fix.** Track a `time_updated` cursor (using the existing getPartsNewerThan / an equivalent messages query), emit an event when a row's time_updated advances past the cursor, and dedupe by row id + state so consumers see the result state of a tool part. Use `>=` with an id-based tiebreak to avoid same-millisecond drops.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-14 — SQLite watcher re-reads the whole session via a blocking sqlite3 subprocess every poll

- **Location:** `sidekick-shared/src/watchers/sqliteWatcher.ts:257`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** pollNewData calls getMessagesForSession and getPartsForSession, which each run `execFileSync('sqlite3', -json ...)` (openCodeDatabase.ts:77) selecting every row for the session, then filters in JS by timestamp. This fires every 2 seconds from the poll timer plus after every debounced db/-wal change (the WAL changes continuously during streaming). For a long OpenCode session that means spawning two synchronous subprocesses that serialize, transfer, and JSON-parse the entire message+part history several times per second while the Ink event loop is blocked (up to the 4s execFileSync timeout each). The DB layer already has an indexed incremental query (getPartsNewerThan) that goes unused.

**Evidence.**

```ts
const messages = this.db.getMessagesForSession(this.sessionId);
      const parts = this.db.getPartsForSession(this.sessionId);

      // Emit new messages
      const newMessages = messages.filter((m) => m.time_created > this.lastMessageTime);
```

**Fix.** Push the cursor into SQL: add/use `WHERE session_id = ? AND time_created > ?` (or time_updated per the cursor fix) queries such as getPartsNewerThan so each poll transfers only new rows, and consider raising the debounce or coalescing wal+db triggers.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-15 — No webviewView.onDidDispose handling: stale _view throws on every event, disposables accumulate

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:374`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** resolveWebviewView stores the view (this._view = webviewView) and registers onDidReceiveMessage/onDidChangeVisibility into this._disposables, but never registers webviewView.onDidDispose. When the user hides the dashboard view (view context-menu uncheck) VS Code disposes the WebviewView; this._view keeps pointing at it, and every _postMessage (line 2572: this._view?.webview.postMessage) then throws 'Webview is disposed' — which happens on every token-usage event, phrase-rotation tick (PhraseRotationManager keeps firing until provider dispose), and quota update during an active session. Additionally, each re-resolve pushes two more disposables into the provider-lifetime _disposables array, which only empties in dispose(), so listeners for dead webviews accumulate for the whole extension session.

**Evidence.**

```ts
this._view = webviewView;
... webviewView.webview.onDidReceiveMessage(
      (message: DashboardWebviewMessage) => this._handleDashboardWebviewMessage(message),
      undefined,
      this._disposables,
    );  // no webviewView.onDidDispose(...) anywhere (grep confirms 0 hits)
```

**Fix.** In resolveWebviewView add: webviewView.onDidDispose(() => { if (this._view === webviewView) { this._view = undefined; } this._phrases.stop(); this._quotaService?.stopRefresh(); ... }, undefined, this._disposables); and track per-view disposables that are disposed in that callback instead of pushing into the provider-lifetime array.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-16 — Stale compactions/attribution from previous session shown after session switch

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:1635`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** _handleSessionStart resets timeline, toolAnalytics, errorDetails, and context size, but never clears this._state.compactions, this._state.contextAttribution, or this._state.latencyDisplay (refreshSessionView at line 2443 has the same gap). _syncFromSessionMonitor only overwrites compactions when the NEW session has some: 'if (stats.compactionEvents && stats.compactionEvents.length > 0)' (line 2098), and same guard for contextAttribution (line 2113). Failure scenario: monitor session A which had 3 compactions, then switch to fresh session B with none — the dashboard's 'Context Compactions' list and ledger (and stale attribution bars) keep showing session A's data because updateDashboard re-renders state.compactions on every updateStats.

**Evidence.**

```ts
private _handleSessionStart(sessionPath: string): void {
    ... this._toolAnalytics.clear();
    this._timeline = [];
    this._state.toolAnalytics = [];
    this._state.timeline = [];
    this._state.errorDetails = [];
    this._currentContextSize = 0;   // no reset of _state.compactions / contextAttribution / latencyDisplay
```

**Fix.** In _handleSessionStart (and refreshSessionView) also set this._state.compactions = [], this._state.contextAttribution = undefined, this._state.latencyDisplay = undefined; in _syncFromSessionMonitor assign compactions/attribution unconditionally (empty array when the new session has none) so the webview clears the sections.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-17 — _sendStateToWebview does plan aggregation + 4 postMessages on every token-usage event

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:2331`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** _handleTokenUsage (fires per parsed usage event during streaming) ends with _sendStateToWebview (line 1542), which posts the full DashboardState (timeline, model breakdown, error messages), plus an 'updatePhrase' with getRandomPhrase(), plus a full 'updatePlan' payload rebuilt via getStats().planState.steps.map, plus _sendPlanHistory() which recomputes six aggregate reductions over all persisted plans and posts 'updatePlanHistory' — all per token event. Besides the waste, sending updatePhrase here makes the header phrase visibly change on every stats tick, fighting the PhraseRotationManager whose whole job is timed rotation (UX flicker during active streaming).

**Evidence.**

```ts
private _sendStateToWebview(): void {
    this._postMessage({ type: 'updateStats', state: this._state });
    this._postMessage({ type: 'updatePhrase', phrase: getRandomPhrase() });
    const plan = this._sessionMonitor.getStats().planState;
    this._postMessage({ type: 'updatePlan', plan: ... });
    this._sendPlanHistory();
  }
```

**Fix.** Restrict _sendStateToWebview to the 'updateStats' post; move updatePhrase exclusively to PhraseRotationManager, and send updatePlan/updatePlanHistory only on plan-change events, webviewReady, and session start/end (or debounce them like the richer-panel updates).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-18 — D3 link join key breaks after first render: all links exit/re-enter each update

- **Location:** `sidekick-vscode/src/providers/MindMapViewProvider.ts:1424`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** updateGraph() keys the line join with `d.source + '-' + d.target`. After the first render, d3.forceLink mutates each bound link's source/target from string IDs into node objects, so on the next update every previously bound link stringifies to '[object Object]-[object Object]' (all identical — D3 duplicate-key collision) while incoming links key as 'id-id'. No keys match, so link.exit() removes every <line> and enter re-creates them all on every graph update (which happens per tool/token event). This defeats object constancy, churns the DOM continuously, and is inconsistent with the circular-layout join at lines 1033-1037 which correctly uses `d.source.id || d.source`.

**Evidence.**

```ts
const link = linkGroup.selectAll('line')
          .data(links, function(d) { return d.source + '-' + d.target; });
```

**Fix.** Use the same accessor as renderCircularLinks: .data(links, function(d) { const sid = d.source.id || d.source; const tid = d.target.id || d.target; return sid + '-' + tid; });

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-19 — TempFiles provider re-parses every subagent JSONL synchronously every 2 seconds

- **Location:** `sidekick-vscode/src/providers/TempFilesTreeProvider.ts:131`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** A 2-second setInterval calls scanSubagentFiles() whenever a session is active. scanSubagentDir (sidekick-shared/src/parsers/subagentScanner.ts) does fs.readdirSync plus fs.readFileSync + JSON.parse of EVERY agent-*.jsonl on every call — there is no mtime/size check. The provider then discards the freshly parsed data for agents already in scannedAgentFiles, meaning after the first pass every 2-second tick fully re-reads and re-parses all subagent transcripts (which can be multi-MB) on the extension host main thread just to conclude there is nothing new.

**Evidence.**

```ts
const scanInterval = setInterval(() => {
      if (this.sessionMonitor.isActive()) {
        this.scanSubagentFiles();
      }
    }, 2000);  // scanSubagentFiles -> scanSubagentDir -> fs.readFileSync(filePath, 'utf-8') per agent file, unconditionally
```

**Fix.** Before parsing, readdir the subagents dir and skip files already in scannedAgentFiles (or compare stat().mtimeMs/size against a cache) so only new/changed agent files are read; alternatively switch to an fs.watch on the subagents directory instead of polling.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-20 — Codex quota path does unthrottled sync snapshot reads/writes on every event batch

- **Location:** `sidekick-vscode/src/services/providers/CodexSessionProvider.ts:33`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** SessionMonitor.processFileChange calls emitQuotaFromSession() whenever newEvents.length > 0 (SessionMonitor.ts:2038-2040). For Codex, getQuotaFromSession() is synchronous and on every invocation runs resolveActiveCodexAccount() (auth-file reads), readQuotaSnapshot(), and writeQuotaSnapshot() — synchronous filesystem I/O — plus queues appendQuotaHistorySample. During an active Codex session emitting events every second or two, this rewrites the quota snapshot file on effectively every batch. Compare OpenCodeSessionProvider, which throttles the equivalent work with a 60s ZAI_QUOTA_REFRESH_INTERVAL_MS cache — Codex has no throttle at all.

**Evidence.**

```ts
resolveActiveCodexAccount();
    const active = getActiveCodexAccount();
    const cached = active ? readQuotaSnapshot('codex', active.id) : null;
    ...
    if (active) {
      writeQuotaSnapshot('codex', active.id, quotaWithResetCredits);
```

**Fix.** Mirror the OpenCode provider: cache the last QuotaState and skip account resolution/snapshot write unless the rate-limit payload changed or a refresh interval (e.g., 30-60s) elapsed.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-21 — File-truncation reset zeroes stats but seenHashes dedup swallows the re-read, leaving 0s and stale maps

- **Location:** `sidekick-vscode/src/services/SessionMonitor.ts:2021`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** When the reader reports truncation (file shrank; ClaudeCodeReader rewinds filePosition to 0 and re-emits ALL events), processFileChange resets token totals, messageCount, aggregator, and sessionStartTime 'for fresh read'. But it does not clear this.seenHashes, so every re-read event is rejected by isDuplicateEvent() at the top of handleEvent (line 2280) and never re-counted — the dashboard shows 0 tokens / 0 messages for a session that had data, until only genuinely-new events trickle in. It also leaves stats.modelUsage, stats.toolCalls, toolAnalyticsMap, timeline, and turnAttributions un-reset, so getSessionSummary() later mixes zeroed totals with pre-truncation model/tool data.

**Evidence.**

```ts
if (this.reader.wasTruncated()) {
        log('Session file truncated, resetting stats');
        // Reset stats for fresh read
        this.stats.totalInputTokens = 0;
        this.stats.totalOutputTokens = 0;
        this.stats.totalCacheWriteTokens = 0;
        this.stats.totalCacheReadTokens = 0;
        this.stats.messageCount = 0;
        this.aggregator.reset();
        this.sessionStartTime = null;
      }
```

**Fix.** On wasTruncated(), perform a full state reset consistent with attachToSession(): clear seenHashes, modelUsage, toolCalls, toolAnalyticsMap, timeline, pendingToolCalls, turnAttributions, and contextTimeline so the re-read from position 0 rebuilds a coherent state (ideally with _isReplaying set to suppress event storms).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-22 — Pinned session is ignored by the OpenCode inactivity auto-switch path

- **Location:** `sidekick-vscode/src/services/SessionMonitor.ts:797`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** performNewSessionCheck() guards auto-switching with `if (this._isPinned) ... return` (line 2147), honoring togglePin()'s contract that 'auto-switching to newer sessions is prevented'. But the OpenCode activity-poll path _checkForNewerSession() — invoked after 60s without new events (lines 774-777) — has no pin check: it fires session end and calls attachToSession(latestPath) unconditionally. A user who pins an OpenCode session to keep watching it while working in another session will be force-switched away (and a spurious sessionEnd -> historical save fires for the pinned session) after one minute of inactivity.

**Evidence.**

```ts
private _checkForNewerSession(): void {
    if (!this.sessionPath || !this.workspacePath) return;
    try {
      const latestPath = this.provider.findActiveSession(this.workspacePath);
      if (latestPath && latestPath !== this.sessionPath) {
        log(`Inactivity detected: newer session found, ending current session`);
        this.eventLogger?.endSession();
        this._onSessionEnd.fire();
```

**Fix.** Add `if (this._isPinned) return;` at the top of _checkForNewerSession(), mirroring performNewSessionCheck().

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-23 — Dedup hash collides for user/tool_result events without IDs, silently dropping events

- **Location:** `sidekick-vscode/src/services/SessionMonitor.ts:2240`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** generateEventHash uses `${type}:${timestamp}:${messageId}:${requestId}`. Claude Code user events (including tool_result carriers) have no message.id and no requestId, so their hash degenerates to `user:<timestamp>::`. When parallel tool calls produce multiple tool_result user lines with the same millisecond timestamp — common when results are flushed in one batch — the second event is treated as a duplicate and handleEvent returns before aggregator.processEvent, so its tokens/tool results are never counted, its pendingToolCalls entry is never removed (leaks and later mis-labels timeline lookups), and toolAnalytics under-counts completions.

**Evidence.**

```ts
private generateEventHash(event: SessionEvent): string {
    const messageId = (event.message as unknown as { id?: string })?.id || '';
    const requestId = (event as unknown as { requestId?: string })?.requestId || '';
    return `${event.type}:${event.timestamp}:${messageId}:${requestId}`;
  }
```

**Fix.** Include a content-derived component when IDs are absent — e.g., for user events append the tool_use_id(s) of contained tool_result blocks (or a short hash of the serialized content) to the key, so distinct same-millisecond events don't collide.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-24 — OpenCode activity poll spawns sqlite3 synchronously on the extension host every 1.5s

- **Location:** `sidekick-vscode/src/services/SessionMonitor.ts:767`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** startActivityPolling runs processFileChange() -> reader.readNew() on a 1500ms interval (OPENCODE_POLL_INTERVAL_MS, line 2086) for as long as an OpenCode session is attached. The DB-backed reader's readIncremental issues at least two queries (getMessagesNewerThan + getPartsNewerThan), each an execFileSync('sqlite3', ...) child-process spawn (sidekick-shared/src/providers/openCodeDatabase.ts:77). That is 2+ blocking process spawns per 1.5s tick on the extension-host event loop, even when the session is completely idle — sustained jank measurable in the extension host, in addition to the same spawns triggered by DB watcher callbacks.

**Evidence.**

```ts
this.opencodePollTimer = setInterval(() => {
      if (!this.sessionPath || !this.reader) return;
      const prevCount = this.stats.messageCount;
      this.processFileChange();
```

**Fix.** Gate the poll body on a cheap staleness check first (fs.statSync mtime of opencode.db/-wal vs last seen) and only hit sqlite3 when the files changed; and/or lengthen the interval with backoff when idle. Longer-term, move DB polling to an async child-process call so the event loop isn't blocked.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-25 — Error panel never shows fix preview after an explanation was displayed

- **Location:** `sidekick-vscode/src/webview/error.ts:571`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** The 'loadError' handler resets only currentErrorContext/currentCode/isLoading/errorMessage — it does not clear currentExplanation or currentFixSuggestion. updateUI()'s else-if chain checks currentExplanation before currentFixSuggestion. Scenario: user runs 'Explain Error' (panel is retained, currentExplanation set), then runs 'Fix Error' on the same or another diagnostic. When 'fixReady' arrives, isLoading=false and currentExplanation is still set from the previous run, so the stale explanation is rendered and the fix preview + Apply Fix button never appear. The fix mode is effectively broken for any reused panel.

**Evidence.**

```ts
} else if (currentExplanation) {
    explanationContent?.classList.remove('sk-hidden');
    renderExplanation(currentExplanation);
  } else if (currentFixSuggestion) {  // 'loadError' case sets only: currentErrorContext, currentCode, isLoading, errorMessage
```

**Fix.** In the 'loadError' case also reset currentExplanation = undefined and currentFixSuggestion = undefined so each new request starts clean; or track the active mode ('explain' | 'fix') in the loadError message and branch updateUI on it.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-26 — Complexity change fires two duplicate AI explanation requests

- **Location:** `sidekick-vscode/src/webview/explain.ts:580`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** changeComplexity() in the webview calls requestExplanation() (posting 'requestExplanation') AND posts 'changeComplexity'. The extension's 'changeComplexity' handler (ExplainViewProvider.ts lines 97-108) then also calls handleExplanationRequest with its own generated requestId. Result: every complexity-button click launches two concurrent LLM completions for the same code. The extension-initiated response carries a requestId the webview never generated, so handleExtensionMessage drops it (message.requestId === currentRequestId check) — a full paid inference call is wasted per click, doubling latency pressure, quota, and API cost.

**Evidence.**

```ts
if (state.code) {
    requestExplanation(state.code, complexity, state.fileContext);
  }

  // Also notify extension of complexity change
  vscode.postMessage({
    type: 'changeComplexity',
    complexity,
  } as ExplainWebviewMessage);
```

**Fix.** Make 'changeComplexity' a pure state-sync notification: in ExplainViewProvider's 'changeComplexity' case, only update this._pendingComplexity and do not call handleExplanationRequest (the webview already issued the request). Alternatively, drop the webview-side requestExplanation and let the extension drive it — but only one side should request.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-27 — Subagent inputTokens counts cache tokens for Claude but not for OpenCode/Codex

- **Location:** `sidekick-shared/src/parsers/subagentScanner.ts:176`
- **Severity / category:** ⚪ low · improvement
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** parseAgentFile folds cache_creation and cache_read tokens into SubagentStats.inputTokens (as does subagentTraceParser.ts:173-176), while OpenCodeProvider.scanSubagents (providers/openCode.ts:1287) sums only tokens.input and CodexProvider.buildSubagentStats (providers/codex.ts:894) sums only usage.input_tokens. The same SubagentStats field therefore means 'total context processed including repeated cache reads' for Claude subagents but 'fresh input only' for the other providers — subagent token columns are not comparable across providers, and Claude subagent numbers balloon with every turn re-reading the cache.

**Evidence.**

```ts
inputTokens +=
            (usage.input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0);
```

**Fix.** Pick one semantic for SubagentStats.inputTokens (fresh input only is consistent with the rest of the token pipeline) and apply it in all three providers; if cache visibility is wanted, add separate cacheReadTokens/cacheWriteTokens fields to SubagentStats.

<details><summary>Verifier notes</summary>

- All three cited code sites match the quotes: the Claude subagent parsers fold cache_creation/cache_read into inputTokens while openCode.ts:1287 sums only tokens.input (OpenCode reports cache separately, per the repo's own context formula at openCode.ts:1675), and the rest of the token pipeline (claudeCode.ts:386-389, EventAggregator.ts:925-926) keeps input and cache fields distinct. The inflated value is user-visible via SubagentTreeProvider.ts:522-524's token badge. However, the Codex half of the claim is wrong: codexParser.ts:888-890 passes OpenAI input_tokens through unchanged, and codex.ts:1043-1046 documents that OpenAI's input_tokens already includes cached_input_tokens as a subset — so Codex subagent inputTokens already means "total prompt including cache reads", matching Claude, and only OpenCode is fresh-input-only.

</details>

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-28 — Aggregator restore() fails silently on version mismatch; version constant duplicated

- **Location:** `sidekick-shared/src/aggregation/EventAggregator.ts:860`
- **Severity / category:** ⚪ low · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** restore() returns void and simply does nothing when `state.version !== SNAPSHOT_SCHEMA_VERSION`, while its comment says 'caller should fall back to full replay' -- but callers cannot tell: DashboardState.tryRestoreFromSnapshot (sidekick-cli) and the VS Code SessionMonitor both call restore() unconditionally and then seek the reader to snapshot.readerPosition. The only current protection is that snapshot.ts keeps its own SNAPSHOT_VERSION = 3 that happens to match; the two constants live in different files and must be bumped in lockstep by hand. If EventAggregator's schema version is bumped without snapshot.ts's, loadSnapshot passes, restore no-ops, and users get zeroed metrics with replay skipped -- silent data loss.

**Evidence.**

```ts
restore(state: SerializedAggregatorState): void {
    if (state.version !== SNAPSHOT_SCHEMA_VERSION) {
      return; // Incompatible snapshot — caller should fall back to full replay
    }
```

**Fix.** Make restore() return boolean (or throw) so callers can fall back to full replay, and export SNAPSHOT_SCHEMA_VERSION so snapshot.ts reuses it instead of maintaining a second constant.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-29 — Knowledge-notes pipeline and 8 other message types are dead protocol on the dashboard

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:1177`
- **Severity / category:** ⚪ low · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** Extension→webview: 'updateKnowledgeCandidates' (line 1177), 'updateKnowledgeNotes' (line 1194), and 'discoveryModeChange' (line 1678) have no case in the webview message switch and no UI — yet _extractAndSurfaceKnowledgeCandidates runs extractKnowledgeCandidates over all tool calls on every debounced richer-panel update and on session end, doing work whose only output is a discarded postMessage. Webview→extension: the provider's handler has cases for 'requestStats', 'setTimelineFilter', 'requestDecisions', 'clearDecisions', 'requestKnowledgeNotes', 'acceptKnowledgeCandidate', 'rejectKnowledgeCandidate', 'requestPlanHistory', and 'openClaudeMd' (lines 456-459, 551-554, 572, 586-611, 640) that the inline script never sends — including a clearDecisions/accept-candidate flow that is unreachable. Payoff: trimming these clarifies the real protocol and removes hot-path work with no observable effect.

**Evidence.**

```ts
if (candidates.length > 0) {
        this._postMessage({ type: 'updateKnowledgeCandidates', candidates });
      }  // no 'updateKnowledgeCandidates' case exists in the webview switch (lines 8652-8998)
```

**Fix.** Either build the knowledge-notes UI in the webview (and wire accept/reject buttons to the existing handlers) or stop calling _extractAndSurfaceKnowledgeCandidates from the dashboard and delete the dead cases from both DashboardWebviewMessage handling and the DashboardMessage union.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-30 — In-progress task nodes never get their highlight: CSS class uses hyphen, data uses underscore

- **Location:** `sidekick-vscode/src/providers/MindMapViewProvider.ts:482`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** getNodeClass builds `'task-' + d.taskStatus` where TaskNodeStatus is 'pending' | 'in_progress' | 'completed' (types/mindMap.ts line 41; MindMapDataService.addTaskNodes sets 'in_progress'), producing class 'task-in_progress'. The stylesheet defines '.node.task-in-progress' with a hyphen, so the green pulsing stroke for the active task is dead CSS and in-progress tasks render unstyled — while the analogous '.node.plan-step-in_progress' rule (line 512) correctly uses the underscore. The tooltip's status color check (line 1526) uses the underscore and works, making the discrepancy invisible in review but broken on screen.

**Evidence.**

```ts
.node.task-in-progress {
      stroke: var(--vscode-charts-green, #4caf50);
      stroke-width: 3;
      animation: task-pulse 1.5s ease-in-out infinite;
    }  // vs getNodeClass: classes.push('task-' + d.taskStatus)  // taskStatus = 'in_progress'
```

**Fix.** Rename the CSS selector to .node.task-in_progress (matching the plan-step convention already used in the same stylesheet).

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-31 — Session Activity summary reads t.count but ToolAnalyticsDisplay only has totalCalls — always 0

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:8217`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** updateGroupSummaries sums state.toolAnalytics with 't.count || 0', but the provider's _updateToolAnalyticsState (line 1575) and the ToolAnalyticsDisplay type (sidekick-vscode/src/types/dashboard.ts line 335) define the field as 'totalCalls' — there is no 'count' property. The reduce therefore always yields 0 and the 'N tool calls' segment of the collapsed Session Activity group summary never appears, even in tool-heavy sessions.

**Evidence.**

```ts
var totalToolCalls = (state.toolAnalytics || []).reduce(function(s, t) { return s + (t.count || 0); }, 0);  // provider sends: { name, totalCalls, successRate, avgDuration, pendingCount }
```

**Fix.** Change to (t.totalCalls || 0) in updateGroupSummaries.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-32 — SubagentTreeProvider worker IDs can collide and completion heuristic marks wrong agent

- **Location:** `sidekick-vscode/src/providers/SubagentTreeProvider.ts:185`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** New live agents get id `worker-${this.subagents.size + 1}`. applyTraceResults() clears and repopulates the map with trace-derived agent IDs, changing size, so a later Task call can generate a worker-N id that already exists: this.subagents.set(agentId, item) silently overwrites the map entry while topLevelAgents.push(item) keeps BOTH items in the visible list — duplicate 'worker-N' rows where one is orphaned from the map (never marked completed). Separately, markOldestRunningAsCompleted() (lines 220-237) marks the oldest running agent on ANY Task tool_result; with parallel subagents that finish out of order, the wrong agent gets flipped to 'completed' while the actually finished one keeps spinning.

**Evidence.**

```ts
const agentId = `worker-${this.subagents.size + 1}`;  ...  this.subagents.set(agentId, item);
    this.topLevelAgents.push(item);
```

**Fix.** Use a monotonically increasing counter field (never derived from map size) or a UUID for live worker IDs, and guard topLevelAgents against duplicate ids; for completion, correlate the Task tool_result's toolUseId with the spawning tool_call instead of picking the oldest running agent.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-33 — Hourly buckets mix UTC date with local hour, skewing peak-hours data for non-UTC users

- **Location:** `sidekick-vscode/src/services/HistoricalDataService.ts:183`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** saveSessionSummary derives the bucket date via summary.startTime.split('T')[0] (UTC calendar date, line 78) but updateHourlyData computes the hour with new Date(summary.startTime).getHours() (local time). For a user at UTC-7, a session starting 18:00 local on July 1 (01:00 UTC July 2) is filed under date '2026-07-02' with hour=18 — a local-evening hour attached to the wrong local day. Hourly/peak-hours charts show sessions on days they didn't happen locally, and daily 'today' queries (also UTC-keyed) shift late-evening sessions to tomorrow.

**Evidence.**

```ts
const startDate = new Date(summary.startTime);
    const hour = startDate.getHours();
```

**Fix.** Pick one timezone consistently: either key both date and hour in UTC (getUTCHours + UTC date) or derive the date from local components (getFullYear/getMonth/getDate) to match getHours(); document the choice in the store schema.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

### P4-34 — dispose() leaks three event emitters: _onTruncation, _onCycleDetected, _onReplayStateChange

- **Location:** `sidekick-vscode/src/services/SessionMonitor.ts:1719`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done — implementation complete and covered by the phase verification matrix.

**Problem.** dispose() disposes ten emitters but omits _onTruncation, _onCycleDetected, and _onReplayStateChange (declared at lines 264-269). Their listener arrays (dashboard/notification subscriptions) survive monitor disposal — on provider switches where a new SessionMonitor is constructed while old listeners were registered, stale listeners are retained for the lifetime of the extension host.

**Evidence.**

```ts
this._onTokenUsage.dispose();
    this._onToolCall.dispose();
    this._onSessionStart.dispose();
    this._onSessionEnd.dispose();
    this._onToolAnalytics.dispose();
    this._onTimelineEvent.dispose();
    this._onDiscoveryModeChange.dispose();
    this._onLatencyUpdate.dispose();
    this._onCompaction.dispose();
    this._onQuotaUpdate.dispose();
```

**Fix.** Add this._onTruncation.dispose(); this._onCycleDetected.dispose(); this._onReplayStateChange.dispose(); to dispose() (or collect all emitters in an array and dispose in a loop so new emitters can't be forgotten).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** Covered by the targeted regression files and full package gates in the phase verification matrix below.

---

## Phase verification matrix

| Area | Regression coverage | Result |
| --- | --- | --- |
| Shared aggregation, context, detection, subagents, and watchers | `EventAggregator.test.ts`, `sessionContext.test.ts`, `sessionActivityDetector.test.ts`, `subagentTraceParser.test.ts`, `detect.test.ts`, `jsonlWatcher.test.ts`, `sqliteWatcher.test.ts` | 79 files / 917 tests passed; build and lint passed |
| Extension dashboard and mind map | `DashboardViewProvider.test.ts`, `MindMapViewProvider.test.ts` | Inline quota/context/truncation handlers, one-message stats updates, view disposal, hidden-view suppression, and burst coalescing passed |
| Extension session pipeline and local history | `SessionMonitor.test.ts`, `HistoricalDataService.test.ts` | Content-aware deduplication, bounded tool retention, pinning, emitter lifecycle, and local date/hour alignment passed |
| Full extension gate | Entire `sidekick-vscode` Vitest suite, ESLint, and esbuild compile | 51 files / 692 tests passed; lint and compile passed |

The obsolete `src/webview/dashboard.ts` entry point was removed, leaving the inline dashboard implementation as the single protocol/UI owner. Architecture documentation and both agent-guidance mirrors now describe the five emitted bundles.
