import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import {
  ClaudeCodeProvider,
  CodexProvider,
  EventAggregator,
  OpenCodeProvider,
  buildSessionContextSnapshot,
  composeContext,
  describeActivityInsights,
  describeActivityNow,
  detectProvider,
  exportActivity,
  readDecisions,
  readNotes,
  readTasks,
  renderActivityMapSvg,
  replayActivity,
  resolveProjectIdentity,
  resolveQuota,
} from 'sidekick-shared';
import type { ProviderId, SessionProviderBase } from 'sidekick-shared';
import type { Command } from 'commander';

declare const __CLI_VERSION__: string;

interface McpFactsOptions {
  cwd: string;
  providerId?: ProviderId;
}

function createProvider(providerId: ProviderId): SessionProviderBase {
  if (providerId === 'codex') return new CodexProvider({ includeCompressedRollouts: true });
  if (providerId === 'opencode') return new OpenCodeProvider();
  return new ClaudeCodeProvider();
}

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { data: value ?? null },
  };
}

async function activeSessionFacts(cwd: string, providerId: ProviderId) {
  const provider = createProvider(providerId);
  try {
    const sessionPath = provider.findActiveSession(cwd);
    if (!sessionPath) return null;
    const events = provider.createReader(sessionPath).readAll();
    const computeContextSize = provider.computeContextSize
      ? (usage: {
          inputTokens: number;
          outputTokens: number;
          cacheWriteTokens: number;
          cacheReadTokens: number;
          reasoningTokens?: number;
        }) =>
          provider.computeContextSize!({
            ...usage,
            model: '',
            timestamp: new Date(),
          })
      : undefined;
    const aggregator = new EventAggregator({
      providerId,
      computeContextSize,
    });
    for (const event of events) aggregator.processEvent(event);
    const snapshot =
      provider.readSessionContextSnapshot?.(sessionPath) ??
      buildSessionContextSnapshot(events, {
        providerId,
        sessionId: provider.getSessionId(sessionPath),
        sessionPath,
        contextWindowForModel: provider.getContextWindowLimit?.bind(provider),
        computeContextSize,
      });
    return { sessionPath, metrics: aggregator.getMetrics(), snapshot };
  } finally {
    provider.dispose();
  }
}

/**
 * The active session's activity map: content-free records (names only, never
 * prompts, file contents, command lines or URLs beyond the host), replayed
 * into a snapshot and full-session insights.
 */
export function activityMapFact(cwd: string, providerId: ProviderId, includeSvg = false) {
  const provider = createProvider(providerId);
  try {
    const sessionPath = provider.findActiveSession(cwd);
    if (!sessionPath) return null;
    const replay = replayActivity({ provider, sessionPath, labels: 'names' });
    const data = exportActivity({
      snapshot: replay.snapshot,
      insights: replay.insights,
      providerId: replay.providerId,
      sessionId: replay.sessionId,
    });
    const summary = [
      describeActivityNow(replay.snapshot, { now: replay.snapshot.at }),
      describeActivityInsights(replay.insights),
    ].join('\n');
    const svg = includeSvg
      ? renderActivityMapSvg(replay.snapshot, {
          now: replay.snapshot.at,
          theme: 'dark',
          motion: 'none',
          insights: replay.insights,
        })
      : undefined;
    return { data, summary, ...(svg ? { svg } : {}) };
  } finally {
    provider.dispose();
  }
}

/**
 * Same policy as `sidekick quota`: Codex queries ask the API first; the other
 * providers may reuse fresh snapshots. OpenCode sessions map to z.ai.
 */
function quotaFact(cwd: string, providerId: ProviderId) {
  return resolveQuota({
    providerId: providerId === 'opencode' ? 'zai' : providerId,
    workspacePath: cwd,
    ...(providerId === 'codex' ? { preferFresh: false } : {}),
  });
}

export function createMcpFactsServer(options: McpFactsOptions): McpServer {
  const providerId = options.providerId ?? detectProvider();
  const cwd = options.cwd;
  const project = resolveProjectIdentity(cwd);
  const server = new McpServer(
    {
      name: 'sidekick-agent-hub',
      version: typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-test',
    },
    {
      instructions:
        'Read-only facts about the current coding-agent session, quota, and Sidekick project stores.',
    },
  );
  const readOnly = { title: '', readOnlyHint: true, destructiveHint: false, idempotentHint: true };

  server.registerTool(
    'get_quota_status',
    {
      description:
        'Get current quota utilization and reset windows using the same resolver as sidekick quota.',
      inputSchema: z.object({}),
      annotations: { ...readOnly, title: 'Get quota status' },
    },
    async () => result(await quotaFact(cwd, providerId)),
  );
  server.registerTool(
    'get_burn_rate',
    {
      description: 'Get current token burn rate for the active observed session.',
      inputSchema: z.object({}),
      annotations: { ...readOnly, title: 'Get burn rate' },
    },
    async () => {
      const facts = await activeSessionFacts(cwd, providerId);
      return result(facts ? facts.metrics.burnRate : null);
    },
  );
  server.registerTool(
    'get_context_pressure',
    {
      description:
        'Get provider-neutral context pressure and compaction facts for the active session.',
      inputSchema: z.object({}),
      annotations: { ...readOnly, title: 'Get context pressure' },
    },
    async () => {
      const facts = await activeSessionFacts(cwd, providerId);
      return result(facts?.snapshot ?? null);
    },
  );
  server.registerTool(
    'get_activity_map',
    {
      description:
        'Get the active session’s activity map: where its work went, station by station ' +
        '(files, shell, network, memory, agents, skills, hooks, plan, …), with time, errors, ' +
        'denials and context weight per station and detected patterns such as retry streaks ' +
        'or edit/test loops. Labels carry names only, never content. includeSvg adds the map as SVG.',
      inputSchema: z.object({ includeSvg: z.boolean().optional() }),
      annotations: { ...readOnly, title: 'Get activity map' },
    },
    async ({ includeSvg }) => {
      const fact = activityMapFact(cwd, providerId, includeSvg === true);
      if (!fact) return result(null);
      return {
        content: [
          { type: 'text' as const, text: fact.summary },
          ...(fact.svg ? [{ type: 'text' as const, text: fact.svg }] : []),
        ],
        structuredContent: { data: fact.data },
      };
    },
  );
  server.registerTool(
    'get_tasks',
    {
      description: 'List persisted tasks for the current project.',
      inputSchema: z.object({}),
      annotations: { ...readOnly, title: 'Get tasks' },
    },
    async () => result(await readTasks(project, { status: 'all' })),
  );
  server.registerTool(
    'get_decisions',
    {
      description: 'List persisted architectural decisions for the current project.',
      inputSchema: z.object({}),
      annotations: { ...readOnly, title: 'Get decisions' },
    },
    async () => result(await readDecisions(project)),
  );
  server.registerTool(
    'get_notes',
    {
      description: 'List persisted knowledge notes for the current project.',
      inputSchema: z.object({}),
      annotations: { ...readOnly, title: 'Get notes' },
    },
    async () => result(await readNotes(project)),
  );
  server.registerTool(
    'get_project_context',
    {
      description: 'Compose tasks, decisions, notes, handoff, and stats for the current project.',
      inputSchema: z.object({ fidelity: z.enum(['full', 'compact', 'brief']).default('compact') }),
      annotations: { ...readOnly, title: 'Get project context' },
    },
    async ({ fidelity }) => {
      const provider = createProvider(providerId);
      try {
        return result(await composeContext(project, fidelity, provider));
      } finally {
        provider.dispose();
      }
    },
  );
  return server;
}

export async function mcpAction(_opts: Record<string, unknown>, cmd: Command): Promise<void> {
  const globalOpts = cmd.parent!.opts();
  const provider =
    globalOpts.provider && globalOpts.provider !== 'auto'
      ? (globalOpts.provider as ProviderId)
      : undefined;
  const server = createMcpFactsServer({
    cwd: (globalOpts.project as string | undefined) || process.cwd(),
    providerId: provider,
  });
  await server.connect(new StdioServerTransport());
}
