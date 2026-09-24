# Account Switcher

Sidekick keeps several Claude Code and Codex logins on one machine and switches between them without `/logout` cycles. It works the same in VS Code and the CLI: every account you sign in to is saved as a profile, the live login is verified after each switch, and expiring credentials are flagged before they fail.

## What gets switched

Both CLIs read one live credential store: the `Claude Code-credentials` macOS Keychain item (or `~/.claude/.credentials.json` on Linux and Windows) and `~/.codex/auth.json`. Switching writes the chosen profile into that store, so anything that reads it follows the switch once it restarts:

| App                                                             | Follows a switch?                            | What Sidekick tells you                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `claude` CLI                                                    | Yes, for new sessions                        | A warning when a session is running: it keeps the previous account and can rotate that account's refresh token |
| Claude Code VS Code / JetBrains extension, Agent SDK            | Yes, after the extension host reloads        | A **Reload Window** action on the switch toast                                                                 |
| Claude Desktop app                                              | **No** — it keeps its own web session        | A warning when it is running: its embedded engine can rotate the shared CLI token behind Sidekick's back       |
| `codex` CLI                                                     | Yes, for new sessions                        | A warning when a session is running                                                                            |
| Codex desktop app / Codex IDE extension                         | Yes, after a restart — they share `~/.codex` | A warning when the app is running; it can refresh the live token while open                                    |
| Codex with `cli_auth_credentials_store = "keyring"` or `"auto"` | **No** — the login lives in the OS keyring   | Refused at add time and at switch time, with the `config.toml` change to make it switchable                    |
| OpenCode, z.ai                                                  | Not supported                                | —                                                                                                              |

Sidekick never calls Anthropic's or OpenAI's OAuth endpoints itself. Sign-ins and token refreshes always go through the official `claude` and `codex` CLIs.

## How accounts get registered

You rarely have to "add" the account you are already using. Sidekick watches the live credential stores and registers any login it has not seen, labelled with its email, so you can switch back to it later. The status bar, the Accounts view, and `sidekick accounts list` all say **Registered &lt;email&gt;** the first time this happens.

To sign in to a _second_ account without disturbing the current one, use **Add Account**. Sidekick opens `claude auth login` or `codex login` in an isolated profile directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), waits for the browser sign-in to finish, and saves the result. Your current login stays untouched until you choose to switch.

## VS Code

**Accounts view.** The Agent Hub sidebar has an **Accounts** view grouped by provider. Each row shows the label, email, plan, and credential health; the current account has a check mark. Hover an account for the exact expiry times. The inline icons switch, sign in again, or open a terminal as that account; right-click for the full menu including remove. The title bar has **Add Account**, **Refresh**, and **Undo** (shown when there is a switch to revert).

**Status bar.** The account badge appears as soon as one account is saved and shows the active account for your inference provider (falling back to Claude, then Codex). It turns amber when the credential is expiring and warning-coloured when it has expired. Click it for the quick pick: accounts grouped by provider with `(current)` marked, plus **Add account…**, **Open terminal as account…**, **Sign in again…**, and **Undo last switch**. Keyboard: `Ctrl+K Ctrl+Shift+A` (`Cmd+K Cmd+Shift+A` on macOS).

**After a switch** you get one notification: `Switched to Work (work@example.com) ✓` with **Undo**, **Details**, and, when the Claude Code extension is active, **Reload Window**. Warnings about running apps are folded into that message; **Details** writes the full list, including process ids, to the Sidekick output channel.

**Open Terminal as Account** starts a VS Code terminal whose `claude` or `codex` use the chosen profile without changing the live login, so two accounts can run side by side. Sidekick warns when you pick the account that is also live, because two sessions refreshing one login can invalidate each other.

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
sidekick accounts doctor                   # expiry, running apps, Codex credential store, keep-alive
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

A switch to an `expired` or `missing` account is refused with a sign-in hint instead of installing a dead credential; pass `--force` on the CLI to override.

**Keep-alive** (opt-in) runs `claude auth status` / `codex login status` inside each inactive profile so the CLI refreshes its own token where it belongs. The live account is never touched by keep-alive.

## Platform notes

- **macOS:** Claude credentials live in the Keychain. Sidekick reads and writes them with `/usr/bin/security`; the first read may prompt for access once. Profiles get their own Keychain items, keyed the same way Claude Code keys `CLAUDE_CONFIG_DIR` logins. If the Keychain is locked (SSH sessions), Sidekick reads the `.credentials.json` fallback Claude Code writes.
- **Linux:** credentials are plain files with `0600` permissions.
- **Windows:** credentials are plain files under `%USERPROFILE%\.claude` and `%USERPROFILE%\.codex`. Use `sidekick accounts env --shell powershell|cmd` instead of launcher scripts; running apps are detected with `tasklist`.

## Troubleshooting

- **"expired; sign in again"** — the saved refresh token is dead. Use **Sign In Again** or `sidekick accounts login <name>`; the account keeps its label and id.
- **Codex says it is not logged in after a switch** — the stored token was revoked upstream (for example a fresh `codex login` on the same workspace elsewhere). Sign in again to that profile.
- **"Codex keeps its login in the OS keyring"** — set `cli_auth_credentials_store = "file"` in `~/.codex/config.toml`, run `codex login`, then add the account again.
- **Claude Desktop keeps signing you out** — the desktop app's embedded engine refreshes the shared CLI token. Sidekick warns when it is running; quit it before switching, or sign in again afterwards.
- **"not verified"** — the store did not read back the written credential. Run `sidekick accounts doctor`; the previous login was restored.
- **"CLAUDE_CONFIG_DIR points at a sidekick profile home"** (or `CODEX_HOME`) — you are in a shell that ran `eval "$(sidekick accounts env …)"` or a subshell from `sidekick accounts shell`. Switching there would overwrite that profile, so it is refused; run the switch from a normal shell or `exit` the subshell first.
