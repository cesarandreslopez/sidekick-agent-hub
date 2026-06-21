# Phase 08 — VS Code surface

**Workstream:** WS8 · **Package:** `sidekick-vscode` · **Depends on:** 03, 04, 06 · **Blocks:** none

## Goal

Make account acquisition/switching reachable in the editor, and render quota for both providers. This is also
the long-running host where opt-in auto-switch (Phase 06) actually runs.

## Files to touch

- `sidekick-vscode/src/services/AccountService.ts`, `services/AccountStatusBar.ts`, `services/QuotaService.ts`.
- `sidekick-vscode/src/extension.ts` (wiring: `QuotaService`:40/414, `AccountService`:78/944,
  `AccountStatusBar`:79/947).
- `sidekick-vscode/package.json` — add commands + the `sidekick.accounts.autoSwitchThreshold` setting.
- Co-located `.test.ts` files (`vscode` mocked via `vi.mock("vscode", …)`).

## Step-by-step

1. **"Add account (sign in)…" command.** Register a command that:
   - prompts for provider (Claude/Codex) + label,
   - runs `spawnAccountLogin(provider, label, { stdio:'inherit' })` **inside an integrated terminal**
     (create a `vscode.window.createTerminal`, run the returned `command args` with the env, then poll
     `getAccountLoginStatus`), OR call `beginAccountLogin` and host the spawn in a terminal you control, then
     `finalizeAccountLogin`. Reuse the CLAUDE.md note about `createTerminal({shellPath})` bypassing shell init
     (inject the CLI bin dir into `env.PATH` if needed).
   - on completion, refresh `AccountService` + status bar.
2. **Switch QuickPick.** A command listing saved accounts (both providers via `listAllAccounts`) with the
   active one marked; selection calls `switchAccount(provider, id)` and refreshes the status bar. Surface any
   `AccountManagerResult.warning` (e.g. Codex OS-keyring) as a `showWarningMessage`.
3. **Multi-provider quota.** Move the dashboard/status quota display from Claude-only state to
   `MultiProviderQuotaService` (`multiProviderQuotaService.ts:78`, subscribe via `onUpdate`:166) so Claude and
   Codex render consistently — matching the CLI `quota --all`.
4. **Auto-switch setting.** Add `sidekick.accounts.autoSwitchThreshold` (number; `0`/off disables; default off).
   Construct the Phase 06 controller from this setting and feed it `MultiProviderQuotaService` updates; react
   to `onDidChangeConfiguration`.
5. **Optional terminal-sync entry points.** Commands to install/uninstall the shell hook and create a
   launcher (Phase 05), clearly labeled as system-modifying/opt-in.

## Acceptance criteria / tests

- Account QuickPick reflects saved state and marks the active account; selecting switches and surfaces warnings.
- The add-account command drives begin → (terminal) → poll → finalize and refreshes the status bar (mock the
  shared facade).
- Quota view updates from `MultiProviderQuotaService` for both providers.
- Auto-switch controller is constructed only when the setting is enabled; disabled by default.
- Existing `QuotaService.test.ts` still passes.

## Done-when

`npx vitest run` passes in `sidekick-vscode/`; F5 Extension Host manual check: "Add account (sign in)…" →
terminal login → status bar updates → switch via QuickPick. Update tracker row 08.
