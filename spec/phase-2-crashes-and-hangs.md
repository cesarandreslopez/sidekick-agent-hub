# Phase 2 — Crashes & Hangs

> Part of the [Sidekick Agent Hub review backlog](./README.md). Read the README first for methodology, trust levels, conventions, and the working loop.

**Goal.** Eliminate the ways the CLI, extension host, and shared readers crash outright or hang forever: message-less-event dereferences, missing child-process error handlers, network calls with no timeout, and inference clients that mis-resolve or squash model IDs.

**This phase:** 24 findings — 7 high, 16 medium, 1 low.

## Progress tracker

Update the Status box as you go: `[ ]` todo → `[~]` in progress → `[x]` done (or `[-]` if dropped after re-verification). Keep the one-line note current.

| ID | Sev | Trust | Location | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| P2-01 | 🔴 | ✅ | `utils/openUrl.ts:28` | openUrl crashes the CLI on Windows: no win32 opener and no spawn 'error' handler | `[x]` |
| P2-02 | 🔴 | ✅ | `src/accountManager.ts:388` | spawnAccountLogin has no child 'error' handler — missing CLI binary crashes the process | `[x]` |
| P2-03 | 🔴 | ✅ | `context/sessionContext.ts:351` | buildSessionContextSnapshot crashes on message-less summary events | `[x]` |
| P2-04 | 🔴 | ✅ | `parsers/sessionPathResolver.ts:44` | encodeWorkspacePath misses dots/spaces, so session discovery fails for such paths | `[x]` |
| P2-05 | 🔴 | ✅ | `providers/openCodeDatabase.ts:89` | OpenCodeDatabase permanently disables itself after one transient sqlite failure | `[x]` |
| P2-06 | 🔴 | ✅ | `services/ApiKeyClient.ts:95` | ApiKeyClient silently downgrades every resolved model ID to haiku | `[x]` |
| P2-07 | 🔴 | ✅ | `utils/requestWithTimeout.ts:44` | All TimeoutManager operations are capped at the 30s inner default timeout | `[x]` |
| P2-08 | 🟠 | ✅ | `dashboard/QuotaService.ts:76` | QuotaService.fetchOnce can hang forever — fetchQuota has no timeout | `[x]` |
| P2-09 | 🟠 | ✅ | `src/codexQuota.ts:587` | Codex ChatGPT usage/reset-credit fetches have no timeout or AbortSignal | `[x]` |
| P2-10 | 🟠 | ✅ | `extractors/toolCall.ts:106` | ToolCallTracker.process crashes on message-less events (e.g. Claude 'summary' lines) | `[x]` |
| P2-11 | 🟠 | ✅ | `src/quota.ts:186` | fetchQuota (Anthropic usage API) has no timeout or AbortSignal | `[x]` |
| P2-12 | 🟠 | ✅ | `src/quotaPoller.ts:170` | QuotaPoller backoff is inverted: failures poll FASTER than the normal interval | `[x]` |
| P2-13 | 🟠 | ✅ | `src/quotaPoller.ts:159` | QuotaPoller swallows getAccessToken failures silently and never recovers from a 401 | `[x]` |
| P2-14 | 🟠 | ✅ | `services/CodexClient.ts:81` | CodexClient: no stdin error handler — early CLI exit raises uncaught EPIPE | `[x]` |
| P2-15 | 🟠 | ✅ | `services/CodexClient.ts:124` | CodexClient resolves aborted/timed-out requests as successful empty completions | `[x]` |
| P2-16 | 🟠 | ✅ | `services/CompletionService.ts:126` | Superseded completion requests hang forever: debounce timer cleared without resolving | `[x]` |
| P2-17 | 🟠 | ✅ | `services/InlineChatService.ts:71` | Inline chat cancel button does nothing: external AbortSignal never wired | `[x]` |
| P2-18 | 🟠 | ✅ | `services/MaxSubscriptionClient.ts:297` | MaxSubscriptionClient squashes literal model IDs to 'haiku' | `[x]` |
| P2-19 | 🟠 | ✅ | `services/OpenCodeClient.ts:91` | OpenCodeClient creates a server session per request and never cleans it up | `[x]` |
| P2-20 | 🟠 | ✅ | `services/OpenCodeClient.ts:87` | OpenCodeClient ignores the abort signal — timeout/cancel never stops the request | `[x]` |
| P2-21 | 🟠 | ✅ | `utils/cliPathResolver.ts:124` | CLI path cache ignores settings changes; clearCliCache is never called | `[x]` |
| P2-22 | 🟠 | 🟡 | `dashboard/ProviderStatusService.ts:63` | ProviderStatusService polls with no fetch timeout and no reentrancy guard | `[x]` |
| P2-23 | 🟠 | ⚠️ | `aggregation/EventAggregator.ts:351` | Explicit compaction events are dropped by the message-less guard in processEvent | `[x]` |
| P2-24 | ⚪ | ✅ | `services/CompletionCache.ts:73` | CompletionCache key omits multiline flag, colliding across completion modes | `[x]` |

---

## Findings

### P2-01 — openUrl crashes the CLI on Windows: no win32 opener and no spawn 'error' handler

- **Location:** `sidekick-cli/src/utils/openUrl.ts:28`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** opener() returns 'open' (darwin), 'explorer.exe' (WSL), else 'xdg-open' — there is no native win32 branch. On Windows (or any Linux without xdg-open), spawn() does not throw synchronously; ENOENT is emitted asynchronously as an 'error' event on the child. No 'error' listener is attached, so the unhandled 'error' event throws an uncaught exception and kills the whole process — after openUrl already returned true and the command printed 'Opened: <url>'. Reachable from `sidekick handoff open` and the `sidekick extract -i` picker (Enter on a URL).

**Evidence.**

```ts
export function openUrl(url: string): boolean {
  try {
    const child = spawn(opener(), [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
```

**Fix.** Add a win32 branch (`spawn('cmd', ['/c', 'start', '', url], ...)` or reuse sidekick-shared's openInBrowser), and always attach `child.on('error', () => {})` so a missing opener degrades to the existing `false`/'Could not open' path instead of crashing.

**Verification:** `sidekick-cli/src/utils/openUrl.test.ts` covers the Windows `rundll32` argv path and a child-process `error`; the CLI suite passes.

---

### P2-02 — spawnAccountLogin has no child 'error' handler — missing CLI binary crashes the process

- **Location:** `sidekick-shared/src/accountManager.ts:388`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** spawn() failures for a nonexistent binary are delivered asynchronously via the child's 'error' event, not as a synchronous throw, so the try/catch around spawn never fires. Only an 'exit' listener is registered; an EventEmitter 'error' event with no listener throws an uncaught exception. Failure scenario: user triggers the add-account login flow while `claude` (or `codex`) is not on PATH -> spawn emits 'error' (ENOENT) -> unhandled 'error' crashes the sidekick CLI / takes down the extension-host call path instead of returning { success: false }. Even if the throw were somehow absorbed, childExited never becomes true, so the loop burns the full 180s timeout and misreports 'Account login timed out.'

**Evidence.**

```ts
let child: ReturnType<typeof spawn>;
  try {
    child = spawn(begin.command, begin.args ?? [], {
      env: { ...process.env, ...(begin.env ?? {}) },
      stdio: opts.stdio ?? 'inherit',
    });
  } catch (err) {
    return { success: false, error: `Could not spawn account login: ${err}` };
  }

  child.on('exit', (code) => {
    childExited = true;
    childExitCode = code;
  });
```

**Fix.** Register child.on('error', (err) => { childExited = true; spawnError = err; }) before the poll loop, and when childExited with a spawnError, return { success: false, error: `Could not spawn account login: ${spawnError}` } immediately instead of polling until timeout.

<details><summary>Verifier notes</summary>

- Read spawnAccountLogin (accountManager.ts:353-430): spawn is Node child_process.spawn, only an 'exit' listener is registered, and no 'error' listener exists. ENOENT for a missing 'claude'/'codex' binary is delivered asynchronously as the child's 'error' event, bypassing the try/catch; an unhandled EventEmitter 'error' emitted in nextTick becomes an uncaughtException, and no uncaughtException handler exists anywhere in the repo, so the sidekick CLI crashes. No guard elsewhere: beginAccountLogin does not verify the binary exists, and both callers (sidekick-cli/src/commands/account.ts:230, sidekick-vscode/src/services/AccountService.ts:89) call it directly; the fallback consequence (childExited never set, 180s timeout with wrong error) is also correct since 'exit' does not fire after a spawn error.
- I read spawnAccountLogin (accountManager.ts:378-391) and confirmed only an 'exit' listener is registered, then empirically verified on this machine's Node 24 that spawning a missing binary throws nothing synchronously (the try/catch is dead), emits 'error'+'close' but never 'exit', and with no 'error' listener kills the process with an unhandled 'error' event. Reachability is real: `sidekick account login` (sidekick-cli/src/commands/account.ts:230) spawns bare PATH-resolved `claude`/`codex` with no preflight check and no global uncaughtException handler, so a user without the target CLI installed crashes the sidekick process; a surrounding try/catch could not catch it since it is not a promise rejection. The claim's secondary consequence also holds — because 'exit' never fires, childExited stays false and the loop would burn the full 180s and misreport a timeout, which is exactly what happens on the VS Code path where the extension host absorbs the uncaught exception.

</details>

**Verification:** `sidekick-shared/src/accountManager.test.ts` emits a spawn failure and verifies login returns a reported failure without an uncaught process error.

---

### P2-03 — buildSessionContextSnapshot crashes on message-less summary events

- **Location:** `sidekick-shared/src/context/sessionContext.ts:351`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** Real Claude Code JSONL transcripts contain summary rows with no `message` field (proven by the tests added in commit 2f0c9a8 'tolerate message-less session events', and ClaudeCodeReader passes raw parsed lines through verbatim). EventAggregator guards this (`if (!event.message) return`), but extractSourcesFromEvent's 'summary' branch dereferences `event.message.content` unguarded, and latestModel() (line 605, used by readSessionContextSnapshot) dereferences `events[i].message.model`. Any session file containing a summary row -- which every resumed Claude Code session has at the top -- makes buildSessionContextSnapshot / readSessionContextSnapshot throw 'Cannot read properties of undefined'. This is a live path: sidekick-cli/src/commands/mcp.ts:72 calls buildSessionContextSnapshot on reader.readAll() output.

**Evidence.**

```ts
case 'summary':
      addSource(state, {
        event,
        layer: 'summary',
        sourceType: 'summary',
        title: 'Context summary',
        text: extractText(event.message.content) || 'Context compacted',
      });
```

**Fix.** Guard both spots: in extractSourcesFromEvent use `extractText(event.message?.content)`, and in latestModel use `events[i].message?.model`. Audit the other extract* helpers in this file (extractSystemSource, extractUserSources, extractAssistantSources) for the same optional-message access.

**Verification:** `sidekick-shared/src/context/sessionContext.test.ts` builds a snapshot containing a message-less summary event without throwing.

---

### P2-04 — encodeWorkspacePath misses dots/spaces, so session discovery fails for such paths

- **Location:** `sidekick-shared/src/parsers/sessionPathResolver.ts:44`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** Claude Code encodes project dirs by replacing every non-alphanumeric character with '-' (verified on disk: '/Applications/Open Design.app/...' is stored as '-Applications-Open-Design-app-...'), but encodeWorkspacePath only replaces ':', '/', and '_'. For a workspace like '~/code/next.js' Claude writes '-Users-x-code-next-js' while this returns '-Users-x-code-next.js'. Strategy 1 (exact dir), strategy 2's normalizedWorkspace (lines 221-226, same limited replacement), and the basename endsWith fallback (basename keeps the dot) all fail, so findActiveSession/findAllSessions return nothing for any workspace whose path contains '.', ' ', or other special chars. extractors/sources/claudeAssets.ts:82 uses getSessionDirectory() directly with no discovery fallback, so asset gathering fails too.

**Evidence.**

```ts
// Replace colons, slashes, and underscores with hyphens
  // Windows: C:\Users\foo_bar -> C:/Users/foo_bar -> C--Users-foo-bar
  // Unix: /home/user/foo_bar -> -home-user-foo-bar
  return normalized.replace(/[:/_]/g, '-');
```

**Fix.** Match Claude Code's actual scheme: after normalizing backslashes, use normalized.replace(/[^a-zA-Z0-9]/g, '-'). Apply the same normalization to discoverSessionDirectory's normalizedWorkspace and the workspaceBasename fallbacks, and add tests for paths containing dots and spaces.

<details><summary>Verifier notes</summary>

- Verified against on-disk ground truth: ~/.claude/projects/ on this machine contains '-Applications-Open-Design-app-Contents-Resources-app-prebundled' and '-Users-...-contextful-desktop--claude-worktrees-...' (dot in '.claude' hyphenated), proving Claude Code replaces all non-alphanumerics with '-', while encodeWorkspacePath (sessionPathResolver.ts:44) only replaces [:/_]. I traced every fallback in discoverSessionDirectory (exact dir, subdirectory prefix, normalized exact match at lines 221-226, basename endsWith at lines 236/265) — all preserve dots/spaces, so none can match when the workspace basename contains one, and claudeAssets.ts:82 uses getSessionDirectory with no discovery at all. Tests only cover underscore/colon/slash paths, so no guard or test contradicts the finding.
- Verified against real on-disk data: ~/.claude/projects contains -Applications-Open-Design-app-Contents-Resources-app-prebundled whose session JSONL cwd is "/Applications/Open Design.app/Contents/Resources/app/prebundled", proving Claude Code hyphenates dots and spaces, while encodeWorkspacePath (line 44) only replaces [:/_]; none of 2,278 project dirs retain a dot/underscore. Simulating every discovery strategy shows total failure when the workspace basename itself contains a dot/space (e.g. ~/code/next.js), and claudeAssets.ts:82 uses getSessionDirectory with no discovery fallback, so asset gathering fails for any special-char path — reproducible with the workspace on this very machine. The only overstatement: when the special char is confined to parent path components and the basename is clean, strategy 2's basename endsWith fallback does rescue findActiveSession/findAllSessions.

</details>

**Verification:** shared and extension `SessionPathResolver.test.ts` cases cover dotted and spaced paths and verify the extension re-exports the Claude-specific resolver.

---

### P2-05 — OpenCodeDatabase permanently disables itself after one transient sqlite failure

- **Location:** `sidekick-shared/src/providers/openCodeDatabase.ts:89`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** query() caches a failed runtime status on any error (sqlite timeout >4s, 'database is locked' while OpenCode writes, maxBuffer exceeded), and open() short-circuits on that cached status forever: 'open(): if (this.runtimeStatus) return this.runtimeStatus.available;'. Nothing ever resets runtimeStatus back to available. After a single transient failure every subsequent query() returns [] for the process lifetime. Compounding it, OpenCodeDbReader.exists() always returns true and OpenCodeProvider.ensureDb() keeps returning the bricked db instance, while the 'dbStatus.kind !== db_missing' gates block the file fallback — so the dashboard/monitor silently shows no new events, no sessions, and no stats until restart.

**Evidence.**

```ts
this.runtimeStatus = toRuntimeStatus(error, 'query_failed');
      return [];
...
  open(): boolean {
    if (this.runtimeStatus) return this.runtimeStatus.available;
```

**Fix.** Treat query failures as transient: in query()'s catch, record the status for reporting but do not let it gate open() (e.g. only cache sqlite_missing/sqlite_blocked as permanent; for query_failed keep runtimeStatus.available=true or add a retry/backoff that clears the cached status after N ms). Add a test that a failed query followed by a successful one returns rows.

<details><summary>Verifier notes</summary>

- Verified the full chain: query()'s catch (line 89) caches available:false, open() (line 44) short-circuits on any cached status, and query() gates on open() (line 67), so after one failure execFileSync is never reattempted and the available-reset at line 84 is unreachable; no code clears runtimeStatus. The instance is long-lived: ensureDb() memoizes one OpenCodeDatabase per provider, providers live for the whole CLI dashboard/VS Code extension process, and OpenCodeDbReader holds the same db reference with SessionMonitor.poll() offering no recovery. The claimed downstream effects are accurate — exists() returns true unconditionally (its own comment says transient sqlite failures should be treated as survivable, proving the permanent cache contradicts design intent), and the dbStatus.kind !== 'db_missing' gates block file fallback for query_failed. Transient failures are realistic (4s SIGKILL timeout, 'database is locked' with sqlite3's default busy_timeout 0 while OpenCode writes, 50MB maxBuffer), and no test covers recovery after a failed query.
- Verified all links in the chain: query()'s catch caches available:false for any non-ENOENT/EPERM error (timeout, locked db, maxBuffer), open() short-circuits on that cache forever, and the only reset (line 84) sits behind the open() gate so it is unreachable after one failure. The instance is process-lifetime: OpenCodeProvider.ensureDb() caches it, the CLI dashboard and SessionMonitor hold one provider across polls, and the VS Code extension re-exports the same shared class. Reachability is concrete — the local opencode.db is 104MB with active WAL, making a 4s ETIMEDOUT on unbounded part/message queries, a >50MB maxBuffer overflow, or a locked-db during WAL recovery all realistic one-off triggers; the OpenCodeDbReader.exists() comment even acknowledges transient sqlite timeouts happen, yet exists()===true plus the kind!=='db_missing' gates ensure no re-discovery and no file fallback.

</details>

**Verification:** `sidekick-shared/src/providers/openCodeDatabase.test.ts` forces one query failure followed by success and verifies the database retries.

---

### P2-06 — ApiKeyClient silently downgrades every resolved model ID to haiku

- **Location:** `sidekick-vscode/src/services/ApiKeyClient.ts:95`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** ModelResolver maps tiers for the claude-api provider to full model IDs (DEFAULT_MODEL_MAPPINGS['claude-api'] = { fast: 'claude-haiku-4-5', balanced: 'claude-sonnet-4-6', powerful: 'claude-opus-4-8' }), and every caller (CompletionService, transform command, InlineChatService, etc.) passes that resolved value into complete(). ApiKeyClient.mapModel() only recognizes the shorthands 'haiku'/'sonnet'/'opus' and its default case returns 'claude-haiku-4-5', so 'claude-sonnet-4-6', 'claude-opus-4-8', and any user-specified literal model ID all fall through to haiku. Failure scenario: user selects inferenceProvider=claude-api and transformModel=powerful; extension.ts resolves 'claude-opus-4-8', logs and shows 'via Claude API · claude-opus-4-8', but the actual API request is made with claude-haiku-4-5 — wrong model on every claude-api request that is not the fast tier, with degraded quality and misleading UI/billing expectations.

**Evidence.**

```ts
private mapModel(model?: string): string {
    switch (model) {
      case 'haiku':
        return 'claude-haiku-4-5';
      case 'sonnet':
        return 'claude-sonnet-4-6';
      case 'opus':
        return 'claude-opus-4-8';
      default:
        return 'claude-haiku-4-5';
    }
  }
```

**Fix.** In mapModel, pass through anything that is not a known shorthand (e.g. `if (model?.startsWith('claude-')) return model;` before the switch, or `default: return model ?? 'claude-haiku-4-5';`), so tier-resolved full IDs and user literals reach the API unchanged.

<details><summary>Verifier notes</summary>

- Traced the full call path: resolveModel() maps claude-api tiers/legacy names to full IDs ('claude-sonnet-4-6', 'claude-opus-4-8') per DEFAULT_MODEL_MAPPINGS, callers (CompletionService, InlineChatService, extension.ts transform command) pass that value into AuthService.complete() which forwards options unchanged to ApiKeyClient for the claude-api provider. ApiKeyClient.mapModel() only matches the shorthands 'haiku'/'sonnet'/'opus' — which cannot arrive on this path since resolveModel converts them to full IDs first — so every non-fast-tier request and every user-specified literal ID falls to the default 'claude-haiku-4-5'. No guard, test, or type constraint prevents this; the sibling MaxSubscriptionClient.mapModel correctly pairs with claude-max's shorthand mapping, confirming ApiKeyClient was left behind when the claude-api mapping moved to full IDs.
- Traced the full path: with inferenceProvider=claude-api, AuthService routes complete() to ApiKeyClient (AuthService.ts:132-138). ModelResolver maps every tier/legacy name for claude-api to full IDs (claude-haiku-4-5/claude-sonnet-4-6/claude-opus-4-8 per DEFAULT_MODEL_MAPPINGS) and every caller (transform command at extension.ts:2445-2501, CompletionService.ts:94, InlineChatService, etc.) passes that resolved value as options.model, so mapModel (ApiKeyClient.ts:87-98) never receives the 'haiku'/'sonnet'/'opus' shorthands it switches on and always falls to the default 'claude-haiku-4-5'. The transform command even logs and shows "via Claude API · claude-opus-4-8" while the SDK request is made with haiku — the exact failure scenario claimed. Reachable by simply configuring claude-api with an API key and using any non-fast-tier feature; the fast tier only escapes because it coincidentally resolves to the same haiku ID.

</details>

**Verification:** `sidekick-vscode/src/services/InferenceModelMapping.test.ts` verifies resolved and literal model IDs pass through `ApiKeyClient` unchanged.

---

### P2-07 — All TimeoutManager operations are capped at the 30s inner default timeout

- **Location:** `sidekick-vscode/src/utils/requestWithTimeout.ts:44`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** TimeoutManager computes a scaled timeout (base 45-60s for documentation/codeTransform/inlineChat + perKb scaling + 1.5x retry multiplier), but none of its callers forward that value into CompletionOptions.timeout — e.g. extension.ts:2497 `authService!.complete(prompt, { model, maxTokens: 4096, signal })` and InlineChatService.ts:74 pass only `signal`. Every client wraps the call in requestWithTimeout, which then applies DEFAULT_REQUEST_TIMEOUT (30_000) and aborts/throws TimeoutError(30000) first. Failure scenario: transform on a large selection — TimeoutManager shows '~74s' in the progress title, the request dies at 30s, promptRetry offers 'Retry (111s)', and the retry dies at 30s again: the timeout scaling math and retry multiplier are never actually applied, and the reported timeoutMs (TimeoutManager's value) is wrong. In the opposite race (TimeoutManager timer firing first), requestWithTimeout sees the external signal aborted and throws AbortError, which executeOnce misclassifies as user cancellation (timedOut: false) so the operation ends silently with no timeout dialog.

**Evidence.**

```ts
const timeoutMs = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
```

**Fix.** Have TimeoutManager.executeOnce pass its computed timeoutMs to the task callback (task: (signal, timeoutMs) => ...) and forward it as options.timeout in every service, or make requestWithTimeout skip its internal default timer whenever an external signal is supplied (only honoring an explicit options.timeout).

<details><summary>Verifier notes</summary>

- Read requestWithTimeout.ts, TimeoutManager.ts, constants.ts, AuthService, all four clients, and all eight executeWithTimeout call sites. Every TimeoutManager consumer passes only {model, maxTokens, signal} — never timeout — so every client-level requestWithTimeout applies the hardcoded 30s default, capping documentation/codeTransform/inlineChat/review/prDescription operations well below their computed timeouts and making the 1.5x retry a no-op; the reported timeoutMs in dialogs is TM's never-applied value. The reverse race (TM timer firing first) does surface as AbortError and is misclassified as user cancellation in executeOnce. The only caller that forwards timeout (CompletionService) bypasses executeWithTimeout, so no guard elsewhere prevents the defect.
- I traced the full chain: requestWithTimeout.ts:44 defaults to DEFAULT_REQUEST_TIMEOUT=30_000 (constants.ts:28), all four inference clients wrap complete() in it and wire the abort signal into the real SDK call, and none of the eight TimeoutManager call sites (extension.ts:2497 codeTransform, InlineChatService:74, Explanation, ErrorExplanation, Documentation, CommitMessage, PrDescription, PreCommitReview) forward a timeout — only signal. The scenario is reachable via the registered sidekick.transform command on a large selection with default settings (60s base + 500ms/KB advertised, killed at 30s; executeOnce then reports its own larger timeoutMs and promptRetry offers a 1.5x retry that is capped at 30s again). The opposite race (external abort misclassified as user cancellation, timedOut:false, silent failure) is also present and reachable when sidekick.timeouts.* is configured below 30s.

</details>

**Verification:** `requestWithTimeout.test.ts` verifies an outer signal can own a deadline beyond 30 seconds, while `TimeoutManager.test.ts` verifies its own deadline is still classified as a timeout.

---

### P2-08 — QuotaService.fetchOnce can hang forever — fetchQuota has no timeout

- **Location:** `sidekick-cli/src/dashboard/QuotaService.ts:76`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** fetchOnce delegates to sidekick-shared's fetchQuota, whose `fetch(USAGE_URL, ...)` (quota.ts:186) passes no signal/timeout; the surrounding try/catch handles rejects but not a stalled connection. Failure scenario: `sidekick quota` (commands/quota.ts:319 awaits Promise.all([service.fetchOnce(), ...])) or the MCP quota resource (commands/mcp.ts:86) on a network that black-holes the request -> the CLI command hangs indefinitely with no output and no error.

**Evidence.**

```ts
async fetchOnce(): Promise<QuotaState> {
    const creds = await readClaudeMaxCredentials();
    if (!creds) {
      return unavailableAuthState();
    }
    return fetchQuota(creds.accessToken);
  }
```

**Fix.** Bound the call in fetchOnce, e.g. race fetchQuota against a timeout that resolves to an unavailable QuotaState with failureKind 'network' (or add an AbortSignal.timeout parameter to shared fetchQuota and pass one here), matching UpdateCheckService's AbortSignal.timeout(5000) pattern.

<details><summary>Verifier notes</summary>

- The code facts check out: fetchQuota's fetch has no signal/timeout, fetchOnce adds none, and both cited callers await it bare with no dispatcher config anywhere in the repo. However, the headline consequence is refuted: the CLI requires Node >=20, so the global fetch is undici, whose defaults bound the request — a black-holed TCP connect fails at the ~10s connectTimeout and an established-but-silent connection at the 300s headersTimeout, both rejecting into fetchQuota's catch and producing a rendered 'Network error' state, so the command cannot hang forever nor exit silently. What remains is a bounded worst-case stall of up to ~5 minutes with no feedback, inconsistent with UpdateCheckService's AbortSignal.timeout(5000) pattern — a real but low-severity defect for which the suggested fix is appropriate.
- The code reads as claimed (no signal/timeout anywhere in the fetchOnce → fetchQuota chain, and callers at quota.ts:319/521 and mcp.ts:86 gate all output on it), but the claimed consequence is not reachable: the CLI requires Node >=20, whose built-in undici fetch bounds a black-holed request via default connectTimeout (~10s) and headersTimeout/bodyTimeout (300s), after which fetchQuota's catch (quota.ts:245) returns a graceful 'Network error' unavailable state — so the command never hangs forever and never ends with no output. What remains reachable is a silent stall of up to ~5 minutes (e.g., VPN drop leaving an established connection that never delivers headers) with zero feedback, which in `quota --all` blocks output for every provider; that is a real but low-severity defect, and the repo's own UpdateCheckService already uses AbortSignal.timeout(5000) for exactly this.

</details>

**Verification:** `sidekick-shared/src/quota.test.ts` leaves the Anthropic request hung and verifies it is aborted at the configured deadline, covering `QuotaService.fetchOnce`.

---

### P2-09 — Codex ChatGPT usage/reset-credit fetches have no timeout or AbortSignal

- **Location:** `sidekick-shared/src/codexQuota.ts:587`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** fetchCodexQuotaFromApi and fetchCodexResetCreditsFromApi call fetch() against chatgpt.com with no AbortController/timeout (unlike zaiQuotaApi.ts, which correctly aborts after 10s). A stalled connection (captive portal, proxy black-holing chatgpt.com) leaves resolveCodexQuota pending for undici's default ~300s headers timeout; CLI commands that await it appear hung, and the awaited resetCredits fetch doubles the stall.

**Evidence.**

```ts
const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(options.usageUrl ?? CHATGPT_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
```

**Fix.** Mirror zaiQuotaApi.ts: create an AbortController with a ~10s unref'd timer and pass signal to both fetches, returning the existing 'network' failure state on AbortError.

<details><summary>Verifier notes</summary>

- Verified both fetch calls in codexQuota.ts (lines 587 and 686) pass no AbortSignal and the file contains no timeout mechanism at all, while zaiQuotaApi.ts (lines 293-307) uses a 10s unref'd AbortController exactly as the claim describes. Checked all callers for compensating guards: CLI quota --refresh/--all and the VS Code dashboard both await resolveCodexQuota with source 'api' directly, with no Promise.race, timeout wrapper, or timeout-bearing fetchImpl, so a stalled connection hangs until undici's ~300s default, and the sequential awaited resetCredits fetch can compound it. The only caveat is the MCP facts server, which uses source 'local' and never hits the network, slightly narrowing the blast radius but not invalidating the defect.
- Verified in codexQuota.ts that neither fetchCodexQuotaFromApi (line 587) nor fetchCodexResetCreditsFromApi (line 686) passes an AbortSignal or timeout, while zaiQuotaApi.ts (lines 293-307) does use a 10s unref'd AbortController. The API path is reachable from real user actions: sidekick quota --refresh and sidekick quota --all pass source:'api' (sidekick-cli/src/commands/quota.ts lines 373, 525), and the VS Code DashboardViewProvider._getCodexQuota uses source:'api' unconditionally (line 1739); both directly await the fetch, and a captive portal or black-holing proxy produces the stalled-headers condition, leaving the call pending until undici's default ~300s headersTimeout. The existing catch already returns the 'network' failure state with local fallback, so the suggested fix is straightforward and correct.

</details>

**Verification:** `sidekick-shared/src/codexQuota.test.ts` verifies both hung usage and reset-credit requests receive abort signals and settle at the configured deadline.

---

### P2-10 — ToolCallTracker.process crashes on message-less events (e.g. Claude 'summary' lines)

- **Location:** `sidekick-shared/src/extractors/toolCall.ts:106`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** Real Claude Code JSONL contains lines with no message field ({"type":"summary","summary":...,"leafUuid":...}); JsonlParser casts them to SessionEvent without validation and ClaudeCodeReader emits them as-is. EventAggregator.processEvent explicitly guards this ('Guard: some event types (e.g. summary) have no message field'), but the publicly exported ToolCallTracker does not: line 106 dereferences event.message.content unconditionally (and line 97 event.message.id on the tool_use path). Any consumer of the published sidekick-shared package that pipes reader output through ToolCallTracker throws 'Cannot read properties of undefined' on the first summary line.

**Evidence.**

```ts
const content = event.message.content;
    if (!Array.isArray(content)) return completed;
```

**Fix.** Use optional chaining: 'const content = event.message?.content;' and 'const id = event.message?.id;' (mirroring extractToolCalls' existing event.message?.content guard), plus a test feeding a message-less summary event.

<details><summary>Verifier notes</summary>

- Verified the full chain: ClaudeCodeReader constructs JsonlParser<SessionEvent> with no schema (claudeCode.ts:91), so JsonlParser casts raw JSON lines to SessionEvent unvalidated (jsonl.ts:90), and real Claude Code summary lines lack a message field — a fact the codebase itself acknowledges via the guard comment in EventAggregator.processEvent (EventAggregator.ts:350-353). ToolCallTracker.process reaches line 106 (event.message.content) unconditionally for summary events (extractToolCalls and extractToolCall both bail early on type checks), and a Node simulation of the exact control flow throws TypeError as claimed. ToolCallTracker is exported public API (index.ts:701) with no in-repo guard on its path, extractToolCalls already uses the defensive event.message?.content pattern that process() omits, and the recent 'tolerate message-less session events' commit (2f0c9a8) fixed observedSessionV1.ts but not toolCall.ts — no test covers message-less input.
- Traced the full path: Claude Code JSONL summary lines lack a message field (confirmed by EventAggregator's own guard comment at aggregation/EventAggregator.ts:350, the summary counting in providers/claudeCode.ts:409, and commit 2f0c9a8's test fixtures); JsonlParser casts JSON.parse output to SessionEvent with no validation when no schema is passed (parsers/jsonl.ts:90) and ClaudeCodeReader passes none; ToolCallTracker.process then unconditionally dereferences event.message.content at toolCall.ts:106, throwing TypeError on the first summary line. The prior commit fixed this exact bug class in observedSessionV1.ts but missed toolCall.ts, and extractToolCalls in the same file already uses the message?.content guard, confirming an oversight. Impact is correctly scoped: no in-repo production code calls ToolCallTracker, but it is publicly exported (index.ts:701) from the published sidekick-shared package whose documented use case is external consumers piping reader output through extractors.

</details>

**Verification:** `sidekick-shared/src/extractors/toolCall.test.ts` feeds a message-less event to `ToolCallTracker.process` and verifies it is ignored safely.

---

### P2-11 — fetchQuota (Anthropic usage API) has no timeout or AbortSignal

- **Location:** `sidekick-shared/src/quota.ts:186`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The core Claude quota fetch has no abort/timeout, yet it sits inside two polling loops (QuotaPoller and MultiProviderQuotaService.poll, which only schedules the next poll in finally after the await resolves). A hung connection to api.anthropic.com stalls the whole Claude quota loop for up to undici's ~300s default header timeout per attempt, freezing quota freshness for minutes with no error surfaced. providerStatus.ts fetchStatusPage has the same gap and additionally makes `sidekick doctor` awaitable on two un-timed fetches.

**Evidence.**

```ts
const res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': BETA_HEADER,
        'Content-Type': 'application/json',
      },
    });
```

**Fix.** Add an AbortController with a ~10s unref'd timeout (same pattern as fetchZaiQuotaFromApi) and map AbortError to the existing 'network' unavailableState; apply the same to fetchStatusPage in providerStatus.ts.

<details><summary>Verifier notes</summary>

- Verified quota.ts:186 fetches with no signal/timeout while both QuotaPoller.poll (schedules next poll only after the await settles, quotaPoller.ts:163) and MultiProviderQuotaService.poll (scheduleNextPoll in finally, multiProviderQuotaService.ts:346-348) block on it, so a hung connection stalls the Claude quota loop with no error surfaced. No compensating guard exists anywhere (no Promise.race, wrapper timeout, or undici setGlobalDispatcher), and sibling code in the same package (zaiQuotaApi.ts:294, pricingCatalog.ts:246) already uses the AbortController+timeout pattern, proving this is an inconsistency rather than a design choice. providerStatus.ts fetchStatusPage (lines 57, 71) has the same gap. The only error in the claim is the CLI command name: doctor.ts makes no network calls.
- Verified every element: quota.ts:186 fetches with no signal/timeout; QuotaPoller.poll (quotaPoller.ts:132) and MultiProviderQuotaService.poll (multiProviderQuotaService.ts:316, scheduleNextPoll in finally at :347) both serialize the next poll behind the un-timed await, and both are instantiated in shipped paths (CLI dashboard QuotaService.ts:35, extension.ts:1264/1277). providerStatus.ts fetchStatusPage has two un-timed fetches awaited by runDoctor (doctor.ts:141-147) with no outer timeout, and zaiQuotaApi.ts:294-307 shows the exact AbortController pattern the fix cites. The triggering state is reachable on real hardware — a black-holed TCP connection from sleep/wake, Wi-Fi/VPN switch, or a stalling proxy leaves the request pending until undici's 300s default headersTimeout, during which no listener is notified and quota freshness silently freezes; recovery then occurs via the network-error catch, matching the claimed medium severity.

</details>

**Verification:** `sidekick-shared/src/quota.test.ts` asserts a hung Anthropic usage fetch is aborted and returns a network-unavailable state.

---

### P2-12 — QuotaPoller backoff is inverted: failures poll FASTER than the normal interval

- **Location:** `sidekick-shared/src/quotaPoller.ts:170`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The retry delay is Math.min(baseInterval * 2^failures, maxBackoffMs) where maxBackoffMs defaults to 120_000. Whenever maxBackoffMs < baseInterval, 'backoff' shortens the interval. This is the CLI's actual configuration: sidekick-cli/src/dashboard/QuotaService.ts constructs QuotaPoller with activeIntervalMs = idleIntervalMs = 300_000 and leaves maxBackoffMs at its 120_000 default, so any persistent failure (network down, 5xx, or the getAccessToken throw when credentials are absent/expired) makes the poller hit the Anthropic usage API every 2 minutes instead of every 5 — hammering harder the longer the failure lasts.

**Evidence.**

```ts
const baseInterval = this.isActive ? this.activeIntervalMs : this.idleIntervalMs;
    const backoff = Math.min(
      baseInterval * Math.pow(2, this.consecutiveFailures),
      this.maxBackoffMs,
    );
    const delay = this.consecutiveFailures > 0 ? backoff : baseInterval;
```

**Fix.** Never let backoff drop below the base interval: const backoff = Math.min(baseInterval * 2 ** failures, Math.max(this.maxBackoffMs, baseInterval)); or clamp with Math.max(baseInterval, ...).

<details><summary>Verifier notes</summary>

- Verified directly: quotaPoller.ts:170-174 computes delay as min(baseInterval * 2^failures, maxBackoffMs) with no lower clamp, and QuotaService.ts:35-43 configures activeIntervalMs = idleIntervalMs = 300_000 while leaving maxBackoffMs at its 120_000 default, so any transient failure (network, 5xx, 429, unknown status per quota.ts:196-246) schedules the next poll in 120s instead of 300s. No guard, type constraint, or test prevents this; the inversion also affects default-configured pollers in idle mode (idle 300_000 > maxBackoff 120_000). Details corrected: the rate is a constant 2.5x faster (cap hit at first failure), expired-token 401s stop the poller entirely rather than fast-poll, and the absent-credentials throw fast-retries but never reaches the API (throw precedes fetchQuota).
- Verified the code and the full call chain: the CLI dashboard (sidekick-cli/src/commands/dashboard.ts:253, 639) is the only QuotaPoller consumer and constructs it with active=idle=300_000ms while leaving maxBackoffMs at its 120_000 default; scheduleNext() then yields min(300_000*2^n, 120_000)=120_000 for any failure, so failures poll every 2 minutes instead of 5. The triggering condition is trivially reachable: fetchQuota maps any network error, 5xx, or 429 to a non-auth unavailable state that increments consecutiveFailures, so any offline period or Anthropic outage produces the inverted behavior against the live usage endpoint.

</details>

**Verification:** `sidekick-shared/src/quotaPoller.test.ts` uses a maximum backoff below the base interval and verifies failures never schedule a faster poll.

---

### P2-13 — QuotaPoller swallows getAccessToken failures silently and never recovers from a 401

- **Location:** `sidekick-shared/src/quotaPoller.ts:159`
- **Severity / category:** 🟠 medium · ux
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** Two error paths leave consumers blind: (1) when getAccessToken throws (the CLI QuotaService throws 'No OAuth token available' when credentials are absent or expired), the catch block only increments consecutiveFailures — notify() is never called, so a signed-out CLI dashboard never receives any quota state and cannot distinguish 'loading' from 'not signed in'. (2) On failureKind 'auth' (HTTP 401) the poller calls this.stop() permanently; after the user re-authenticates via `claude`, quota stays frozen on the stale error until the whole dashboard restarts.

**Evidence.**

```ts
} catch {
      this.consecutiveFailures++;
    }

    this.scheduleNext();
```

**Fix.** In the catch block, notify listeners with an unavailable auth/unknown QuotaState built from the thrown error; instead of stop() on 401, keep scheduling at the idle interval (as MultiProviderQuotaService does) so recovery after re-login is automatic.

<details><summary>Verifier notes</summary>

- Verified both paths in sidekick-shared/src/quotaPoller.ts: the catch block (lines 159-161) only increments consecutiveFailures with no notify(), and the CLI QuotaService's getAccessToken does throw 'No OAuth token available' when readClaudeMaxCredentials() returns null (absent or expired creds), so the CLI dashboard's quota stays null and the dedicated 'Sign in required' descriptor in quotaPresentation.ts can never render via polling. On failureKind 'auth' (401), lines 138-143 call this.stop(), permanently halting polling with no recovery after re-login. MultiProviderQuotaService (multiProviderQuotaService.ts lines 361-367, 415-416) already implements the suggested behavior — emit auth state, keep polling at idle interval, auto-recover — confirming real divergence and a low-risk, user-visible fix.

</details>

**Verification:** `sidekick-shared/src/quotaPoller.test.ts` verifies token and 401 failures publish unavailable state and schedule a later retry instead of stopping.

---

### P2-14 — CodexClient: no stdin error handler — early CLI exit raises uncaught EPIPE

- **Location:** `sidekick-vscode/src/services/CodexClient.ts:81`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The prompt is written to child.stdin immediately after spawn with no 'error' listener on the stdin stream. child.on('error') only covers spawn failures, not stream write errors. Failure scenario: codex exits immediately (unknown flag after a CLI update, auth failure printing usage, or a stale cached path from findCli pointing at a wrapper that fails) while a large prompt is still being flushed — the write triggers an 'error' (EPIPE) event on child.stdin that has no listener, which becomes an uncaught exception in the extension host instead of a rejected completion promise.

**Evidence.**

```ts
// Write prompt to stdin and close
        child.stdin.write(prompt);
        child.stdin.end();
```

**Fix.** Add `child.stdin.on('error', (err) => reject(err));` (or swallow EPIPE specifically) before writing, e.g. `child.stdin.on('error', () => { /* handled via close */ });`, so early process death cannot crash the host.

<details><summary>Verifier notes</summary>

- Read CodexClient.ts and requestWithTimeout.ts: child.stdin.write(prompt)/end() at lines 81-82 has no 'error' listener, and nothing upstream can catch a stream 'error' event since it throws outside the promise chain. Empirically reproduced with node: spawning /usr/bin/false and writing a 5MB buffer to its stdin raised an uncaught EPIPE that was not delivered to child.on('error'). The defect is real; only the stated consequence needs adjustment.
- Verified in CodexClient.ts: no 'error' listener exists on child.stdin, and child.on('error') does not cover stream write errors, so a pending EPIPE emits an unhandled stream error. The triggering state is reachable: code-transform (extension.ts:2470ff) and DocumentationService build prompts from raw uncapped editor selections (>64KB pipe buffer is easy), and the hardcoded version-sensitive flags (--experimental-json etc.) make an instant arg-parse exit of an updated/old codex CLI realistic; the SIGTERM-on-abort path (line 75) can also kill the child mid-flush. However, the claimed consequence is overstated: the 'close' handler still fires and rejects the promise with the exit code and stderr, and the VS Code extension host's global uncaughtException handler logs rather than crashes, so the impact is unhandled-error noise, not a lost rejection or host crash.

</details>

**Verification:** `sidekick-vscode/src/services/CodexClient.test.ts` emits a stdin `error` and verifies the request rejects without an uncaught EPIPE.

---

### P2-15 — CodexClient resolves aborted/timed-out requests as successful empty completions

- **Location:** `sidekick-vscode/src/services/CodexClient.ts:124`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** On abort the child is killed with SIGTERM, which makes 'close' fire with code === null; the handler's `code !== 0 && code !== null` guard then resolves with the (empty or partial) `response` instead of rejecting. Because the work promise resolves, requestWithTimeout returns it as a normal success — no TimeoutError and no AbortError is ever surfaced for codex. Failure scenario: a codex inline completion times out at 30s; instead of the timeout warning with 'Open Settings', CompletionService receives '' and silently shows nothing; a transform shows the misleading 'No transformation returned' warning. Additionally, kill('SIGTERM') has no SIGKILL escalation, so a codex process that ignores SIGTERM lingers.

**Evidence.**

```ts
child.on('close', (code) => {
          if (errorMessage) {
            reject(new Error(`Codex error: ${errorMessage}`));
          } else if (code !== 0 && code !== null) {
            reject(
              new Error(`Codex exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`),
            );
          } else {
            resolve(response);
          }
        });
```

**Fix.** In the close handler, check `if (signal.aborted) { const e = new Error('Request was cancelled'); e.name = 'AbortError'; reject(e); return; }` before the code checks (requestWithTimeout will convert it to TimeoutError when appropriate), and escalate to SIGKILL after a short grace period if the process has not exited.

<details><summary>Verifier notes</summary>

- Verified all links in the chain: on abort CodexClient kills the child with SIGTERM, Node fires 'close' with code === null, and the handler's `code !== 0 && code !== null` guard falls through to resolve(response) at line 124 with an empty/partial string. requestWithTimeout contains no Promise.race — its TimeoutError/AbortError mapping only runs when the work promise rejects with an AbortError-named error, so the resolved empty string is returned as a normal success (sibling clients ApiKeyClient/MaxSubscriptionClient correctly reject via SDK signal linking, confirming the contract). Downstream consequences match: CompletionService.ts:213-214 only surfaces the timeout warning on TimeoutError, and extension.ts:2530 shows 'No transformation returned' for empty results. The SIGTERM-without-SIGKILL-escalation point is also accurate, and there are no CodexClient tests guarding this.
- Verified all three links of the chain: (1) on POSIX, kill('SIGTERM') makes 'close' fire with code === null, and CodexClient's guard `code !== 0 && code !== null` then resolves with the accumulated (typically empty) response; (2) requestWithTimeout merely awaits the work promise — it only converts rejections, so a resolved promise returns as normal success and no TimeoutError/AbortError is ever produced for codex; (3) consumers depend on TimeoutError for feedback (CompletionService.ts:213-217 rethrows it for the TimeoutManager 'Open Settings' warning; extension.ts:2530 shows 'No transformation returned' on empty transform output). Reachability is concrete: AuthService.ts:145 routes the codex inference provider to CodexClient, DEFAULT_REQUEST_TIMEOUT is 30s, and a codex exec turn exceeding 30s (or user cancellation) triggers the exact path on macOS/Linux. The SIGTERM-without-SIGKILL point is also correct, and worse than stated: a child ignoring SIGTERM leaves the promise pending forever since nothing else rejects it.

</details>

**Verification:** `sidekick-vscode/src/services/CodexClient.test.ts` verifies abort rejects as cancellation and escalates from SIGTERM to SIGKILL instead of resolving an empty completion.

---

### P2-16 — Superseded completion requests hang forever: debounce timer cleared without resolving

- **Location:** `sidekick-vscode/src/services/CompletionService.ts:126`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** getCompletion awaits a Promise whose resolve is only invoked by the debounce setTimeout. When a newer request arrives during the debounce window it calls clearTimeout(this.debounceTimer) on the previous request's timer, so the previous promise can never settle — that getCompletion call is stuck forever. Failure scenario: user hits the manual completion trigger twice within debounceMs (default 300ms); the first provideInlineCompletionItems call never returns, its 'Generating completion...' withProgress notification (InlineCompletionProvider.ts:83) stays on screen indefinitely, and each superseded request leaks its async frame (document, context, closures) for the life of the session.

**Evidence.**

```ts
await new Promise<void>((resolve) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(resolve, debounceMs);
    });
```

**Fix.** Store the pending resolve alongside the timer (e.g. { timer, resolve }); when clearing a previous debounce, invoke its resolve() so the superseded call proceeds to the existing `requestId !== this.lastRequestId` check and returns undefined promptly. Also resolve any pending debounce in dispose().

<details><summary>Verifier notes</summary>

- Verified in CompletionService.ts:126-131 that the debounce promise's resolve is held only by the setTimeout; a newer request clears that timer before installing its own, so the superseded getCompletion call suspends at the await permanently — the requestId guard at line 134 is unreachable for it. No compensating guard exists: the token-to-abort link is registered only after the debounce, cancelPending() only aborts pendingController, and dispose() clears the timer without resolving. The caller wraps getCompletion in withProgress (Notification "Generating completion...", cancellable), which only dismisses when the callback promise settles, so the stuck notification and leaked promise chain are real consequences.
- Traced the full path in CompletionService.ts and InlineCompletionProvider.ts: the debounce promise's resolve is only reachable via the setTimeout callback, and a superseding request's clearTimeout (line 128) discards it with no other settlement path — token cancellation is only wired at line 168, after the await, and dispose() also clears without resolving. Reachability is confirmed: Ctrl+Shift+Space is bound to sidekick.triggerCompletion which fires editor.action.inlineSuggest.trigger (Invoke kind), and the shipped debounce default is 1000ms (package.json), so two manual triggers within one second — trivially achievable — strand the first getCompletion call and its withProgress notification permanently.

</details>

**Verification:** `sidekick-vscode/src/services/CompletionService.test.ts` verifies superseded and disposed debounce requests both settle instead of hanging.

---

### P2-17 — Inline chat cancel button does nothing: external AbortSignal never wired

- **Location:** `sidekick-vscode/src/services/InlineChatService.ts:71`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** InlineChatProvider.processWithProgress wires its progress cancel button to this.abortController and passes the signal into inlineChatService.process(request, signal), but process() only checks abortSignal?.aborted once at entry and never forwards it — the executeWithTimeout call omits the `externalSignal` option that ExecuteOptions explicitly provides for this purpose. Failure scenario: user clicks Cancel on the provider's 'Generating response...' notification; the AI request keeps running to completion and its result is still processed. Compounding it, TimeoutManager opens its own second progress notification (showProgress: true), so the user sees two stacked notifications where only the inner one actually cancels.

**Evidence.**

```ts
const result = await this.timeoutManager.executeWithTimeout({
      operation: opLabel,
      task: (signal: AbortSignal) =>
        this.authService.complete(fullPrompt, {
          model,
          maxTokens: 2000,
          signal,
        }),
      config: timeoutConfig,
      contextSize,
      showProgress: true,
      cancellable: true,
```

**Fix.** Pass `externalSignal: abortSignal` in the executeWithTimeout options (executeOnce already links external signals), and set showProgress: false in InlineChatService since InlineChatProvider already owns a progress notification.

<details><summary>Verifier notes</summary>

- Verified in InlineChatService.ts that process() checks abortSignal only once at entry and the executeWithTimeout call (line 71) omits externalSignal, while TimeoutManager.executeOnce demonstrably links externalSignal to its internal AbortController when provided. InlineChatProvider wires its cancellable "Generating response..." notification to an AbortController whose signal is passed to process() but never forwarded, so outer Cancel does not abort the request and the completed result is still processed (including edit-apply prompts). Every sibling service (CommitMessageService, ExplanationService, DocumentationService, ErrorExplanationService) passes externalSignal: signal, confirming the omission is a defect, and the showProgress: true double-notification claim is also accurate. The only nuance is a JSDoc note calling the abortSignal param deprecated, which does not refute the user-facing dead cancel button.
- Verified end-to-end: the sidekick.inlineChat command (extension.ts:2704) reaches processWithProgress, which wires the outer progress Cancel to this.abortController and passes its signal to process(); InlineChatService.process (line 43) checks the signal only at entry and the executeWithTimeout call (line 71) omits externalSignal, which TimeoutManager.ExecuteOptions (line 73) provides and executeOnce (lines 260-267) links for exactly this purpose. Consequence confirmed by trace: outer Cancel aborts an unheeded signal, the request completes with success:true, and the provider still shows/applies the result (including the Apply-edit prompt). The double-notification compounding is also real — showProgress:true opens TimeoutManager's own second cancellable notification (line 277), and only that inner one actually cancels.

</details>

**Verification:** `sidekick-vscode/src/services/InlineChatService.test.ts` verifies the progress cancellation token reaches inference as an aborted signal.

---

### P2-18 — MaxSubscriptionClient squashes literal model IDs to 'haiku'

- **Location:** `sidekick-vscode/src/services/MaxSubscriptionClient.ts:297`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** ModelResolver documents that anything that is not a tier or shorthand 'passes through as a literal model ID', and the Claude Agent SDK accepts full model IDs. mapModel() defeats that contract: any value outside ['haiku','sonnet','opus'] is silently replaced by 'haiku'. Failure scenario: a claude-max user sets sidekick.transformModel to 'claude-opus-4-8' (or any dated model ID) to pin a model; resolveModel passes it through, the status/progress label shows that model, but the actual request runs on haiku with no warning.

**Evidence.**

```ts
private mapModel(model?: string): string {
    const validModels = ['haiku', 'sonnet', 'opus'];
    return model && validModels.includes(model) ? model : 'haiku';
  }
```

**Fix.** Return the value unchanged when it is a plausible model ID (e.g. `if (model) return model;` with only undefined falling back to 'haiku'), or at minimum pass through values matching /^claude-/ and log when falling back.

<details><summary>Verifier notes</summary>

- Traced the full path: resolveModel (ModelResolver.ts:53-54) passes non-tier values through as literal model IDs, CompletionOptions.model (types.ts:26-29) documents full-ID acceptance, AuthService.complete forwards options untouched, and MaxSubscriptionClient.mapModel (lines 295-298, applied at line 232) silently replaces any value outside ['haiku','sonnet','opus'] with 'haiku' — no guard, no log. The Claude Agent SDK accepts full model IDs, so a claude-max user pinning e.g. sidekick.transformModel='claude-opus-4-8' silently runs on Haiku while the extension log reports the requested model.
- Traced the full path: sidekick.transformModel's own description in package.json invites "an exact model ID"; config.get returns arbitrary strings despite the enum (VS Code enums only warn); resolveModel (ModelResolver.ts:53-54) passes literals through; AuthService.complete routes options unchanged; MaxSubscriptionClient.mapModel (lines 295-298) then silently replaces any non-alias value with 'haiku' before the SDK call at line 232, with no fallback warning. The bundled @anthropic-ai/claude-agent-sdk types refute the code's rationale — Options.model is `string` with dated model IDs given as examples — so the squash is both reachable via advertised configuration and unnecessary.

</details>

**Verification:** `sidekick-vscode/src/services/InferenceModelMapping.test.ts` verifies `MaxSubscriptionClient` preserves literal model IDs while retaining legacy tier aliases.

---

### P2-19 — OpenCodeClient creates a server session per request and never cleans it up

- **Location:** `sidekick-vscode/src/services/OpenCodeClient.ts:91`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** Every complete() call creates a brand-new OpenCode session and never deletes it, so sessions accumulate on the OpenCode server/storage without bound — one per inline completion, transform, commit message, etc. Beyond the unbounded growth, these synthetic sessions land in OpenCode's normal session storage where OpenCodeSessionProvider/SessionMonitor discovers sessions, polluting monitored stats — exactly the problem MaxSubscriptionClient explicitly guards against with `persistSession: false` ('prevent SDK calls from creating JSONL files that would pollute SessionMonitor data'). Failure scenario: user with inferenceProvider=opencode does a day of inline completions; hundreds of one-shot sessions pile up and the dashboard can attach to a synthetic completion session as the 'most recent' one instead of the real coding session.

**Evidence.**

```ts
// Create a session
      const session = await client.session.create({ body: {} });
      const sessionId = session.data?.id ?? session.id;
```

**Fix.** Delete the session after extracting the response (e.g. `await client.session.delete({ path: { id: sessionId } })` in a finally block), or reuse one long-lived session per client instance and dispose it in dispose().

<details><summary>Verifier notes</summary>

- Verified in sidekick-vscode/src/services/OpenCodeClient.ts: complete() calls client.session.create({body:{}}) on every invocation (line 91), and a repo-wide grep finds no session.delete/deleteSession anywhere; dispose() only closes the spawned server handle, so sessions accumulate unbounded. The contrast claim is accurate: MaxSubscriptionClient.ts lines 237-239 set persistSession: false with the exact quoted comment about polluting SessionMonitor data. The pollution consequence is real in the common case: OpenCode persists API-created sessions to storage/session/{projectID}/ (or its DB), which sidekick-shared's OpenCodeProvider reads with no filter for synthetic sessions, sorts newest-first by mtime (openCode.ts findSessionsInDirectoryFromFiles line 990), and SessionMonitor attaches to sessions[0] (SessionMonitor.ts lines 897, 1432) — so a just-created completion session can win as "most recent" when the extension is attached to a server running in the monitored workspace.
- Verified in sidekick-vscode/src/services/OpenCodeClient.ts: complete() creates a session per call (line 91) and no session deletion/reuse exists anywhere in the repo; dispose() only closes the server handle. The path is hot and reachable — AuthService routes inline completions (1s debounce), commit messages, inline chat, explanations, etc. through OpenCodeClient when inferenceProvider=opencode (explicit setting or auto-detect), and OpenCode persists every API-created session to the same storage/DB that sidekick-shared's OpenCodeProvider monitors, with no TTL. MaxSubscriptionClient's persistSession:false comment (line 237-239) confirms the project explicitly guards against exactly this pollution on the Claude path.

</details>

**Verification:** `sidekick-vscode/src/services/OpenCodeClient.test.ts` verifies every created synthetic session is deleted in success and failure paths.

---

### P2-20 — OpenCodeClient ignores the abort signal — timeout/cancel never stops the request

- **Location:** `sidekick-vscode/src/services/OpenCodeClient.ts:87`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The requestWithTimeout work callback is declared as `async () => {...}`, discarding the AbortSignal parameter, and neither session.create nor session.prompt receives it. When the timeout fires or the user cancels, requestWithTimeout throws, but the OpenCode server keeps generating the full response (consuming provider quota/tokens) and the orphaned session finishes in the background. Failure scenario: user cancels a slow inline-chat request on the opencode provider; the UI reports cancellation while the backend continues billing the full generation. Additionally, module-level clientInstance/serverHandle (lines 19-23) mean two concurrent first requests can both fail the attach probe and both call createOpencode, spawning a second server whose handle is overwritten and never closed.

**Evidence.**

```ts
return requestWithTimeout(options, async () => {
      const client = await this.getClient();

      // Create a session
      const session = await client.session.create({ body: {} });
```

**Fix.** Accept the signal parameter (`async (signal) => ...`) and forward it to the SDK calls (the generated SDK client accepts fetch options/signal per request), aborting the underlying HTTP request; guard getClient() with a single in-flight promise to prevent double server spawn.

<details><summary>Verifier notes</summary>

- Verified in sidekick-vscode/src/services/OpenCodeClient.ts:87 that the requestWithTimeout work callback is declared `async () =>`, discarding the AbortSignal that requestWithTimeout.ts:56 passes, and neither session.create (line 91) nor session.prompt (line 119) receives it, while all three sibling clients (ApiKeyClient:47, MaxSubscriptionClient:215-217, CodexClient:63-72) correctly wire the signal — confirming an omission, not a design choice. No outer guard exists: AuthService.complete delegates directly and there is no OpenCodeClient test. The claim's mechanism is slightly wrong (requestWithTimeout has no Promise.race, so it never throws when the callback ignores the signal — cancel/timeout are complete no-ops and the caller hangs until the full generation completes), which makes the defect worse, not refuted. The secondary double-spawn race in getClient() is also real as a race window, though whether the second createOpencode leaks a server or fails with port-in-use is SDK/timing-dependent.
- Read OpenCodeClient.ts, requestWithTimeout.ts, TimeoutManager.ts, InlineChatService.ts, AuthService.ts, and the installed @opencode-ai/sdk type definitions. The signal-discard is real and the cancel path is fully reachable (VS Code cancel token → TimeoutManager AbortController → options.signal → requestWithTimeout's internal controller → ignored by the work callback), and the SDK accepts a per-request signal so the fix is straightforward. The claim's stated mechanism is wrong — requestWithTimeout does not throw because there is no Promise.race anywhere in the chain — but the surviving defect (timeout never enforced, cancel inert, full generation billed and delivered late) is at least as severe as claimed.

</details>

**Verification:** `sidekick-vscode/src/services/OpenCodeClient.test.ts` verifies request signals reach SDK calls and concurrent initialization shares one in-flight client/server creation.

---

### P2-21 — CLI path cache ignores settings changes; clearCliCache is never called

- **Location:** `sidekick-vscode/src/utils/cliPathResolver.ts:124`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** findCli consults the module-level resolvedPaths cache before ever looking at configuredPath, and a repo-wide grep shows clearCliCache has zero call sites (no configuration-change listener invokes it). Failure scenario: the extension first resolves 'claude' from PATH (or a wrong install), the user then sets sidekick.claudePath to the correct binary via Settings — every subsequent findClaudeCli() call still returns the stale cached path until the extension host restarts, so the setting appears to do nothing. The same applies to a cached path whose binary is later uninstalled: the stale path is returned forever.

**Evidence.**

```ts
// Return cached result if available
  const cached = resolvedPaths.get(binaryName);
  if (cached) return cached;

  // 1. Check user-configured path
  if (configuredPath && configuredPath.trim() !== '') {
```

**Fix.** Register a vscode.workspace.onDidChangeConfiguration listener (e.g. in activate()) that calls clearCliCache('claude') / clearCliCache('codex') when the corresponding path settings change, and/or include configuredPath in the cache key and re-validate cached paths with fs.existsSync before returning them.

<details><summary>Verifier notes</summary>

- Verified in cliPathResolver.ts that findCli returns the module-level cache (keyed only by binaryName, no existence re-check) before consulting configuredPath, and a repo-wide grep shows clearCliCache is exported but never called — no onDidChangeConfiguration listener watches sidekick.claudePath or sidekick.sidekickCliPath. AuthService's config listener only recreates client instances, which cannot clear the module-level cache, so a changed claudePath setting is ignored until the extension host restarts. The settings exist in package.json, making the failure scenario reachable exactly as described.
- Verified in cliPathResolver.ts (lines 123-128) that findCli returns the module-level cache before checking configuredPath, and repo-wide grep confirms clearCliCache has zero production call sites (only a test file) with no onDidChangeConfiguration listener covering sidekick.claudePath. The scenario is reachable: MaxSubscriptionClient.complete()/isAvailable() call findClaudeCli() on every request under the default claude-max provider, so the first successful resolution is cached and a later sidekick.claudePath change is silently ignored until extension-host restart; the cached path is also never re-validated with existsSync, so an uninstalled/relocated binary keeps being returned. Mitigating nuance: null results are not cached, so the setting works immediately if the CLI was never found — the bug only bites when a wrong-but-existing binary was cached first.

</details>

**Verification:** `sidekick-vscode/src/utils/cliPathResolver.test.ts` changes configured paths and executable availability, verifying cache keys and revalidation follow both.

---

### P2-22 — ProviderStatusService polls with no fetch timeout and no reentrancy guard

- **Location:** `sidekick-cli/src/dashboard/ProviderStatusService.ts:63`
- **Severity / category:** 🟠 medium · bug
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` complete

**Problem.** fetchProviderStatus/fetchOpenAIStatus (sidekick-shared/src/providerStatus.ts) call global fetch with no AbortSignal or timeout. The 60s setInterval fires _fetchAll unconditionally. Failure scenario: a stalled network connection (firewall drop, captive portal) -> each in-flight fetch hangs indefinitely while a new pair starts every 60s, accumulating pending sockets for the lifetime of the dashboard; additionally two overlapping _fetchAll calls can resolve out of order, letting an older, staler status response overwrite a newer one in _cached/_cachedOpenAI.

**Evidence.**

```ts
const [claude, openai] = await Promise.all([fetchProviderStatus(), fetchOpenAIStatus()]);
    this._cached = claude;
```

**Fix.** Add an in-flight guard (`if (this._fetching) return; this._fetching = true; ... finally { this._fetching = false; }`) in _fetchAll, and give the shared fetchStatusPage an `AbortSignal.timeout(10_000)` so a hung request can't outlive the poll interval.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

<details><summary>Verifier notes</summary>

- Verified in sidekick-shared/src/providerStatus.ts that fetchStatusPage calls fetch with no AbortSignal/timeout, and in ProviderStatusService.ts that the 60s setInterval invokes _fetchAll with no in-flight guard, so overlapping polls and out-of-order cache/callback overwrites are genuinely possible. However, the CLI runs on Node where fetch is undici with default ~10s connect and 300s headers/body timeouts, so requests cannot hang indefinitely and socket accumulation is bounded at roughly 5 overlapping poll iterations, refuting the "lifetime of the dashboard" leak. What remains is a real but lower-severity race: a stalled fetch resolving up to ~300s late can overwrite a fresher status with a stale or fallback state for up to one 60s poll cycle, self-correcting on the next tick.
- Verified the code matches the claim (no AbortSignal, no reentrancy guard in /Users/cesarandreslopez/code/sidekick-agent-hub/sidekick-cli/src/dashboard/ProviderStatusService.ts and sidekick-shared/src/providerStatus.ts), but the claimed failure states are unreachable: the CLI runs on Node >=20 native fetch (undici), whose default 10s connect / 300s headers / 300s body timeouts bound any hung request, capping overlap at ~5 in-flight polls (~10 sockets) rather than indefinite accumulation, with errors caught and converted to fallbackState. The out-of-order overwrite scenario produces the same user-visible outcome the design already accepts — any single failed poll unconditionally overwrites good cached status with "Status unavailable" until the next 60s tick — so no new meaningful defect remains beyond a self-correcting ≤60s cosmetic blip in a best-effort status widget.

</details>

**Verification:** `sidekick-vscode/src/services/ProviderStatusService.test.ts` verifies overlapping polls share one in-flight refresh; shared `providerStatus.test.ts` verifies hung fetches abort and fall back.

---

### P2-23 — Explicit compaction events are dropped by the message-less guard in processEvent

- **Location:** `sidekick-shared/src/aggregation/EventAggregator.ts:351`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** processEvent returns early when `event.message` is missing, and the comment itself names 'summary' as the type that lacks message. But the explicit-compaction hook `recordExplicitCompaction` sits after the guard (lines 405-407), so Claude Code summary rows (which ClaudeCodeReader passes through with no message) never record a compaction, never get a 'Context compacted' timeline entry, and never feed analytics. Only the heuristic >20%-context-drop detector can catch them afterward, so compactions reclaiming <20% (or occurring before the first usage event) are silently missing from compactionCount/compactionEvents on the SessionEvent path (shared SessionMonitor.poll, buildSessionContextSnapshot), while the FollowEvent path (jsonlWatcher summary -> processFollowEvent line 564) does record them -- the two hosts show different compaction numbers for the same session.

**Evidence.**

```ts
// Guard: some event types (e.g. 'summary') have no message field in the raw JSONL
    if (!event.message) {
      return;
    }
```

**Fix.** Before the `!event.message` return, handle the message-independent work: `if (event.type === 'summary') { this.recordExplicitCompaction(event.timestamp, event.compaction); this.addTimelineFromSessionEvent(event); }` (addTimelineFromSessionEvent needs its own message-optional handling), then return.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `sidekick-shared/src/aggregation/EventAggregator.test.ts` verifies a message-less summary records both compaction and timeline activity.

---

### P2-24 — CompletionCache key omits multiline flag, colliding across completion modes

- **Location:** `sidekick-vscode/src/services/CompletionCache.ts:73`
- **Severity / category:** ⚪ low · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** CompletionContext carries `multiline` (and `filename`) specifically for caching, but hashKey only uses language:model:prefixTail:suffixHead. A completion cleaned under one mode is served for the other. Failure scenario: user requests a completion with sidekick.multiline=false (result truncated to a single line and cached), then enables multiline and re-triggers at the same cursor within the 30s TTL — the cache returns the truncated single-line result instead of a block completion; the reverse direction inserts a cached multi-line block where a single-line completion was requested.

**Evidence.**

```ts
private hashKey(context: CompletionContext): string {
    // Use last 500 chars of prefix and first 200 of suffix
    const prefixTail = context.prefix.slice(-500);
    const suffixHead = context.suffix.slice(0, 200);
    return `${context.language}:${context.model}:${prefixTail}:${suffixHead}`;
  }
```

**Fix.** Include the multiline flag (and optionally filename) in the key: `return `${context.language}:${context.model}:${context.multiline ? 'm' : 's'}:${prefixTail}:${suffixHead}`;`.

<details><summary>Verifier notes</summary>

- Verified hashKey (CompletionCache.ts:73) omits multiline while the cached value depends on it: CompletionService builds the prompt with getSystemPrompt(context.multiline, ...) and caches the output of cleanCompletion(completion, context.multiline, ...), which truncates code to the first line when multiline=false. No onDidChangeConfiguration listener clears the cache when sidekick.multiline changes (checked extension.ts listeners; cache clears only on dispose), so flipping the setting and re-triggering at the same cursor within the 30s TTL serves the wrong-mode completion in either direction, exactly as claimed. Since multiline is otherwise determined by the setting plus language (language is in the key), the collision requires a mid-session setting flip, consistent with the claimed low severity.
- Verified hashKey (CompletionCache.ts:69-74) omits multiline while CompletionService caches the mode-dependent cleaned result: cleanCompletion (prompts.ts:203-209, 285-306) applies different length limits and truncates single-line code completions to the first line, and the prompt itself differs via getSystemPrompt(context.multiline). Reachability confirmed: multiline is re-read from settings per request (CompletionService.ts:93,111), the cache check (line 155) precedes all mode-dependent logic, and no onDidChangeConfiguration listener in extension.ts clears the cache or recreates CompletionService when sidekick.multiline changes — so toggling the setting and re-triggering at the same cursor within the 30s TTL serves the stale-mode result, precisely the flow a user follows when testing the toggle. Severity "low" is correct given the 30s TTL and same-context requirement.

</details>

**Verification:** `sidekick-vscode/src/services/CompletionCache.test.ts` stores identical input in single-line and multiline modes and verifies the entries do not collide.

---
