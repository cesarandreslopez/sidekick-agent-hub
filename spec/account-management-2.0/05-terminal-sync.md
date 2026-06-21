# Phase 05 — Terminal sync: shell hook, active-pointer files, per-account launchers (opt-in)

**Workstream:** WS5 · **Package:** `sidekick-shared` · **Depends on:** 01, 03 · **Blocks:** 07 (`--launcher`)

## Goal

Let power users have **different accounts live in different terminals simultaneously** — the ai-switcher model
— without disturbing the live-home apply path (Phase 04) that serves zero-config consumers. Everything here
is **opt-in**: nothing runs on import, nothing is installed unless the user explicitly asks.

> Port of ai-switcher: `tools.rs:923 install_shell_hook`, `tools.rs:667 write_launcher`, active-pointer files
> under `active/`. Adapt markers/paths to sidekick.

## Files to touch

- **New:** `sidekick-shared/src/terminalSync.ts`.
- **New:** `sidekick-shared/src/terminalSync.test.ts`.

## Step-by-step

1. **Active-pointer files.** `accounts/active/{claude,codex}.profile` containing the active profile home path
   (or absent = use default). Writers: `setTerminalActiveProfile(provider, home|null)` (atomic write / unlink).
2. **Idempotent shell hook.** A function `installShellHook()` that inserts a block delimited by
   `# >>> sidekick >>>` / `# <<< sidekick <<<` into `~/.zshrc` (and `~/.bashrc` if present), replacing any
   existing block (idempotent). The block exports `CLAUDE_CONFIG_DIR` / `CODEX_HOME` from the pointer files
   for each new shell, e.g.:
   ```sh
   # >>> sidekick >>>
   sidekick_sync() {
     if [ -r ~/.config/sidekick/accounts/active/claude.profile ]; then export CLAUDE_CONFIG_DIR="$(cat ~/.config/sidekick/accounts/active/claude.profile)"; else unset CLAUDE_CONFIG_DIR; fi
     if [ -r ~/.config/sidekick/accounts/active/codex.profile ]; then export CODEX_HOME="$(cat ~/.config/sidekick/accounts/active/codex.profile)"; else unset CODEX_HOME; fi
   }
   sidekick_sync >/dev/null 2>&1
   # <<< sidekick <<<
   ```
   Provide `uninstallShellHook()` (removes the block) and `isShellHookInstalled()`.
3. **Per-account launchers.** `writeLauncher(name, provider, profileHome)` creates `~/.local/bin/<name>`
   (e.g. `claude-work`), `0o755`, marked `# sidekick-launcher v1`, that `exec`s the real binary with the
   account's env baked in (hard-coded `CLAUDE_CONFIG_DIR`/`CODEX_HOME` so it survives binary auto-update).
   Validate `name` (`^[a-zA-Z0-9_-]+$`), refuse collisions with existing non-sidekick files and with system
   commands on PATH. `removeLauncher(name)` only removes files carrying the sidekick marker.
4. All functions are explicit calls; **no module-load side effects**. Document that these mutate the user's
   shell config and `~/.local/bin` and should be gated behind a clear opt-in in the CLI/VS Code.

## Acceptance criteria / tests

- `installShellHook` is idempotent: two installs produce exactly one block; `uninstallShellHook` removes it;
  unrelated rc-file content is preserved (temp HOME fixtures).
- `setTerminalActiveProfile` writes/clears the pointer file atomically.
- `writeLauncher` rejects invalid names and collisions; the generated script contains the marker + correct
  env export; `removeLauncher` won't delete a non-sidekick file of the same name.

## Done-when

`npx vitest run src/terminalSync.test.ts` passes; functions exported (wired in Phase 09). Update tracker row 05.
