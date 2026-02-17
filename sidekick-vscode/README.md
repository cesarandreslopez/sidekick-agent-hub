# Sidekick for Max

Your Claude Max, working harder: completions, transforms, commits, code review, session monitoring, and more.

![Sidekick demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/all_features.gif?v=4)

**Claude Code is incredible for complex, multi-file refactoring and agentic workflows.** But sometimes you just want a quick inline completion while typing, or to transform a snippet of code without spinning up a full conversation. And you shouldn't have to pay for yet another subscription to get that.

If you're already paying for Claude Max, Sidekick lets you use those tokens for inline completions, code transforms, AI commit messages, and real-time session monitoring--no extra cost, no separate account.

## Why Am I Building This?

Claude Code and other AI agents have transformed how we build software. But some of us are still **control freaks** who want to *see*, *review*, and *understand* everything that our overly-enthusiastic robot assistant does with our code. We also enjoy writing actual code ourselves sometimes.

Sidekick gives you visibility into what Claude is doing and quick AI assistance for the small stuff—all without leaving VS Code.

## Why Use This Extension?

**Stop paying twice for AI coding tools.**

You're already spending $100-200/month on Claude Max. Sidekick lets you drop your Copilot subscription and get completions, transforms, and session monitoring from the same plan:

| Without This Extension | With This Extension |
|------------------------|---------------------|
| Pay $100-200/mo for Claude Max | Same subscription |
| Pay $10-19/mo extra for Copilot | No additional cost |
| No visibility into token usage | Real-time monitoring dashboard |
| Blind to what Claude is doing | Activity timeline, cost tracking, mind map |

**Designed to complement Claude Code CLI, not replace it:**
- Use **Claude Code CLI** for complex, multi-file refactoring and agentic tasks
- Use **Sidekick** for fast inline completions, quick code transforms, and monitoring your CLI sessions
- **Session Monitor** shows token usage, costs, activity timeline, and exactly what Claude is doing—essential for understanding where your quota goes, especially if you're hitting limits

The extension uses Haiku by default for inline completions—fast, responsive, and lightweight enough that they won't meaningfully impact your Claude Code quota.

## Prerequisites

- **Claude Max subscription** (Recommended) OR **Anthropic API key**
- **Claude Code CLI** installed and authenticated (for Max subscription mode)

> **Why Max subscription is recommended:** Inline completions fire frequently as you type. With an API key, these per-token costs add up quickly. With Max ($100-200/month), completions are covered by your existing plan—no surprise bills. Haiku-powered completions are lightweight enough that they won't meaningfully impact your Claude Code quota.

## Installation

### For Claude Max Subscribers (Recommended)

1. Install and authenticate Claude Code CLI:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth
   ```
   Follow the prompts to authenticate with your Claude Max subscription.

2. Install the VS Code extension:
   - **VS Code**: Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max)
   - **Cursor/VSCodium**: Install from [Open VSX](https://open-vsx.org/extension/cesarandreslopez/sidekick-for-max)
   - **Manual**: Download `.vsix` from [GitHub Releases](https://github.com/cesarandreslopez/sidekick-for-claude-max/releases) → Extensions → "Install from VSIX..."

3. Start typing in any file - completions should appear as ghost text

### For API Key Users

1. Install the VS Code extension (same as above)

2. Set your API key:
   - Run "Sidekick: Set API Key" from the Command Palette
   - Enter your Anthropic API key

3. Change auth mode in settings:
   - Open Settings (`Ctrl+,`)
   - Search for "sidekick.authMode"
   - Select "api-key"

## Features

### Claude Code Session Monitor

Monitor your Claude Code sessions in real-time with a comprehensive analytics dashboard. Click the Session Monitor icon in the activity bar to access all monitoring features.

![Session Monitor demo](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/cost_session_context_quotas_claude_code.gif)

**Session Analytics Dashboard:**
- Real-time token usage and cost tracking with model-specific pricing
- **Context token attribution** chart showing where your context budget goes (system prompt, CLAUDE.md, user messages, assistant responses, tool I/O, thinking)
- Token usage tooltips and quota projections showing estimated usage at reset
- Context window gauge showing input/output token usage vs. limits
- **Compaction detection** with timeline markers showing when context was compressed and how much was lost
- Activity timeline displaying user prompts, tool calls, errors, and subagent spawns
- **Timeline search & filtering** with full-text search and noise classification (filter system reminders, sidechains)

![Context attribution, compaction detection, and filterable timeline](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/context_attribution_compaction_and_filterable_timelines.png)
- Collapsible session navigator to save vertical space when not switching sessions
- Session selector dropdown to switch between active and recent sessions

![Session navigator](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/session_explorer.png)
- **Browse Session Folders**: Manually select any Claude project folder to monitor, even from different directories
- Tool analytics with categorization and **drill-down** to individual tool calls
- **Session Summary** with AI narrative generation (progress notification + inline spinner)
- Organized Session tab with three collapsible groups: Session Activity, Performance & Cost, Tasks & Recovery

![Activity timeline](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/session_activity_timeline.gif)

**Mind Map Visualization:**
- Interactive D3.js force-directed graph showing session structure
- Visualizes conversation flow, tool usage, and file relationships
- Real-time updates as the session progresses

![Mind map visualization](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/node_visualization_graph.gif)

**Kanban Board:**
- Tasks and subagent spawns grouped by status in a dedicated view
- Subagent cards with cyan accent and agent type chips (Explore, Plan, Bash, etc.)
- Collapsible columns with hidden-task summaries
- Real-time updates as tasks and agents move through the workflow

![Kanban board](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/kanban_style_monitoring.gif)

**Conversation Viewer:**
- Full editor tab showing the complete session conversation in chat-style layout
- User, assistant, tool, and compaction chunks with distinct visual styling
- Built-in search for finding content within long conversations

**Tool Inspector:**
- Full editor tab with specialized rendering per tool type
- Read: file paths with range info; Edit: inline diff display; Bash: formatted commands; Grep/Glob: search parameters
- Filter buttons by tool type, expandable detail panels

**Cross-Session Search:**
- Search across all Claude Code sessions in `~/.claude/projects/`
- QuickPick interface with context snippets and event type icons

**Notification Triggers:**
- Configurable alerts for credential file access (`.env`, `.credentials`), destructive commands (`rm -rf`, `git push --force`), tool error bursts, context compaction, and token usage thresholds
- Fires VS Code notifications for monitoring autonomous sessions

**Tree Views:**
- **Latest Files Touched** - Quick access to files modified during Claude Code sessions
- **Subagents** - Monitor spawned Task agents with token usage, duration, and parallel execution detection

**Status Bar Integration:**
- Real-time session indicator in the VS Code status bar
- Quick access to dashboard and monitoring controls

**CLAUDE.md Suggestions:**
- AI-powered analysis of your session patterns
- Detects recovery patterns (when Claude gets stuck and how it recovers)
- Generates best practices based on actual usage
- Collapsible suggestions panel with progress indicators

![CLAUDE.md suggestions](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/suggest_improvements_to_agent_claude_md.gif)

The monitor automatically discovers Claude Code sessions and updates in real-time. If Claude Code is running in a different directory than your workspace (e.g., a subdirectory), use **Browse Session Folders** to manually select the session folder. Your selection persists across VS Code restarts. Perfect for understanding token usage, tracking costs, and seeing exactly what Claude is doing in your codebase.

### Inline Completions

Get intelligent code suggestions as you type. Completions appear as ghost text that you can accept with Tab.

![Inline completions](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/inline_transforms.gif?v=3)

- Automatic suggestions after a brief pause in typing
- Manual trigger: `Ctrl+Shift+Space` (Cmd+Shift+Space on Mac)
- Toggle on/off via status bar or Command Palette

### Transform Selected Code

Transform selected code using natural language instructions.

![Code transforms](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/code_transforms.gif?v=3)

1. Select the code you want to modify
2. Press `Ctrl+Shift+M` (Cmd+Shift+M on Mac)
3. Enter your instruction (e.g., "Add error handling", "Convert to async/await", "Add TypeScript types")
4. The selection is replaced with the modified code

### Quick Ask (Inline Chat)

Ask questions about code or request changes without leaving your editor.

1. Press `Ctrl+I` (Cmd+I on Mac) to open quick input
2. Ask a question or request a change
3. For changes: review the diff preview and Accept/Reject

**Features:**
- Context-aware - uses selected code or cursor context
- Ask questions - "What does this function do?" or "Is this thread-safe?"
- Request changes - "Add error handling" or "Convert to async/await"
- Diff preview for proposed changes
- Uses Sonnet by default

### Generate Documentation

Automatically generate JSDoc/docstrings for functions, classes, and methods.

1. Place cursor in a function or select code
2. Press `Ctrl+Shift+D` (Cmd+Shift+D on Mac)
3. Documentation is inserted above the function

**Features:**
- Supports TypeScript, JavaScript, Python, and more
- Generates parameter descriptions, return types, and examples
- Uses Haiku by default for fast generation

### Explain Code

Get AI-powered explanations for selected code.

1. Select code you want to understand
2. Press `Ctrl+Shift+E` (Cmd+Shift+E on Mac)
3. Choose complexity level from the submenu

**Features:**
- Five complexity levels: ELI5, Curious Amateur, Imposter Syndrome, Senior, PhD Mode
- Rich webview panel with markdown rendering
- Regenerate with custom instructions
- Uses Sonnet by default

### Error Explanations & Fixes

Understand and fix errors with AI assistance.

- Click the lightbulb on any diagnostic → "Explain Error with AI" or "Fix Error with AI"
- Or right-click → Sidekick → Explain Error / Fix Error
- Five complexity levels for explanations
- Uses Sonnet by default

### AI Commit Messages

Generate intelligent commit messages from your staged changes with a single click.

![AI commit message generation](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/commit_generation.gif?v=3)

1. Stage your changes in the Source Control panel
2. Click the sparkle button in the Source Control toolbar
3. A commit message is generated based on your diff
4. Optionally regenerate with custom guidance (e.g., "focus on the bug fix", "make it shorter")

**Features:**
- Analyzes your git diff to create contextual commit messages
- Supports Conventional Commits format (`feat(scope): description`) or simple descriptions
- Configurable default guidance for consistent commit style across your team
- Automatically filters out lockfiles, binary files, and generated code
- Uses Sonnet by default for high-quality messages

### Pre-commit AI Review

Review your changes before committing. Click the eye icon in the Source Control toolbar.

**Features:**
- Bug detection - catches potential issues before they're committed
- Security concerns - highlights potential vulnerabilities
- Code smells - identifies maintainability issues
- Inline decorations - issues shown directly in the editor
- Uses Sonnet by default for thorough analysis

### PR Description Generation

Generate pull request descriptions automatically. Click the PR icon in the Source Control toolbar.

**Features:**
- Analyzes all commits on your branch vs the base branch
- Generates summary, change list, and test plan
- Copies to clipboard - ready to paste into GitHub/GitLab
- Uses Sonnet by default for comprehensive descriptions

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| Sidekick: Show Menu | Click status bar | Open the Sidekick menu |
| Sidekick: Toggle Inline Completions | - | Enable/disable completions |
| Sidekick: Trigger Completion | Ctrl+Shift+Space | Manually request a completion |
| Sidekick: Transform Selected Code | Ctrl+Shift+M | Transform selected code with instruction |
| Quick Ask | Ctrl+I | Ask questions or request code changes |
| Generate Documentation | Ctrl+Shift+D | Generate JSDoc/docstrings |
| Explain Code | Ctrl+Shift+E | Explain selected code with AI |
| Explain Error with AI | Lightbulb menu | Explain diagnostic error |
| Fix Error with AI | Lightbulb menu | Apply AI-suggested fix |
| Sidekick: Generate Commit Message | Click sparkle in SCM | Generate commit message from staged changes |
| Sidekick: Review My Changes | Click eye in SCM | AI review of staged changes |
| Sidekick: Generate PR Description | Click PR icon in SCM | Generate pull request description |
| Sidekick: View Logs | - | Open output channel for debugging |
| Sidekick: Set API Key | - | Set your Anthropic API key |
| Sidekick: Test Connection | - | Test API connectivity |
| Sidekick: Open Session Dashboard | - | Open the Claude Code session monitor dashboard |
| Sidekick: Start Session Monitoring | - | Begin monitoring Claude Code sessions |
| Sidekick: Stop Session Monitoring | - | Stop monitoring Claude Code sessions |
| Sidekick: Refresh/Find Session | - | Discover new Claude Code sessions |
| Sidekick: Browse Session Folders... | - | Browse all Claude project folders to manually select a session |
| Sidekick: Reset to Auto-Detect Session | - | Clear custom folder selection, revert to auto-detect |
| Sidekick: View Session Conversation | - | Open full conversation viewer for the current session |
| Sidekick: Search Across Sessions | - | Search across all Claude Code sessions |
| Sidekick: Open Tool Inspector | - | Open rich tool call inspector for the current session |

### Status Bar Menu

Click "Sidekick" in the status bar to access:

![Status bar menu](https://raw.githubusercontent.com/cesarandreslopez/sidekick-for-claude-max/main/assets/logs_and_configuration.gif?v=3)

- Enable/Disable completions
- Configure Extension settings
- View Logs
- Test Connection
- Set API Key

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidekick.authMode` | `max-subscription` | Authentication mode: `max-subscription` or `api-key` |
| `sidekick.enabled` | `true` | Enable inline completions |
| `sidekick.debounceMs` | `1000` | Delay before requesting completion (ms) |
| `sidekick.inlineContextLines` | `30` | Lines of context before/after cursor for inline |
| `sidekick.transformContextLines` | `50` | Lines of context before/after selection for transform |
| `sidekick.multiline` | `false` | Enable multi-line completions (prose files always use multiline) |
| `sidekick.inlineModel` | `haiku` | Model for inline: `haiku`, `sonnet`, or `opus` |
| `sidekick.transformModel` | `opus` | Model for transform: `opus`, `sonnet`, or `haiku` |
| `sidekick.docModel` | `haiku` | Model for documentation generation |
| `sidekick.explainModel` | `sonnet` | Model for code explanations |
| `sidekick.errorModel` | `sonnet` | Model for error explanations and fixes |
| `sidekick.inlineChatModel` | `sonnet` | Model for Quick Ask |
| `sidekick.reviewModel` | `sonnet` | Model for pre-commit review |
| `sidekick.prDescriptionModel` | `sonnet` | Model for PR description generation |
| `sidekick.commitMessageModel` | `sonnet` | Model for commit messages: `haiku`, `sonnet`, or `opus` |
| `sidekick.commitMessageStyle` | `conventional` | Commit format: `conventional` or `simple` |
| `sidekick.commitMessageGuidance` | (empty) | Default guidance for all commit messages |
| `sidekick.showCommitButton` | `true` | Show commit message button in Source Control |
| `sidekick.claudePath` | (empty) | Custom path to Claude CLI (for pnpm/yarn/non-standard installs) |
| `sidekick.explanationComplexity` | `imposter-syndrome` | AI explanation level: `eli5`, `curious-amateur`, `imposter-syndrome`, `senior`, `phd` |
| `sidekick.explanationModel` | `sonnet` | Model for explanations: `haiku`, `sonnet`, or `opus` |
| `sidekick.showCompletionHint` | `true` | Show visual hint at cursor suggesting AI completion |
| `sidekick.completionHintDelayMs` | `1500` | Delay before showing completion hint (ms) |
| `sidekick.enableSessionMonitoring` | `true` | Enable Claude Code session monitoring |
| `sidekick.notifications.enabled` | `true` | Enable session notification triggers |
| `sidekick.notifications.triggers.env-access` | `true` | Alert on credential/env file access |
| `sidekick.notifications.triggers.destructive-cmd` | `true` | Alert on destructive commands |
| `sidekick.notifications.triggers.tool-error` | `true` | Alert on tool error bursts |
| `sidekick.notifications.triggers.compaction` | `true` | Alert on context compaction |
| `sidekick.notifications.tokenThreshold` | `0` | Alert when token usage exceeds this value (0 = disabled) |

> **Note:** Prose files (Markdown, plaintext, HTML, XML, LaTeX, etc.) automatically use multiline mode regardless of the setting.

## Troubleshooting

### No completions appearing
1. Click status bar → "Test Connection" to verify API connectivity
2. Click status bar → "View Logs" to check for errors
3. Verify the status bar shows "Sidekick" is enabled

### "Claude Code CLI not found" error (Max subscription mode)
- Install the CLI: `npm install -g @anthropic-ai/claude-code`
- Authenticate: `claude auth`
- Verify: `claude --version`
- **If installed via pnpm/yarn/volta:** Set `sidekick.claudePath` in settings to the full path (find it with `which claude` on Linux/Mac or `where claude` on Windows)

### API key issues (API key mode)
- Run "Sidekick: Set API Key" to update your key
- Ensure your API key has sufficient credits
- Run "Sidekick: Test Connection" to verify connectivity

### Rate limited
- Wait a moment and try again
- Consider using `haiku` model for more frequent completions
- Increase `debounceMs` to reduce request frequency

## Architecture

The extension uses the Anthropic SDK directly:
- **Max subscription mode**: Uses Claude Agent SDK to leverage your existing CLI authentication
- **API key mode**: Uses Anthropic SDK with your API key

No local server required.

## License

MIT
