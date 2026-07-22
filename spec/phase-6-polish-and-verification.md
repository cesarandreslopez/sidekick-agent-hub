# Phase 6 — Polish & Remaining Verification

> Part of the [Sidekick Agent Hub review backlog](./README.md). Read the README first for methodology, trust levels, conventions, and the working loop.

**Goal.** Low-severity papercuts and the tail of findings whose adversarial verifiers never ran. Verify each against current code before touching it (or fold into whichever earlier phase touches the same file).

**This phase:** 12 findings — 0 high, 0 medium, 12 low.

## Progress tracker

Update the Status box as you go: `[ ]` todo → `[~]` in progress → `[x]` done (or `[-]` if dropped after re-verification). Keep the one-line note current.

| ID    | Sev | Trust | Location                                  | Finding                                                                                              | Status |
| ----- | --- | ----- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------ |
| P6-01 | ⚪  | ✅    | `src/extension.ts:2671`                   | Explain-code progress notification closes instantly and its Cancel is a no-op                        | `[x]`  |
| P6-02 | ⚪  | 🟡    | `commands/quota.ts:448`                   | quota --tier option is parsed and documented but never used                                          | `[x]`  |
| P6-03 | ⚪  | 🟡    | `commands/quota.ts:242`                   | quota exit codes inconsistent: Claude text-mode failure exits 1, JSON and Codex/z.ai failures exit 0 | `[x]`  |
| P6-04 | ⚪  | 🟡    | `commands/search.ts:56`                   | search/decisions --limit accepts garbage: parseInt NaN silently disables the limit                   | `[x]`  |
| P6-05 | ⚪  | 🟡    | `providers/PlanBoardViewProvider.ts:126`  | Plan board Refresh never re-reads ~/.claude/plans; new plan files invisible until reload             | `[x]`  |
| P6-06 | ⚪  | 🟡    | `services/CrossSessionSearch.ts:59`       | Cross-session search spinner sticks on forever when query drops below 3 chars                        | `[x]`  |
| P6-07 | ⚪  | 🟡    | `services/ErrorExplanationService.ts:166` | generateFix discards any fix whose code contains the word 'cannot'                                   | `[x]`  |
| P6-08 | ⚪  | 🟡    | `services/MonitorStatusBar.ts:158`        | MonitorStatusBar throttle drops the trailing update, leaving stale totals on screen                  | `[x]`  |
| P6-09 | ⚪  | ⚠️    | `parsers/sessionPathResolver.ts:389`      | findAllSessions drops every session if one file vanishes between readdir and stat                    | `[x]`  |
| P6-10 | ⚪  | ⚠️    | `providers/claudeCode.ts:130`             | Incremental readers decode byte chunks independently, corrupting multi-byte UTF-8 at boundaries      | `[x]`  |
| P6-11 | ⚪  | ⚠️    | `watchers/factory.ts:39`                  | Watcher factory matches session IDs by substring, can attach to the wrong session                    | `[x]`  |
| P6-12 | ⚪  | ⚠️    | `watchers/jsonlTail.ts:138`               | jsonlTail reports offsets that can point mid-line, dropping an event on resume                       | `[x]`  |

---

## Findings

### P6-01 — Explain-code progress notification closes instantly and its Cancel is a no-op

- **Location:** `sidekick-vscode/src/extension.ts:2671`
- **Severity / category:** ⚪ low · ux
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** explainCodeWithComplexity wraps showExplanation in withProgress({ cancellable: true }) but neither awaits/returns the showExplanation promise nor uses the cancellation token (`_progress, _token` both unused). The async callback returns immediately, so the 'Generating explanation...' notification flashes and disappears while the AI request is still running, and clicking Cancel during the flash aborts nothing. Users get no progress feedback for the (potentially 30s+) explanation generation, unlike every other command in the file which awaits its service call and wires the token to an AbortController.

**Evidence.**

```ts
await vscode.window.withProgress(
  {
    location: vscode.ProgressLocation.Notification,
    title: 'Generating explanation...',
    cancellable: true,
  },
  async (_progress, _token) => {
    explainProvider!.showExplanation(selectedText, complexity, { fileName, languageId });
  },
);
```

**Fix.** Return/await the showExplanation promise inside the withProgress callback and wire the token to an AbortController passed through to ExplanationService (mirroring the sidekick.generateDocs command), or drop the misleading withProgress wrapper if the explain panel provides its own loading state.

<details><summary>Verifier notes</summary>

- Verified extension.ts:2664-2673: the withProgress callback fires showExplanation without awaiting anything and ignores the token, so the notification flashes instantly and Cancel is a no-op — that part is accurate, and sibling explainErrorWithComplexity (line 2727-2729) does wire the token properly. However, the "no progress feedback" claim is wrong: showExplanation opens a webview panel with its own spinner and "Generating explanation..." text (src/webview/explain.ts:390-392), and the primary suggested fix is infeasible since showExplanation is synchronous void with the AI request driven from the webview message loop, not the command. The proposal's alternative fix (drop the misleading withProgress wrapper) is correct, trivial, and worth doing.

</details>

**Verification:** source review confirms the command now opens the explanation webview directly, whose own loading UI tracks the request; the extension compile and full command/provider suite pass.

---

### P6-02 — quota --tier option is parsed and documented but never used

- **Location:** `sidekick-cli/src/commands/quota.ts:448`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** cli.ts registers `zaiTierOption()` on the quota command (`--tier <id>` with choices lite/pro/max/auto, default auto), but the only consumer, fetchZaiQuotaPayload, receives the options as `_localOpts` and ignores them — `resolveZaiQuota()` is called with no arguments, and ZaiQuotaResolveOptions (sidekick-shared/src/zaiQuotaApi.ts:363) has no tier field at all; planType is derived from the API response. `sidekick quota --provider zai --tier max` silently behaves identically to `--tier auto`, so the flag is dead surface area that misleads users into thinking they can override plan detection.

**Evidence.**

```ts
async function fetchZaiQuotaPayload(_localOpts: Record<string, unknown>): Promise<{
  quota: Awaited<ReturnType<typeof resolveZaiQuota>>;
  detected: boolean;
}> {
  const [quota, detected] = await Promise.all([resolveZaiQuota(), detectZaiRouting()]);
```

**Fix.** Either remove `zaiTierOption()` from the quota command (and options.ts if unused elsewhere), or plumb `localOpts.tier` through a real resolveZaiQuota option; at minimum warn when a non-auto tier is passed and ignored.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** the option factory, command registration, and obsolete option tests are removed; the built `sidekick quota --help` smoke output contains no `--tier` while z.ai quota tests pass.

---

### P6-03 — quota exit codes inconsistent: Claude text-mode failure exits 1, JSON and Codex/z.ai failures exit 0

- **Location:** `sidekick-cli/src/commands/quota.ts:242`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** When Claude quota is unavailable, text mode calls process.exit(1) but the `--json` branch returns with exit 0; codexQuotaAction and zaiQuotaAction return exit 0 for unavailable in both modes ('OpenCode does not provide rate-limit data' also exits 0 in text mode while writing only to stderr). Scripts checking `sidekick quota --json`'s exit status cannot distinguish success from no-credentials/network failure, and behavior differs by provider for the same condition.

**Evidence.**

```ts
if (!quota.available) {
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ ...quota, peak }, null, 2) + '\n');
    return;
  }
  printClaudeQuotaError(quota);
  process.exit(1);
}
```

**Fix.** Pick one contract and apply it to all providers, e.g. set `process.exitCode = 1` whenever `quota.available === false` (JSON payload still emitted on stdout), so both output modes and all providers signal failure identically.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `commands/quota.test.ts` proves unavailable Claude JSON, Claude text, Codex JSON, z.ai text, and partial `--all` results set exit code 1 without suppressing structured/useful output.

---

### P6-04 — search/decisions --limit accepts garbage: parseInt NaN silently disables the limit

- **Location:** `sidekick-cli/src/commands/search.ts:56`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** `--limit abc` (or `--limit 0x`, `12abc` partially parsing) produces NaN, which is passed as maxResults to searchSessions; NaN comparisons are always false so the cap is silently disabled and the command can dump unbounded results. decisions.ts:65 has the same unvalidated `parseInt(opts.limit)`. extract.ts already solves this correctly with parseLimit() rejecting non `[1-9]\d*` input.

**Evidence.**

```ts
const limit: number = opts.limit ? parseInt(opts.limit as string, 10) : 50;
```

**Fix.** Reuse extract.ts's parseLimit() (move it to a shared util) for search's and decisions' `--limit`, or use commander's argParser with validation so bad values fail at parse time like the choice-validated options.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `utils/parseLimit.test.ts` rejects alphabetic, partially numeric, hexadecimal, zero, negative, and decimal inputs; extract/search/decisions now share that parser.

---

### P6-05 — Plan board Refresh never re-reads ~/.claude/plans; new plan files invisible until reload

- **Location:** `sidekick-vscode/src/providers/PlanBoardViewProvider.ts:126`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** \_loadClaudeCodePlans() (readClaudeCodePlanFiles) runs exactly once, in the constructor. The webview's Refresh button posts 'refresh', whose handler only calls \_syncFromSessionMonitor() + \_sendStateToWebview(), which merges the stale cached this.\_claudeCodePlans array. Any plan file Claude Code writes after extension activation never appears in the History section — even after clicking Refresh — until the VS Code window is reloaded. Users pressing Refresh to see their just-finished plan get silently stale data.

**Evidence.**

```ts
case 'refresh':
        this._syncFromSessionMonitor();
        this._sendStateToWebview();
        break;  // _loadClaudeCodePlans() is only invoked once in the constructor (line 73)
```

**Fix.** Make the 'refresh' case call this.\_loadClaudeCodePlans() (which already re-syncs and re-sends on completion) instead of, or before, the synchronous sync; optionally also re-run it on onSessionEnd so completed plans appear automatically.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `PlanBoardViewProvider.test.ts` completes the initial read, sends a webview refresh, and proves a second disk read publishes the newly discovered plan; generation ordering prevents stale reads from winning.

---

### P6-06 — Cross-session search spinner sticks on forever when query drops below 3 chars

- **Location:** `sidekick-vscode/src/services/CrossSessionSearch.ts:59`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** onDidChangeValue sets quickPick.busy=true BEFORE scheduling the 300ms debounce timer, but the short-query branch clears the pending timer and returns without resetting busy. Failure scenario: type 'abcd' (busy=true, timer armed), then backspace to 'ab' within 300ms -> timer is cleared so the only code path that sets busy=false never runs -> the QuickPick shows a perpetual progress indicator for the rest of the search session. The pending timer is also never cleared in onDidHide, so a late callback mutates a disposed QuickPick.

**Evidence.**

```ts
if (query.length < 3) {
  quickPick.items = [];
  return;
}
quickPick.busy = true;
```

**Fix.** Set `quickPick.busy = false` in the short-query branch (and clear searchTimer in the onDidHide handler before disposing). Optionally move `quickPick.busy = true` inside the setTimeout callback so busy only shows while a search actually runs.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `CrossSessionSearch.test.ts` types a long query then shortens it before debounce, proving busy clears and no search runs; hiding the picker also cancels pending work.

---

### P6-07 — generateFix discards any fix whose code contains the word 'cannot'

- **Location:** `sidekick-vscode/src/services/ErrorExplanationService.ts:166`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** The refusal heuristic runs substring checks over the ENTIRE lowercased response, which is supposed to be the fixed code itself. Failure scenario: the fix legitimately contains 'cannot' or 'unable to' in a string literal, comment, or error message (e.g. fixing `throw new Error('Cannot read properties of undefined')`, an extremely common JS error-handling pattern) -> generateFix returns null -> the user is told no fix is available even though a valid fix was generated and paid for.

**Evidence.**

```ts
if (
  lowerResponse.includes('cannot') ||
  lowerResponse.includes('unable to') ||
  lowerResponse.includes('need more context')
) {
  return null;
}
```

**Fix.** Only treat the response as a refusal when it does not look like code: e.g. check the first line/sentence for refusal phrasing (`/^(i\s+)?(cannot|can't|unable to)/i` on the trimmed response) or require that the response contains no code fence/newline structure before classifying it as a refusal.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `fixResponse.test.ts` recognizes leading natural-language refusals while accepting code/comments containing `cannot` or `unable to`.

---

### P6-08 — MonitorStatusBar throttle drops the trailing update, leaving stale totals on screen

- **Location:** `sidekick-vscode/src/services/MonitorStatusBar.ts:158`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** handleTokenUsage updates internal counters via syncFromMonitor on every event but throttles updateDisplay with a leading-edge-only gate and no trailing timer. Failure scenario: a burst of token-usage events arrives within 500ms and then the agent goes idle (the common end-of-response pattern) -> the first event renders, the rest are skipped, and no final render is scheduled -> the status bar shows the token/context numbers from the START of the burst until the next unrelated event, so the displayed session totals are persistently stale exactly when the user looks at them.

**Evidence.**

```ts
const now = Date.now();
if (now - this.lastUpdateTime < this.UPDATE_THROTTLE_MS) {
  return;
}
this.lastUpdateTime = now;

this.updateDisplay();
```

**Fix.** When throttled, schedule a trailing render instead of returning: `if (!this.pendingRender) this.pendingRender = setTimeout(() => { this.pendingRender = undefined; this.updateDisplay(); }, this.UPDATE_THROTTLE_MS);` and clear the timer in dispose().

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `MonitorStatusBar.test.ts` emits two token updates in one throttle window and proves the trailing timer renders the newest total; lifecycle paths clear the timer.

---

### P6-09 — findAllSessions drops every session if one file vanishes between readdir and stat

- **Location:** `sidekick-shared/src/parsers/sessionPathResolver.ts:389`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** Unlike findSessionsInDirectory (lines 582-595) which wraps its per-file statSync in try/catch and filters nulls, findAllSessions calls fs.statSync inside .map() with no per-file guard. If a single .jsonl is deleted between readdirSync and statSync (session cleanup, temp workspace teardown), the throw is caught by the outer catch and the function returns [] — all sessions for the workspace disappear from history views for that refresh instead of just the vanished file being skipped.

**Evidence.**

```ts
.map((file) => {
        const fullPath = path.join(sessionDir, file);
        const stats = fs.statSync(fullPath);
        return {
          path: fullPath,
          mtime: stats.mtime.getTime(),
        };
      })
```

**Fix.** Mirror findSessionsInDirectory: wrap the statSync in try/catch returning null and filter out nulls before sorting.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `sessionPathResolver.test.ts` injects an ENOENT for one listed JSONL file and proves the readable sibling remains in results.

---

### P6-10 — Incremental readers decode byte chunks independently, corrupting multi-byte UTF-8 at boundaries

- **Location:** `sidekick-shared/src/providers/claudeCode.ts:130`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** ClaudeCodeReader.readNew() (and CodexReader.readNew() at providers/codex.ts:467) reads the byte range [filePosition, currentSize) and calls buffer.toString('utf-8') on it in isolation. If a poll boundary lands mid-way through a multi-byte UTF-8 sequence (emoji/CJK in assistant text, written across multiple write() calls), the trailing partial bytes decode to U+FFFD and the leading continuation bytes of the next chunk decode to U+FFFD as well — the reassembled JSONL line parses fine but the message text shown in dashboards contains replacement characters. readSync's return value is also ignored, so a short read would decode trailing NUL bytes.

**Evidence.**

```ts
fs.readSync(fd, buffer, 0, bufferSize, this.filePosition);
fs.closeSync(fd);

const chunk = buffer.toString('utf-8');
```

**Fix.** Keep a persistent string_decoder.StringDecoder per reader and feed it the raw Buffer (decoder.write(buffer)) so partial sequences carry across chunks; also use the bytesRead return value to bound the decode.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `utf8Readers.test.ts` splits a four-byte emoji across two filesystem reads for both Claude and Codex readers and proves the reconstructed event/metadata contains the original character with no replacement glyph.

---

### P6-11 — Watcher factory matches session IDs by substring, can attach to the wrong session

- **Location:** `sidekick-shared/src/watchers/factory.ts:39`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** createWatcher resolves a requested sessionId with `sessions.find((s) => s.includes(sessionId))` over full file paths. A short or partial id (a user pasting the first 8 chars of a UUID, or an id like '2026' that also appears in a directory name or another session's filename) silently matches the first path containing that substring in mtime order, so the CLI follows/replays a different session than asked with no warning.

**Evidence.**

```ts
const match = sessions.find((s) => s.includes(sessionId));
```

**Fix.** Match against `path.basename(s, ext)` with equality or startsWith, and error on ambiguity (more than one candidate) listing the matches, mirroring the existing not-found error.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `watchers/factory.test.ts` proves directory substrings do not match, a unique ID prefix resolves, and an ambiguous prefix throws with candidate IDs.

---

### P6-12 — jsonlTail reports offsets that can point mid-line, dropping an event on resume

- **Location:** `sidekick-shared/src/watchers/jsonlTail.ts:138`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** readNow advances `this.offset` by all bytes read even when the chunk ends in a partial JSONL line; the fragment stays in JsonlParser's internal buffer. getOffset() and the onBatchComplete `offset` therefore point into the middle of a line whenever a writer is mid-append. A consumer persisting that offset (the documented use of onBatchComplete/startOffset in this public npm API) and later resuming via `startOffset` makes the parser see only the tail half of that line: parseLine drops it (`!trimmed.startsWith('{')`) or errors, so the event spanning the boundary is silently lost. seekTo has the same hazard.

**Evidence.**

```ts
this.offset += bytesRead;
this.eventsInCurrentBatch = 0;
this.parser.processChunk(buffer.toString('utf-8', 0, bytesRead));
this.options.onBatchComplete?.({
  bytesRead,
  eventsRead: this.eventsInCurrentBatch,
  offset: this.offset,
});
```

**Fix.** Track a 'committed' offset that excludes the parser's buffered remainder (offset - Buffer.byteLength(parserBuffer)) and expose that from getOffset()/onBatchComplete, or document that offsets are only safe to persist after a batch whose chunk ended in a newline.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `jsonlTail.test.ts` reads half a line, persists the reported offset, resumes in a new tail after completion, and proves the spanning event is emitted exactly from the safe pre-line offset.

---
