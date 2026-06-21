# Phase 04 — Non-destructive switching, live-home apply, migration

**Workstream:** WS4 · **Package:** `sidekick-shared` · **Depends on:** 01, 02, 03 · **Blocks:** 06, 07, 08

## Goal

Make Claude switching **non-destructive and lossless** (each account keeps its own profile home; switching
back never loses the rotated credential), while keeping plain `claude`/editors/sidekick-inference working
with **zero env config** via a "live-home apply" step. Migrate existing installs from the old flat backup
layout (`credentials/{uuid}.*`, `configs/{uuid}.*`) into per-account profile homes.

> Mirror the Codex design that already exists: `performCodexAuthSwap` (`codexProfiles.ts:532`) +
> `reconcileCodexAuthState` (`codexProfiles.ts:647`). Claude should end up structurally analogous.

## Files to touch

- `sidekick-shared/src/accounts.ts` — `switchToAccount`:209 (refactor), add `applyActiveClaudeToLiveHome`,
  `resolveActiveClaudeHome`, `reconcileClaudeAuthState`.
- `sidekick-shared/src/claudeProfiles.ts` — may host `resolveActiveClaudeHome` / profile-home helpers.
- `sidekick-shared/src/accounts.test.ts` (extend).

## Step-by-step

1. **Profile home is canonical.** After Phase 03, each Claude account has
   `claude/profiles/{uuid}/home/` with its own `.claude.json` + credentials (keychain-suffixed on macOS, or
   `.credentials.json` file otherwise). Treat that as the durable per-account store; the flat
   `credentials/{uuid}.*` + `configs/{uuid}.*` files become a compatibility/backup mirror.
2. **`resolveActiveClaudeHome()`** — analogue of `resolveSidekickCodexHome` (`codexProfiles.ts:353`). Returns
   the active account's profile home if one is active, else `~/.claude`. Used by readers that want the active
   account's config without env juggling.
3. **`applyActiveClaudeToLiveHome()`** — the "make the active account visible to plain `claude`" step:
   - Read the active profile's credentials: `readActiveCredentials(profileHome)` (Phase 02).
   - Write them to the **default** live store: `writeActiveCredentials(creds /* no dir */)` → default keychain
     `Claude Code-credentials` / `~/.claude/.credentials.json`.
   - Merge the profile's `oauthAccount` into `~/.claude/.claude.json` (reuse the merge in `switchToAccount`
     step 4, `accounts.ts:288`).
   - Atomic + rollback on failure (the existing `switchToAccount` already has a rollback pattern at
     `accounts.ts:280,296` — preserve it).
4. **Refactor `switchToAccount(uuid)`** so the **registry pointer is the source of truth**:
   - Update `activeByProvider['claude-code']` via `setActiveSavedAccount` (`accountRegistry.ts:175`).
   - Call `applyActiveClaudeToLiveHome()` so existing zero-config consumers keep working.
   - Keep the public signature + `AccountManagerResult` return unchanged. Keep the current backup-of-current
     behavior for safety, but source the *target* credentials from the profile home (falling back to the flat
     backup files if a profile home doesn't exist yet — pre-migration accounts).
5. **`reconcileClaudeAuthState()`** — idempotent migration (marker file
   `accounts/claude/.profiles-migrated-v1`, like `codexProfiles.ts:649`). For each saved Claude account
   without a profile home: create `claude/profiles/{uuid}/home/`, write `.claude.json` (`{ oauthAccount }`
   from `configs/{uuid}.config.json`) and the credential (`credentials/{uuid}.credentials.json` → keychain
   suffix entry on macOS, or `.credentials.json` file otherwise). Best-effort; never throw; never break
   startup. Call it where `reconcileCodexAuthState` is already called (find its call site;
   `ensureDefaultAccounts` / extension activation).
6. **macOS caution:** writing per-account keychain entries (suffix) and the default entry are separate
   `security` calls; each may prompt. Batch writes; tolerate user-denied prompts (return a warning, don't crash).

## Acceptance criteria / tests

- After `switchToAccount(B)`, `getActiveSavedAccount('claude-code')` is B **and** the live home reflects B's
  `oauthAccount` + credentials; switching back to A restores A losslessly (fixture-based, non-darwin file mode).
- `resolveActiveClaudeHome()` returns the active profile home when set, `~/.claude` otherwise.
- `reconcileClaudeAuthState()` migrates a fixture with flat backups into profile homes, writes the marker,
  and is a no-op on second run (marker present). Never throws on malformed input.
- Pre-migration accounts (flat backups, no profile home) can still be switched to.

## Done-when

`npx vitest run src/accounts.test.ts` passes incl. new cases; switching is lossless in the fixture round-trip;
migration is idempotent. Manual macOS round-trip is part of Phase 07 verification. Update tracker row 04.
