# Phase 5 — Cross-Package Consolidation & Release Hygiene

> Part of the [Sidekick Agent Hub review backlog](./README.md). Read the README first for methodology, trust levels, conventions, and the working loop.

**Goal.** Retire drifted duplicate copies in the extension in favor of sidekick-shared, and fix CI/build/release gaps. Also sweeps up confirmed shared quota/account/persistence hygiene bugs. Consolidation must not break the published sidekick-shared API.

**This phase:** 25 findings — 1 high, 12 medium, 12 low.

## Progress tracker

Update the Status box as you go: `[ ]` todo → `[~]` in progress → `[x]` done (or `[-]` if dropped after re-verification). Keep the one-line note current.

| ID    | Sev | Trust | Location                                     | Finding                                                                                             | Status |
| ----- | --- | ----- | -------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| P5-01 | 🔴  | ✅    | `providers/ProviderDetector.ts:30`           | VS Code ProviderDetector misses OpenCode installs at ~/.local/share on macOS/Windows                | `[x]`  |
| P5-02 | 🟠  | ✅    | `src/autoSwitch.ts:102`                      | Auto-switch trusts arbitrarily old cached snapshots when picking the target account                 | `[x]`  |
| P5-03 | 🟠  | ✅    | `src/codexQuotaWatcher.ts:284`               | CodexQuotaWatcher rescans every rollout tail (up to ~100MB) every 30s when idle                     | `[x]`  |
| P5-04 | 🟠  | ✅    | `src/errorHistory.ts:53`                     | error-history.json grows without bound — every session appends, nothing prunes                      | `[x]`  |
| P5-05 | 🟠  | ✅    | `src/terminalSync.ts:92`                     | installShellHook rename-over ~/.zshrc destroys symlinked rc files and resets permissions            | `[x]`  |
| P5-06 | 🟠  | 🟡    | `workflows/cli-ci.yml:63`                    | sidekick-cli is never linted or type-checked in any CI workflow                                     | `[x]`  |
| P5-07 | 🟠  | 🟡    | `sidekick-cli/package.json:70`               | CLI double-ships MCP SDK and zod: bundled into the binary AND declared runtime deps                 | `[x]`  |
| P5-08 | 🟠  | 🟡    | `services/QuotaService.ts:105`               | VS Code QuotaService drifted from shared QuotaPoller the CLI already adopted                        | `[x]`  |
| P5-09 | 🟠  | ⚠️    | `workflows/release.yml:92`                   | Release workflow swallows every ovsx publish failure, not just 'already published'                  | `[x]`  |
| P5-10 | 🟠  | ⚠️    | `services/NotificationTriggerService.ts:258` | Master sidekick.notifications.enabled toggle ignored by cycle and token notifications               | `[x]`  |
| P5-11 | 🟠  | ⚠️    | `services/PersistenceService.ts:190`         | PersistenceService.save() race drops mutations/deletions made during the awaited write              | `[x]`  |
| P5-12 | 🟠  | ⚠️    | `services/PlanPersistenceService.ts:99`      | savePlan dedup never matches untitled plans, appending duplicate 'Untitled Plan' entries            | `[x]`  |
| P5-13 | 🟠  | ⚠️    | `providers/ProviderDetector.ts:160`          | VS Code ProviderDetector ignores rotated Codex state_N.sqlite databases                             | `[x]`  |
| P5-14 | ⚪  | ✅    | `src/multiProviderQuotaService.ts:389`       | During transient failures with cached data, no update is emitted and staleness is never marked      | `[x]`  |
| P5-15 | ⚪  | ✅    | `readers/handoff.ts:11`                      | readLatestHandoff replaces the first '.json' occurrence anywhere in the path                        | `[x]`  |
| P5-16 | ⚪  | ✅    | `statusline/formatter.ts:63`                 | Statusline ETA is not capped at the 5h window reset — prints impossible '~37h left'                 | `[x]`  |
| P5-17 | ⚪  | 🟡    | `sidekick-cli/esbuild.cjs:56`                | CLI build script exits silently on non-esbuild failures                                             | `[x]`  |
| P5-18 | ⚪  | 🟡    | `sidekick-shared/CHANGELOG.md:8`             | Unreleased shared fix exists only in sidekick-shared/CHANGELOG.md, not the root or docs changelogs  | `[x]`  |
| P5-19 | ⚪  | 🟡    | `src/modelInfo.ts:385`                       | getModelPricing does a linear prefix scan over the hydrated LiteLLM catalog per event               | `[-]`  |
| P5-20 | ⚪  | 🟡    | `types/historicalData.ts:83`                 | Shared HistoricalDataStore type omits the hourly field the canonical schema writes                  | `[x]`  |
| P5-21 | ⚪  | 🟡    | `src/zaiQuotaWatcher.ts:244`                 | ZaiQuotaWatcher.lastError is never cleared — one quota error taints every future emission           | `[x]`  |
| P5-22 | ⚪  | 🟡    | `services/TaskPersistenceService.ts:72`      | Task store file watcher is never closed when listeners unsubscribe and refreshes on unrelated files | `[x]`  |
| P5-23 | ⚪  | 🟡    | `utils/changelogParser.ts:7`                 | changelogParser copy in vscode is dead weight with a stale justification                            | `[x]`  |
| P5-24 | ⚪  | ⚠️    | `services/SidekickCliService.ts:35`          | nvm CLI path candidates sorted lexicographically, picking older node versions                       | `[x]`  |
| P5-25 | ⚪  | ⚠️    | `services/TaskPersistenceService.ts:160`     | sessionCount incremented on every periodic task persist, not per session                            | `[x]`  |

---

## Findings

### P5-01 — VS Code ProviderDetector misses OpenCode installs at ~/.local/share on macOS/Windows

- **Location:** `sidekick-vscode/src/services/providers/ProviderDetector.ts:30`
- **Severity / category:** 🔴 high · bug
- **Trust:** ✅ confirmed (manual read)
- **Status:** `[x]` done

**Problem.** The vscode copy of OpenCode data-dir resolution has drifted behind sidekick-shared. Shared getOpenCodeDataDir() (sidekick-shared/src/providers/openCode.ts:82-119, added in commit 69f2b67) probes a candidate list starting with ~/.local/share/opencode and returns the first dir containing opencode.db before falling back to the platform default. The vscode local copy returns the platform dir unconditionally (Application Support on darwin, LOCALAPPDATA on win32). On macOS, when OpenCode stores its data in ~/.local/share/opencode (the case the shared fix exists for), detectProvider() computes hasOpenCode=false, so auto-detection (extension.ts:308 and AuthService.ts:102 both call this live) silently selects Claude Code or Codex and the dashboard monitors the wrong/no agent, while the shared OpenCodeProvider itself would have found the data. Explicitly configuring sidekick.sessionProvider=opencode works, making the auto-detect failure look like random flakiness.

**Evidence.**

```ts
if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'opencode');
  }
... (shared side, openCode.ts:86-101): const candidates = [path.join(os.homedir(), '.local', 'share', 'opencode')]; ... if (fs.existsSync(path.join(candidate, 'opencode.db'))) return candidate;
```

**Fix.** Delete the local getOpenCodeDataDir/getOpenCodeStorageDir helpers and detection heuristics; import getOpenCodeDataDir, detectProvider, and getAllDetectedProviders from sidekick-shared (all exported from index.ts:212/214 and already bundled). Keep only the vscode-config lookup and the ProviderId -> SessionProvider instance mapping in the extension.

**Verification:** `ProviderDetector.test.ts` proves configured and automatic detection delegate to the shared detector and maps Claude sessions to Claude Max inference; the extension compile gate bundles the shared implementation.

---

### P5-02 — Auto-switch trusts arbitrarily old cached snapshots when picking the target account

- **Location:** `sidekick-shared/src/autoSwitch.ts:102`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** Candidate quotas for non-active accounts come from readQuotaSnapshot, which returns the last persisted sample marked stale:true — but decideAutoSwitch filters only on candidate.quota?.available and never checks stale/capturedAt age. Failure scenario: account B's snapshot is a week old showing 10% utilization; account A crosses the 90% threshold -> controller switches live credentials to B even though B may be fully exhausted right now, and because switchedDuringCrossing is then set, the user is parked on the exhausted account until utilization reporting crosses back below threshold.

**Evidence.**

```ts
const best = candidates
  .filter(
    (candidate) =>
      candidate.accountId !== active.accountId &&
      candidate.switchable !== false &&
      candidate.quota?.available,
  )
  .sort((a, b) => quotaRemaining(b.quota) - quotaRemaining(a.quota))[0];
```

**Fix.** Add a freshness gate: ignore candidates whose quota.capturedAt is older than the relevant window (e.g., > 5h for the fiveHour window) or whose fiveHour.resetsAt is already in the past — or treat past-reset snapshots as 0% utilization explicitly and stale in-window snapshots as unknown (excluded).

<details><summary>Verifier notes</summary>

- Verified in code: decideAutoSwitch (autoSwitch.ts:98-105) filters only on available/switchable, while the default readSnapshot is readQuotaSnapshot, which returns arbitrarily old persisted samples explicitly marked stale:true — a flag nothing in the auto-switch path consults. Snapshots are only ever written for the actively-sampled account (quotaHistory.ts:276, CodexSessionProvider.ts:33), so non-active candidates' quotas are frozen at last-active time, and the extension (extension.ts:1265) uses the default reader in production. The switchedDuringCrossing parking consequence is also accurate: after switching, the flag only clears when active utilization drops below threshold (autoSwitch.ts:200-202, 239).
- Verified in code: decideAutoSwitch (autoSwitch.ts:98-105) filters only on quota?.available, and readQuotaSnapshot (quotaSnapshots.ts:153-169) returns the last persisted sample with stale:true but no age/reset gating; the production controller (extension.ts:1265) uses the default readSnapshot. Snapshots for non-active accounts are never refreshed (quotaHistory.ts:276 writes only from the active account's samples; MultiProviderQuotaService polls only active credentials), so unbounded snapshot age is the normal steady state, and the switchedDuringCrossing latch (lines 224/239, cleared only below threshold at 200-202) does park the user on the chosen account. The claim's exact "switch to exhausted B" scenario is reachable but requires B's quota to be consumed out-of-band (second machine/claude.ai on the same account — a normal pattern, since quota is account-wide and the snapshot store is local).

</details>

**Verification:** `autoSwitch.test.ts` supplies a stale snapshot older than five hours and proves it cannot be selected; controller tests still cover valid threshold switching.

---

### P5-03 — CodexQuotaWatcher rescans every rollout tail (up to ~100MB) every 30s when idle

- **Location:** `sidekick-shared/src/codexQuotaWatcher.ts:284`
- **Severity / category:** 🟠 medium · perf
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** refreshActiveSession runs on a 30s interval; whenever there is no active Codex session (or the active session has not emitted rate_limits yet) it calls emitCachedOrUnavailable, which calls resolveCodexQuotaFromLocalSources. That path (codexQuota.ts) recursively walks every directory under each Codex home's sessions/ tree, stats every file, then tail-reads up to DEFAULT_MAX_SESSION_FILES=50 files x DEFAULT_TAIL_BYTES=2MB each. A user with Codex history but no live session (the common idle case) pays up to ~100MB of disk reads plus a full tree walk every 30 seconds, forever, in both the VS Code extension and the CLI dashboard (MultiProviderQuotaService owns this watcher). emitState dedupes the emission but not the scan.

**Evidence.**

```ts
localProvider = this.providerFactory();
const local = resolveCodexQuotaFromLocalSources({
  workspacePath: this.workspacePath,
  activeAccount: account,
  readSnapshot: this.readSnapshot,
  writeSnapshot: this.writeSnapshot,
  provider: localProvider,
  maxTailBytes: this.maxTailBytes,
  maxSessionFiles: this.maxSessionFiles,
});
```

**Fix.** Cache the local-scan result in the watcher (e.g., remember the newest rollout mtime seen and skip the rescan unless a cheap top-level mtime check on the sessions dirs changed), or fall straight to readSnapshot when a scan already ran within the last N minutes with no filesystem change.

<details><summary>Verifier notes</summary>

- The mechanics are all confirmed in code: refreshActiveSession fires every 30s, the no-session/no-rate-limits path calls resolveCodexQuotaFromLocalSources unconditionally (codexQuotaWatcher.ts:284), that function walks every Codex sessions/ tree and tail-reads up to 50 files x 2MB with no caching, and emitState dedupes only the emission, not the scan. However, the blast radius is overstated: the CLI dashboard never uses this watcher (dashboard.ts:637 gets Codex quota from the event stream; no MultiProviderQuotaService in sidekick-cli), and in the VS Code extension the watcher only runs when sidekick.accounts.autoSwitchThreshold > 0, which defaults to 0. Also, findActiveSession returns the newest workspace-matching rollout even when Codex is idle, so a user with Codex history in the current workspace takes the cheap attached-reader path; the heavy rescan repeats only when no rollout matches the workspace or the matched rollout never emitted rate_limits.
- The code mechanics check out: refreshActiveSession runs on a 30s interval and its fallback path calls resolveCodexQuotaFromLocalSources with no scan caching (emitState dedupes only the emission), and that function walks every sessions/ tree, stats every rollout, and tail-reads up to 50 files x 2MB per pass. However, tracing callers refutes the claimed reach: the CLI never uses CodexQuotaWatcher/MultiProviderQuotaService (Codex quota there comes from FollowEvent), and in VS Code the watcher only exists when sidekick.accounts.autoSwitchThreshold > 0 (default 0 = disabled). Also, the claimed common trigger is wrong: findActiveSession has no recency cutoff, so a user with Codex history in the current workspace attaches to the newest rollout, caches its rate_limits on readAll, and never rescans; the repeated scan only occurs when no rollout matches the workspace cwd (or the matching rollout has no rate_limits sample).

</details>

**Verification:** `codexQuotaWatcher.test.ts` performs two idle refreshes under one cache window and asserts only the first creates a local fallback scanner while cached quota remains visible.

---

### P5-04 — error-history.json grows without bound — every session appends, nothing prunes

- **Location:** `sidekick-shared/src/errorHistory.ts:53`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** appendErrorHistory (called from the extension on every session end, extension.ts:436) appends a record to `sessions` with no retention cap, unlike historical-data.json which has HISTORICAL_SESSION_RETENTION_LIMIT. The file grows forever; getTopFailingTools/readErrorHistory JSON.parse the entire file on each `sidekick stats` run and updateJsonStoreAtomic re-reads, re-spreads, and re-serializes the whole array on every append, so both the file size and the per-session write cost grow linearly with lifetime session count.

**Evidence.**

```ts
await updateJsonStoreAtomic(filePath, emptyStore, (store) => ({
  ...store,
  schemaVersion: ERROR_HISTORY_SCHEMA_VERSION,
  sessions: [...store.sessions, record],
  lastSaved: record.endedAt,
}));
```

**Fix.** Cap the array in the update callback, e.g. `sessions: [...store.sessions, record].slice(-MAX_ERROR_HISTORY_SESSIONS)` (a few hundred is plenty for the 7-day getTopFailingTools window), or drop records older than a retention horizon (e.g. 30 days) on each append. Also guard `Array.isArray(store.sessions)` before spreading.

<details><summary>Verifier notes</summary>

- Verified every element: errorHistory.ts:53 appends with no cap and no other code touches error-history.json (no external pruning exists); extension.ts:436 appends on every session end, even for sessions with zero failures; historical-data.json and quota history both prune (HISTORICAL_SESSION_RETENTION_LIMIT=500, 91-day retention), making this the only unbounded store; updateJsonStoreAtomic (writers/atomic.ts) re-reads/re-spreads/re-serializes the full array per append and CLI stats parses the whole file each run. The claim stands as written; severity is at the generous end since records are small and growth is slow, but the defect is real.
- I attempted to refute the claim but every element checks out. errorHistory.ts:50-55 appends unconditionally with no cap, and a repo-wide grep shows the only code touching error-history.json is errorHistory.ts itself — nothing prunes it, unlike historical-data.json (HistoricalDataService.ts:111 applies .slice(-HISTORICAL_SESSION_RETENTION_LIMIT), limit 500) and quotaHistory.ts (91-day pruneFileSync). The trigger is routinely reachable: extension.ts:436 runs in the onSessionEnd handler, SessionMonitor fires \_onSessionEnd from at least five sites (session switch, inactivity, dispose), and a record is appended even for failure-free sessions, so the array grows with every session end in any workspace. The cost claims are also accurate: updateJsonStoreAtomic (writers/atomic.ts:33-55) re-reads, re-spreads, and re-serializes the full store with 2-space indent per append, and sidekick stats (sidekick-cli/src/commands/stats.ts:161) JSON.parses the whole file via getTopFailingTools(7). The secondary point holds too — updateJsonStoreAtomic does no shape validation, so a file where sessions is not an array would make the spread throw.

</details>

**Verification:** `errorHistory.test.ts` seeds the maximum history, appends once, and proves the oldest entry is pruned while the newest 500 remain.

---

### P5-05 — installShellHook rename-over ~/.zshrc destroys symlinked rc files and resets permissions

- **Location:** `sidekick-shared/src/terminalSync.ts:92`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** installHookInFile rewrites the user's ~/.zshrc / ~/.bashrc via atomicWriteFile, which writes a tmp file and fs.renameSync's it over the target. If the rc file is a symlink into a dotfiles repo (very common), the rename replaces the symlink with a plain file: the dotfiles-managed original stops being sourced and future dotfile syncs silently diverge. The rewrite also forces mode 0o600 regardless of the file's previous permissions, and getShellRcPaths unconditionally includes ~/.zshrc so a bash-only user gets a new ~/.zshrc created.

**Evidence.**

```ts
function installHookInFile(filePath: string): void {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const cleaned = stripShellHook(existing).replace(/\s*$/, '');
  const next = cleaned ? `${cleaned}\n\n${buildShellHookBlock()}` : buildShellHookBlock();
  atomicWriteFile(filePath, next, 0o600);
}
```

**Fix.** Resolve the target with fs.realpathSync before writing so the content lands in the symlink's destination, preserve the existing file's mode (fs.statSync(...).mode), and only install into rc files that already exist (create at most the one matching the user's $SHELL).

<details><summary>Verifier notes</summary>

- Verified all three sub-claims in sidekick-shared/src/terminalSync.ts: atomicWriteFile (lines 31-45) uses writeFileSync-to-tmp + renameSync, and rename(2) replaces a destination symlink with a plain file rather than following it; the tmp file is created with hardcoded mode 0o600 which the rename carries onto the rc file regardless of its prior mode; and getShellRcPaths (lines 75-81) includes ~/.zshrc unconditionally while gating only ~/.bashrc on existence, so bash-only users get a new ~/.zshrc. No realpath/lstat/symlink guard exists anywhere in the file, its tests, or callers.
- Verified the code: atomicWriteFile does tmp-write + renameSync with forced mode 0o600, rename(2) replaces a destination symlink with the plain tmp file, and getShellRcPaths unconditionally includes ~/.zshrc — all three technical claims are accurate, and uninstallHookInFile shares the same flaw. The triggering filesystem state (symlinked rc via stow/hand-linked dotfiles) is common and the failure is deterministic on any call. The only reachability caveat: no in-repo caller exists — neither the CLI nor the VS Code extension invokes installShellHook — so it fires only through the exported public API of the published sidekick-shared package, which the changelog explicitly advertises as an opt-in shell-hook helper for host consumers.

</details>

**Verification:** `terminalSync.test.ts` proves installation preserves an rc symlink and its target mode, and creates only the current shell's rc file when none exists.

---

### P5-06 — sidekick-cli is never linted or type-checked in any CI workflow

- **Location:** `.github/workflows/cli-ci.yml:63`
- **Severity / category:** 🟠 medium · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** grep across .github/workflows shows lint runs only for vscode (ci.yml:42, release.yml:74) and shared (release.yml:118 only). The CLI's 'npm run lint' is invoked by no workflow, and the CLI has no tsc typecheck anywhere (tsconfig is noEmit, build is esbuild which strips types without checking, vitest does not typecheck). So type errors and lint violations in sidekick-cli land on main and ship to npm unchecked. Additionally, shared's lint runs only at release time, so a shared-only lint error merges silently and then blocks the npm publish — the exact failure mode the maintainer has already hit.

**Evidence.**

```ts
cli-ci.yml steps: '- name: Install dependencies\n        run: npm ci\n\n      - name: Run tests\n        run: npm test\n\n      - name: Build CLI\n        run: npm run build' (no lint, no tsc); sidekick-cli/package.json scripts have no typecheck entry and tsconfig has "noEmit": true
```

**Fix.** Add 'npm run lint' and a 'npx tsc --noEmit' step to the cli-tests job in cli-ci.yml and to the publish-npm job in release.yml; add 'npm run lint' for sidekick-shared to the shared-tests job in cli-ci.yml (or ci.yml) so shared lint failures surface pre-merge instead of at release.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** CLI CI and release now run shared lint plus CLI lint/typecheck; local `npm run lint` and `npx tsc --noEmit` complete cleanly.

---

### P5-07 — CLI double-ships MCP SDK and zod: bundled into the binary AND declared runtime deps

- **Location:** `sidekick-cli/package.json:70`
- **Severity / category:** 🟠 medium · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** esbuild.cjs bundles with no externals (only './sidekick-main.mjs'), and '@modelcontextprotocol/sdk' + 'zod' are statically imported in src/commands/mcp.ts, so they are inside dist/sidekick-main.mjs (grep of the built bundle confirms 'modelcontextprotocol' occurrences). Yet package.json lists both as runtime "dependencies", so every 'npm i -g sidekick-agent-hub' downloads the full MCP SDK tree plus zod v3 that is never loaded at runtime — pure install bloat, unlike chalk/ink/react/commander/sidekick-shared which are correctly devDependencies. Related waste: the bundle contains two zod majors (CLI's zod ^3.25.76 for the MCP SDK and shared's zod ^4.3.6), inflating the 2.4 MB binary.

**Evidence.**

```ts
"dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.25.76"
  } — while esbuild.cjs builds with bundle: true and external: ['./sidekick-main.mjs'] only
```

**Fix.** Move '@modelcontextprotocol/sdk' and 'zod' to devDependencies (they are bundled like every other dep). Longer term, align the CLI's direct zod usage with shared's zod v4 (or import z from a shared re-export) so only one zod copy is bundled.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** the package and lockfile classify MCP SDK and Zod as build-time dependencies; `build-all.sh` produces a self-contained CLI and the built binary runs `--help` without runtime installs.

---

### P5-08 — VS Code QuotaService drifted from shared QuotaPoller the CLI already adopted

- **Location:** `sidekick-vscode/src/services/QuotaService.ts:105`
- **Severity / category:** 🟠 medium · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** sidekick-cli/src/dashboard/QuotaService.ts delegates to shared QuotaPoller ('Delegates to the shared QuotaPoller for polling, caching, and backoff'), which adds exponential backoff on transient failures (quotaPoller.ts:166-177), stop-on-auth-failure (139-143), and notifies listeners with cached state annotated with the error (147-154). The vscode QuotaService re-implements polling with a bare setInterval: no backoff, it keeps polling forever after auth failures, and when it serves stale cached quota (lines 78-81) it returns without firing \_onQuotaUpdate, so event-driven consumers never learn the data is stale/errored. The two surfaces now behave differently for the same quota source, and future poller fixes land only on the CLI side.

**Evidence.**

```ts
this._refreshInterval = setInterval(() => this.fetchQuota(), this.REFRESH_INTERVAL_MS);
... if (shouldKeepCachedQuota(state) && this._cachedQuota?.available) {
      log('Fetch failed, using cached quota');
      return this._cachedQuota;
    }
```

**Fix.** Rebuild the vscode QuotaService on shared QuotaPoller (as the CLI QuotaService does), wiring poller.onUpdate into the vscode EventEmitters and keeping the vscode-only \_recordHistorySample hook in the update callback.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `QuotaService.test.ts` proves refresh lifecycle delegates once to `QuotaPoller` and retryable failures emit stale cached quota with error metadata.

---

### P5-09 — Release workflow swallows every ovsx publish failure, not just 'already published'

- **Location:** `.github/workflows/release.yml:92`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** The Open VSX publish step appends '|| echo "Already published — continuing"' to the whole command. Any failure — expired OVSX_PAT, network error, registry rejection, malformed .vsix — exits 0 and the release goes green while no extension was published. The npm jobs handle the same idempotency correctly by pre-checking 'npm view <pkg>@<version>' and failing hard on real publish errors; the extension job is the only one with a blanket error suppressor. As a side note the tooling is also unpinned ('npx ovsx', 'npx @vscode/vsce'), so a breaking major of either tool changes release behavior silently.

**Evidence.**

```ts
run: npx ovsx publish sidekick-for-max-${{ needs.validate.outputs.version }}.vsix || echo "Already published — continuing"
```

**Fix.** Pre-check whether the version already exists on Open VSX (ovsx get or the registry HTTP API) and skip explicitly, letting a real 'ovsx publish' failure fail the job — mirroring the npm-view pattern used by publish-shared/publish-npm. Pin ovsx and @vscode/vsce versions (npx ovsx@x.y.z or devDependencies).

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** workflow inspection confirms a 200/404 Open VSX preflight is the only skip path, unexpected HTTP responses and publish errors fail the job, and both publishing CLIs are pinned.

---

### P5-10 — Master sidekick.notifications.enabled toggle ignored by cycle and token notifications

- **Location:** `sidekick-vscode/src/services/NotificationTriggerService.ts:258`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** When `sidekick.notifications.enabled` is false, loadTriggers() returns [] which silences all pattern-based triggers, but handleCycleDetected and handleTokenUsage bypass this.triggers entirely: handleCycleDetected checks only the per-trigger key `triggers.cycle-detected` (default true) and handleTokenUsage (lines 509-535) checks only `this.tokenThreshold > 0`. Failure scenario: user sets sidekick.notifications.enabled=false to silence Sidekick -> agent enters a tool-call loop or crosses 500K tokens -> warning toasts still appear, contradicting the documented master switch ('Enable session monitoring notifications').

**Evidence.**

```ts
const config = vscode.workspace.getConfiguration('sidekick.notifications');
if (!config.get<boolean>('triggers.cycle-detected', true)) return; // no check of config.get('enabled')
```

**Fix.** Add a shared `isNotificationsEnabled()` check (reading `sidekick.notifications.enabled`) at the top of handleCycleDetected and handleTokenUsage, or cache the enabled flag in loadTriggers() and consult it in both handlers.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `NotificationTriggerService.test.ts` disables the master setting, emits both cycle and high-token events, and proves neither creates a warning.

---

### P5-11 — PersistenceService.save() race drops mutations/deletions made during the awaited write

- **Location:** `sidekick-vscode/src/services/PersistenceService.ts:190`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** save() captures `pending = this.store`, awaits updateJsonStoreAtomic (which can block up to 3s on the cross-process lock), then unconditionally sets isDirty=false and pendingDeletions.clear(), and replaces this.store with the merged object. Failure scenario: while the write is in flight (after mergeStoreForSave has already run), the user clicks 'Clear Completed' on the task board -> TaskPersistenceService.clearCompleted() mutates the OLD store object, calls recordDeletions(keys) and markDirty(). When the await resolves, this.store is replaced by the pre-clear merged object, isDirty is forced back to false, and pendingDeletions.clear() erases the recorded deletions; the debounced save scheduled by markDirty then early-returns on `if (!this.isDirty) return`. Result: the cleared/archived tasks silently resurrect (same for KnowledgeNoteService.deleteNote and DecisionLogService.clearAll).

**Evidence.**

```ts
this.store = await updateJsonStoreAtomic(this.dataFilePath, this._createEmptyStore, (latest) =>
  this.mergeStoreForSave(latest, pending),
);
this.isDirty = false;
this.pendingDeletions.clear();
```

**Fix.** Snapshot dirty state before the await: record a generation counter incremented by markDirty()/recordDeletions(); after the await, only clear isDirty/pendingDeletions if the generation is unchanged, and re-apply pending mutations (or simply reschedule save()) if it changed. Also merge the returned store with any post-snapshot in-memory mutations instead of overwriting this.store unconditionally.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `PersistenceService.test.ts` pauses an atomic write, mutates the store in flight, releases the write, and proves the later mutation survives and is flushed next.

---

### P5-12 — savePlan dedup never matches untitled plans, appending duplicate 'Untitled Plan' entries

- **Location:** `sidekick-vscode/src/services/PlanPersistenceService.ts:99`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** The persisted record stores `title: planState.title || 'Untitled Plan'` (line 82) but the update-vs-insert lookup compares the stored title against the RAW `planState.title`. When planState.title is undefined/empty, `p.title` is 'Untitled Plan' while `planState.title` is undefined, so findIndex never matches and every save unshifts a new entry. Additionally when the session summary is unavailable, extension.ts:453 falls back to `unknown-${Date.now()}` for sessionId, guaranteeing a unique key each time. Failure scenario: a session with an untitled plan ends (or ends/resumes/ends across idle boundaries) -> plan history accumulates duplicate 'Untitled Plan' rows until MAX_PLANS_PER_PROJECT evicts real history.

**Evidence.**

```ts
const existingIdx = this.store.plans.findIndex(
  (p) => p.sessionId === sessionId && p.title === planState.title,
);
```

**Fix.** Compare against the normalized title actually persisted: `const title = planState.title || 'Untitled Plan';` then `findIndex((p) => p.sessionId === sessionId && p.title === title)`, and reuse `title` when building `persisted`.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `PlanPersistenceService.test.ts` saves two untitled updates for one session and proves one normalized `Untitled Plan` record remains with the latest content.

---

### P5-13 — VS Code ProviderDetector ignores rotated Codex state_N.sqlite databases

- **Location:** `sidekick-vscode/src/services/providers/ProviderDetector.ts:160`
- **Severity / category:** 🟠 medium · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** Shared detect.ts gained rotation-aware Codex state DB matching (/^state(?:\_\d+)?\.sqlite$/ in hasCodexStateDb/getCodexStateDbMtime, detect.ts:18-42; codexDatabase.ts:134 scans the same pattern), but the vscode copy still checks only the literal state.sqlite in both presence detection (lines 160-164, 227-231) and activity-mtime ranking (lines 108-114). A Codex install whose DB has rotated to state_1.sqlite (and whose sessions dir is absent or has older mtimes) is either not detected at all or ranked with a stale mtime, so auto-detection picks the wrong session provider and detectInferenceProvider() picks the wrong inference provider.

**Evidence.**

```ts
const hasCodex = codexHomes.some(
    (codexHome) =>
      fs.existsSync(path.join(codexHome, 'sessions')) ||
      fs.existsSync(path.join(codexHome, 'state.sqlite')),
  );
... (shared detect.ts:20): fs.readdirSync(codexHome).some((entry) => /^state(?:_\d+)?\.sqlite$/.test(entry))
```

**Fix.** Same as the OpenCode drift: replace the vscode-local filesystem heuristics with sidekick-shared's detectProvider/getAllDetectedProviders, or at minimum port hasCodexStateDb/getCodexStateDbMtime from sidekick-shared/src/providers/detect.ts.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** the extension now has no Codex filesystem heuristic to drift; `ProviderDetector.test.ts` proves it delegates to shared detection, whose rotated-state regression test passes in the shared suite.

---

### P5-14 — During transient failures with cached data, no update is emitted and staleness is never marked

- **Location:** `sidekick-shared/src/multiProviderQuotaService.ts:389`
- **Severity / category:** ⚪ low · ux
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** handleTransientFailure emits nothing when a previously successful Claude state is visible: listeners keep rendering the old sample as if it were current for the entire outage — no stale flag, no failure descriptor, and capturedAt drifting further from reality (an outage spanning a 5-hour reset shows utilization/reset times that are simply wrong). Contrast with readQuotaSnapshot consumers, which at least get stale:true. The error is only visible in the log callback.

**Evidence.**

```ts
this.cachedFallbackActive = hasVisibleCachedSuccess;
if (!hasVisibleCachedSuccess) {
  this.emitClaudeState(state);
}
```

**Fix.** When hasVisibleCachedSuccess, emit the cached lastSuccessfulClaudeState augmented with { stale: true, source: 'cache', error: state.error, failureKind: state.failureKind } so dashboards can badge the data as cached instead of presenting it as live.

<details><summary>Verifier notes</summary>

- Read multiProviderQuotaService.ts:372-393 and confirmed handleTransientFailure emits nothing when a cached success is visible, so listeners keep rendering the old sample as live with no stale flag or failure info (log-only visibility). The contrast is real — quotaSnapshots.ts:167, codexQuotaWatcher.ts:312, and zaiQuotaApi.ts:382 all mark cache fallbacks stale:true — and the fix is cheap: ProviderQuotaState already supports stale/source, and both the VS Code dashboard (DashboardViewProvider.ts:7149) and CLI (commands/quota.ts:412-414) already render stale/cache badges, so the augmented emit lights up existing UI. No test pins the no-emit behavior; the only implementation caveats are emitting once per fallback entry and not letting the stale-flagged emit overwrite lastSuccessfulClaudeState via updateProviderQuota (line 222-223).

</details>

**Verification:** `multiProviderQuotaService.test.ts` polls successfully then receives a 503 and proves a second update carries the prior utilization with `source: cache`, `stale: true`, and failure metadata.

---

### P5-15 — readLatestHandoff replaces the first '.json' occurrence anywhere in the path

- **Location:** `sidekick-shared/src/readers/handoff.ts:11`
- **Severity / category:** ⚪ low · bug
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** String.replace with a string literal replaces the first match, not the extension. Slugs preserve dots (encodeWorkspacePath only replaces [:/_]), so a workspace like /Users/x/my.json.app yields slug '-Users-x-my.json.app' and path '.../handoffs/-Users-x-my.json.app.json'; the replace produces '.../handoffs/-Users-x-my-latest.md.app.json' — a nonexistent file — so the handoff silently reads as missing. projectMigration.ts builds the same path correctly as `${slug}-latest.md`, so migration and reader can also disagree.

**Evidence.**

```ts
const filePath = getProjectDataPath(slug, 'handoffs').replace('.json', '-latest.md');
```

**Fix.** Build the path directly instead of string surgery: `path.join(getConfigDir(), 'handoffs', `${slug}-latest.md`)` (matching projectMigration.ts), or at minimum anchor the replace: `.replace(/\.json$/, '-latest.md')`.

<details><summary>Verifier notes</summary>

- Verified every link in the chain: handoff.ts:11 does a first-occurrence string replace of '.json'; paths.ts getProjectDataPath appends `${slug}.json`; encodeWorkspacePath only strips [:/_] so dots survive into slugs; and both the writer (HandoffService.ts:74) and projectMigration.ts:52-55 build `${slug}-latest.md` directly, so a workspace path containing '.json' makes the reader target a file that is never written, with the error silently swallowed. No guard, type constraint, or test prevents dotted slugs. The defect is real but only fires for workspace paths containing a literal '.json' substring, so the claimed low severity is correct.
- Verified all links in the chain: getProjectDataPath produces `handoffs/${slug}.json`, encodeWorkspacePath (paths.ts:44-47) preserves dots so slugs can contain `.json`, and the string-form replace at handoff.ts:11 rewrites the first occurrence anywhere in the path. A concrete real-world trigger exists — opening a workspace like a checkout of the actual repo `package.json-validator` produces slug `-Users-x-code-package.json-validator`, and the reader then probes `...-package-latest.md-validator.json`, which never exists, while the writer (HandoffService.ts:74) and projectMigration.ts:53-54 correctly write `${slug}-latest.md`. The empty catch swallows ENOENT so the handoff silently reads as null on real product paths (context composer, HandoffService, CLI handoff command). The condition is rare, so the stated "low" severity is accurate.

</details>

**Verification:** `readers/handoff.test.ts` uses the slug `client.json-tools` and proves only the final file extension is replaced.

---

### P5-16 — Statusline ETA is not capped at the 5h window reset — prints impossible '~37h left'

- **Location:** `sidekick-shared/src/statusline/formatter.ts:63`
- **Severity / category:** ⚪ low · ux
- **Trust:** ✅ confirmed (2 verifiers)
- **Status:** `[x]` done

**Problem.** estimateWindowEta extrapolates linearly to 100% with no cap at the window's remaining lifetime. Inputs: utilization 10%, 250 minutes into the window → burnRate 0.04%/min → estimateTimeToQuota(10, 100, 0.04) = 2250 min → the statusline renders 'acct:x · 5h 10% resets 14:05 · ~37h30m left', an ETA 7x longer than the 5-hour window that resets in 50 minutes. Stale snapshots past resetAt (sampleAt > resetAt) also produce elapsed > 300 min and a bogus ETA from expired utilization data.

**Evidence.**

```ts
const elapsedMinutes = (sampleAt - (resetAt - FIVE_HOUR_WINDOW_MS)) / 60_000;
if (elapsedMinutes <= 0 || quota.fiveHour.utilization <= 0) return null;
const burnRate = quota.fiveHour.utilization / elapsedMinutes;
return estimateTimeToQuota(quota.fiveHour.utilization, 100, burnRate);
```

**Fix.** Return null (or omit the ETA segment) when the projected exhaustion time exceeds minutes-until-reset — i.e. cap with `Math.min(eta, (resetAt - now.getTime()) / 60_000)` and suppress when the cap wins — and return null when sampleAt >= resetAt (snapshot from an already-expired window).

<details><summary>Verifier notes</summary>

- Read estimateWindowEta (formatter.ts:55-64) and estimateTimeToQuota (BurnRateCalculator.ts:50-58): the linear extrapolation to 100% has no cap at time-until-reset, and the proposal's arithmetic (10% at 250 min → 2250 min → "~37h30m left" beside a reset 50 min away) is exact. The stale-snapshot claim also holds — readQuotaSnapshot (quotaSnapshots.ts:153-169) returns cached snapshots with no expiry check and the formatter never compares capturedAt to resetsAt, and the CLI statusline command is a cache-only hot path run on every prompt, so both paths are user-visible. No upstream guard exists; the codebase's own projectQuotaWindow caps its analogous projection, underscoring the gap.

</details>

**Verification:** `statusline/formatter.test.ts` covers a reachable cap ETA, an exhaustion estimate beyond reset, and an already-passed reset; only the reachable ETA is rendered.

---

### P5-17 — CLI build script exits silently on non-esbuild failures

- **Location:** `sidekick-cli/esbuild.cjs:56`
- **Severity / category:** ⚪ low · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** main().catch(() => process.exit(1)) discards the error entirely. esbuild's own compile errors print via its logger, but any other failure — a broken require('./package.json'), a plugin throw, fs errors — makes 'npm run build' (and prepublishOnly during npm publish, and the 'Build CLI' release step) exit 1 with zero diagnostics. The sibling script sidekick-vscode/esbuild.js gets this right with 'main().catch((e) => { console.error(e); process.exit(1); })'.

**Evidence.**

```ts
main().catch(() => process.exit(1));
```

**Fix.** Match the vscode build script: main().catch((e) => { console.error(e); process.exit(1); });

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** the catch handler now reports the original error before exiting; the CLI build and packaged-binary smoke test pass through `build-all.sh`.

---

### P5-18 — Unreleased shared fix exists only in sidekick-shared/CHANGELOG.md, not the root or docs changelogs

- **Location:** `sidekick-shared/CHANGELOG.md:8`
- **Severity / category:** ⚪ low · ux
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** Commit 2f0c9a8 ('fix(shared): tolerate message-less session events') added an [Unreleased] Fixed entry to the shared changelog only. CHANGELOG.md (root, 'full project'), docs/changelog.md, and the vscode/cli changelogs have no corresponding entry (grep for 'Unreleased' and 'message-less' matches nothing outside the shared file). The repo convention (and the release job's changelog extraction, release.yml:203-218, which reads only the root CHANGELOG.md) means this fix will be silently missing from the next GitHub release notes unless someone remembers to copy it forward at tag time.

**Evidence.**

```ts
## [Unreleased]

### Fixed

- **Observed-session message-less events**: `derivePendingUserRequestV1()` now tolerates Claude Code summary and other bookkeeping rows without a `message`...
```

**Fix.** Mirror the entry into an [Unreleased] section of the root CHANGELOG.md (and docs/changelog.md) now, so the next version bump only has to rename the heading; keep all five changelogs moving together as the project convention requires.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** all five changelogs contain an Unreleased entry for message-less observed-session events, including the root file consumed by the release workflow.

---

### P5-19 — getModelPricing does a linear prefix scan over the hydrated LiteLLM catalog per event

- **Location:** `sidekick-shared/src/modelInfo.ts:385`
- **Severity / category:** ⚪ low · perf
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[-]` dropped — verifier measurements refute a meaningful performance defect: real model IDs hit exact keys and rare misses cost only microseconds.

**Problem.** After hydratePricingCatalog runs, overrideSortedKeys holds the full LiteLLM catalog (thousands of keys, roughly doubled by the bare-model duplicates from normalizeLiteLlmCatalog). Dated Claude IDs like 'claude-opus-4-6-20250620' miss the exact-match check, so every lookup walks the whole sorted key list doing startsWith. EventAggregator calls getModelPricing per assistant event (EventAggregator.ts:492), so replaying a large session file performs thousands-of-keys x thousands-of-events string scans for a value that is identical for the handful of distinct model IDs in a session.

**Evidence.**

```ts
function findLongestPrefix(keys: string[], modelId: string): string | null {
  for (const key of keys) {
    if (modelId === key || modelId.startsWith(key)) return key;
  }
  return null;
}
```

**Fix.** Memoize resolved lookups in a Map<string, ModelPricing | null> inside modelInfo.ts (cleared by \_setPricingOverrides/\_clearPricingOverrides so hydration invalidates it). A session has few distinct model IDs, so a tiny cache removes virtually all scans.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

<details><summary>Verifier notes</summary>

- Verified in code: findLongestPrefix (modelInfo.ts:385) is a linear startsWith scan, lookupPricing has no memoization, hydration fills overrideSortedKeys with the full LiteLLM catalog (4,015 keys in the real cache on this machine, bare-model duplicates included), and EventAggregator.ts:492 calls getModelPricing per assistant event lacking a reported cost. However, probing the actual hydrated catalog refutes the claim's central example: real dated Claude IDs (claude-opus-4-5-20251101, claude-sonnet-4-5-20250929, etc.) are exact keys in LiteLLM and hit the O(1) path; only IDs absent verbatim — brand-new dated models not yet in the catalog, and always-unpriced IDs like '<synthetic>' — take the full per-event scan of both tables with no negative caching.
- The claim's triggering condition is empirically false: dated Claude IDs (e.g. claude-opus-4-5-20251101, claude-haiku-4-5-20251001) exist as exact keys in the hydrated LiteLLM catalog, so overrideTable[modelId] hits at O(1) and findLongestPrefix never runs — verified against the real 4,015-key cache at ~/.config/sidekick/pricing-catalog.json and against model IDs found in 400 real session JSONL files (all exact hits except rare '<synthetic>' events, 13 occurrences). The only reachable scan cases (synthetic placeholder events, a brand-new model before catalog refresh) were benchmarked at 4-7 microseconds per lookup, i.e. tens of milliseconds even across a pathological 10k-event replay, far below the cost of parsing the JSONL itself. No meaningful perf defect remains.

</details>

**Verification:** re-verification used the documented real catalog/session measurements; no cache or code change was justified.

---

### P5-20 — Shared HistoricalDataStore type omits the hourly field the canonical schema writes

- **Location:** `sidekick-shared/src/types/historicalData.ts:83`
- **Severity / category:** ⚪ low · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** The shared file declares 'Canonical source: sidekick-vscode/src/types/historicalData.ts', but the canonical type has HourlyData (line 117) and 'hourly?: Record<string, HourlyData[]>' (line 206), which HistoricalDataService actively writes into ~/.config/sidekick/historical-data.json (HistoricalDataService.ts:172-178). The shared mirror lacks both, so readHistory() consumers — the CLI's stats/today/StaticDataLoader and external npm consumers of sidekick-shared — get a typed store where the hourly data on disk is invisible, and cannot build hourly analytics without unsafe casts. Since sidekick-shared is the published public API, the mirror being behind the canonical schema is an API-completeness drift.

**Evidence.**

```ts
export interface HistoricalDataStore {
  schemaVersion: number;
  daily: Record<string, DailyData>;
  monthly: Record<string, MonthlyData>;
  allTime: AllTimeStats;
  lastSaved: string;
  ... (no hourly field) — vscode canonical has: hourly?: Record<string, HourlyData[]>;
```

**Fix.** Add HourlyData and the optional hourly field to sidekick-shared/src/types/historicalData.ts, then make the vscode types/historicalData.ts a re-export of the shared module (like codex.ts/opencode.ts already are) so the schema has a single source of truth.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** the shared TypeScript build validates the additive `HourlyData` API and extension re-export; the full historical-data service suite continues to pass hourly bucket behavior.

---

### P5-21 — ZaiQuotaWatcher.lastError is never cleared — one quota error taints every future emission

- **Location:** `sidekick-shared/src/zaiQuotaWatcher.ts:244`
- **Severity / category:** ⚪ low · bug
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** recomputeAndEmit unconditionally re-applies this.lastError to every computed state, and nothing ever resets lastError to null — not window expiry, not the authoritative resetsAt passing, not new successful turns. Failure scenario: user hits a 1308 five-hour limit once; days later, with fresh usage well under budget, every emitted state (and every persisted snapshot/history sample via writeSnapshot/maybeAppendHistory) still carries error + failureKind 'rate_limit' + rateLimitReachedType, so UIs keep showing a rate-limited banner indefinitely. Module is deprecated but still exported from the public sidekick-shared surface.

**Evidence.**

```ts
if (this.lastError) {
  state.error = this.lastError.message;
  state.failureKind = this.lastError.kind === 'expired' ? 'auth' : 'rate_limit';
  state.rateLimitReachedType = this.lastError.kind;
}
```

**Fix.** Clear this.lastError once now() passes the error's resetsAt (or after a fixed TTL when resetsAt is absent), e.g. at the top of recomputeAndEmit: if (this.lastError?.resetsAt && Date.parse(this.lastError.resetsAt) <= nowMs) this.lastError = null.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

<details><summary>Verifier notes</summary>

- Verified by reading zaiQuotaWatcher.ts in full: lastError is assigned only at init (null) and in ingestError, and recomputeAndEmit unconditionally re-applies it to every emitted/persisted state; no clearing logic exists anywhere (grep confirms), despite the "If we recently saw an error" comment implying recency was intended. ZaiQuotaError.resetsAt exists, so the suggested fix is sound, and no test or external guard contradicts the defect. The defect is real but its blast radius is smaller than implied: the module is deprecated, constructed by nothing in-repo except its own tests, and reachable externally only via the "./dist/\*" deep-import subpath (it is not re-exported from the index barrel).
- The code reading is accurate — lastError is set in ingestError (line 190) and never reset, so lines 244-248 taint every emission for the instance's lifetime. But the failing state is unreachable: repo-wide grep and git history (-S "new ZaiQuotaWatcher" across all branches) show the watcher has never been instantiated by any product code — only its own unit test — and no UI subscribes to it, so the claimed "rate-limited banner shown indefinitely" cannot occur. The claim's "still exported from the public sidekick-shared surface" is also wrong: index.ts/node.ts/browser.ts export only zaiQuotaApi symbols; the class is reachable solely via the generic "./dist/\*" wildcard deep import, and the only known external consumer pins 0.18.5, which predates the z.ai modules (shipped 0.21.1). Even hypothetically the taint is process-lifetime-bounded, since a restart nulls lastError and the first recompute overwrites the persisted snapshot.

</details>

**Verification:** `zaiQuotaWatcher.test.ts` advances an injected clock past the authoritative reset and proves subsequent state drops both error and failure kind.

---

### P5-22 — Task store file watcher is never closed when listeners unsubscribe and refreshes on unrelated files

- **Location:** `sidekick-vscode/src/services/TaskPersistenceService.ts:72`
- **Severity / category:** ⚪ low · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** onDidChange's returned Disposable only removes the listener from the set; the fs.FSWatcher on the whole tasks directory keeps running (until service dispose) even with zero listeners, and every onDidChange call tears down and recreates the watcher. The watch callback also ignores the filename argument, so writes to ANY project's task file (or its .tmp/.lock siblings from atomic writes, including this process's own saves) trigger a full refreshFromDisk of this project's store plus listener notifications. Payoff: filtering on the event filename (`path.basename(this.dataFilePath)`) and closing the watcher when changeListeners becomes empty removes redundant disk reads and cross-project re-render churn in multi-window/multi-project setups.

**Evidence.**

```ts
onDidChange(listener: () => void): vscode.Disposable {
    this.changeListeners.add(listener);
    this.startFileWatcher();
    return { dispose: () => this.changeListeners.delete(listener) };
  }
```

**Fix.** In the fs.watch callback, ignore events whose filename is neither the store's basename nor undefined; in the returned dispose, close the watcher when `this.changeListeners.size === 0`; and skip startFileWatcher() when a watcher already exists.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `TaskPersistenceService.test.ts` disposes the final listener, replaces the task file, waits past debounce, and proves no callback fires; target-name filtering is exercised by the existing atomic replacement test.

---

### P5-23 — changelogParser copy in vscode is dead weight with a stale justification

- **Location:** `sidekick-vscode/src/utils/changelogParser.ts:7`
- **Severity / category:** ⚪ low · improvement
- **Trust:** 🟡 plausible (1 verifier)
- **Status:** `[x]` done

**Problem.** The file's header claims a local copy is required 'because the extension's tsconfig rootDir prevents cross-package imports', but the extension imports from 'sidekick-shared' in dozens of files (BurnRateCalculator.ts is literally 'export { BurnRateCalculator } from sidekick-shared'), and shared exports parseChangelog from its index (sidekick-shared/src/index.ts:346). The two copies are currently identical modulo comments, but the copy re-creates the exact drift channel that already bit ProviderDetector — and the misleading comment encourages future contributors to keep forking instead of importing.

**Evidence.**

```ts
* NOTE: This is a local copy of sidekick-shared/src/parsers/changelogParser.ts
 * because the extension's tsconfig rootDir prevents cross-package imports.
```

**Fix.** Delete the body and re-export: export { parseChangelog } from 'sidekick-shared'; export type { ChangelogEntry } from 'sidekick-shared'; update DashboardViewProvider.ts imports (lines 59-60) accordingly.

**Before you fix:** this finding was only single-verified. Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** the extension shim now only re-exports the shared parser/types; extension compile and the full dashboard/shared parser suites pass.

---

### P5-24 — nvm CLI path candidates sorted lexicographically, picking older node versions

- **Location:** `sidekick-vscode/src/services/SidekickCliService.ts:35`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** getNvmSidekickPaths claims to enumerate node versions 'most recent first' but sorts directory names like 'v22.9.0'/'v22.10.0' lexicographically. Failure scenario: user has ~/.nvm/versions/node/v22.9.0 and v22.10.0 with sidekick installed under v22.10.0's default alias; '.sort().reverse()' orders 'v22.9.0' before 'v22.10.0' (and 'v9.x' before 'v20.x'), so findCli probes the older version's bin first and can launch a stale sidekick binary (or trigger the outdated-CLI nag against the wrong install).

**Evidence.**

```ts
return fs
  .readdirSync(nvmDir)
  .sort()
  .reverse()
  .map((v) => path.join(nvmDir, v, 'bin', 'sidekick'));
```

**Fix.** Sort numerically by semver components, e.g. `.sort((a, b) => cmpSemver(parse(b), parse(a)))` where parse strips the leading 'v' and splits on '.', or reuse the existing isNewer() helper in this same file as the comparator.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `SidekickCliService.test.ts` sorts `v22.10.0`, `v22.9.0`, and `v20.18.0` and proves numeric-semver descending order.

---

### P5-25 — sessionCount incremented on every periodic task persist, not per session

- **Location:** `sidekick-vscode/src/services/TaskPersistenceService.ts:160`
- **Severity / category:** ⚪ low · bug
- **Trust:** ⚠️ unverified — re-check first
- **Status:** `[x]` done

**Problem.** saveSessionTasks unconditionally bumps sessionCount, but TaskBoardViewProvider calls it repeatedly during a single session (\_maybePersistTasks debounced auto-persist on every board update, TaskBoardViewProvider.ts:214-222, plus session end and dispose). Failure scenario: one long session with periodic persists inflates sessionCount by dozens/hundreds, so the stored 'sessions' figure (surfaced in the 'Loaded persisted tasks: N tasks from M sessions' log and available to any store consumer, including the CLI which shares this file) is wildly wrong.

**Evidence.**

```ts
this.store.lastSessionId = sessionId;
this.store.sessionCount++;
this.markDirty();
```

**Fix.** Only increment when the session actually changes: `if (this.store.lastSessionId !== sessionId) { this.store.sessionCount++; }` before assigning lastSessionId.

**Before you fix:** this finding was not adversarially verified (its verifier agents hit a session limit). Re-read the cited code and confirm the failure is real and reachable before changing anything; if it does not hold, mark Status `[-]` with a one-line reason.

**Verification:** `TaskPersistenceService.test.ts` saves the same session twice and a second session once, then proves `sessionCount` is exactly two.

---
