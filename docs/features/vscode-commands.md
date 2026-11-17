# VS Code Command Reference

Every command the extension adds to the Command Palette (`Ctrl+Shift+P`, `Cmd+Shift+P` on macOS), where each appears as **Sidekick: _title_**. **Sidekick: Show Menu**, or a click on "Sidekick" in the status bar, opens a quick pick built from the same list. The command IDs are what you use in `keybindings.json`.

## Default Keybindings

Each shortcut is a chord: press `Ctrl+K` (`Cmd+K` on macOS), release, then press the second key.

| Command                 | Windows / Linux           | macOS                   | Active when                                                                                 |
| ----------------------- | ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| Trigger Completion      | `Ctrl+K Ctrl+Shift+Space` | `Cmd+K Cmd+Shift+Space` | The editor has focus                                                                        |
| Transform Selected Code | `Ctrl+K Ctrl+Shift+M`     | `Cmd+K Cmd+Shift+M`     | Text is selected in an editable editor                                                      |
| Generate Documentation  | `Ctrl+K Ctrl+G`           | `Cmd+K Cmd+G`           | An editable editor has focus                                                                |
| Explain Selected Code   | `Ctrl+K Ctrl+E`           | `Cmd+K Cmd+E`           | Text is selected in the editor                                                              |
| Quick Ask (Inline Chat) | `Ctrl+K Ctrl+A`           | `Cmd+K Cmd+A`           | An editable editor has focus, the suggestion list is closed, and inline chat is not focused |
| Switch Account…         | `Ctrl+K Ctrl+Shift+A`     | `Cmd+K Cmd+Shift+A`     | Anywhere                                                                                    |

To change one, open **Keyboard Shortcuts** and search for the command ID.

## Session Monitoring

See [Session Monitor](session-monitor.md), [Activity Map](activity-map.md), and [Tool Inspector](tool-inspector.md).

| Title                          | Command ID                        | What it does                                                                                                         |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Open Session Dashboard         | `sidekick.openDashboard`          | Focus the Session Analytics view in the Agent Hub sidebar                                                            |
| Open Activity Map              | `sidekick.openActivityMap`        | Open the activity map in an editor tab with insights and a replay bar                                                |
| Export Activity Map…           | `sidekick.exportActivityMap`      | Save the map as SVG or the session's activity as JSON                                                                |
| View Session Conversation      | `sidekick.openConversation`       | Open the current session's conversation in an editor tab                                                             |
| Search Across Sessions         | `sidekick.searchSessions`         | Search the text of all sessions and open the conversation you pick                                                   |
| Open Tool Inspector            | `sidekick.openToolInspector`      | Inspect the session's tool calls in an editor tab, rendered per tool (diffs for edits, commands, …)                  |
| Generate Session Summary       | `sidekick.generateSessionSummary` | Build the session summary and show the dashboard's Summary tab                                                       |
| Dump Session Report            | `sidekick.dumpSession`            | Export the session as text, markdown, JSON, or an HTML report                                                        |
| Generate HTML Report           | `sidekick.generateReport`         | Build a self-contained HTML report of the session and open it in a panel                                             |
| Extract Session Assets         | `sidekick.extractAssets`          | Pull URLs, file paths, commands, and plans out of recent Claude Code and Codex chats for this project                |
| Import Historical Session Data | `sidekick.importHistoricalData`   | Import finished Claude Code, Codex, and OpenCode sessions into the usage history; already imported files are skipped |
| Open CLI Dashboard             | `sidekick.openCliDashboard`       | Run `sidekick dashboard` in an integrated terminal                                                                   |

**Open Activity Map** and **Export Activity Map…** are listed in the palette only while monitoring is active; they are also buttons on the Activity Map view. **Extract Session Assets**, **Dump Session Report**, and **Generate HTML Report** are also buttons on the Session Analytics view.

## Session Discovery

See [Session Discovery](session-monitor.md#session-discovery).

| Title                                  | Command ID                        | What it does                                                                                        |
| -------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Start Session Monitoring               | `sidekick.startMonitoring`        | Resume monitoring, keeping your provider and custom session folder                                  |
| Stop Session Monitoring                | `sidekick.stopMonitoring`         | Pause monitoring                                                                                    |
| Find Session                           | `sidekick.refreshSession`         | Look for the active session again and attach to it                                                  |
| Browse Session Folders…                | `sidekick.selectSessionFolder`    | Pick a session folder by hand; the choice persists across restarts                                  |
| Reset to Auto-Detect Session           | `sidekick.clearCustomSessionPath` | Drop the folder you picked and go back to automatic detection                                       |
| Session Path Diagnostics (Claude Code) | `sidekick.sessionDiagnostics`     | Write how the workspace maps to a folder under `~/.claude/projects/` to the Sidekick output channel |

## Accounts

See [Account Switcher](account-switcher.md).

| Title                     | Command ID                          | What it does                                                                                   |
| ------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Add Account…              | `sidekick.accounts.add`             | Sign in to another Claude Code or Codex account; the current login is untouched                |
| Switch Account…           | `sidekick.accounts.pick`            | Quick pick of saved accounts by provider; switches the live login and verifies it              |
| Sign In Again to Account… | `sidekick.accounts.signInAgain`     | Sign in again to a saved account whose credential has expired                                  |
| Open Terminal as Account… | `sidekick.accounts.openTerminal`    | Open a terminal whose `claude` or `codex` uses a saved account, without switching the live one |
| Remove Account…           | `sidekick.accounts.remove`          | Delete a saved account and its stored credentials                                              |
| Undo Last Account Switch  | `sidekick.accounts.undo`            | Revert the last switch                                                                         |
| Refresh Accounts          | `sidekick.accounts.refresh`         | Register new live logins and re-read credential health                                         |
| Register Current Login    | `sidekick.accounts.registerCurrent` | Save the live Claude Code and Codex logins as accounts if they are not saved yet               |

The Accounts view also has inline buttons on each account (switch, sign in again, open terminal) and a right-click menu with **Remove**.

## Project Memory

See [Knowledge Notes](knowledge-notes.md) and [Session Handoff](session-handoff.md).

| Title                                             | Command ID                      | What it does                                                                          |
| ------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| Add Knowledge Note                                | `sidekick.addKnowledgeNote`     | Attach a gotcha, pattern, guideline, or tip to the selected lines                     |
| Inject Knowledge Notes into CLAUDE.md / AGENTS.md | `sidekick.injectKnowledgeNotes` | Append the active notes to your agent's instruction file                              |
| Set Up Session Handoff                            | `sidekick.setupHandoff`         | Add a reference to your agent's instruction file pointing at previous session context |
| Open External Session Handoff                     | `sidekick.openExternalHandoff`  | Open the URL from `sidekick.handoffUrlTemplate`, filled in for the current session    |

## AI Features

These run through the inference provider you set up in [Provider Setup](../getting-started/provider-setup.md). See [Inline Completions](inline-completions.md), [Code Transforms](code-transforms.md), [Quick Ask](inline-chat.md), [Generate Docs](generate-docs.md), [Explain Code](explain-code.md), [Error Analysis](error-analysis.md), [Code Review](code-review.md), [PR Descriptions](pr-descriptions.md), and [Commit Messages](commit-messages.md).

| Title                     | Command ID                       | What it does                                                                                  |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| Toggle Inline Completions | `sidekick.toggle`                | Turn inline completions on or off (the `sidekick.enabled` setting)                            |
| Trigger Completion        | `sidekick.triggerCompletion`     | Request a completion at the cursor; it appears as ghost text                                  |
| Transform Selected Code   | `sidekick.transform`             | Replace the selection with code rewritten from your instruction                               |
| Quick Ask (Inline Chat)   | `sidekick.inlineChat`            | Ask a question or request a change in place, with a diff preview for changes                  |
| Generate Documentation    | `sidekick.generateDocs`          | Insert a doc comment or docstring for the function at the cursor                              |
| Explain Selected Code     | `sidekick.explainCode`           | Explain the selected code at your chosen complexity level                                     |
| Explain Error with AI     | `sidekick.explainError`          | Explain the error or warning at the cursor                                                    |
| Fix Error with AI         | `sidekick.fixError`              | Propose a fix for the error at the cursor                                                     |
| Review My Changes         | `sidekick.reviewChanges`         | Review your changes for bugs, security concerns, and code smells (eye icon in Source Control) |
| Clear AI Review           | `sidekick.clearReview`           | Remove the review annotations                                                                 |
| Generate PR Description   | `sidekick.generatePrDescription` | Write a pull request description from your branch's changes (PR icon in Source Control)       |
| Generate Commit Message   | `sidekick.generateCommitMessage` | Write a commit message from your diff (sparkle icon in Source Control)                        |

**Explain Error with AI** and **Fix Error with AI** are listed in the palette only when an editor is open. In the editor's right-click menu, the **Sidekick** submenu also offers explanations at a chosen level (ELI5, Curious Amateur, Imposter Syndrome, Senior, PhD Mode) for code and for errors.

## Setup and Troubleshooting

See [Provider Setup](../getting-started/provider-setup.md) and [Settings Reference](../configuration/settings.md).

| Title                     | Command ID                      | What it does                                                                                          |
| ------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Show Menu                 | `sidekick.showMenu`             | Open the Sidekick quick pick of commands                                                              |
| Run Doctor                | `sidekick.doctor`               | Check project, session, account, provider, and dependency health, and show the dashboard's Health tab |
| View Logs                 | `sidekick.showLogs`             | Open the Sidekick output channel                                                                      |
| Switch Inference Provider | `sidekick.setInferenceProvider` | Choose Claude Max, Claude API, OpenCode, or Codex CLI for the AI features                             |
| Set API Key               | `sidekick.setApiKey`            | Store an Anthropic API key for the Claude API provider                                                |
| Test Connection           | `sidekick.testConnection`       | Check that the inference provider responds                                                            |
| Install Statusline        | `sidekick.installStatusline`    | Merge a Sidekick status-line command into your Claude Code settings                                   |
| Uninstall Statusline      | `sidekick.uninstallStatusline`  | Remove it and restore the previous status-line block                                                  |
| Check for Updates         | `sidekick.checkForUpdates`      | Check for a newer version of the extension now, even with automatic checks turned off                 |

## Context-Menu Actions

A few actions have no palette entry and appear only where they apply: **Edit Knowledge Note**, **Confirm Knowledge Note (Mark as Reviewed)**, and **Delete Knowledge Note** on notes in the Knowledge Notes view, and **Switch to This Account** on accounts in the Accounts view.
