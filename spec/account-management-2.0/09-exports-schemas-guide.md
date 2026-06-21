# Phase 09 — Exports, Zod schemas, docs + integration guide

**Workstream:** WS9 · **Package:** `sidekick-shared` + `docs` · **Depends on:** 01–06 · **Blocks:** consumers

## Goal

Make the new surface consumable: re-export everything from the package root, ship **Zod schemas** for the
facade types (so consumers get TS + Zod parity for IPC validation out of the box), and document the exact
call sequence a TTY-less desktop uses. This is what lets contextful (issue #203) build Option A without
reimplementing keychain/auth detection.

## Key fact

`zod@^4.3.6` is **already** a dependency of `sidekick-shared`, and **`sidekick-shared/src/schemas/` already
exists** with `schemas/quota` and `schemas/quotaHistory` (re-exported from `index.ts` ~485–499). Follow that
established pattern — do **not** invent a new location or add a dependency.

## Files to touch

- `sidekick-shared/src/index.ts` — account exports live ~321–373; add the new modules there. Schema
  re-exports go in the schemas block ~485+.
- **New:** `sidekick-shared/src/schemas/accountManager.ts` (+ `schemas/accountManager.test.ts`).
- **New:** `docs/` page(s) for account management; link from `mkdocs.yml` (built with **zensical**, not mkdocs).
- `api-contract.md` and `integration-guide.md` in this spec folder are the source content for the docs page.

## Step-by-step

1. **Re-export from `index.ts`:**
   - `claudeProfiles.ts` (Phase 01): `getClaudeProfilesDir`, `getClaudeProfileHome`, `claudeKeychainSuffix`,
     `claudeKeychainService`, `isClaudeProfileAuthenticated`, `readClaudeProfileIdentity`.
   - `accountManager.ts` (Phase 03): `beginAccountLogin`, `getAccountLoginStatus`, `finalizeAccountLogin`,
     `spawnAccountLogin`, `switchAccount`, `listAllAccounts`, and all related types.
   - `accounts.ts` additions (Phase 04): `applyActiveClaudeToLiveHome`, `resolveActiveClaudeHome`,
     `reconcileClaudeAuthState`.
   - `terminalSync.ts` (Phase 05) and `autoSwitch.ts` (Phase 06) public functions/types.
2. **Zod schemas** in `schemas/accountManager.ts`, matching `api-contract.md` exactly:
   `accountProviderIdSchema`, `beginAccountLoginResultSchema`, `accountLoginStatusSchema`,
   `accountManagerResultSchema`, `accountEntrySchema`, `savedAccountProfileSchema`, `listAllAccountsResultSchema`.
   Re-export from `index.ts`. Keep TS types and Zod schemas in lockstep (a TS type derived via `z.infer`, or
   a test asserting parity) — this is exactly what contextful's `src/ipc/contracts.test.ts` enforces.
3. **Docs page** documenting the API + the call sequence from `integration-guide.md`. Build check:
   `zensical build --strict` from repo root.

## Acceptance criteria / tests

- A test imports from the **built** package entry (or `src/index.ts`) and asserts every new function **and**
  every new Zod schema is reachable (packaging/export test).
- `schemas/accountManager.test.ts`: valid objects parse; invalid ones throw; `z.infer` types line up with the
  hand-written TS types (compile-time check or explicit assertion).
- `zensical build --strict` succeeds.

## Done-when

Exports + schemas reachable from the package root; docs build clean. Update tracker row 09. Then do the
**Release** row (tracker §7): version bumps, four changelogs, lint all three packages, build, branch
`feature/account-manager-2.0` (no Claude co-author trailer).
