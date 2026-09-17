# Add your accounts

Sidekick registers the Claude Code and Codex accounts you are already signed in to. Open the **Accounts** view in the Agent Hub sidebar to see them with their credential health.

**Add a second account:** run *Sidekick: Add Account…*. Sidekick opens `claude auth login` or `codex login` in an isolated profile, so your current login stays untouched, and saves the new account when the browser sign-in completes.

**Switch:** select the account badge in the status bar, or the arrows icon next to an account in the Accounts view. Sidekick verifies the switch and tells you which running apps still hold the previous login. **Undo** reverts the last switch.

**Run two accounts at once:** *Open Terminal as Account* starts a terminal where `claude` or `codex` use the chosen account without changing the live login.

Saved accounts expire after a few weeks unless they are refreshed. The view shows when; select **Sign In Again** on an expired account, or turn on `sidekick.accounts.keepAlive`.
