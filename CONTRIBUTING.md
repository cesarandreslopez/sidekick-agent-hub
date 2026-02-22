# Contributing to Sidekick Agent Hub

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing.

## Getting Started

### Prerequisites

- Node.js 18+
- VS Code 1.85+
- Claude Max subscription with authenticated CLI (`claude auth`), or an Anthropic API key

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/cesarandreslopez/sidekick-agent-hub.git
   cd sidekick-agent-hub
   ```

2. **Set up the VS Code extension**
   ```bash
   cd sidekick-vscode
   npm install
   npm run compile
   ```

3. **Build the shared library and CLI** (optional)
   ```bash
   bash scripts/build-all.sh
   ```

4. **Run tests to verify setup**
   ```bash
   npm test
   ```

## Development Workflow

### Running Locally

1. Open `sidekick-vscode/` in VS Code and press `F5` to launch the Extension Development Host.

### Available Commands

All commands run from `sidekick-vscode/`:

```bash
npm run compile      # Dev build (with source maps)
npm run build        # Production build (minified)
npm run watch        # Watch mode for development
npm test             # Run all tests (Vitest)
npm run test:watch   # Watch mode for tests
npm run lint         # Check for linting issues
npm run lint:fix     # Auto-fix linting issues
npm run package      # Create .vsix for distribution
```

### Code Style

- We use ESLint for linting
- Run `npm run lint` before committing
- Run `npm run lint:fix` to auto-fix issues

### Running Tests

Tests use Vitest and are co-located with source files (e.g., `FooService.ts` / `FooService.test.ts`). When adding new functionality, add tests alongside the source.

```bash
npm test             # Run all tests
npm run test:watch   # Watch mode
```

## Project Structure

```
sidekick-for-claude-max/
├── sidekick-vscode/    # VS Code extension
├── sidekick-shared/    # Pure TS library (readers, types, providers)
├── sidekick-cli/       # CLI binary (TUI dashboard)
├── scripts/            # Build scripts
├── docs/               # Documentation site
└── ...
```

### Extension Source

```
sidekick-vscode/src/
├── extension.ts                 # Entry point: activate(), command registration
├── types.ts                     # Shared interfaces (AuthMode, ClaudeClient, etc.)
├── providers/
│   ├── InlineCompletionProvider.ts  # VS Code InlineCompletionItemProvider
│   ├── DashboardViewProvider.ts     # Session analytics webview
│   ├── MindMapViewProvider.ts       # D3.js mind map visualization
│   ├── TaskBoardViewProvider.ts     # Kanban board for task tracking
│   ├── ExplainViewProvider.ts       # Code explanation webview
│   ├── ErrorViewProvider.ts         # Error explanation webview
│   ├── InlineChatProvider.ts        # Inline chat / quick ask
│   ├── TempFilesTreeProvider.ts     # Tree view for files touched by Claude
│   └── SubagentTreeProvider.ts      # Tree view for subagent monitoring
├── services/
│   ├── AuthService.ts           # Central auth orchestration
│   ├── MaxSubscriptionClient.ts # Claude Code CLI integration
│   ├── ApiKeyClient.ts          # Direct Anthropic API client
│   ├── CompletionService.ts     # Debouncing, caching, cancellation
│   ├── CompletionCache.ts       # LRU cache for completions
│   ├── CommitMessageService.ts  # AI commit messages from git diffs
│   ├── GitService.ts            # Git operations (diff, staging)
│   ├── SessionMonitor.ts        # Real-time JSONL session file monitoring
│   ├── SessionPathResolver.ts   # Cross-platform Claude Code directory detection
│   ├── JsonlParser.ts           # JSONL parser with line buffering
│   ├── ModelPricingService.ts   # Token cost calculation by model
│   ├── BurnRateCalculator.ts    # Token consumption tracking
│   ├── TimeoutManager.ts        # Adaptive timeout logic
│   └── ...                      # + explanation, documentation, review services
├── types/                       # Type definitions per feature area
├── utils/
│   ├── prompts.ts               # System/user prompts for all features
│   ├── diffFilter.ts            # Filters lockfiles/binaries from diffs
│   └── tokenEstimator.ts        # Token usage estimation
└── webview/                     # Browser-context UI code (IIFE bundles)
    └── dashboard.ts             # Dashboard UI with Chart.js
```

### Key Architecture Concepts

- **Build system:** esbuild bundles two targets -- CommonJS for the extension host (`out/extension.js`) and IIFE for webviews (`out/webview/*.js`).
- **Dual auth modes:** Max subscription (default, no API cost) or API key (per-token billing). Both implement `ClaudeClient` in `types.ts`.
- **Model tiers:** Haiku (fast inline completions), Sonnet (balanced), Opus (quality transforms). Each feature has its own configurable model setting.
- **Request management:** Debouncing (configurable delay), LRU caching, AbortController for cancellation.
- **Session monitoring:** `SessionMonitor` watches JSONL files and emits events consumed by the dashboard, mind map, kanban board, and tree providers.
- **Prompt templates:** All prompts centralized in `utils/prompts.ts` and `utils/analysisPrompts.ts`.

## Making Changes

### Branch Naming

- `feature/description` - New features
- `fix/description` - Bug fixes
- `docs/description` - Documentation changes
- `refactor/description` - Code refactoring

### Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(auth): add OAuth2 support
fix(completion): handle empty responses gracefully
docs: update README with troubleshooting section
refactor(session): extract path resolution logic
```

Guidelines:
- Use present tense, imperative mood ("add feature" not "added feature")
- Keep the first line under 72 characters
- Reference issues when applicable (`Fix #123`)

### Pull Requests

1. Create a feature branch from `main`
2. Make your changes with clear commits
3. Ensure all tests pass (`npm test`)
4. Ensure linting passes (`npm run lint`)
5. Update documentation if needed
6. Submit a PR with a clear description

## Areas for Contribution

### Good First Issues

Look for issues labeled `good first issue` -- these are suitable for newcomers.

### Current Priorities

- Test coverage improvements (add tests alongside new or existing services)
- Session monitoring enhancements (dashboard, mind map, kanban board)
- Performance improvements for inline completions
- Documentation and developer experience
- Bug fixes

## Questions?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
