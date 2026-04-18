# sidekick-shared

Shared data access library for [Sidekick Agent Hub](https://github.com/cesarandreslopez/sidekick-agent-hub).

[![npm version](https://img.shields.io/npm/v/sidekick-shared.svg)](https://www.npmjs.com/package/sidekick-shared)
[![license](https://img.shields.io/npm/l/sidekick-shared.svg)](https://github.com/cesarandreslopez/sidekick-agent-hub/blob/main/LICENSE)

Types, parsers, providers, readers, formatters, aggregation, search, reporting, credentials, and quota for AI agent session monitoring. Used by both the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) and the [CLI dashboard](https://www.npmjs.com/package/sidekick-agent-hub).

## Installation

```bash
npm install sidekick-shared
```

## API Overview

| Module | Description |
|--------|-------------|
| **Types** | Session events, OpenCode/Codex format types, persistence schemas (tasks, decisions, notes, plans, historical data) |
| **Paths** | Config directory resolution, project data paths, workspace encoding |
| **Readers** | Read tasks, decisions, notes, history, handoff, and plans from `~/.config/sidekick/` |
| **Providers** | Session provider abstraction with Claude Code, OpenCode, and Codex implementations; auto-detection via filesystem |
| **Parsers** | JSONL event parsing, OpenCode/Codex format normalization, subagent scanning, session path resolution, debug log parsing |
| **Watchers** | Live session file watching with event bridging |
| **Formatters** | Tool summary, noise classification, session dump (text/markdown/JSON), event highlighting |
| **Search** | Cross-session full-text search, advanced filtering (substring, fuzzy, regex, date) |
| **Aggregation** | Event aggregation, frequency tracking, activity heatmaps, pattern extraction |
| **Report** | Self-contained HTML session report generation |
| **Credentials** | Claude Max OAuth credential reading from `~/.claude/.credentials.json` |
| **Quota** | Claude Max subscription quota fetching (5-hour and 7-day windows) and Codex rate-limit extraction from event streams |
| **Provider Status** | API health checking via status.claude.com and status.openai.com (indicator, components, incidents) |
| **Schemas** | Zod schemas for runtime JSONL event validation (`sessionEventSchema`, `messageUsageSchema`, `sessionMessageSchema`) |
| **Extractors** | Pure functions for single-event processing: `extractTokenUsage()`, `extractToolCalls()` |
| **Model Info & Pricing** | Model family parsing (Anthropic / OpenAI / Google), context-window lookup (including Opus 4.7 / Sonnet 4.7 1M and GPT-5.x variants), pricing tables with optional LiteLLM hydration, and null-aware cost calculation (`getModelInfo()`, `calculateCost()`, `formatCost()`, `hydratePricingCatalog()`) |
| **Quota Polling** | `QuotaPoller` class with exponential backoff, active/idle intervals, and cached fallback |
| **Accounts** | Multi-provider account registry (v2) with per-provider active account, save/switch/remove, v1 migration, and `ensureDefaultAccounts()` for first-run bootstrap of the active system Claude/Codex credentials as a "Default" saved account |
| **Codex Profiles** | Codex account lifecycle — prepare, finalize, switch, remove — with isolated `CODEX_HOME` directories and multi-home monitoring support |
| **Quota Snapshots** | Persistent quota caching per provider/account for offline fallback |

## Supported import paths

`sidekick-shared` ships three public entry points plus a few convenience subpaths. Pick the one that matches your runtime.

| Path                              | Runtime                     | What it exposes                                                    |
|-----------------------------------|-----------------------------|--------------------------------------------------------------------|
| `sidekick-shared`                 | Node (CLI, extension host)  | Full public API (readers, providers, parsers, pricing, …).         |
| `sidekick-shared/browser`         | **Browser / webview**       | Pure helpers: context-window lookup, model parsing, cost math.     |
| `sidekick-shared/node`            | Node only                   | LiteLLM pricing catalog hydration (`fs` + `path`).                 |
| `sidekick-shared/phrases`         | Any runtime                 | Phrase arrays + `getRandomPhrase()`.                               |
| `sidekick-shared/modelContext`    | Any runtime                 | Direct access to the context-window module.                        |
| `sidekick-shared/modelInfo`       | Any runtime                 | Direct access to model parsing and cost math.                      |

### Browser / webview runtimes

Import from `sidekick-shared/browser`. **Do not import the package root from browser code** — the root re-exports Node-only pricing hydration and can drag `node:fs` / `node:path` into your bundle.

```typescript
import {
  getModelContextWindowSize,
  DEFAULT_CONTEXT_WINDOW,
  parseModelId,
  calculateCost,
  formatCost,
} from 'sidekick-shared/browser';
```

### Node / CLI / extension host

Hydrate the pricing catalog from the `node` subpath:

```typescript
import { hydratePricingCatalog } from 'sidekick-shared/node';

await hydratePricingCatalog({ cacheDir: '~/.config/sidekick' });
```

## Usage Examples

### Detect the active session provider

```typescript
import { detectProvider } from 'sidekick-shared';

const provider = await detectProvider('/path/to/project');
if (provider) {
  console.log(`Active provider: ${provider.id}`);
  const sessions = await provider.listSessions();
}
```

### Read persisted tasks

```typescript
import { readTasks, getProjectSlug } from 'sidekick-shared';

const slug = getProjectSlug('/path/to/project');
const tasks = readTasks({ projectSlug: slug });
console.log(`Found ${tasks.length} tasks`);
```

### Check provider status

```typescript
import { fetchProviderStatus } from 'sidekick-shared';

const status = await fetchProviderStatus();
if (status.indicator !== 'none') {
  console.log(`Claude API: ${status.description}`);
  for (const c of status.affectedComponents) {
    console.log(`  ${c.name}: ${c.status}`);
  }
}
```

### Fetch subscription quota

```typescript
import { fetchQuota, readClaudeMaxCredentials } from 'sidekick-shared';

const creds = readClaudeMaxCredentials();
if (creds) {
  const quota = await fetchQuota(creds.accessToken);
  if (quota.available) {
    console.log(`5-hour utilization: ${quota.fiveHour.utilization}%`);
  } else {
    console.log(quota.failureKind, quota.httpStatus, quota.retryAfterMs);
  }
}
```

Unavailable quota responses remain non-throwing and may include:

- `failureKind`: `auth | network | rate_limit | server | unknown`
- `httpStatus`: HTTP response status when available
- `retryAfterMs`: retry delay in milliseconds for `429` responses when the API provides `Retry-After`

For first-party style messaging, `describeQuotaFailure()` maps unavailable quota states to stable alert keys plus display-ready severity/title/message/detail fields for CLI and VS Code consumers.

### Model info and cost calculation

```typescript
import { getModelInfo, calculateCost, formatCost } from 'sidekick-shared';

const info = getModelInfo('claude-sonnet-4-6-20260321');
console.log(info.family, info.version, info.contextWindow); // "sonnet" "4.6" 200000

const cost = calculateCost(
  { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0 },
  'claude-sonnet-4-6-20260321',
);
console.log(formatCost(cost)); // "$0.0045"
```

### Extract token usage and tool calls from events

```typescript
import { extractTokenUsage, extractToolCalls } from 'sidekick-shared';

const usage = extractTokenUsage(event); // TokenUsage | null
const tools = extractToolCalls(event);  // ToolCall[]
```

### Validate JSONL events with Zod schemas

```typescript
import { JsonlParser, sessionEventSchema } from 'sidekick-shared';

const parser = new JsonlParser(
  { onEvent: (e) => console.log(e), onError: (e) => console.warn(e) },
  { schema: sessionEventSchema },
);
parser.addChunk(rawData);
```

### Poll quota with backoff

```typescript
import { QuotaPoller } from 'sidekick-shared';

const poller = new QuotaPoller({
  activeIntervalMs: 300_000,
  idleIntervalMs: 300_000,
  getAccessToken: async () => token,
});
poller.onUpdate((state) => console.log(state));
poller.start();
```

## Building

```bash
npm run build
```

Compiles TypeScript to `dist/` via `tsc`.

## Testing

```bash
npm test
```

Uses Vitest. Run `npm run test:watch` for watch mode.

## See Also

- [Sidekick for Max](https://marketplace.visualstudio.com/items?itemName=CesarAndresLopez.sidekick-for-max) — VS Code extension
- [Sidekick CLI](https://www.npmjs.com/package/sidekick-agent-hub) — Terminal dashboard (`npm install -g sidekick-agent-hub`)

## License

MIT
