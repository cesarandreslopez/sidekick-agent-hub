# Account Switcher

Sidekick keeps several Claude Code and Codex logins on one machine and switches between them without `/logout` cycles. It works the same in VS Code and the CLI: every account you sign in to is saved as a profile, the live login is verified after each switch, and expiring credentials are flagged before they fail.

## What gets switched

Both CLIs read one live credential store: the `Claude Code-credentials` macOS Keychain item (or `~/.claude/.credentials.json` on Linux and Windows) and `~/.codex/auth.json`. Switching writes the chosen profile into that store, so anything that reads it follows the switch once it restarts:

| App                                                                                    | Follows a switch?                             | What Sidekick tells you                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `claude` CLI                                                                           | Yes, for new sessions                         | A warning when a session is running: it keeps the previous account and can rotate that account's refresh token             |
| Claude Code VS Code / JetBrains extension, Agent SDK                                   | Yes, after the extension host reloads         | A **Reload Window** action on the switch toast                                                                             |
| Claude Desktop app                                                                     | **No** — it keeps its own web session         | A warning when it is running: its embedded engine can rotate the shared CLI token behind Sidekick's back                   |
| `codex` CLI                                                                            | Yes, for new sessions                         | Switching is blocked while a Codex session runs; close it first (`--force` does not override this)                         |
| Codex desktop app / Codex IDE extension                                                | Yes, after a restart — they share `~/.codex`  | Switching is blocked while Codex consumers run; close them first                                                           |
| Codex with `cli_auth_credentials_store` set to `"keyring"`, `"auto"`, or `"ephemeral"` | **No** — the login is not kept in `auth.json` | Refused at add, switch, and launch time (as is an unreadable setting), with the `config.toml` change to make it switchable |
| OpenCode, z.ai                                                                         | Not supported                                 | —                                                                                                                          |

Sidekick never calls Anthropic's or OpenAI's OAuth endpoints itself. Sign-ins and token refreshes always go through the official `claude` and `codex` CLIs.

### One usable copy per login

Claude Code rotates the refresh token on every refresh, and Codex rotates its refresh token too, so a second usable copy of a login consumes the token the first copy still needs. Sidekick keeps the live account in its live home and stores its backup privately, where neither CLI runs.

- **The live account** keeps identity and health metadata in its profile, plus a private backup. Opening a terminal as that account uses its normal live home.
- **An inactive account** can use its own profile home. Keep-alive never recreates missing profile credentials from a backup.
- **A switch** requires a verified outgoing backup, even with `--force`. Codex also verifies the target backup and removes its profile credential before installing it live. The outgoing account receives a usable profile copy only after it is inactive. A journal supports interrupted-switch recovery.
- **Repairs and re-logins** advance the same account only when the saved credential is demonstrably newer. Rollback preserves any external change. Unrelated MCP credentials remain in place.

Claude switching borrows Claude Code's refresh locks. Codex has no shared filesystem refresh lock: Sidekick blocks live writes while Codex consumers are detected, or when process detection fails. `--force` does not override that check or an active keep-alive lease. Process checks and snapshot comparisons cannot exclude a new external process starting immediately afterward; close Codex consumers before switching.

Sync removes duplicates left by older builds after preserving the freshest credential. A newer copy is installed first when safe. Busy or unreadable stores produce a pending-repair warning and are retried. `sidekick accounts doctor` inspects without changing credentials. `--fix` repairs after confirmation: it removes unused copies and second copies of the live login, deletes unreadable Claude copies, and for Codex removes stale stashes and abandoned login homes and finishes interrupted switches. With `--json` or without a terminal it needs `--yes`, and `--json` lists the repairs in `repaired`. Codex repairs wait while Codex apps run.

## How accounts get registered

You rarely have to "add" the account you are already using. Sidekick watches the live credential stores and registers any login it has not seen, labelled with its email, so you can switch back to it later. The status bar, the Accounts view, and `sidekick accounts list` all say **Registered &lt;email&gt;** the first time this happens.

To sign in to a _second_ account without disturbing the current one, use **Add Account**. Sidekick opens `claude auth login` or `codex login` in an isolated profile directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), waits for the browser sign-in to finish, and saves the result. Your current login stays untouched until you choose to switch.

## VS Code

**Accounts view.** The Agent Hub sidebar has an **Accounts** view grouped by provider. Each row shows the label, email, plan, and credential health; the current account has a check mark. Hover an account for the exact expiry times. The inline icons switch, sign in again, or open a terminal as that account; right-click for the full menu including remove. The title bar has **Add Account**, **Refresh**, and **Undo** (shown when there is a switch to revert).

**Status bar.** The account badge appears as soon as one account is saved and shows the active account for your inference provider (falling back to Claude, then Codex). It turns amber when the credential is expiring and warning-coloured when it has expired. Click it for the quick pick: accounts grouped by provider with `(current)` marked, plus **Add account…**, **Open terminal as account…**, **Sign in again…**, and **Undo last switch**. Keyboard: `Ctrl+K Ctrl+Shift+A` (`Cmd+K Cmd+Shift+A` on macOS).

**After a switch** you get one notification: `Switched to Work (work@example.com) ✓` with **Undo**, **Details**, and, when the Claude Code extension is active, **Reload Window**. Warnings about running Claude apps are folded into that message (a Codex switch is refused outright while Codex apps run); **Details** writes the full list, including process ids, to the Sidekick output channel.

**Open Terminal as Account** starts a VS Code terminal whose `claude` or `codex` use the chosen profile without changing the live login, so two accounts can run side by side. For the account that is already live, the terminal simply uses the normal Claude or Codex home: a session in its profile directory would be a second copy of the live login.

Settings:

| Setting                                 | Default | Effect                                                                                                                        |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sidekick.accounts.keepAlive`           | `false` | Refresh saved-but-inactive accounts through the official CLIs in their isolated profiles after activation and every six hours |
| `sidekick.accounts.autoSwitchThreshold` | `0`     | Quota utilization percentage that triggers an automatic switch to a healthier saved account (0 disables)                      |

## CLI

```bash
sidekick accounts                          # interactive picker: ↑↓ move, Enter switch, a add, l sign in again,
                                           # r remove, s shell, u undo, ? help, q quit
sidekick accounts list                     # saved accounts with health and expiry (--json for scripts)
sidekick accounts add --label Work         # sign in to a second account; the current login is untouched
sidekick accounts switch work              # switch by label, email, id, or unique prefix
sidekick accounts switch --next            # cycle within one provider (add --provider when both have accounts)
sidekick accounts login work               # sign in again to an existing (expired) account
sidekick accounts undo                     # revert the last switch
sidekick accounts remove old --yes         # delete a saved account and its credentials
sidekick accounts doctor                   # read-only: expiry, stored credentials, running apps, Codex store, keep-alive
sidekick accounts doctor --fix             # repair stored credentials Sidekick owns (asks first; --yes skips)
sidekick accounts config auto-switch 90    # or: off
sidekick accounts config keep-alive on     # or: off, run
```

Every subcommand honours the global `--json` flag and `--provider claude-code|codex|all`. A switch prints a verified summary:

```
Switched Claude Code → Work (work@example.com)  ✓ verified
  ! Running claude sessions keep the previous account until restarted; a running session can rotate the refresh token of the account you just left.
New claude sessions use work@example.com.
Undo: sidekick accounts undo
```

### Two accounts side by side

`env` prints the environment that points a single shell at a saved profile; `shell` opens a subshell (or runs one command) with it:

```bash
eval "$(sidekick accounts env work)"                       # bash / zsh: this shell only
sidekick accounts env work --shell fish | source            # fish
sidekick accounts env work --shell powershell | Invoke-Expression   # PowerShell
for /f "delims=" %i in ('sidekick accounts env work --shell cmd') do @%i   # cmd.exe

sidekick accounts shell work                                # subshell as Work; `exit` to return
sidekick accounts shell work -- claude                      # one claude session as Work
```

The legacy `sidekick account --…` flags keep working and print the modern equivalent on stderr.

### Dashboard

Press `A` in `sidekick dashboard` for the accounts overlay: `Enter` switches, `u` undoes. The status bar shows the active account coloured by health. Adding accounts, signing in again, and subshells need the raw terminal, so the overlay points you at the matching `sidekick accounts` command.

## Credential health

Claude Code refresh tokens expire about three weeks after they were last used, and Codex reports its own refresh time. Sidekick records a secret-free health file next to each profile whenever it stores a credential, so every surface can show:

| State      | Meaning                                                                                     | Action                                               |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `fresh`    | Access token valid; refresh token has days left                                             | none                                                 |
| `expiring` | Access token lapsed (the CLI refreshes on next use) or refresh token ends within three days | switch to it soon, or turn on keep-alive             |
| `expired`  | Refresh token expired (recorded, or estimated from the snapshot age)                        | **Sign In Again** / `sidekick accounts login <name>` |
| `missing`  | No stored credentials                                                                       | sign in                                              |
| `unknown`  | The stored credential carries no expiry (API-key logins)                                    | none                                                 |

A switch to an `expired` or `missing` account is refused with a sign-in hint instead of installing a dead credential; pass `--force` on the CLI to override the health check. Codex consumer checks, leases, backup verification, and freshness rules remain mandatory.

**Keep-alive** (opt-in) uses `claude auth status` or Codex's app-server refresh protocol inside an eligible inactive profile. Codex performs no inference turn, and `codex login status` is not used for refresh. Both providers skip the live identity, a matching live refresh token, copies taken from live that have not been handed back by a switch, missing profile credentials, and copies older than their private backup. A lease prevents a concurrent switch to the account; Codex does not allow `--force` to bypass it.

## Platform notes

- **macOS:** Claude credentials live in the Keychain. Sidekick reads and writes them with `/usr/bin/security` exactly as Claude Code does (hex payload, the same account name), reads every write back before trusting it, and never logs a token. The first read may prompt for access once. Inactive profiles get their own Keychain items, keyed the same way Claude Code keys `CLAUDE_CONFIG_DIR` logins, and tagged with a `sidekick-agent-hub:<directory>` comment; Sidekick also records every such directory in `accounts/claude/credential-homes.json`, so `accounts doctor` can prove which items are its own. If the Keychain is locked (SSH sessions), Sidekick reads the `.credentials.json` fallback Claude Code writes.
- **Linux:** credentials are plain files with `0600` permissions.
- **Windows:** credentials are plain files under `%USERPROFILE%\.claude` and `%USERPROFILE%\.codex`. Use `sidekick accounts env --shell powershell|cmd` instead of launcher scripts; running apps are detected with `tasklist`.

## Troubleshooting

- **"expired; sign in again"** — the saved refresh token is dead. Use **Sign In Again** or `sidekick accounts login <name>`; the account keeps its label and id.
- **Codex reports a reused refresh token** — close Codex consumers, inspect with `sidekick accounts doctor --provider codex`, and sign in again if the token is already invalid. A private backup is recovery data, not proof that an upstream token is still valid.
- **"Codex credential storage (keyring) is not file-based"** (or `auto`, `ephemeral`, `unreadable`) — set `cli_auth_credentials_store = "file"` in `~/.codex/config.toml`, run `codex login`, then add the account again.
- **Claude Desktop keeps signing you out** — the desktop app's embedded engine refreshes the shared CLI token. Sidekick warns when it is running; quit it before switching, or sign in again afterwards.
- **"not verified"** — the store did not read back the written credential. The message says whether the previous login was restored; if it could not be, it is still saved, and `sidekick accounts doctor` shows what to do.
- **Claude Code says "Not logged in · Please run /login"** — the live login's refresh token was used up by another copy of the same login, or the stored credential could not be read. Run `/login` (or **Sign In Again**), then `sidekick accounts doctor`: it lists any second copy of the live login and unreadable stored credentials, and `--fix` removes them. Claude Desktop and any other tool that runs `claude` against its own copy of your login can still cause this; quit them before switching.
- **Doctor reports an "unreadable credential"** — an older Sidekick build could store a credential cut off at about 4 KB (the limit of the `security` tool's interactive mode) once several MCP servers had OAuth tokens. That copy cannot be used. `sidekick accounts doctor --fix` deletes it; sign in again to that account if its backup has expired.
- **Hundreds of `Claude Code-credentials-<hash>` items in Keychain Access** — Sidekick builds before 0.27.6 left one behind each time they ran against a throwaway `SIDEKICK_CONFIG_DIR` with your real home (for example inside another project's test suite). They are copies of old logins that nothing uses. Other tools also create these items for their own `CLAUDE_CONFIG_DIR`, so Sidekick never deletes them by name. List them with the one-off script in the repository and delete them yourself once the list looks right:

  ```bash
  scripts/claude-keychain-orphans.sh                          # dry run: service and creation time
  scripts/claude-keychain-orphans.sh --keep ~/work/claude-dir # keep a directory another tool still uses
  scripts/claude-keychain-orphans.sh --delete                 # asks before deleting
  ```

  The script reads attributes only (never a secret) and always keeps Sidekick's profile directories, `~/.claude`, and `$CLAUDE_CONFIG_DIR`.

- **"CLAUDE_CONFIG_DIR points at a sidekick profile home"** (or `CODEX_HOME`) — you are in a shell that ran `eval "$(sidekick accounts env …)"` or a subshell from `sidekick accounts shell`. Switching there would overwrite that profile, so it is refused; run the switch from a normal shell or `exit` the subshell first.
