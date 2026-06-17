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
| **Watchers** | Live session file watching with event bridging, plus `createJsonlTail()` for raw incremental JSONL consumers |
| **Formatters** | Display helpers (`formatTokenCount()`, `formatDurationMs()`), tool summary, noise classification, session dump (text/markdown/JSON), event highlighting |
| **Search** | Cross-session full-text search, advanced filtering (substring, fuzzy, regex, date) |
| **Aggregation** | Event aggregation, frequency tracking, activity heatmaps, pattern extraction |
| **Session Context** | Provider-neutral context evidence snapshots (`buildSessionContextSnapshot()`, `calculateSessionContextPressure()`, `createSessionContextProjector()`, `readSessionContextSnapshot()`): layered evidence sources, low/medium/high context pressure, and observed capabilities (tools, MCP servers, permission mode, rate limits) |
| **Assistant Turns** | Browser-safe timeline/process/answer projection for provider-normalized assistant turns (`segmentAssistantTurn()`, `assistantTurnEventsFromSessionEvents()`), including interleaved reasoning, compact tool groups, and Claude `Task` subagent refs without prompt leakage |
| **Report** | Self-contained HTML session report generation |
| **Credentials** | Claude Max OAuth credential reading from `~/.claude/.credentials.json` |
| **Quota** | Claude Max subscription quota fetching (5-hour and 7-day windows) and Codex rate-limit extraction from event streams |
| **Provider Status** | API health checking via status.claude.com and status.openai.com (indicator, components, incidents) |
| **Schemas** | Zod schemas for runtime validation of data crossing process/IPC boundaries — JSONL session events (`sessionEventSchema`, `messageUsageSchema`, `sessionMessageSchema`), assistant turns, quota, account status, and quota history — plus `extractSessionEvents()` to unwrap `progress`-wrapped events. Also published fs-free via the [`sidekick-shared/schemas`](#supported-import-paths) subpath |
| **Extractors** | Pure functions for single-event processing: `extractTokenUsage()`, `extractToolCall()` (top-level `tool_use`), `extractToolCalls()` (assistant content blocks) |
| **Model Info & Pricing** | Model family parsing (Anthropic / OpenAI / Google, including legacy `claude-3-opus-…` and `claude-3-5-sonnet-…` IDs), context-window lookup (including Fable 5 / Opus 4.8 / Opus 4.7 / Sonnet 4.7 1M and GPT-5.x variants), pricing tables with optional LiteLLM hydration, null-aware cost (`calculateCost()`), provenance-preserving cost (`calculateCostWithProvenance()`, `mergeCostSources()`), and display helpers (`shortModelName()`, `getModelDisplayInfo()`, `compareModelIds()`, `sortModelIds()`, `formatCost()`) |
| **Quota Polling** | `QuotaPoller` class with exponential backoff, active/idle intervals, and cached fallback |
| **Multi-Provider Quota** | `MultiProviderQuotaService` orchestrates Claude polling + peak-hours + account labels + Codex quota updates behind one typed `{ claude?, codex? }` event stream. `CodexQuotaWatcher` watches the active Codex rollout for live rate limits with snapshot fallback |
| **Accounts** | Multi-provider account registry (v2) with per-provider active account, save/switch/remove, v1 migration, `ensureDefaultAccounts()` for first-run bootstrap of the active system Claude/Codex credentials as a "Default" saved account, and `getActiveAccountStatus()` for a single-pass active-account read across providers |
| **Codex Profiles** | Codex account lifecycle — prepare, finalize, switch, remove — switching atomically swaps the profile's backed-up credentials into the system `~/.codex/auth.json`, with rotated-token staleness protection, one-time dual-home migration, and legacy multi-home session monitoring |
| **Quota Snapshots** | Persistent quota caching per provider/account for offline fallback |
| **Phrases** | Curated humorous phrases for loading/idle states, available as a flat `ALL_PHRASES` array or grouped via `PHRASE_CATEGORIES` for category-aware UI |

## Supported import paths

`sidekick-shared` ships three public entry points plus a few convenience subpaths. Pick the one that matches your runtime.

| Path                              | Runtime                     | What it exposes                                                    |
|-----------------------------------|-----------------------------|--------------------------------------------------------------------|
| `sidekick-shared`                 | Node (CLI, extension host)  | Full public API (readers, providers, parsers, pricing, …).         |
| `sidekick-shared/browser`         | **Browser / webview**       | Pure helpers: context-window lookup, model parsing, cost math, assistant turn projection. |
| `sidekick-shared/node`            | Node only                   | LiteLLM pricing catalog hydration (`fs` + `path`).                 |
| `sidekick-shared/phrases`         | Any runtime                 | Phrase arrays + `getRandomPhrase()`.                               |
| `sidekick-shared/modelContext`    | Any runtime                 | Direct access to the context-window module.                        |
| `sidekick-shared/modelInfo`       | Any runtime                 | Direct access to model parsing and cost math.                      |
| `sidekick-shared/formatting`      | Any runtime                 | Direct access to pure token and duration display helpers.           |
| `sidekick-shared/schemas`         | Any runtime                 | Pure Zod boundary schemas (session events, assistant turns, quota, account status, quota history) — fs-free, no Node builtins. |

### Browser / webview runtimes

Import from `sidekick-shared/browser`. **Do not import the package root from browser code** — the root re-exports Node-only pricing hydration and can drag `node:fs` / `node:path` into your bundle.

```typescript
import {
  getModelContextWindowSize,
  DEFAULT_CONTEXT_WINDOW,
  parseModelId,
  calculateCost,
  formatCost,
  formatTokenCount,
  formatDurationMs,
  segmentAssistantTurn,
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

### Check Claude peak-hours state

```typescript
import { fetchPeakHoursStatus } from 'sidekick-shared';

// Third-party endpoint: promoclock.co/api/status (unaffiliated with Anthropic).
// Returns a `unavailable: true` fallback on any network or parse error.
const peak = await fetchPeakHoursStatus();
if (!peak.unavailable && peak.isPeak) {
  console.log(`${peak.label} — off-peak in ${peak.minutesUntilChange}m`);
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
import { extractTokenUsage, extractToolCall, extractToolCalls } from 'sidekick-shared';

const usage = extractTokenUsage(event);          // TokenUsage | null
const tools = extractToolCalls(event);           // ToolCall[]    — assistant content blocks
const toolFromEvent = extractToolCall(event);    // ToolCall | null — top-level `tool_use` events
```

### Project session context evidence

Build a provider-neutral snapshot of what an assistant has "seen" in a session — layered evidence sources, context pressure, and observed capabilities. Read it through any session provider, or build it directly from a canonical `SessionEvent[]`.

```typescript
import { detectProvider, readSessionContextSnapshot } from 'sidekick-shared';

const provider = await detectProvider('/path/to/project');
if (provider) {
  const snapshot = readSessionContextSnapshot(provider, '/path/to/session.jsonl');

  console.log(snapshot.pressure);          // 'low' | 'medium' | 'high'
  console.log(snapshot.contextTokens, '/', snapshot.contextWindow);
  console.log(snapshot.capabilities.tools, snapshot.capabilities.mcpServers);
  console.log(snapshot.sources.length, 'evidence sources');
}
```

Use `createSessionContextProjector()` for incremental updates as new events stream in, or `calculateSessionContextPressure(contextTokens, contextWindow)` for the pressure band alone.

### Project an assistant turn into Timeline + Process + Answer

Build a compact UI-safe projection from provider-normalized turn events. The final contiguous text run becomes `answer`; earlier narration, tools, and reasoning stay in `process` / `reasoningBlocks`, and `timeline` preserves their interleaved arrival order for rendering.

```typescript
import {
  assistantTurnEventsFromSessionEvents,
  segmentAssistantTurn,
} from 'sidekick-shared/browser';

const projection = segmentAssistantTurn(assistantTurnEventsFromSessionEvents(sessionEvents));

console.log(projection.answer);
console.log(projection.timeline);
console.log(projection.process.steps);
console.log(projection.subagents); // Claude Task spawns, prompt text omitted
```

### Format shared dashboard values

```typescript
import { formatTokenCount, formatDurationMs, formatCost } from 'sidekick-shared';

console.log(formatTokenCount(15_000)); // "15.0k"
console.log(formatDurationMs(330_000)); // "5m 30s"
console.log(formatCost(0.0045)); // "$0.0045"
```

### Validate JSONL events with Zod schemas

```typescript
import { JsonlParser, sessionEventSchema } from 'sidekick-shared';

const parser = new JsonlParser(
  { onEvent: (e) => console.log(e), onError: (e) => console.warn(e) },
  { schema: sessionEventSchema },
);
parser.processChunk(rawData);
```

The boundary schemas — `sessionEventSchema` plus the quota, account-status, and quota-history schemas — are also importable fs-free from `sidekick-shared/schemas`, which keeps Zod out of bundles that only need the pure math/formatting helpers. `extractSessionEvents()` from the same subpath unwraps Claude Code `progress`-wrapped events into canonical `SessionEvent[]`.

### Tail raw JSONL events incrementally

Use `createJsonlTail()` when a consumer needs raw parsed events and owns its own aggregation lifecycle. `onBatchComplete` fires once after each drained byte chunk, which lets callers defer expensive UI or metrics updates until parsing for that chunk is complete.

```typescript
import { createJsonlTail, sessionEventSchema } from 'sidekick-shared';

const tail = createJsonlTail({
  path: '/path/to/session.jsonl',
  schema: sessionEventSchema,
  onEvent: event => aggregator.processEvent(event),
  onBatchComplete: () => renderMetrics(aggregator.getMetrics()),
  onError: error => console.warn(error.message),
});

tail.start();
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

### Orchestrate quota across Claude and Codex

```typescript
import { MultiProviderQuotaService } from 'sidekick-shared';

const service = new MultiProviderQuotaService({
  // Optional — when set, an internal CodexQuotaWatcher is created and managed.
  codexWorkspacePath: '/path/to/project',
});

service.onUpdate(({ claude, codex }) => {
  if (claude) console.log('Claude:', claude.fiveHour.utilization, claude.peakHours?.label);
  if (codex)  console.log('Codex:',  codex.fiveHour.utilization, codex.accountLabel);
});

service.startPolling();
// service.setPollingMode('active'); // tighter cadence while a session is live
// service.updateProviderQuota('codex', codexQuota); // externally push Codex quota snapshots
// service.dispose();
```

Or run the Codex watcher standalone (e.g. inside an existing polling loop):

```typescript
import { CodexQuotaWatcher } from 'sidekick-shared';

const watcher = new CodexQuotaWatcher('/path/to/project');
watcher.onUpdate((state) => console.log(state.fiveHour.utilization, state.accountLabel));
watcher.start();
```

### Read active account status across providers

```typescript
import { getActiveAccountStatus } from 'sidekick-shared';

const status = getActiveAccountStatus();
if (!status.ok) console.log('No saved account active');
console.log(status.claude.present, status.claude.email);
console.log(status.codex.present, status.codex.label);
```

### Track cost provenance for honest UI rollups

```typescript
import { calculateCostWithProvenance, mergeCostSources, formatCost } from 'sidekick-shared';

const a = calculateCostWithProvenance({
  usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  modelId: 'claude-sonnet-4-20250514',
  reportedCostUsd: 1.23, // provider-reported when available — wins over local estimate
});
const b = calculateCostWithProvenance({
  usage: { inputTokens: 200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  modelId: 'unknown-model', // no pricing → { source: 'unpriced' }
});

const total = (a.costUsd ?? 0) + (b.costUsd ?? 0);
const totalSource = mergeCostSources(a.source, b.source); // 'unpriced' wins (least certain)
console.log(formatCost(total), totalSource);
```

### Deferred Contextful adoption note

`sidekick-shared@0.18.x` already exposes the quota primitives Contextful needs: `MultiProviderQuotaService`, `ProviderQuotaMap`, `ProviderQuotaState`, and `CodexQuotaWatcher`. Contextful should keep its local integration unchanged until a newer `sidekick-shared` release is published to npm, then migrate thin wrappers to these public APIs plus `formatTokenCount()`, `formatDurationMs()`, and `createJsonlTail()`.

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
