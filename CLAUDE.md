# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sidekick Agent Hub is an AI coding assistant with real-time agent monitoring. It ships as a VS Code extension and a terminal dashboard, using Claude Max, Claude API, OpenCode, or Codex CLI for inference and session monitoring.

The repo is a small monorepo:

- `sidekick-vscode/` — VS Code extension, extension-host services, and webview source
- `sidekick-shared/` — shared TypeScript library used by the extension and CLI; published as `sidekick-shared`
- `sidekick-cli/` — Ink-based terminal dashboard; published as `sidekick-agent-hub` with the `sidekick` binary
- `docs/`, `mkdocs.yml`, `assets/`, `images/` — documentation site content and assets
- `scripts/` — cross-package build, lint, and version helpers

## Build & Development Commands

Extension commands run from `sidekick-vscode/`:

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

Shared library commands run from `sidekick-shared/`:

```bash
npm run build        # tsc build to dist/
npm test             # Build, then run Vitest
npm run lint         # ESLint check
```

CLI commands run from `sidekick-cli/`:

```bash
npm run build        # esbuild ESM binary to dist/sidekick-cli.mjs
npm test             # Run Vitest
npm run lint         # ESLint check
```

**Monorepo-wide helpers** (run from repo root) cover all three packages — `sidekick-shared`, `sidekick-vscode`, `sidekick-cli`:

```bash
bash scripts/lint-all.sh          # Lint all three packages (CI lints each separately)
bash scripts/lint-all.sh --fix    # Lint + auto-fix all three
bash scripts/build-all.sh         # npm install + build all three; CLI binary at sidekick-cli/dist/sidekick-cli.mjs
bash scripts/bump-version.sh X.Y.Z # Update package.json versions; sync lockfiles separately
```

### Documentation Site

The docs site uses **zensical** (not mkdocs). Config is in `mkdocs.yml` at the repo root, content in `docs/`.

```bash
zensical build --strict   # Build docs site (from repo root)
zensical serve            # Local dev server with hot reload
```

Do **not** use `mkdocs build` or `mkdocs serve` — use `zensical` instead.

## Architecture

### Build System (esbuild.js)

`sidekick-vscode/esbuild.js` produces six bundles:

| Output | Format | Platform |
|--------|--------|----------|
| `out/extension.js` (from `src/extension.ts`) | CommonJS | Node.js |
| `out/webview/explain.js` | IIFE | Browser |
| `out/webview/error.js` | IIFE | Browser |
| `out/webview/dashboard.js` | IIFE | Browser |
| `out/webview/chartjs-vendor.js` | IIFE | Browser |
| `out/webview/d3-vendor.js` | IIFE | Browser |

Only `vscode` is externalized from the extension-host bundle. Other extension dependencies (including `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`, and `sidekick-shared`) are bundled by esbuild. The `conditions: ['import']`, `banner`, and `define` settings in `esbuild.js` polyfill `import.meta.url` for ESM deps bundled into CJS. Chart.js and D3.js are bundled into local browser vendor files so the dashboard and mind map work offline.

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
- **z.ai quota derivation** (shared): `sidekick-shared/src/zaiQuota.ts` (stateless accumulator/tier resolver/error parser) and `zaiQuotaWatcher.ts` (event-driven watcher). z.ai has no usage API, so quota is *estimated* from OpenCode traffic — observed-only, no z.ai inference provider or account management yet
- **Webview UI**: `src/webview/` — vanilla TS bundled as IIFE; Chart.js and D3.js load from local vendor bundles

### Persistence

Cross-session data stored in `~/.config/sidekick/`:
- `historical-data.json` — token/cost/tool usage stats
- `tasks/{projectSlug}.json` — kanban board carry-over
- `decisions/{projectSlug}.json` — decision log

## Sidekick CLI and Shared Library

The CLI reads from `~/.config/sidekick/` (same data as the VS Code extension). Build everything with `bash scripts/build-all.sh`. Shared data access lives in `sidekick-shared/` (tsc-built TypeScript library); the terminal dashboard lives in `sidekick-cli/` (esbuild-bundled ESM binary).

- **npm package**: `sidekick-agent-hub` — the **binary name** is `sidekick` (defined in `sidekick-cli/package.json` `bin` field), not `sidekick-agent-hub`
- **shared npm package**: `sidekick-shared` — published independently for consumers that need readers, providers, schemas, formatting, model info, and session asset extraction
- **CLI discovery**: `SidekickCliService.ts` searches configured path → common paths (including nvm) → `which sidekick`
- **VS Code terminal launch gotcha**: `vscode.window.createTerminal({ shellPath })` bypasses shell init (`.bashrc`/`.zshrc`), so nvm/volta `node` is not in PATH. The service injects the CLI's bin directory into the terminal `env.PATH` to fix this.

## Testing

Tests use **Vitest** with co-located files (`Foo.ts` / `Foo.test.ts`). The `vscode` module must be mocked in test files using `vi.mock("vscode", ...)` since VS Code is not available in the test runner.

## Conventions

- **TypeScript**: `strict: true`, target ES2022. The extension uses `noEmit: true` and builds with esbuild; `sidekick-shared` emits declarations and JavaScript via `tsc`.
- **Linting**: ESLint 9 + typescript-eslint; `@typescript-eslint/no-explicit-any` is `warn`; unused vars prefixed with `_` are allowed
- **Commits**: Conventional Commits (`feat(scope):`, `fix(scope):`, etc.)
- **Branches**: `feature/`, `fix/`, `docs/`, `refactor/` prefixes
- **File naming**: PascalCase for classes/services, camelCase for utilities
- **Settings prefix**: All VS Code settings use `sidekick.*`

## Release Process

Releases are triggered by pushing a `v*` tag to `main`. The CI workflow (`.github/workflows/release.yml`) runs five jobs:

1. **Validate Version** — verifies tag is on `main` and all three `package.json` versions match the tag
2. **Publish VS Code Extension** — lint, test, package `.vsix`, upload as artifact, publish to Open VSX
3. **Publish Shared Library to npm** — lint, test, build, publish `sidekick-shared` (skips if version already published)
4. **Publish CLI to npm** — build shared lib, test CLI, build CLI, verify binary, publish `sidekick-agent-hub` (skips if version already published)
5. **Create GitHub Release** — downloads `.vsix` artifact, extracts changelog section, creates release with `.vsix` attached

**Version bump checklist** (all must match the tag):
- `bash scripts/bump-version.sh <version>` bumps the three `package.json` files at once. It does **not** touch lockfiles, so still:
  - `sidekick-vscode/package-lock.json`, `sidekick-cli/package-lock.json`, and `sidekick-shared/package-lock.json` (run `npm install --package-lock-only` in each workspace)
- If bumping by hand instead, the three `package.json` files are: `sidekick-vscode/`, `sidekick-cli/`, `sidekick-shared/`

**Changelogs to update** (five total):
- `CHANGELOG.md` (root — full project)
- `sidekick-vscode/CHANGELOG.md` (extension-specific)
- `sidekick-cli/CHANGELOG.md` (CLI-specific)
- `sidekick-shared/CHANGELOG.md` (shared-library-specific)
- `docs/changelog.md` (documentation site)
