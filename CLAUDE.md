# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sidekick Agent Hub is an AI coding assistant and project-intelligence toolkit with real-time agent monitoring. It ships as a VS Code extension and a terminal dashboard. Inference can run through Claude Max, Claude API, OpenCode, or Codex CLI; session monitoring reads Claude Code, OpenCode, or Codex session data.

The repo is a small monorepo:

- `sidekick-vscode/` — VS Code extension, extension-host services, and webview source
- `sidekick-shared/` — canonical provider, parser, persistence, quota, transcript, and schema library used by the extension and CLI; published as `sidekick-shared`
- `sidekick-cli/` — Ink-based terminal dashboard and one-shot command suite; published as `sidekick-agent-hub` with the `sidekick` binary
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
npm run format       # Prettier write for this package
npm run format:check # Prettier check for this package
npm run package      # Create .vsix for distribution
```

Run a single test file: `npx vitest run src/services/ModelResolver.test.ts` (from `sidekick-vscode/`).

Press **F5** in VS Code with `sidekick-vscode/` open to launch the Extension Development Host.

Shared library commands run from `sidekick-shared/`:

```bash
npm run build        # tsc build to dist/
npm run clean        # Remove dist/
npm test             # Build, then run Vitest
npm run test:watch   # Watch mode for tests
npm run lint         # ESLint check
npm run lint:fix     # ESLint auto-fix
npm run format       # Prettier write for this package
npm run format:check # Prettier check for this package
```

CLI commands run from `sidekick-cli/`:

```bash
npm run build        # Build ESM launcher + main bundle in dist/
npm run build:sea    # Build the Node 22 SEA input bundle (dist/sidekick-sea.mjs)
npm run clean        # Remove dist/
npm test             # Run Vitest
npm run test:watch   # Watch mode for tests
npm run lint         # ESLint check
npm run lint:fix     # ESLint auto-fix
npm run format       # Prettier write for this package
npm run format:check # Prettier check for this package
npx tsc --noEmit     # Type-check (also run by release CI)
```

**Monorepo-wide helpers** (run from repo root) cover all three packages — `sidekick-shared`, `sidekick-vscode`, `sidekick-cli`:

```bash
bash scripts/lint-all.sh          # Lint all three packages (CI lints each separately)
bash scripts/lint-all.sh --fix    # Lint + auto-fix all three
bash scripts/format-all.sh        # Prettier write across packages, docs, root markdown/YAML, and workflows
bash scripts/format-check-all.sh  # Prettier check across packages, docs, root markdown/YAML, and workflows
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

| Output                                       | Format   | Platform |
| -------------------------------------------- | -------- | -------- |
| `out/extension.js` (from `src/extension.ts`) | CommonJS | Node.js  |
| `out/webview/explain.js`                     | IIFE     | Browser  |
| `out/webview/error.js`                       | IIFE     | Browser  |
| `out/webview/dashboard.js`                   | IIFE     | Browser  |
| `out/webview/chartjs-vendor.js`              | IIFE     | Browser  |
| `out/webview/d3-vendor.js`                   | IIFE     | Browser  |

Only `vscode` is externalized from the extension-host bundle. Other extension dependencies (including `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`, and `sidekick-shared`) are bundled by esbuild. The `conditions: ['import']`, `banner`, and `define` settings in `esbuild.js` polyfill `import.meta.url` for ESM deps bundled into CJS. Chart.js and D3.js are bundled into local browser vendor files so the dashboard and mind map work offline.

### Dual Provider System

Two separate provider concepts exist:

1. **Inference providers** (`InferenceProviderId` in `sidekick-vscode/src/types/inferenceProvider.ts`): `claude-max | claude-api | opencode | codex` — which service generates AI completions
2. **Session providers** (`ProviderId` / `SessionProviderBase` in `sidekick-shared/src/providers/types.ts`, extended by the VS Code `SessionProvider` in `sidekick-vscode/src/types/sessionProvider.ts`): `claude-code | opencode | codex` — which CLI agent's sessions to monitor

Both use the shared `sidekick-shared/src/providers/detect.ts` auto-detection based on session-data presence and most-recent activity. The VS Code `ProviderDetector` is a thin settings-aware adapter. Inference and session provider selections remain independent.

### ClaudeClient Interface

All inference clients implement `ClaudeClient` from `sidekick-vscode/src/types.ts`:

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

### Shared Library Runtime Boundaries

- `sidekick-shared` is the full Node-oriented public API used by the extension host and CLI.
- `sidekick-shared/browser` contains pure filesystem-free helpers for webviews and browser bundles. Webview code must not import the package root or `sidekick-shared/node`.
- `sidekick-shared/node` contains explicitly Node-only catalog hydration, observed-context persistence, transcript/history reads, session previews, and observed-session collection.
- `sidekick-shared/schemas` and `sidekick-shared/statusline` are dedicated schema and status-line entry points. Prefer public entry points over `sidekick-shared/dist/*` compatibility deep imports.
- Built-in provider constructors perform no environment probing. Long-lived hosts should use `createSessionProviders({ onDiagnostic })`; missing databases, directories, or `sqlite3` are reported as structured diagnostics on use rather than constructor failures.

### Session Monitoring Pipeline

```
CLI agent writes JSONL/SQLite/session files
  → sidekick-shared SessionProviderBase (normalizes to SessionEvent)
    → VS Code SessionMonitor (watches files, aggregates stats, emits events)
      → Dashboard / MindMap / KanbanBoard / TreeViews / Notifications
```

Canonical provider implementations live in `sidekick-shared/src/providers/`. The classes in `sidekick-vscode/src/services/providers/` are thin VS Code adapters with product-specific quota hooks. The canonical event type is `SessionEvent` in `sidekick-shared/src/types/sessionEvent.ts`; `ClaudeSessionEvent` remains only as a compatibility alias, and `sidekick-vscode/src/types/claudeSession.ts` re-exports the shared types.

For non-VS Code consumers, `sidekick-shared/src/sessionMonitor.ts` provides a UI-independent monitor and `ObservedSessionCollector` provides fingerprint-cached collection with an optional subscription model.

### Request Management

- **Debouncing**: Configurable delay (default 1000ms) before firing inline completion requests
- **LRU cache**: `CompletionCache` — 100 entries, 30s TTL
- **Cancellation**: `AbortController` linked through `CompletionOptions.signal`
- **Timeouts**: `TimeoutManager` provides per-operation timeouts with context-size scaling

### Key Source Locations

- **Extension entry point**: `sidekick-vscode/src/extension.ts` — `activate()`, command/provider registration
- **Extension core types**: `sidekick-vscode/src/types.ts` (`ClaudeClient`, `CompletionOptions`) and `sidekick-vscode/src/types/`
- **Prompt templates**: `sidekick-vscode/src/utils/prompts.ts`, `sidekick-vscode/src/utils/analysisPrompts.ts`, `sidekick-vscode/src/utils/summaryPrompts.ts`
- **Inference clients**: `sidekick-vscode/src/services/AuthService.ts`, `sidekick-vscode/src/services/MaxSubscriptionClient.ts`, `sidekick-vscode/src/services/ApiKeyClient.ts`, `sidekick-vscode/src/services/OpenCodeClient.ts`, `sidekick-vscode/src/services/CodexClient.ts` (spawns the CLI directly, no SDK)
- **Canonical session providers**: `sidekick-shared/src/providers/claudeCode.ts`, `sidekick-shared/src/providers/openCode.ts`, `sidekick-shared/src/providers/codex.ts`; factory/detection/types are alongside them
- **VS Code provider adapters**: `sidekick-vscode/src/services/providers/ClaudeCodeSessionProvider.ts`, `sidekick-vscode/src/services/providers/OpenCodeSessionProvider.ts`, `sidekick-vscode/src/services/providers/CodexSessionProvider.ts`
- **Shared public surfaces**: `sidekick-shared/src/index.ts`, `sidekick-shared/src/browser.ts`, `sidekick-shared/src/node.ts`, `sidekick-shared/src/schemas/index.ts`, `sidekick-shared/src/statusline/index.ts`
- **Shared session pipeline**: `sidekick-shared/src/types/sessionEvent.ts`, `sidekick-shared/src/sessionMonitor.ts`, `sidekick-shared/src/observedSessionCollector.ts`, `sidekick-shared/src/sessionTranscripts.ts`, `sidekick-shared/src/sessionPreviews.ts`
- **CLI entry points**: `sidekick-cli/src/entry.ts` (fast status-line dispatch) and `sidekick-cli/src/cli.ts` (Commander registration); command implementations are in `sidekick-cli/src/commands/`
- **z.ai quota** (shared): `sidekick-shared/src/zaiQuotaApi.ts` — `resolveZaiQuota()` reads z.ai's authoritative `api/monitor/usage/quota/limit` endpoint (5-Hour / Weekly windows), discovering credentials from OpenCode's stored z.ai token (`zai-coding-plan` → `zai`) or `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`, with cached-snapshot fallback. The older observed-traffic estimator (`zaiQuota.ts` / `zaiQuotaWatcher.ts`) is retained for backward compatibility but deprecated and no longer used for product quota display. z.ai is monitored-only — no z.ai inference provider or account-management surface yet
- **Webview UI**: `sidekick-vscode/src/webview/` — vanilla TS bundled as IIFE; Chart.js and D3.js load from local vendor bundles. The dashboard document is rendered by `src/providers/dashboardTemplate.ts` (markup) and `dashboardStyles.ts` (CSS); its behaviour is the `src/webview/dashboard/` bundle, where `legacy.ts` is the still-untyped script moved out of the old inline template and new features go in typed modules beside it

### Persistence

Cross-session data defaults to `~/.config/sidekick/` on Unix and `%APPDATA%/sidekick/` on Windows. `getConfigDir()` resolves a `setConfigDir()` override first, then `SIDEKICK_CONFIG_DIR`, then the platform default. Do not hardcode the default path in new storage code.

Important stores include:

- `historical-data.json` — token/cost/tool usage stats and bounded session history
- `tasks/`, `decisions/`, `plans/`, `knowledge-notes/`, `notifications/` — per-project JSON stores
- `handoffs/` — latest and timestamped session handoff documents
- `event-logs/` and `error-history.json` — optional session audit logs and categorized error history
- `accounts/accounts.json`, `quota-snapshots.json`, `quota-history/` — provider-aware accounts and quota state/history
- `snapshots/` — cached session aggregation snapshots
- `pricing-catalog.json` — cached LiteLLM prices and context windows (24h TTL)
- `observed-context-windows.json` — context windows actually reported by providers, per model
- `usage-cache/` — per-session usage events extracted from session logs, keyed by size and mtime (feeds billing blocks and usage reports)
- `state.json` — public, versioned (`schemaVersion: 1`) snapshot for external tools, written by the status line and both dashboards only when changed
- `cli-config.json` and `update-check.json` — CLI preferences and update-check cache

Use the shared path helpers and atomic writers for cross-process stores. `resolveProjectIdentity()` resolves symlinks and exposes canonical plus legacy slugs for migration. Do not confuse Sidekick's config-store `encodeWorkspacePath()` with Claude Code's directory encoder; use `encodeClaudeWorkspacePath()` / `getClaudeSessionDirectory()` for `~/.claude/projects/` paths.

## Sidekick CLI and Shared Library

The CLI and extension use the same config root and shared provider/session formats. The CLI reads the persisted project data and also writes through commands such as `tasks add` / `tasks done`, `note add`, `decision add`, and `import`; use `sidekick-shared` readers, writers, and path helpers instead of duplicating file I/O. Build everything with `bash scripts/build-all.sh`. The CLI build emits `dist/sidekick-cli.mjs` as the executable launcher and `dist/sidekick-main.mjs` as the dynamically loaded main bundle.

- **npm package**: `sidekick-agent-hub` — the **binary name** is `sidekick` (defined in `sidekick-cli/package.json` `bin` field), not `sidekick-agent-hub`
- **shared npm package**: `sidekick-shared` — published independently for readers/writers, providers, schemas, transcripts, context projection, usage normalization, pricing, quota, and session asset extraction
- **CLI discovery**: `sidekick-vscode/src/services/SidekickCliService.ts` searches configured path → common paths (including nvm) → `which sidekick`
- **VS Code terminal launch gotcha**: `vscode.window.createTerminal({ shellPath })` bypasses shell init (`.bashrc`/`.zshrc`), so nvm/volta `node` is not in PATH. The service injects the CLI's bin directory into the terminal `env.PATH` to fix this.

## Testing

Tests use **Vitest** with co-located `.test.ts` / `.test.tsx` files. When a tested extension module imports `vscode`, mock it with `vi.mock("vscode", ...)` because VS Code is not available in the test runner. The shared package's `npm test` runs its build through `pretest`; release CI also runs `npx tsc --noEmit` for the CLI.

## Conventions

- **TypeScript**: `strict: true`, target ES2022. The extension and CLI use `noEmit: true` and build with esbuild; `sidekick-shared` emits CommonJS JavaScript and declarations via `tsc`.
- **Linting**: ESLint 9 + typescript-eslint; `@typescript-eslint/no-explicit-any` is `warn`; unused vars prefixed with `_` are allowed
- **Commits**: Conventional Commits (`feat(scope):`, `fix(scope):`, etc.)
- **Branches**: `feature/`, `fix/`, `docs/`, `refactor/` prefixes
- **File naming**: PascalCase for classes/services, camelCase for utilities
- **Settings prefix**: All VS Code settings use `sidekick.*`

## Release Process

Releases are triggered by pushing a `v*` tag to `main`. The CI workflow (`.github/workflows/release.yml`) runs five jobs:

1. **Validate Version** — verifies tag is on `main` and all three `package.json` versions match the tag
2. **Publish VS Code Extension** — lint, format-check, test, package `.vsix`, upload as artifact, publish to Open VSX (skip if the version already exists)
3. **Publish Shared Library to npm** — lint, format-check, test, build, publish `sidekick-shared` (skips if version already published)
4. **Publish CLI to npm** — build shared lib, then format-check, lint, type-check, test, build, and verify the CLI before publishing `sidekick-agent-hub` (skips if version already published)
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
