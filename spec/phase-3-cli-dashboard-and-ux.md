# Phase 3 — CLI Dashboard & Terminal UX

> Part of the [Sidekick Agent Hub review backlog](./README.md). Read the README first for methodology, trust levels, conventions, and the working loop.

**Goal.** Fix the terminal dashboard the user actually looks at: garbled quota text, timezone-wrong date filters, mis-sorted panels, and the Ink layer’s mouse/scroll off-by-ones. Mostly CLI-only, low regression risk.

**This phase:** 28 findings — 6 high, 12 medium, 10 low.

## Progress tracker

Update the Status box as you go: `[ ]` todo → `[~]` in progress → `[x]` done (or `[-]` if dropped after re-verification). Keep the one-line note current.

| ID | Sev | Trust | Location | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| P3-01 | 🔴 | ✅ | `commands/quotaHistory.ts:92` | quota history heatmap: weekday rows misaligned for every render except Saturdays | `[x]` |
| P3-02 | 🔴 | ✅ | `commands/report.ts:30` | report: --no-open and --no-thinking flags are silently ignored | `[x]` |
| P3-03 | 🔴 | ✅ | `ink/Dashboard.tsx:450` | Side-list mouse click selects the item one row below the clicked one | `[x]` |
| P3-04 | 🔴 | ✅ | `ink/DetailPane.tsx:32` | Detail pane's last 2 lines are unreachable at max scroll; Timeline tail hidden | `[x]` |
| P3-05 | 🔴 | ✅ | `ink/SessionPickerInk.tsx:92` | Grouped session picker opens the wrong session on Enter | `[x]` |
| P3-06 | 🔴 | ✅ | `panels/SessionsPanel.ts:494` | Quota-failure text iterates wordWrap() string char-by-char, one line per character | `[x]` |
| P3-07 | 🟠 | ✅ | `dashboard/dateFilterExpression.ts:136` | Date filter: date-only timestamps parsed as UTC midnight vs local-midnight bounds | `[x]` |
| P3-08 | 🟠 | ✅ | `dashboard/GitDiffCache.ts:62` | GitDiffCache runs synchronous git diff on the render path, freezing the TUI up to 3s | `[x]` |
| P3-09 | 🟠 | ✅ | `dashboard/MindMapBuilder.ts:230` | Mind map git-diff annotations never render: lookup keys don't match numstat keys | `[x]` |
| P3-10 | 🟠 | ✅ | `panels/PlansPanel.ts:91` | PlansPanel dedup compares a timestamp prefix to a session-UUID prefix — never matches | `[x]` |
| P3-11 | 🟠 | ✅ | `panels/TasksPanel.ts:39` | TasksPanel sortKey is NaN for subagent and plan-step task IDs, breaking status sort | `[x]` |
| P3-12 | 🟠 | ⚠️ | `src/cli.ts:384` | program.parse() with async actions: user-reachable errors crash with raw stack traces | `[x]` |
| P3-13 | 🟠 | ⚠️ | `commands/dashboard.ts:560` | dashboard: SIGINT/SIGTERM handlers prevent exit, leaving the TUI process hung | `[x]` |
| P3-14 | 🟠 | ⚠️ | `ink/Dashboard.tsx:428` | TabBar click hitboxes drift 2 columns per tab, activating the wrong panel | `[x]` |
| P3-15 | 🟠 | ⚠️ | `ink/Dashboard.tsx:105` | 'Context compacted' toast is skipped: alert scan window misses synthetic entries | `[x]` |
| P3-16 | 🟠 | ⚠️ | `ink/Dashboard.tsx:242` | SideList overflows its box when scrolled: last row and ▼ indicator are clipped | `[x]` |
| P3-17 | 🟠 | ⚠️ | `mouse/MouseProvider.tsx:55` | Mouse capture is torn down and re-enabled on every render (up to 10x/sec) | `[x]` |
| P3-18 | 🟠 | ⚠️ | `inference/CliInferenceClient.ts:241` | CliInferenceClient: stdin write has no error handler — EPIPE can crash the dashboard | `[x]` |
| P3-19 | ⚪ | ✅ | `dashboard/MindMapBuilder.ts:734` | fitText truncation counts invisible tag/ANSI chars, breaking boxed mind map borders | `[x]` |
| P3-20 | ⚪ | ✅ | `panels/SessionsPanel.ts:113` | Session label built from ISO timestamp prefix renders as 'session-2026-07-' | `[x]` |
| P3-21 | ⚪ | ✅ | `utils/taskMerger.ts:36` | taskMerger: live task overwrite drops persisted createdAt/sessionOrigin | `[x]` |
| P3-22 | ⚪ | ⚠️ | `commands/dashboard.ts:190` | dashboard: original session provider leaks when picker switches providers | `[x]` |
| P3-23 | ⚪ | ⚠️ | `ink/Dashboard.tsx:291` | Timeline auto-scroll-to-bottom depends on the previous tab's line count | `[x]` |
| P3-24 | ⚪ | ⚠️ | `ink/Dashboard.tsx:619` | StatusBar totalCount calls panel.getItems a second time on every render | `[x]` |
| P3-25 | ⚪ | ⚠️ | `mouse/parseMouseEvent.ts:26` | parseMouseEvent handles only the first SGR sequence per stdin chunk | `[x]` |
| P3-26 | ⚪ | ⚠️ | `ink/parseBlessedTags.tsx:60` | Unmatched close tags pop wrong style frame; search highlight strips label color | `[x]` |
| P3-27 | ⚪ | ⚠️ | `ink/useWindowedScroll.ts:41` | useWindowedScroll never re-clamps scrollOffset when the list shrinks or resizes | `[x]` |
| P3-28 | ⚪ | ⚠️ | `utils/clipboard.ts:34` | clipboard copy always fails on native Windows — clip.exe only tried under WSL | `[x]` |

---

## Findings

### P3-01 — quota history heatmap: weekday rows misaligned for every render except Saturdays

- **Location:** `sidekick-cli/src/commands/quotaHistory.ts:92`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** quotaHistoryAction requests an inclusive range of exactly weeks*7 days, and readQuotaHistoryDailyBuckets (sidekick-shared/src/quotaHistory.ts) emits one bucket for every day in the range, so cells.length === weeks*7 always. renderProviderHeatmap prepends firstDayOfWeek null pads to align cells[0] to its weekday row, but then `while (padded.length > totalCells) padded.shift()` removes exactly those pads from the front, putting cells[0] back at index 0 (row 'Sun'). Every date is therefore attributed to the wrong day-of-week label unless cells[0] is actually a Sunday (i.e. the command is run on a UTC Saturday). Users reading 'I burn quota on Mondays' get wrong data.

**Evidence.**

```ts
const padded: (QuotaHistoryDailyCell | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i += 1) padded.push(null);
  for (const cell of cells) padded.push(cell);
  while (padded.length < totalCells) padded.push(null);
  while (padded.length > totalCells) padded.shift();
```

**Fix.** When overflow occurs, drop whole 7-cell columns from the front to preserve row parity (`while (padded.length > totalCells) padded.splice(0, 7);`), or trim the oldest cells before padding and recompute firstDayOfWeek from the kept first cell. Add a test asserting a known date lands on its correct weekday row with a full weeks*7 input.

**Verification:** `commands/quotaHistory.test.ts` renders a full two-week Monday-based range and asserts the hot cell remains on the Monday row.

---

### P3-02 — report: --no-open and --no-thinking flags are silently ignored

- **Location:** `sidekick-cli/src/commands/report.ts:30`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** Commander stores a `--no-open` flag under the key `open` (default true, false when passed) and `--no-thinking` under `thinking`. reportAction reads `opts.noOpen` and `opts.noThinking`, which never exist, so both are always false. Running `sidekick report --no-open --output x.html` (e.g. in a script/CI) still launches the user's browser, and `--no-thinking` still embeds thinking blocks in the HTML report. The repo itself uses the correct pattern elsewhere: dashboard.ts reads `opts.mouse === false` for `--no-mouse`, and handoff.ts reads `opts.open !== false`.

**Evidence.**

```ts
const noOpen: boolean = !!opts.noOpen;
  const theme: 'dark' | 'light' = opts.theme === 'light' ? 'light' : 'dark';
  const noThinking: boolean = !!opts.noThinking;
```

**Fix.** Read the commander-normalized keys: `const noOpen = opts.open === false;` and `const noThinking = opts.thinking === false;` (matching handoff.ts's `opts.open !== false`). Add a test covering both flags.

**Verification:** `commands/report.test.ts` verifies Commander’s normalized `open` and `thinking` keys disable browser opening and thinking inclusion.

---

### P3-03 — Side-list mouse click selects the item one row below the clicked one

- **Location:** `sidekick-cli/src/dashboard/ink/Dashboard.tsx:450`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** The click-to-index mapping assumes items start at y=2 (comment: 'row 1 = border/panel title row'), but in Ink the border and the panel-title are separate rows: y=0 TabBar, y=1 SideList top border, y=2 title row (' Tasks (5) '), items from y=3. So clicking the first item (y=3) computes itemRow = 3-2 = 1 and selects the second item; every item click lands one below the clicked row, and clicking the panel title selects the first item. The detail pane then shows the wrong item's content.

**Evidence.**

```ts
// Row 0 = tab bar, row 1 = border/panel title row
// When scrolled down, a "▲" indicator takes an extra row
const hasScrollUp = sideScroll.scrollOffset > 0;
const itemRow = y - 2 - (hasScrollUp ? 1 : 0);
const itemIndex = sideScroll.scrollOffset + itemRow;
```

**Fix.** Change the mapping to `const itemRow = y - 3 - (hasScrollUp ? 1 : 0);` (tab bar, border, and title each occupy one row) and update the comment. Add a bounds check so clicks on the title/border rows (itemRow < 0) do not select anything.

**Verification:** `ink/mouseHitTesting.test.ts` verifies the first item begins after tab, border, and title rows and title clicks select nothing.

---

### P3-04 — Detail pane's last 2 lines are unreachable at max scroll; Timeline tail hidden

- **Location:** `sidekick-cli/src/dashboard/ink/DetailPane.tsx:32`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** DetailPane reserves up to 2 rows for scroll indicators (effectiveHeight = viewportHeight - indicatorAbove - worstCaseBelow), but every scroll clamp uses the full viewportHeight: dashboardReducer SCROLL_DETAIL_DELTA clamps to `totalLines - viewportHeight`, inputDispatch 'G' uses `detailLineCount - detailViewportHeight`, and the auto-scroll effect in Dashboard.tsx uses `detailLines.length - detailViewportHeight`. At that max offset, indicatorAbove=1 and worstCaseBelow=1, so only viewportHeight-2 lines render: lines T-2 and T-1 can never be displayed. Since the Timeline tab auto-scrolls to this offset, the two newest timeline lines are permanently invisible. The bottom indicator also prints `totalLines - scrollOffset - viewportHeight` (using viewportHeight, not effectiveHeight), which shows "(0 more)" or a negative count while content is actually hidden.

**Evidence.**

```ts
const worstCaseBelow = totalLines > scrollOffset + viewportHeight - 1 ? 1 : 0;
const effectiveHeight = Math.max(1, viewportHeight - indicatorAbove - worstCaseBelow);
...
<Text color="gray">▼ ({totalLines - scrollOffset - viewportHeight} more)</Text>
```

**Fix.** Use one consistent effective height for both rendering and clamping: export a helper (e.g. maxDetailScroll(totalLines, viewportHeight) = Math.max(0, totalLines - (viewportHeight - 2))) and use it in SCROLL_DETAIL_DELTA, the 'G' handler, and the auto-scroll effect; fix the bottom indicator to print totalLines - scrollOffset - effectiveHeight.

**Verification:** reducer/input tests plus `ink/detailScroll.test.ts` verify the common max-scroll helper reserves indicator rows and reaches the final lines.

---

### P3-05 — Grouped session picker opens the wrong session on Enter

- **Location:** `sidekick-cli/src/dashboard/ink/SessionPickerInk.tsx:92`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** In the multi-provider grouped view, rows are re-ordered by provider (buildGroupedRows groups item indices per provider), and the highlight is drawn against that grouped order (isSelected = selectableIdx === selectedIndex). But the Enter handler indexes the original recency-sorted items array directly. collectMultiProviderItems sorts all providers' sessions by mtime, so items interleave providers; whenever grouping reorders them, the session opened differs from the one highlighted. Scenario: items by recency = [claude-A, codex-X, claude-B]. Grouped view shows claude-A (pos 0), claude-B (pos 1), codex-X (pos 2). User highlights claude-B (selectedIndex=1), presses Enter -> onSelect(items[1]) opens codex-X.

**Evidence.**

```ts
if (key.return) {
  if (selectedIndex === items.length) {
    onSelect(null);
  } else {
    onSelect(items[selectedIndex].sessionPath);
  }
```

**Fix.** When grouped, resolve the selection through the grouped rows: const itemRows = grouped.rows.filter(r => r.type === 'item'); const target = itemRows[selectedIndex]; then use target.index === items.length for 'wait' and items[target.index].sessionPath otherwise. Keep the current direct indexing only for the flat view.

**Verification:** `ink/SessionPickerInk.test.ts` verifies grouped Claude/Codex ordering resolves Enter to the highlighted source item and wait sentinel.

---

### P3-06 — Quota-failure text iterates wordWrap() string char-by-char, one line per character

- **Location:** `sidekick-cli/src/dashboard/panels/SessionsPanel.ts:494`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** wordWrap() (formatters.ts) returns a string, not an array. `for...of` over a string iterates individual characters, so every character of the quota failure message is pushed as its own display line. Failure scenario: user runs the dashboard with claude-code provider but no Max OAuth credentials (or any quota fetch failure) -> describeQuotaFailure returns a descriptor -> the Summary tab renders ~36 one-character lines ('S', 'i', 'g', 'n', ...) instead of a wrapped message, garbling the panel and pushing all later sections (provider status, context attribution) off-screen.

**Evidence.**

```ts
const quotaTextWidth = Math.max(20, w - 4);
          for (const line of wordWrap(failureText, quotaTextWidth)) {
            lines.push(`  {grey-fg}${line}{/grey-fg}`);
          }
```

**Fix.** Iterate the wrapped lines: `for (const line of wordWrap(failureText, quotaTextWidth).split('\n'))`.

<details><summary>Verifier notes</summary>

- Verified that wordWrap in sidekick-cli/src/dashboard/formatters.ts (line 167) returns a '\n'-joined string, and SessionsPanel.ts imports that exact function from '../formatters'. Line 494 iterates it with for...of, which iterates a string character-by-character (legal at target ES2022, so no compile error), pushing each character as its own display line. The trigger path is reachable: describeQuotaFailure (sidekick-shared/src/quotaPresentation.ts) returns a descriptor for any quota failure on claude-code/codex providers, and no guard or post-processing prevents or repairs the garbled output. The only inaccuracy is minor: the no-credentials failure text is ~110 chars, so the panel emits ~110 one-character lines, not ~36.
- wordWrap() (formatters.ts:167-199) provably returns a '\n'-joined string, and SessionsPanel.ts:494 is the only call site that does for...of over it, iterating characters and pushing one display line per character. The failing state is reachable: dashboard.ts:507 wires QuotaService updates into state.setQuota, and the shared QuotaPoller notifies unavailable states with failureKind set on OAuth rejection (HTTP 401 → failureKind 'auth') or on a first-poll network/server/rate-limit failure before any cached success, which makes describeQuotaFailure return a descriptor whose ~100-char message renders as ~100 one-character lines. One trigger named in the claim is wrong in detail: the "no Max OAuth credentials" case never reaches this branch via the dashboard, because QuotaService.getAccessToken throws and QuotaPoller's catch swallows it without notifying, leaving m.quota null.

</details>

**Verification:** `panels/SessionsPanel.test.ts` renders an unavailable quota and verifies the failure is emitted as wrapped lines rather than character rows.

---

### P3-07 — Date filter: date-only timestamps parsed as UTC midnight vs local-midnight bounds

- **Location:** `sidekick-cli/src/dashboard/dateFilterExpression.ts:136`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** parseDateExpression builds bounds from local midnights (startOfLocalDay), but itemTimestampMs parses the leading YYYY-MM-DD of sessionOrigin/sessionId with Date.parse, which the spec treats as UTC midnight. SessionsPanel.getItemTimestamp (line 145) does the same with SessionRecord.date ('YYYY-MM-DD'). Failure scenario: user in any UTC-negative timezone (all of the Americas) types the Date filter `today` or `2026-07-21` -> bounds start at local midnight (e.g. 06:00Z) while today's history row parses to 00:00Z -> `ts >= since` fails and sessions/tasks from that exact day disappear from the filtered list.

**Evidence.**

```ts
const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
      if (match) {
        const ms = Date.parse(match[0]);
```

**Fix.** When the value is date-only, construct a local date instead: split into y/m/d and use `new Date(y, m - 1, d).getTime()` (apply the same in SessionsPanel.getItemTimestamp for `session.date`).

<details><summary>Verifier notes</summary>

- Verified the full chain: parseDateExpression builds local-midnight bounds (new Date(y,m,d)), Dashboard.tsx:194-198 compares ts >= since, and both SessionsPanel.getItemTimestamp (Date.parse of YYYY-MM-DD SessionRecord.date, confirmed date-only at HistoricalDataService.ts:78) and itemTimestampMs's sessionOrigin/sessionId fallback parse date-only strings as UTC midnight per the ECMAScript spec. Empirically confirmed with TZ=America/Denver: `today` bounds start 06:00Z while the day row parses to 00:00Z, so that day's Sessions-panel history row is excluded (and an explicit YYYY-MM-DD filter matches the wrong day's row, off-by-one). No guard elsewhere compensates; the existing regression test codifies the UTC-midnight parse.
- Traced the full pipeline: Dashboard.tsx (lines 186-199) applies date-mode bounds via `ts >= since && ts < until`; parseDateExpression emits local-midnight bounds; SessionsPanel.getItemTimestamp (line 145) runs Date.parse on SessionRecord.date, which real ~/.config/sidekick/historical-data.json confirms is bare 'YYYY-MM-DD' — spec-parsed as UTC midnight. Verified numerically on this UTC-05:00 machine: Date.parse('2026-07-21') is 5 hours before local midnight, so typing `today` or `2026-07-21` in the date filter drops today's history row (and `yesterday` shifts a full day). The claim's secondary path (itemTimestampMs sessionOrigin/sessionId fallback, quoted line 136) is latent, not reachable with real data: tasks always carry full-ISO createdAt, and sessionOrigin/sessionId are UUIDs or 'cli', which never match the date-prefix regex — so tasks do not actually disappear.

</details>

**Verification:** date-filter and panel timestamp tests verify date-only values resolve to local midnight for both fallback identifiers and historical sessions.

---

### P3-08 — GitDiffCache runs synchronous git diff on the render path, freezing the TUI up to 3s

- **Location:** `sidekick-cli/src/dashboard/GitDiffCache.ts:62`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** getStats() is called from SessionsPanel.renderSummary (line 421), renderFiles (line 711), renderMindMap (line 606), and buildNarrativePrompt — i.e. on every render tick of the Sessions panel. The 5s TTL means that every 5 seconds the cache refetches via execSync('git diff HEAD --numstat', { timeout: 3_000 }), which blocks the Node event loop (and thus the entire Ink UI, keyboard input, and file watchers) for the full duration of the git command. On large repos, slow disks, or repos with smudge filters this is a visible periodic freeze of up to 3 seconds.

**Evidence.**

```ts
const output = execSync('git diff HEAD --numstat', {
        cwd: this.workspacePath,
        timeout: 3_000,
        encoding: 'utf-8',
      });
```

**Fix.** Refresh asynchronously: keep returning the last-known Map synchronously, and when the TTL expires kick off a non-blocking `execFile('git', [...])` that swaps the cache in its completion callback (with an in-flight guard).

<details><summary>Verifier notes</summary>

- Verified the cited code and full call chain: GitDiffCache.getStats() uses execSync('git diff HEAD --numstat', {timeout: 3000}) on TTL expiry, and it is called from SessionsPanel's Summary/MindMap/Files tab render functions, which Dashboard.tsx:273 invokes synchronously in the React component body on every Ink render (renders fire continuously during active sessions via a 100ms-throttled rerender bridge in commands/dashboard.ts). No async prefetch, worker, or guard exists anywhere — the only mitigations are the 5s TTL and 3s timeout the claim already accounts for, so a slow git diff blocks the event loop (UI, input, watchers) for up to 3s roughly every 5s.
- Traced the full chain: GitDiffCache is always constructed (workspacePath defaults to cwd), the default dashboard view is Sessions/Summary/first-item, and Dashboard.tsx:273 invokes renderSummary synchronously in the React render body, hitting getStats() -> execSync('git diff HEAD --numstat', {timeout: 3000}) whenever the 5s TTL has lapsed. Watcher events schedule renders at 100ms throttle during live sessions and every keystroke re-renders, so the blocking refetch genuinely recurs about every 5s in the tool's core use case, freezing the event loop for the git command's duration. The block is capped at ~3s by the timeout, but on typical repos the command takes tens of ms, so the visible multi-second freeze needs a large repo, cold cache, or diff filters.

</details>

**Verification:** `dashboard/GitDiffCache.test.ts` verifies render-path reads return immediately, overlapping refreshes share one async request, and completed numstat replaces the cache.

---

### P3-09 — Mind map git-diff annotations never render: lookup keys don't match numstat keys

- **Location:** `sidekick-cli/src/dashboard/MindMapBuilder.ts:230`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** GitDiffCache.getStats() keys the map by repo-relative paths from `git diff --numstat` output. buildMindMapTree looks up by `f.path` (the absolute file_path Claude Code passes to Read/Write/Edit) or `shortenPath(f.path)` ('.../a/b/c'). Neither ever equals a repo-relative path for files more than 3 segments deep, so the `+N -N` diff suffix in the mind map tree silently never appears — SessionsPanel.renderFiles gets this right by calling `this.diffCache?.toRelative(f.path)` first, but that conversion is not applied on the mind map path (renderMindMap passes raw getStats()).

**Evidence.**

```ts
const ds = diffStats?.get(f.path) ?? diffStats?.get(shortPath);
```

**Fix.** Pass a resolver into buildMindMapTree (or pre-map the diffStats keys in SessionsPanel.renderMindMap using diffCache.toRelative) so lookups use repo-relative paths, matching renderFiles' behavior.

<details><summary>Verifier notes</summary>

- GitDiffCache keys its map with raw repo-relative numstat paths (GitDiffCache.ts:70-75), while FileTouch.path is the absolute file_path from tool inputs (DashboardState.ts:713) and buildMindMapTree looks up diffStats.get(f.path) ?? diffStats.get(shortenPath(f.path)) (MindMapBuilder.ts:229-230) — an absolute or '.../'-prefixed string can never equal a repo-relative key, and SessionsPanel.renderMindMap passes getStats() raw with no toRelative conversion (SessionsPanel.ts:606, 629). renderFiles does apply toRelative first (SessionsPanel.ts:737-738), confirming the intended pattern, and MindMapBuilder.test.ts never exercises the diffStats parameter, so nothing masks the silent failure.
- Traced the full data path: GitDiffCache keys stats by repo-relative paths from `git diff HEAD --numstat`; DashboardState.extractFileTouch stores raw absolute tool-input paths (Claude Code file tools require absolute paths); MindMapBuilder.ts:230 looks up by the absolute path or shortenPath's '.../a/b/c' form, neither of which can equal a repo-relative key. The failing state is reachable by default: SessionsPanel.mindMapView initializes to 'tree', and renderMindMap (SessionsPanel.ts:629) passes raw getStats() into buildMindMapTree, while renderFiles (line 737) correctly converts via diffCache.toRelative first. MindMapBuilder.test.ts has no diffStats coverage, so nothing catches the silent miss.

</details>

**Verification:** `dashboard/MindMapBuilder.test.ts` supplies an absolute file and repo-relative numstat key and verifies the `+3 -1` annotation renders.

---

### P3-10 — PlansPanel dedup compares a timestamp prefix to a session-UUID prefix — never matches

- **Location:** `sidekick-cli/src/dashboard/panels/PlansPanel.ts:91`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The active-plan dedup adds `metrics.sessionStartTime.substring(0, 8)` (an ISO timestamp, so always '2026-07-'-style) to the set, then checks it against `p.sessionId.substring(0, 8)` (a session UUID prefix from PersistedPlan.sessionId, confirmed in sidekick-shared/src/types/plan.ts). These can never be equal, so the skip is dead code. Failure scenario: the active session's plan gets persisted while the session is still running -> the same plan appears twice in the Plans list (once pinned as 'active-plan', once as a historical row).

**Evidence.**

```ts
if (activeSessionPlanAdded.has(p.sessionId.substring(0, 8))) continue;
```

**Fix.** Track the real session ID: `if (metrics.sessionId) activeSessionPlanAdded.add(metrics.sessionId)` (DashboardMetrics.sessionId is set via setSessionId in commands/dashboard.ts) and compare with `p.sessionId` directly, no substring.

<details><summary>Verifier notes</summary>

- Verified both sides of the comparison: the set is seeded with metrics.sessionStartTime.substring(0,8) — an ISO 8601 timestamp prefix like "2026-07-" (EventAggregator sets sessionStartTime from event.timestamp, documented ISO 8601) — while p.sessionId is a real session UUID (CLI persistPlan uses metrics.sessionId = session file basename; VS Code uses summary.sessionId) or a word-based plan slug in the fallback reader. A date prefix with dashes at indices 4/7 can never equal a UUID's first 8 hex chars or a word slug, so the dedup 'continue' at line 91 is provably dead code, contradicting the explicit comments stating its intent. The suggested fix is sound since DashboardMetrics.sessionId exists and is populated via setSessionId.
- Verified both halves. (1) Dead comparison: sessionStartTime is an ISO-8601 event timestamp (EventAggregator.ts:346, sessionEvent.ts:75), so its 8-char prefix is always "YYYY-MM-", while PersistedPlan.sessionId is the session file basename (UUID / ses_* / rollout-*) written by persistPlan (dashboard.ts:128); no session-ID format can match an ISO date prefix, so the skip at PlansPanel.ts:91 is unreachable. (2) Duplicate is reachable: persistPlan writes the active plan on quit/SIGINT (dashboard.ts:527), session switch (293), and "Session ended" (313/588), and loadStaticData reads the same per-project store at startup (StaticDataLoader.ts:65); relaunching the dashboard and attaching/replaying the same session rebuilds metrics.plan, producing both the pinned active-plan row and an identical historical row.

</details>

**Verification:** `panels/phase3Regressions.test.ts` gives the active and persisted plan the same full session ID and verifies only the active row remains.

---

### P3-11 — TasksPanel sortKey is NaN for subagent and plan-step task IDs, breaking status sort

- **Location:** `sidekick-cli/src/dashboard/panels/TasksPanel.ts:39`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** DashboardState.getMetrics() synthesizes tasks with non-numeric IDs: subagent tasks use the tool_use_id (e.g. 'toolu_01AB...') and plan steps use 'plan-<id>'. parseInt on those returns NaN, so sortKey becomes NaN. Dashboard.tsx sorts with `items.sort((a, b) => a.sortKey - b.sortKey)`; a NaN-returning comparator produces implementation-defined ordering. Failure scenario: any session that spawns a subagent or enters plan mode -> those tasks land at arbitrary positions in the Tasks list instead of being grouped in_progress -> pending -> completed, and the order can jump between renders.

**Evidence.**

```ts
sortKey: (STATUS_SORT[t.status] ?? 3) * 1000 + parseInt(t.taskId, 10),
```

**Fix.** Guard the numeric part: `const n = parseInt(t.taskId, 10); sortKey: (STATUS_SORT[t.status] ?? 3) * 1000 + (Number.isNaN(n) ? 999 : n)` (or sort non-numeric IDs by insertion order).

<details><summary>Verifier notes</summary>

- Verified all three legs: TasksPanel.ts:39 computes sortKey with unguarded parseInt(t.taskId); DashboardState.getMetrics() synthesizes tasks with non-numeric IDs (raw toolu_ ids at line 549, plan-<id> at line 564, plus agent-<toolUseId> tracked tasks from EventAggregator.ts:1770); and Dashboard.tsx:229 sorts with a.sortKey - b.sortKey with no NaN sanitization anywhere in between. mergeTasks preserves IDs unchanged and no test covers this, so any session with a subagent or plan produces NaN sortKeys and those rows are not grouped by status.
- Traced the full data path: EventAggregator assigns non-numeric taskIds ('todo-N' at line 1633, tool_use_id 'toolu_...' for subagents at 1828), DashboardState.getMetrics synthesizes subagent tasks (line 549) and 'plan-<id>' tasks (line 564), and TasksPanel.ts:39 does parseInt on them yielding NaN, which flows into Dashboard.tsx:229's numeric sort. The defect is broader than claimed — even plain TodoWrite tasks get 'todo-N' IDs, so nearly all live tasks have NaN sortKeys, meaning the status grouping never applies. One detail is off: per the ES spec a NaN comparator return coerces to +0, so all-NaN keys give stable insertion order (no grouping) rather than chaos; only mixed numeric/NaN keys make the comparator inconsistent and implementation-defined, though visible order still shifts across renders as TodoWrite reinserts change Map insertion order.

</details>

**Verification:** `panels/phase3Regressions.test.ts` verifies non-numeric plan/tool task IDs receive finite keys and remain grouped by status.

---

### P3-12 — program.parse() with async actions: user-reachable errors crash with raw stack traces

- **Location:** `sidekick-cli/src/cli.ts:384`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** cli.ts calls `program.parse()` (not parseAsync), so the promise from every async action handler is dropped and any rejection becomes an unhandled promise rejection. Several handlers have no try/catch: capture.ts (taskAddAction/taskDoneAction/noteAddAction/decisionAddAction), handoff.ts externalHandoffAction, today.ts, dashboard.ts, doctor.ts, mcp.ts. Concrete repros: `sidekick tasks done <unknown-id>` — completeTask throws 'Task not found: …' (sidekick-shared/src/writers/tasks.ts:65) — and `sidekick handoff open` with no --url-template/env — renderHandoffUrlTemplate throws 'No handoff URL template is configured.' (sidekick-shared/src/handoffUrl.ts:14). Both print an ERR_UNHANDLED_REJECTION stack trace instead of a clean one-line error, unlike the catch-and-exit(1) pattern used by stats/tasks/notes.

**Evidence.**

```ts
program.parse();
```

**Fix.** Use `program.parseAsync().catch((err) => { process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });` as a global backstop, and/or wrap the uncaught handlers (capture.ts, externalHandoffAction, today.ts) in the same try/catch pattern as stats.ts.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `cliError.test.ts` verifies async action errors are rendered as one clean line; the CLI now uses `parseAsync()` with this global rejection backstop.

---

### P3-13 — dashboard: SIGINT/SIGTERM handlers prevent exit, leaving the TUI process hung

- **Location:** `sidekick-cli/src/commands/dashboard.ts:560`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** Registering `process.on('SIGINT'|'SIGTERM', cleanup)` suppresses Node's default terminate-on-signal behavior, and cleanup() neither unmounts the Ink instance nor calls process.exit. Ink keeps stdin in raw mode, so the event loop stays alive: `kill <pid>` (or SIGINT delivered from outside the raw-mode keypress path, e.g. tmux kill-session cleanup or a parent process signaling) runs cleanup and then the process hangs forever with the terminal left in the alternate screen. Only in-app Ctrl+C (Ink's exitOnCtrlC) reaches the `await instance.waitUntilExit(); cleanup(); process.exit(0);` path.

**Evidence.**

```ts
process.on('exit', disableMouse);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
```

**Fix.** Make the signal path terminate: `const onSignal = () => { cleanup(); instance.unmount(); process.exit(0); };` (instance.unmount() resolves waitUntilExit and restores the terminal; note the handlers are registered before `instance` exists today, so register them after render or guard the reference).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `commands/dashboardLifecycle.test.ts` verifies signal handling performs cleanup, unmounts Ink, and exits.

---

### P3-14 — TabBar click hitboxes drift 2 columns per tab, activating the wrong panel

- **Location:** `sidekick-cli/src/dashboard/ink/Dashboard.tsx:428`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** The hitbox math assumes each tab renders as "[N] Title" (key + title + 4), but TabBar actually renders `{p.shortcutKey} {p.title}` with marginRight=1, i.e. key + 1 space + title + 1 margin = key + title + 2 columns. Each tab's assumed width is 2 columns too large, so assumed start columns drift right by 2*i: with ~8 panels, tab 8's hitbox starts ~14 columns past its real position. Clicking the left portion of a later tab activates the previous panel, and clicks near the row's end miss entirely. The DetailTabBar mapping has the same family of bug: it starts at sideWidth+2 while the first tab starts at sideWidth+1, and inactive tabs are label+2 wide, not label+3.

**Evidence.**

```ts
// Each tab renders as "[N] Title" + marginRight=1 → key.length + title.length + 4
const tabWidth = String(panels[i].shortcutKey).length + panels[i].title.length + 4;
```

**Fix.** Use tabWidth = String(panels[i].shortcutKey).length + 1 + panels[i].title.length + 1 (content + margin) to match TabBar.tsx's actual render; for DetailTabBar start at col = sideWidth + 1 and use per-tab width (i === activeIndex ? label+2 : label+1) + 1 margin. Better: derive both widths from a single shared helper used by the renderer and the hit-test.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `ink/mouseHitTesting.test.ts` checks top and detail tab coordinates against the exact renderer widths, including active-tab markers.

---

### P3-15 — 'Context compacted' toast is skipped: alert scan window misses synthetic entries

- **Location:** `sidekick-cli/src/dashboard/ink/Dashboard.tsx:105`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** The alert effect assumes timeline entries and eventCount grow 1:1: it scans the last `eventCount delta` timeline entries. But DashboardState.processEvent injects synthetic compaction entries ({ type: 'summary', summary: 'Context compacted...' }) into _timeline *without* incrementing the aggregator's eventCount, then pushes the real event. So on a compaction, the timeline grows by 2 while eventCount grows by 1; startIdx = timeline.length - 1 points at the real event and the loop never sees the synthetic 'summary' entry at length-2. The compaction warning toast — the primary purpose of this scan — is systematically missed (it only fires by luck when later events in the same 100ms render batch shift it into the window).

**Evidence.**

```ts
const newCount = metrics.eventCount - lastAlertCountRef.current;
const startIdx = Math.max(0, metrics.timeline.length - newCount);
for (let i = startIdx; i < metrics.timeline.length; i++) {
  const e = metrics.timeline[i];
  if (e.type === 'summary') {
    addToast(e.summary || 'Context compacted', 'warning');
```

**Fix.** Track timeline consumption directly instead of via eventCount: keep a ref of the last-processed timeline entry count (DashboardState could expose a monotonically increasing totalTimelineAppends counter that survives the ring-buffer shift), and scan `timeline.length - (totalAppends - lastSeenAppends)` … or simplest, have DashboardState emit alert events explicitly rather than the UI diffing the ring buffer.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `DashboardState.test.ts` proves one compaction plus one real event increments the timeline append cursor by three; `timelineAlerts.test.ts` verifies both new entries are scanned.

---

### P3-16 — SideList overflows its box when scrolled: last row and ▼ indicator are clipped

- **Location:** `sidekick-cli/src/dashboard/ink/Dashboard.tsx:242`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** sideViewportHeight = rows - 5 accounts for tab bar (1), status bar (1), border (2), and title (1), which exactly fills the bordered box's rows-4 inner height with title + items. But SideList additionally renders a '▲' row when scrollOffset > 0 and a '▼' row when more items exist below, without reducing the item slice. When scrolled mid-list, content needs up to rows-2 rows in a rows-4 box; with overflow="hidden" the bottom 1-2 rows are clipped: the last visible item row disappears (though it is selectable — pressing j moves the selection marker off-screen) and the ▼ 'more below' indicator can never be seen. DetailPane explicitly reserves indicator space (effectiveHeight); SideList does not.

**Evidence.**

```ts
const sideViewportHeight = Math.max(1, rows - 5); // tab bar + borders + status bar
... (SideList.tsx renders label row + {hasMoreAbove && <Text>▲</Text>} + items.slice(scrollOffset, scrollOffset + viewportHeight) + {hasMoreBelow && <Text>▼</Text>} inside the same border)
```

**Fix.** Mirror DetailPane's approach in SideList: compute effectiveHeight = viewportHeight - (hasMoreAbove ? 1 : 0) - (worst-case hasMoreBelow ? 1 : 0) and slice that many items, keeping the useWindowedScroll viewportHeight in sync so ensureVisible math matches what is actually drawn (also update the click mapping in handleMouse for the reduced window).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `ink/mouseHitTesting.test.ts` verifies two indicator rows are reserved whenever the side list needs scrolling.

---

### P3-17 — Mouse capture is torn down and re-enabled on every render (up to 10x/sec)

- **Location:** `sidekick-cli/src/dashboard/ink/mouse/MouseProvider.tsx:55`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** MouseProvider's effect depends on `onMouse`. Dashboard's handleMouse useCallback depends on `sideScroll`, and useWindowedScroll returns a brand-new object literal every render, so handleMouse gets a new identity on every render. dashboard.ts rerenders on a 100ms throttle during active sessions, so ~10x/second the effect cleanup+setup runs: stdin listener removed/re-added, `process.on('exit')` churned, and 6 escape sequences written to stdout (disableMouse's 3 + enableMouse's 3), interleaved with Ink's frame output. This is continuous wasted syscall/IO traffic for the entire dashboard lifetime and makes the mouse-mode toggling race-prone on slow terminals.

**Evidence.**

```ts
process.stdin.on('data', handler);
...
return () => {
  process.stdin.removeListener('data', handler);
  process.removeListener('exit', exitHandler);
  disableMouse();
};
}, [enabled, onMouse]);
```

**Fix.** In MouseProvider, hold the callback in a ref (const onMouseRef = useRef(onMouse); onMouseRef.current = onMouse;) and invoke onMouseRef.current(event) from a stable handler with effect deps [enabled] only. Additionally/alternatively, memoize the object returned by useWindowedScroll with useMemo so consumers' deps stay stable.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `mouse/mouseDataHandler.test.ts` verifies a stable handler dispatches through the latest callback ref; the subscription effect now depends only on `enabled`.

---

### P3-18 — CliInferenceClient: stdin write has no error handler — EPIPE can crash the dashboard

- **Location:** `sidekick-cli/src/inference/CliInferenceClient.ts:241`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** spawnWithStdin writes the (potentially large) prompt to proc.stdin with no 'error' listener on the stdin stream and no write callback. If the spawned `claude --print` / `codex exec` process exits before consuming stdin (not logged in, immediate usage error) or fails to spawn, the pipe write emits EPIPE/ERR_STREAM_DESTROYED on the stdin Writable; with no listener that becomes an uncaught exception that kills the whole TUI mid-session. The proc-level 'error' handler (line 236) does not cover stream errors. Additionally the 60s timeout calls proc.kill() (SIGTERM only) with no SIGKILL escalation, so a wedged child can linger.

**Evidence.**

```ts
proc.stdin.write(prompt);
    proc.stdin.end();
```

**Fix.** Attach `proc.stdin.on('error', () => {})` (or pass a callback to write/end and resolve with an error result), and escalate the timeout kill: after `proc.kill()`, `setTimeout(() => proc.kill('SIGKILL'), 5_000).unref()`.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `inference/CliInferenceClient.test.ts` verifies stdin EPIPE settles as an error and a timed-out child escalates from SIGTERM to SIGKILL.

---

### P3-19 — fitText truncation counts invisible tag/ANSI chars, breaking boxed mind map borders

- **Location:** `sidekick-cli/src/dashboard/MindMapBuilder.ts:734`
- **Severity / category:** ⚪ low · ux
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** fitText pads by visible length (correct) but truncates by raw string length. Section headers always contain color markup (e.g. `⚙ {green-fg}TOOLS{/green-fg} ─── 8 types, 120 total calls`), so on narrow terminals where the header exceeds the inner width, `text.substring(0, width - 3)` spends most of the budget on the invisible `{green-fg}` characters: the rendered line is visibly shorter than the box width (right border `│` shifts left) and a tag can be cut mid-token (`{green-f...`), which blessed renders literally.

**Evidence.**

```ts
function fitText(text: string, width: number): string {
  const vLen = visibleLength(text);
  if (vLen <= width) return text + ' '.repeat(width - vLen);
  // Truncate plain text (no tags) by visible length
  return text.substring(0, width - 3) + '...';
}
```

**Fix.** Reuse the tag-aware truncateTagged() from this same file (extended to also skip ANSI escapes) for the overflow branch, then pad the result to `width` by visible length.

<details><summary>Verifier notes</summary>

- Verified fitText (MindMapBuilder.ts:730-735) truncates its overflow branch by raw string length while padding by visibleLength, and every boxed section header (line 1118) is wrapped in color markup — blessed tags in the sole production caller (SessionsPanel.ts:617, blessedTags: true). Overflow is reachable: inner width caps at 44, the TOOLS header overflows under ~50-column terminals, and the PLAN header with a long plan title (line 943) can overflow even at default 80-column width; when it does, ~23 invisible tag chars consume the budget, shortening the rendered line so the right border misaligns and a tag can be cut mid-token, which blessed renders literally. The tag-aware truncateTagged helper (line 656) exists unused in this path, so the suggested fix is small, local, and low-risk.

</details>

**Verification:** `dashboard/MindMapBuilder.test.ts` verifies tagged and ANSI strings truncate to the requested visible width without cutting markup.

---

### P3-20 — Session label built from ISO timestamp prefix renders as 'session-2026-07-'

- **Location:** `sidekick-cli/src/dashboard/panels/SessionsPanel.ts:113`
- **Severity / category:** ⚪ low · ux
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** metrics.sessionStartTime is an ISO timestamp, so substring(0, 8) always yields 'YYYY-MM-' with a trailing dash — the side-list shows 'session-2026-07-' for every active session, which looks broken and is identical for all sessions in a month. MindMapBuilder does the same at lines 87 and 1055 ('SESSION [2026-07-] — claude-code'), even though DashboardMetrics.sessionId (the real session UUID, set via setSessionId in commands/dashboard.ts) is available on the same metrics object.

**Evidence.**

```ts
const sessionId = (metrics.sessionStartTime || 'active').substring(0, 8);
```

**Fix.** Prefer the real ID: `const sessionId = (metrics.sessionId || metrics.sessionStartTime || 'active').substring(0, 8);` and mirror the change in MindMapBuilder's two session-header sites.

<details><summary>Verifier notes</summary>

- Verified SessionsPanel.ts:113 and MindMapBuilder.ts:87/1055 use (metrics.sessionStartTime || ...).substring(0, 8); sessionStartTime is an ISO 8601 string (set from event.timestamp in EventAggregator, documented ISO in sessionEvent.ts), so the label always renders as 'session-2026-07-'. DashboardMetrics.sessionId exists (DashboardState.ts:179, populated at :635) and is set via state.setSessionId in commands/dashboard.ts:570/615, so the suggested one-line fix with fallback is accurate and near-zero risk. User-visible cosmetic defect in the main session list and mind-map headers; related PlansPanel.ts:80-91 dedup comparing sessionStartTime prefix to sessionId prefix corroborates sessionId was the intended value.

</details>

**Verification:** SessionsPanel and MindMapBuilder tests verify the real `sessionId` is preferred in active, tree, and boxed headers.

---

### P3-21 — taskMerger: live task overwrite drops persisted createdAt/sessionOrigin

- **Location:** `sidekick-cli/src/dashboard/utils/taskMerger.ts:36`
- **Severity / category:** ⚪ low · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** Live TaskItems built in DashboardState.getMetrics never carry createdAt or sessionOrigin (those fields are only populated on the persisted branch), and the live pass replaces the whole persisted object. Failure scenario: a task exists in tasks/{projectSlug}.json with createdAt and is also active in the live session -> after merge its data has no timestamp fields -> itemTimestampMs returns null -> the Tasks/Kanban Date filter's null-timestamp guard excludes the task even when its known createdAt is inside the filter range.

**Evidence.**

```ts
for (const t of live) {
    map.set(t.taskId, t);
  }
```

**Fix.** Merge instead of replace when a persisted entry exists: `const prev = map.get(t.taskId); map.set(t.taskId, { ...t, createdAt: t.createdAt ?? prev?.createdAt, sessionOrigin: t.sessionOrigin ?? prev?.sessionOrigin });`

<details><summary>Verifier notes</summary>

- Verified every link: live TaskItems built in DashboardState.getMetrics (lines 529-584) never set createdAt/sessionOrigin (the aggregator's TrackedTask.createdAt is dropped in the mapping), mergeTasks' live pass replaces the persisted object wholesale, TasksPanel has no getItemTimestamp so Dashboard.tsx:195-198 falls back to itemTimestampMs(it.data) and excludes null-timestamp items. So a persisted task with an in-range createdAt vanishes from the Tasks panel Date filter once it is also live; no guard elsewhere prevents it and the dateFilterTimestamp regression tests don't cover this panel.
- Traced the full chain: live TaskItems built in DashboardState.getMetrics (lines 532-582) never set createdAt/sessionOrigin (though TrackedTask.createdAt exists upstream), mergeTasks (taskMerger.ts:36) replaces persisted entries wholesale, TasksPanel exposes the merged TaskItem as item.data with no getItemTimestamp, and Dashboard.tsx:194-198's date filter excludes null-timestamp items. Overlap between live and persisted taskIds is the merge's designed common case — TaskPersistenceService persists under the same TodoWrite ids ("1","2","3"), so any project with a non-empty persisted store plus an active session collides. The scenario is reachable with the standard extension+CLI setup and the severity (low) is right.

</details>

**Verification:** `panels/phase3Regressions.test.ts` verifies a live task override retains persisted `createdAt` and `sessionOrigin`.

---

### P3-22 — dashboard: original session provider leaks when picker switches providers

- **Location:** `sidekick-cli/src/commands/dashboard.ts:190`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** When the session picker returns a session owned by a different provider, activeProvider is replaced with a freshly constructed provider. The subsequent cleanup loop only disposes additionalProviders (`if (p !== activeProvider) p.dispose()`) and the final cleanup() disposes only activeProvider — the original `provider` from resolveProvider() is never disposed. For OpenCodeProvider that means an open sqlite handle/subprocess held for the entire (long-running) dashboard session.

**Evidence.**

```ts
if (result.providerId && result.providerId !== provider.id) {
            activeProvider = createProviderById(result.providerId);
          }
```

**Fix.** After the picker resolves, dispose the unused original: `if (activeProvider !== provider) { try { provider.dispose(); } catch {} }` (and prefer reusing the matching instance already present in additionalProviders instead of constructing a new one).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `commands/dashboardLifecycle.test.ts` verifies provider switching reuses the matching picker provider and disposes the original.

---

### P3-23 — Timeline auto-scroll-to-bottom depends on the previous tab's line count

- **Location:** `sidekick-cli/src/dashboard/ink/Dashboard.tsx:291`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** prevDetailLineCountRef is a single ref shared across all items and tabs and is never reset on item/tab switches. Opening an autoScrollBottom tab (Timeline) only scrolls to the bottom if its line count exceeds whatever content was previously displayed. Scenario: user views a 400-line detail tab (ref=400), then selects a session's Timeline tab with 200 lines -> 200 > 400 is false, so the Timeline opens pinned to the top showing the oldest events, and stays there until 200+ new lines accumulate.

**Evidence.**

```ts
// Only auto-scroll when new content arrives (line count increased)
if (detailLines.length > prevDetailLineCountRef.current) {
  const bottomOffset = detailLines.length - detailViewportHeight;
  dispatch({ type: 'SCROLL_DETAIL', offset: bottomOffset });
}
prevDetailLineCountRef.current = detailLines.length;
```

**Fix.** Key the ref to the content identity: reset prevDetailLineCountRef.current to 0 whenever selectedItem?.id or tabIdx changes (e.g. track a lastContentKeyRef and compare), so the first render of an autoScrollBottom tab always jumps to the bottom.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `ink/detailScroll.test.ts` verifies switching from a longer detail tab to a shorter Timeline still requests initial bottom scrolling.

---

### P3-24 — StatusBar totalCount calls panel.getItems a second time on every render

- **Location:** `sidekick-cli/src/dashboard/ink/Dashboard.tsx:619`
- **Severity / category:** ⚪ low · perf
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** Each render already calls panel.getItems(metrics, staticData) inside getFilteredItems (line 168); the StatusBar totalCount prop invokes it again, doubling the panel item-building work (label formatting, data mapping across the whole timeline/task/session collections) on every render. With the 100ms rerender throttle during active sessions this runs up to ~20 getItems calls per second on the hottest path in the UI.

**Evidence.**

```ts
matchCount={currentItems.length}
totalCount={panel.getItems(metrics, staticData).length}
```

**Fix.** Compute the raw list once per render (const allItems = panel.getItems(metrics, staticData)), pass it into the filtering logic, and use allItems.length for totalCount — or return { items, totalCount } from getFilteredItems.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `ink/panelItems.test.ts` verifies the raw panel list is built once while preserving separate filtered and total counts.

---

### P3-25 — parseMouseEvent handles only the first SGR sequence per stdin chunk

- **Location:** `sidekick-cli/src/dashboard/ink/mouse/parseMouseEvent.ts:26`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** Fast wheel scrolling and drags make terminals emit many SGR sequences that Node frequently coalesces into a single stdin 'data' chunk (e.g. '\x1b[<64;10;5M\x1b[<64;10;5M\x1b[<64;10;5M'). The non-global regex exec returns only the first match, and MouseProvider calls onMouse once per chunk, so the remaining events in the chunk are silently dropped — scrolling advances 1 step where the user scrolled 3+, making wheel scrolling feel laggy/inconsistent under fast input.

**Evidence.**

```ts
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
...
const match = SGR_MOUSE_RE.exec(str);
if (!match) return null;
```

**Fix.** Add a parseMouseEvents(data): TerminalMouseEvent[] that iterates str.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g) and returns every event; have MouseProvider's data handler dispatch each parsed event (keeping the single-event function for backward compatibility if needed).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `mouse/parseMouseEvent.test.ts` feeds three SGR sequences in one chunk and verifies all three events are returned.

---

### P3-26 — Unmatched close tags pop wrong style frame; search highlight strips label color

- **Location:** `sidekick-cli/src/dashboard/ink/parseBlessedTags.tsx:60`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** Open tags the parser doesn't support (e.g. {blue-bg}) push nothing, but their close tags ({/blue-bg}) still pop the top frame, unbalancing the stack. SideList.applySearchHighlight wraps matches in '{blue-bg}{white-fg}$1{/white-fg}{/blue-bg}'. For a colored label like '{cyan-fg}foo bar baz{/cyan-fg}' with filter 'bar': {blue-bg} is ignored, {/blue-bg} pops the cyan frame, so ' baz' renders unstyled, and the final {/cyan-fg} pops nothing. Net effect: everything after a highlight loses its color, and since -bg is ignored the 'highlight' itself renders as plain white text with no background — barely visible.

**Evidence.**

```ts
if (isClose) {
  // Pop the most recent matching frame
  if (styleStack.length > 1) {
    styleStack.pop();
  }
} ... // Other tags (e.g. {white-bg}) are silently ignored
```

**Fix.** Keep the stack balanced: for any unrecognized open tag push a copy of the current frame (no-op frame) so its close pops correctly; and implement -bg tags by mapping them to Ink's backgroundColor prop so search highlighting actually renders a background.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `ink/parseBlessedTags.test.tsx` verifies background highlighting renders and both unsupported and unmatched closes preserve the surrounding foreground style.

---

### P3-27 — useWindowedScroll never re-clamps scrollOffset when the list shrinks or resizes

- **Location:** `sidekick-cli/src/dashboard/ink/useWindowedScroll.ts:41`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** The clamp effect only adjusts selectedIndex on totalItems change (and only resets scrollOffset when totalItems hits 0); scrollOffset keeps its old value when the list shrinks, and viewportHeight is not in the deps at all. Scenario: 100 items, selection ~60 (offset ~50); a live update or filter shrinks the list to 30 -> SideList renders items.slice(50, ...) = an empty pane with a stale ▲ indicator until the next selection change syncs it. Similarly, enlarging the terminal leaves a stale offset showing a partial window with a spurious ▲.

**Evidence.**

```ts
useEffect(() => {
  if (totalItems === 0) {
    setSelectedIndex(0);
    setScrollOffset(0);
    return;
  }
  setSelectedIndex((prev) => Math.min(prev, totalItems - 1));
}, [totalItems]);
```

**Fix.** In the same effect, also clamp the offset: setScrollOffset((prev) => Math.max(0, Math.min(prev, totalItems - viewportHeight))) and add viewportHeight to the dependency array so terminal resizes re-clamp too.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `ink/useWindowedScroll.test.ts` verifies stale offsets re-clamp when the list shrinks, empties, or the viewport grows.

---

### P3-28 — clipboard copy always fails on native Windows — clip.exe only tried under WSL

- **Location:** `sidekick-cli/src/utils/clipboard.ts:34`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** nativeCopy builds its candidate list with a darwin branch and a WSL branch, but no `platform() === 'win32'` branch, so on native Windows it only tries xclip/xsel (absent) and then osc52Copy opens '/dev/tty', which does not exist on Windows and throws. Result: every copy from `sidekick extract -i` (Enter/^Y on a path/command) prints 'Could not copy to clipboard.' even though clip.exe ships with Windows.

**Evidence.**

```ts
if (platform() === 'darwin') attempts.push(['pbcopy', []]);
  else if (isWSL()) attempts.push(['clip.exe', []]);
  if (process.env.WAYLAND_DISPLAY) attempts.push(['wl-copy', []]);
  attempts.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['-ib']]);
```

**Fix.** Add `else if (platform() === 'win32') attempts.push(['clip.exe', []]);` (clip.exe reads stdin, which spawnSync's `input` already provides), and guard osc52Copy to skip the '/dev/tty' path on win32.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `utils/clipboard.test.ts` verifies native Windows selects only `clip.exe` while retaining WSL and Wayland fallbacks.

---
