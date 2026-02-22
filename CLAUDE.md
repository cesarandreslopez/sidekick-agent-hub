# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sidekick for Max is a VS Code extension providing AI-powered inline completions, code transforms, commit messages, session monitoring, and more — using the user's existing Claude Max subscription or Anthropic API key. It also supports OpenCode and Codex CLI as inference and monitoring providers.

All extension source lives in `sidekick-vscode/`. The root directory contains only documentation and assets.

## Build & Development Commands

All commands run from `sidekick-vscode/`:

```bash
npm run compile      # Dev build with source maps (esbuild)
npm run build        # Production build, minified
npm run watch        # Watch mode for development
npm test             # Run all tests (Vitest)
npm run test:watch   # Watch mode for tests
npm run lint         # ESLint check
npm run lint:fix     # ESLint auto-fix
npm run package      # Create .vsix for distribution
```

Run a single test file: `npx vitest run src/services/ModelResolver.test.ts` (from `sidekick-vscode/`).

Press **F5** in VS Code with `sidekick-vscode/` open to launch the Extension Development Host.

### Documentation Site

The docs site uses **zensical** (not mkdocs). Config is in `mkdocs.yml` at the repo root, content in `docs/`.

```bash
zensical build --strict   # Build docs site (from repo root)
zensical serve            # Local dev server with hot reload
```

Do **not** use `mkdocs build` or `mkdocs serve` — use `zensical` instead.

## Architecture

### Build System (esbuild.js)

esbuild produces four bundles:

| Output | Format | Platform |
|--------|--------|----------|
| `out/extension.js` (from `src/extension.ts`) | CommonJS | Node.js |
| `out/webview/explain.js` | IIFE | Browser |
| `out/webview/error.js` | IIFE | Browser |
| `out/webview/dashboard.js` | IIFE | Browser |

Only `vscode` is externalized. All other dependencies (including `@anthropic-ai/claude-agent-sdk` and `@opencode-ai/sdk`) are bundled by esbuild. The `conditions: ['import']`, `banner`, and `define` settings in esbuild.js polyfill `import.meta.url` for ESM deps bundled into CJS.

### Dual Provider System

Two separate provider concepts exist:

1. **Inference providers** (`InferenceProviderId` in `src/types/inferenceProvider.ts`): `claude-max | claude-api | opencode | codex` — which service generates AI completions
2. **Session providers** (`SessionProvider` in `src/types/sessionProvider.ts`): `claude-code | opencode | codex` — which CLI agent's sessions to monitor

Both use auto-detection via `ProviderDetector` based on filesystem presence and most-recent mtime.

### ClaudeClient Interface

All inference clients implement `ClaudeClient` from `src/types.ts`:

```typescript
interface ClaudeClient {
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  isAvailable(): Promise<boolean>;
  dispose(): void;
}
```

`AuthService` is the central entry point — lazily initializes the correct client and routes all `complete()` calls.

### Model Resolution

`ModelResolver.resolveModel()` handles: `"auto"` → per-feature default tier (from `FEATURE_AUTO_TIERS`) → provider-specific model ID. Legacy names (`haiku`/`sonnet`/`opus`) map through `LEGACY_TIER_MAP`. Tiers (`fast`/`balanced`/`powerful`) map through `DEFAULT_MODEL_MAPPINGS`. Anything else passes through as a literal model ID.

### Session Monitoring Pipeline

```
CLI agent writes JSONL/DB files
  → SessionProvider (normalizes to ClaudeSessionEvent)
    → SessionMonitor (watches files, aggregates stats, emits events)
      → Dashboard / MindMap / KanbanBoard / TreeViews / Notifications
```

Provider implementations live in `src/services/providers/`. Each normalizes raw data into `ClaudeSessionEvent` format defined in `src/types/claudeSession.ts`.

### Request Management

- **Debouncing**: Configurable delay (default 1000ms) before firing inline completion requests
- **LRU cache**: `CompletionCache` — 100 entries, 30s TTL
- **Cancellation**: `AbortController` linked through `CompletionOptions.signal`
- **Timeouts**: `TimeoutManager` provides per-operation timeouts with context-size scaling

### Key Source Locations

- **Entry point**: `src/extension.ts` — `activate()`, all command/provider registration
- **Core types**: `src/types.ts` (ClaudeClient, CompletionOptions), `src/types/` (per-feature types)
- **Prompt templates**: `src/utils/prompts.ts`, `src/utils/analysisPrompts.ts`, `src/utils/summaryPrompts.ts`
- **Inference clients**: `src/services/AuthService.ts`, `MaxSubscriptionClient.ts`, `ApiKeyClient.ts`, `OpenCodeClient.ts`, `CodexClient.ts` (spawns CLI directly, no SDK)
- **Session providers**: `src/services/providers/ClaudeCodeSessionProvider.ts`, `OpenCodeSessionProvider.ts`, `CodexSessionProvider.ts`
- **Webview UI**: `src/webview/` — vanilla TS, bundled as IIFE; Chart.js for dashboard, D3.js for mind map

### Persistence

Cross-session data stored in `~/.config/sidekick/`:
- `historical-data.json` — token/cost/tool usage stats
- `tasks/{projectSlug}.json` — kanban board carry-over
- `decisions/{projectSlug}.json` — decision log

## Sidekick CLI

The CLI reads from `~/.config/sidekick/` (same data as the VS Code extension). Build with `bash scripts/build-all.sh`. Source in `sidekick-shared/` (pure TS library) and `sidekick-cli/` (esbuild-bundled binary).

## Testing

Tests use **Vitest** with co-located files (`Foo.ts` / `Foo.test.ts`). The `vscode` module must be mocked in test files using `vi.mock("vscode", ...)` since VS Code is not available in the test runner.

## Conventions

- **TypeScript**: `strict: true`, target ES2022, no tsc emission (`noEmit: true` — esbuild builds)
- **Linting**: ESLint 9 + typescript-eslint; `@typescript-eslint/no-explicit-any` is `warn`; unused vars prefixed with `_` are allowed
- **Commits**: Conventional Commits (`feat(scope):`, `fix(scope):`, etc.)
- **Branches**: `feature/`, `fix/`, `docs/`, `refactor/` prefixes
- **File naming**: PascalCase for classes/services, camelCase for utilities
- **Settings prefix**: All VS Code settings use `sidekick.*`
