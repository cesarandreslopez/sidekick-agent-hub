# Phase 02 — Parameterize credential I/O by config dir

**Workstream:** WS2 · **Package:** `sidekick-shared` · **Depends on:** 01 · **Blocks:** 03, 04

## Goal

Today `credentialIO.ts` reads/writes only the *default* Claude keychain entry (`Claude Code-credentials`)
or `~/.claude/.credentials.json`. To read an isolated profile's credentials (and later copy them to the
live home), it must operate on an **arbitrary config dir** — deriving the keychain service from the dir via
`claudeKeychainService` (Phase 01). Existing no-arg callers must be unaffected.

## Files to touch

- `sidekick-shared/src/credentialIO.ts` (functions `readActiveCredentials`:31, `writeActiveCredentials`:58,
  `getCredentialsFilePath`:19, constant `KEYCHAIN_SERVICE`:17).
- `sidekick-shared/src/credentialIO.test.ts` (add cases; create if absent).

## Step-by-step

1. Add an optional `configDir` parameter to both functions. When provided:
   - macOS service name = `claudeKeychainService(configDir)` (import from `claudeProfiles.ts`);
   - file path = `path.join(configDir, '.credentials.json')` (instead of `~/.claude/.credentials.json`).
   When omitted, behavior is **identical to today** (default service / `~/.claude/.credentials.json`).
   ```ts
   export function readActiveCredentials(configDir?: string): unknown { /* … */ }
   export function writeActiveCredentials(credentials: unknown, configDir?: string): void { /* … */ }
   ```
2. Refactor `getCredentialsFilePath(configDir?)` to take the optional dir; keep the default
   `~/.claude/.credentials.json`.
3. Replace the hard-coded `KEYCHAIN_SERVICE` usages with `claudeKeychainService(configDir)`. Keep the
   constant exported (or re-export the default) so nothing else breaks.
4. Avoid a circular import: `claudeProfiles.ts` (Phase 01) imports nothing from `credentialIO.ts`, and
   `credentialIO.ts` imports only `claudeKeychainService`/`claudeKeychainSuffix`. If a cycle appears, move
   the suffix helpers into a tiny `claudeKeychain.ts` that both import.
5. macOS write uses `security add-generic-password -U -s <service> …` (see `credentialIO.ts:63`); file write
   stays atomic (tmp + rename, `mode 0o600`).

## Acceptance criteria / tests

- `readActiveCredentials()` / `writeActiveCredentials(x)` (no dir) behave exactly as before (mock `execFileSync`
  for darwin; mock `fs` for non-darwin) — assert the **default** service/path is used.
- With a `configDir`: darwin path calls `security … -s 'Claude Code-credentials-<suffix>'`; non-darwin path
  reads/writes `<configDir>/.credentials.json`.
- Round-trip: `writeActiveCredentials(obj, dir)` then `readActiveCredentials(dir)` returns the object
  (non-darwin temp-dir test).

## Done-when

`npx vitest run src/credentialIO.test.ts` passes; existing callers (`accounts.ts:228,278,282,298`) still
compile and behave unchanged. Update tracker row 02.
