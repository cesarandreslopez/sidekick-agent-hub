# Phase 01 — Claude isolated-profile primitives + keychain suffix

**Workstream:** WS1 · **Package:** `sidekick-shared` · **Depends on:** none · **Blocks:** 02, 03, 04

## Goal

Give Claude the same isolated-profile capability Codex already has, so a *new* account can be logged in
without touching the active one. The lynchpin is detecting/reading an isolated Claude login, which on macOS
lives in a keychain entry named by a hash of the config dir.

## Background (verified)

Claude Code stores OAuth credentials in the macOS keychain under service `Claude Code-credentials` when
`CLAUDE_CONFIG_DIR` is **unset**. When `CLAUDE_CONFIG_DIR` **is** set (isolated profile), it stores them under
`Claude Code-credentials-{suffix}` where `suffix = sha256(CLAUDE_CONFIG_DIR)[:4 bytes]` rendered as hex
(8 chars). On Linux/WSL/Windows the credential is a file `<CLAUDE_CONFIG_DIR>/.credentials.json`. Identity
(`emailAddress`, `accountUuid`) lives in `<CLAUDE_CONFIG_DIR>/.claude.json` under `oauthAccount`.

Source of truth for the algorithm: ai-switcher `src-tauri/src/quota.rs:349 claude_keychain_suffix`
(reads suffixed entry first, falls back to default). Verified vectors are in the acceptance tests below.

## Files to touch

- **New:** `sidekick-shared/src/claudeProfiles.ts` (mirror the structure of `codexProfiles.ts`).
- **New:** `sidekick-shared/src/claudeProfiles.test.ts`.

## Step-by-step

1. Path helpers (reuse `getAccountsDir()` from `accountRegistry.ts:43`):
   ```ts
   export function getClaudeProfilesDir(): string {
     return path.join(getAccountsDir(), 'claude', 'profiles');
   }
   export function getClaudeProfileHome(uuid: string): string {
     return path.join(getClaudeProfilesDir(), uuid, 'home');   // = CLAUDE_CONFIG_DIR
   }
   ```
2. **Keychain suffix** (port of the Rust fn; `sha256` of the dir string, first 4 bytes, hex):
   ```ts
   import { createHash } from 'crypto';
   export function claudeKeychainSuffix(configDir: string): string {
     return createHash('sha256').update(configDir).digest('hex').slice(0, 8);
   }
   export function claudeKeychainService(configDir?: string): string {
     return configDir ? `Claude Code-credentials-${claudeKeychainSuffix(configDir)}` : 'Claude Code-credentials';
   }
   ```
   > Note: the Rust impl uses the path **string** exactly as passed. Match how the suffix is computed in
   > practice (the dir string Claude Code itself receives via `CLAUDE_CONFIG_DIR`). Do **not** call
   > `path.resolve` before hashing unless you confirm Claude Code resolves it first — the verified vectors
   > below use the raw string.
3. **Authentication check** for a profile home (macOS keychain entry exists, else file exists, plus identity):
   ```ts
   export function isClaudeProfileAuthenticated(home: string): boolean {
     const hasCred = process.platform === 'darwin'
       ? keychainServiceExists(claudeKeychainService(home))               // `security find-generic-password -s <svc>`
       : fs.existsSync(path.join(home, '.credentials.json'));
     return hasCred && readClaudeProfileIdentity(home) !== null;
   }
   ```
   Implement `keychainServiceExists(service)` with `execFileSync('security', ['find-generic-password','-s',service], …)`
   returning `true` on exit 0 (see `credentialIO.ts:34` for the call shape; swallow errors → `false`).
4. **Identity reader** (the per-profile analogue of `readActiveClaudeAccount` at `accounts.ts:133`):
   ```ts
   export function readClaudeProfileIdentity(home: string): { email: string; uuid: string } | null {
     try {
       const raw = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
       const email = raw?.oauthAccount?.emailAddress, uuid = raw?.oauthAccount?.accountUuid;
       return email && uuid ? { email, uuid } : null;
     } catch { return null; }
   }
   ```
5. **Dir bootstrap** with `mode: 0o700` (mirror `codexProfiles.ts:111 ensureCodexProfileDirs`).
6. Keep this module **side-effect free on import** (no work at module load).

## Acceptance criteria / tests

- `claudeKeychainSuffix('/Users/hoangphan/Library/Application Support/dev.hoangphan.AI-Account-Switcher/accounts/claude/53d79dfb-fbe4-41fb-9827-e8afd2e128bb')` === `'e3c60653'`.
- `claudeKeychainSuffix('/Users/hoangphan/.ai-switcher-logintest')` === `'8244da8e'`.
- `claudeKeychainService(undefined)` === `'Claude Code-credentials'`; with a dir → `'Claude Code-credentials-<suffix>'`.
- `readClaudeProfileIdentity` returns `{email,uuid}` for a fixture `home/.claude.json` with `oauthAccount`,
  `null` when the file is missing or lacks `oauthAccount`.
- `isClaudeProfileAuthenticated` on non-darwin: `true` only when both `.credentials.json` and a valid
  `.claude.json` identity exist (mock `process.platform`).

## Done-when

`npx vitest run src/claudeProfiles.test.ts` passes from `sidekick-shared/`; suffix vectors green; module
exports `getClaudeProfilesDir`, `getClaudeProfileHome`, `claudeKeychainSuffix`, `claudeKeychainService`,
`isClaudeProfileAuthenticated`, `readClaudeProfileIdentity`. (Exports wired into `index.ts` in Phase 09.)
Update the tracker row 01.
