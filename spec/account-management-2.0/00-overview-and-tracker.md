# Sidekick Account Management 2.0 — Spec & Progress Tracker

> **Read this file first.** It is the index + live status board for the whole effort. Every phase has its
> own file (`01`–`09`, plus `api-contract.md` and `integration-guide.md`). Each phase file is
> self-sufficient: **Goal · Files to touch · Step-by-step · Acceptance criteria / tests · Done-when**.
> When you finish a phase, update the **Progress Tracker** table below.

---

## 1. Why this exists (context)

A downstream consumer of `sidekick-shared` — the Tauri desktop in `contextful-com/contextful_desktop`
(issue #203) — shows *read-only* status of which Claude Code / Codex account is active, but has **no in-app
way to switch or acquire accounts**. The investigation found:

- `sidekick-shared` already implements switching between **already-saved** accounts (pure local file I/O).
- But the saved-account registry is empty in practice, because **nothing ever acquires a new account**.
- Acquiring a new account needs an interactive `claude`/`codex` **browser-OAuth login**, which a TTY-less
  desktop cannot orchestrate today. The Codex two-phase flow exists in `sidekick-shared`, but the actual
  login **spawn lives only in the CLI** (`sidekick-cli/src/commands/account.ts:211 runCodexLogin`,
  `stdio:'inherit'` — needs a TTY). Claude has **no isolated-login path at all**.

**Outcome:** ship sidekick **0.21.0** (`shared` + `cli` + `vscode`) turning account management into a
first-class, headless-capable, multi-account, **non-destructive** subsystem, plus a public API + Zod
schemas + integration guide so any consumer can build the full "Manage accounts" UX (issue Option A).
**Do not edit `contextful_desktop`** (separate repo; project policy).

## 2. What we borrowed from the reference repos

Both references are Tauri account/config switchers at `/Users/cesarandreslopez/code/references/{ai-switcher,cc-switch}`.

| Idea | Source (verified) | Decision |
|---|---|---|
| **Isolated-profile login** via `CLAUDE_CONFIG_DIR` / `CODEX_HOME` so acquisition never disturbs the active account | ai-switcher `src-tauri/src/tools.rs:537 launch_profile_login` | **Adopt** — generalize to Claude (Codex already does it) |
| **Login-completion polling** (watch ~2s for ~3min, emit event) | ai-switcher `src-tauri/src/app_state.rs:3286 spawn_login_watch` | **Adopt** — see Phase 03 |
| **Claude isolated keychain detection**: service `Claude Code-credentials-{suffix}`, `suffix = sha256(CLAUDE_CONFIG_DIR)[:8]` | ai-switcher `src-tauri/src/quota.rs:349 claude_keychain_suffix` | **Adopt** — 3-line Node port; lynchpin (Phase 01) |
| **Active-pointer files + idempotent shell hook** (`# >>> … >>>` markers) | ai-switcher `src-tauri/src/tools.rs:923 install_shell_hook` | **Adopt** — opt-in (Phase 05) |
| **Per-account launchers** (`claude-work`, `codex-pro`) | ai-switcher `src-tauri/src/tools.rs:667 write_launcher` | **Adopt** — opt-in (Phase 05) |
| **Auto-switch when active account hits a quota threshold** | ai-switcher `src-tauri/src/app_state.rs:759 refresh_tool` | **Adopt** — opt-in, **off by default** (Phase 06) |
| **Atomic writes (tmp+rename), keep backups, preserve perms** | cc-switch `src-tauri/src/config.rs:204 atomic_write` | Already present in sidekick; reuse |
| In-process device-code OAuth (no CLI spawn) | cc-switch `src-tauri/src/commands/auth.rs:82` | **Reject** for Claude — reverse-engineering Anthropic PKCE is fragile; reuse the official CLI login |
| SQLite SSOT, session-manager terminal launch | cc-switch | Out of scope (sidekick uses a JSON registry + already monitors sessions) |

## 3. Target architecture — unified profile model for both providers

Source of truth stays `~/.config/sidekick/accounts/accounts.json` (already v2, multi-provider, via
`accountRegistry.ts`). Both providers get the **same shape**:

```
~/.config/sidekick/accounts/
  accounts.json                      # registry: activeByProvider + profiles (EXISTING)
  credentials/{uuid}.credentials.json  # EXISTING Claude backup (migrated away in Phase 04)
  configs/{uuid}.config.json           # EXISTING Claude backup (migrated away in Phase 04)
  claude/profiles/{uuid}/home/       # NEW: acts as CLAUDE_CONFIG_DIR (isolated)
  codex/profiles/{id}/codex-home/    # EXISTING
  active/{claude,codex}.profile      # NEW: pointer files for shell-hook terminal sync (Phase 05)
```

Three independently-testable layers:

1. **Acquisition (isolated login).** Log a *new* account into its own profile home; detect completion;
   register it — never touching the currently-active account.
2. **Switching (non-destructive).** The registry pointer is the source of truth. An `apply` step mirrors
   the active profile into the canonical **live home** (`~/.claude` keychain default entry / `~/.codex/auth.json`)
   so plain `claude`/`codex` and sidekick's own inference keep working with **zero env config**. Because each
   account keeps its own profile home, switching back is always lossless (fixes today's single-keychain-entry
   fragility).
3. **Terminal sync (opt-in).** Active-pointer files + idempotent shell hook + per-account launchers, for
   users who want different accounts live in different terminals simultaneously.

## 4. Phase map

| Phase | File | Workstream | Package |
|---|---|---|---|
| 01 | `01-claude-profiles.md` | Claude isolated-profile primitives + keychain suffix | shared |
| 02 | `02-credential-io.md` | Parameterize credential I/O by config dir | shared |
| 03 | `03-login-facade.md` | `beginAccountLogin` / `getAccountLoginStatus` / `finalizeAccountLogin` / `spawnAccountLogin` | shared |
| 04 | `04-switching-apply.md` | Non-destructive switch + live-home apply + Claude migration | shared |
| 05 | `05-terminal-sync.md` | Shell hook, active-pointer files, per-account launchers | shared |
| 06 | `06-auto-switch.md` | Auto-switch on quota threshold (opt-in, off by default) | shared (+cli/vscode flags) |
| 07 | `07-cli.md` | CLI `account --login/--launcher/--auto-switch`, `--provider all`, `quota --all --json` | cli |
| 08 | `08-vscode.md` | "Add account (sign in)…", switch QuickPick, multi-provider quota, auto-switch setting | vscode |
| 09 | `09-exports-schemas-guide.md` | `index.ts` exports, Zod schemas, docs + integration guide | shared/docs |
| — | `api-contract.md` | The public TS signatures + Zod shapes consumers depend on | reference |
| — | `integration-guide.md` | Exact call sequence for a TTY-less desktop (contextful) | reference |

**Recommended order:** 01 → 02 → 03 → 04 (these are the contextful unblocker; could ship alone) → 09
(exports/schemas so the contract is consumable) → 05 → 06 → 07 → 08. 07/08 depend on 03–06.

## 5. Progress Tracker

> Update on every change. **Status:** `Not started` / `In progress` / `Blocked` / `Done`.

| # | Phase | Status | Owner | PR / commit | Notes |
|---|---|---|---|---|---|
| 01 | Claude profiles + keychain suffix | Done | Codex | phase-01 commit | suffix vectors + profile auth primitives |
| 02 | Credential I/O parameterization | Done | Codex | phase-02 commit | config-dir credential reads/writes; no-arg defaults preserved |
| 03 | Login facade + spawn helper | Not started | | | the contextful unblocker |
| 04 | Non-destructive switch + migration | Not started | | | `reconcileClaudeAuthState` |
| 05 | Terminal sync (opt-in) | Not started | | | shell hook + launchers |
| 06 | Auto-switch on quota | Not started | | | off by default |
| 07 | CLI surface | Not started | | | `--login`, `--provider all`, `quota --all` |
| 08 | VS Code surface | Not started | | | login command + QuickPick |
| 09 | Exports + Zod + guide | Not started | | | schemas dir already exists |
| R | Release 0.21.0 | Not started | | | versions+changelogs+lint (§7) |

## 6. Ground-truth references (verified line numbers)

`sidekick-shared/src/`:
- `accounts.ts` — `AccountManagerResult`:41 (already has `needsLogin`/`profileId`/`codexHome`),
  `readActiveClaudeAccount`:133, `addCurrentAccount`:148, `switchToAccount`:209, `removeAccount`:315,
  `getClaudeConfigPath`:56, `atomicWriteJson`:85, `getCredentialsDir`/`getConfigsDir`:67/71.
- `codexProfiles.ts` — `getCodexProfileHome`:103, `isCodexProfileAuthenticated`:325, `getCodexLoginStatus`:272,
  `resolveSidekickCodexHome`:353, `getCodexExecutionEnv`:359, `prepareCodexAccount`:366, `finalizeCodexAccount`:407,
  `performCodexAuthSwap`:532, `switchToCodexAccount`:635, `reconcileCodexAuthState`:647, `removeCodexAccount`:717,
  `atomicWriteFile`:131, `atomicWriteJson`:115.
- `credentialIO.ts` — `KEYCHAIN_SERVICE`:17, `getCredentialsFilePath`:19, `readActiveCredentials`:31,
  `writeActiveCredentials`:58.
- `accountRegistry.ts` — `AccountProviderId`:5, `AccountIdentityMetadata`:7, `SavedAccountProfile`:14,
  `SavedAccountRegistry`:24, `getAccountsDir`:43, `listSavedAccountProfiles`:147, `getActiveSavedAccount`:155,
  `upsertSavedAccountProfile`:163, `setActiveSavedAccount`:175, `replaceSavedAccountProfiles`:182,
  `removeSavedAccountProfile`:194.
- `accountStatus.ts` — `getActiveAccountStatus`.
- `multiProviderQuotaService.ts` — `class MultiProviderQuotaService`:78, `onUpdate`:166, `getLatest`:180,
  `updateProviderQuota`:184, `poll`:257. `quotaPoller.ts` — `class QuotaPoller`:50.
- `index.ts` — account exports ~321–373, quota ~375–414, **existing** `schemas/quota` + `schemas/quotaHistory`
  exports ~485–499. **`sidekick-shared/src/schemas/` already exists** — add account schemas there.

`sidekick-cli/src/`:
- `cli.ts` — global `--provider`:32, `resolveProviderId`:38 (returns `ProviderId`), `quota` cmd:166,
  `account` cmd:208–220.
- `commands/account.ts` — `accountAction`:34, `claudeAccountAction`:58, `codexAccountAction`:234,
  `runCodexLogin`:211. `commands/quota.ts` — `quotaAction`.

`sidekick-vscode/src/`:
- `services/AccountService.ts`, `services/AccountStatusBar.ts`, `services/QuotaService.ts`.
- `extension.ts` — `QuotaService` import:40 / init:414, `AccountService` import:78 / init:944,
  `AccountStatusBar` import:79 / init:947.

ai-switcher (reference, verified): keychain suffix algorithm `sha256(path)[:4 bytes]` hex; verified vectors —
`…/accounts/claude/53d79dfb-fbe4-41fb-9827-e8afd2e128bb` → `e3c60653`; `/Users/hoangphan/.ai-switcher-logintest` → `8244da8e`.

## 7. Release 0.21.0 checklist (per `CLAUDE.md` + maintainer memory)

- Bump version to **0.21.0** in `sidekick-vscode/package.json`, `sidekick-cli/package.json`,
  `sidekick-shared/package.json`; refresh `sidekick-cli/package-lock.json` + `sidekick-shared/package-lock.json`
  (`npm install --package-lock-only` in each).
- Update **all four** changelogs: root `CHANGELOG.md`, `sidekick-vscode/CHANGELOG.md`,
  `sidekick-cli/CHANGELOG.md`, `docs/changelog.md`. **No orphan `[Unreleased]` heading** — strip the
  placeholder; keep all four in sync.
- Run `npm run lint` in **all three** packages (shared/vscode/cli) — CI lints each separately; a shared-only
  error blocks the npm publish.
- Build everything: `bash scripts/build-all.sh` (CLI + shared), `npm run build` (vscode).
- Commits: Conventional Commits, **no Claude `Co-Authored-By` trailer** (this repo credits humans only).
  Branch `feature/account-manager-2.0`.
- Release is triggered by pushing a `v0.21.0` tag to `main` (CI: validate → publish Open VSX → publish npm →
  GitHub release). Only tag/push when the maintainer asks.

## 8. Risks (carry into every phase)

- **macOS keychain is the top risk.** Isolated Claude login writes `Claude Code-credentials-{suffix}`; the
  live-home apply writes the default `Claude Code-credentials`. Validate the suffix on a real machine early
  (Phase 01 unit test + one manual end-to-end). Keychain permission prompts can appear.
- **The `claude` login command varies by CLI version.** `claude /login` (interactive REPL command) vs first-run
  `claude` vs `claude auth login` (used by ai-switcher). `beginAccountLogin` must return a command verified
  against the installed `claude`; make it detectable/overridable (Phase 03).
- **Migrating existing Claude backups** must be best-effort + idempotent (marker file), mirroring
  `reconcileCodexAuthState` (Phase 04).
- **Codex OS-keyring accounts** can't be file-swapped (already handled with a warning, `codexProfiles.ts:438`);
  preserve that behavior through the facade.
- **Backward compatibility:** keep existing `addCurrentAccount`/`switchToAccount`/`switchToCodexAccount`
  signatures; the new facade is additive. contextful currently pins `0.18.5` → bump to `0.21.0`.
