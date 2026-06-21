# Phase 07 — CLI surface

**Workstream:** WS7 · **Package:** `sidekick-cli` · **Depends on:** 03, 04, 06 · **Blocks:** none

## Goal

Surface the new capabilities in `sidekick`: interactive `--login` (headless-safe, both providers),
opt-in `--launcher`, `--auto-switch`, unified `--provider all` for `account`, and `quota --all --json`.
Keep all existing flags and stable JSON output.

## Files to touch

- `sidekick-cli/src/commands/account.ts` (`accountAction`:34, `claudeAccountAction`:58,
  `codexAccountAction`:234, `runCodexLogin`:211).
- `sidekick-cli/src/commands/quota.ts` (`quotaAction`).
- `sidekick-cli/src/cli.ts` (`account` cmd:208–220, `quota` cmd:166, `resolveProviderId`:38).
- Co-located `.test.ts` files.

## Step-by-step

1. **`--login` for both providers.** Add `.option('--login', 'Sign in and save a new account')` to the
   `account` command. In the action, when `--login` is set, call
   `spawnAccountLogin(provider, opts.label, { stdio:'inherit' })` (Phase 03) and print the result. This
   **replaces** the Claude "must already be signed in" limitation and **supersedes** the local `runCodexLogin`
   (delete it; the shared helper now owns the spawn). For Claude, validate `resolveClaudeLoginCommand()` works
   against the installed `claude` here (this is the real manual-validation moment — see Risk in Phase 03).
   Keep `--add` (save the *currently* signed-in account) working as today via `addCurrentAccount`.
2. **`--launcher <name>`.** When set, call `writeLauncher(name, provider, profileHome)` (Phase 05) for the
   target/active account; print the created path and a one-line "open a new terminal / run `<name>`" hint.
3. **`--auto-switch <pct|off>`.** Persist the `AutoSwitchConfig` to the CLI's config location and print the
   new state. (The CLI is one-shot; document that continuous auto-switch happens in the VS Code extension /
   long-running host. The CLI flag mainly sets the persisted threshold.)
4. **`--provider all` for `account`.** `resolveProviderId` (`cli.ts:38`) returns a `ProviderId`; `'all'` is
   **not** one. Special-case `--provider all` in the action *before* calling `resolveProviderId`: render both
   Claude and Codex sections (reuse `listAllAccounts` from Phase 03). Update the option help text at
   `cli.ts:210`.
5. **`quota --all --json`.** Add `.option('--all', 'Show all providers')` to the `quota` command. When set,
   resolve both Claude and Codex quota and print a combined object keyed by provider. Keep the single-provider
   human output unchanged. (This collapses the two commands the maintainer runs today —
   `quota --provider claude` + `quota --provider codex` — into one.)
6. Preserve existing `--json` shapes; new flags add fields, never remove.

## Acceptance criteria / tests

- `account --provider claude --login --label work` (mock `spawnAccountLogin`) prints success and the saved
  email; failure path exits non-zero with the error.
- `account --provider all` lists both providers; `--json` emits `{ claude:[…], codex:[…], activeByProvider }`.
- `quota --all --json` emits a combined object with both providers; single-provider output unchanged.
- `--launcher work` calls the launcher writer; invalid names exit non-zero.
- Existing `account`/`quota` tests still pass.

## Manual validation (real machine, required)

- `sidekick account --provider claude --login --label work` → browser OAuth → `sidekick account` lists it →
  `sidekick quota --provider claude` reflects the active account → `sidekick account --provider claude
  --switch-to <other>` flips back losslessly. Repeat for `--provider codex`.

## Done-when

`npx vitest run` passes in `sidekick-cli/`; manual flows verified; `runCodexLogin` removed. Update tracker row 07.
