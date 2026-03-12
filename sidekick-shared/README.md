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
| **Quota** | Claude Max subscription quota fetching (5-hour and 7-day windows) |
| **Provider Status** | Claude API health checking via status.claude.com (indicator, components, incidents) |

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
