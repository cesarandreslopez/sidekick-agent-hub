import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CodexProvider, ResolveQuotaOptions } from 'sidekick-shared';

const { mockResolveQuota } = vi.hoisted(() => ({ mockResolveQuota: vi.fn() }));

// Only the quota resolver is stubbed; every other fact reads the real stores.
vi.mock('sidekick-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('sidekick-shared')>()),
  resolveQuota: (...args: unknown[]) => mockResolveQuota(...args),
}));

import { createMcpFactsServer } from './mcp';

describe('Sidekick MCP facts server', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    mockResolveQuota.mockReset();
  });

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  async function connect(providerId: 'claude-code' | 'codex' | 'opencode') {
    const server = createMcpFactsServer({ cwd: '/work/project', providerId });
    const client = new Client({ name: 'sidekick-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it('answers get_quota_status through the shared resolver with the workspace path', async () => {
    const resolved = {
      runtimeProvider: 'codex',
      providerId: 'codex',
      fiveHour: { utilization: 12, resetsAt: '2026-09-04T15:00:00Z' },
      sevenDay: { utilization: 40, resetsAt: '2026-09-08T09:00:00Z' },
      available: true,
      resolution: 'api',
      source: 'api',
      freshness: 'fresh',
    };
    mockResolveQuota.mockResolvedValue(resolved);

    const client = await connect('codex');
    const response = await client.callTool({ name: 'get_quota_status', arguments: {} });

    // Codex uses the same live-query policy as the CLI.
    expect(mockResolveQuota).toHaveBeenCalledWith({
      providerId: 'codex',
      workspacePath: '/work/project',
      preferFresh: false,
    });
    expect((response.structuredContent as { data: unknown }).data).toEqual(resolved);
  });

  it('maps OpenCode sessions to the z.ai quota', async () => {
    mockResolveQuota.mockResolvedValue({ available: false, resolution: 'unavailable' });

    const client = await connect('opencode');
    await client.callTool({ name: 'get_quota_status', arguments: {} });

    expect(mockResolveQuota).toHaveBeenCalledWith({
      providerId: 'zai',
      workspacePath: '/work/project',
    });
  });

  it('returns live Codex usage and reset credits through the real resolver', async () => {
    const shared = await vi.importActual<typeof import('sidekick-shared')>('sidekick-shared');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-mcp-quota-'));
    const now = new Date('2026-09-05T12:00:00Z');
    const writeSnapshot = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async (input) =>
      Response.json(
        String(input).endsWith('/wham/usage')
          ? {
              rate_limit: {
                primary_window: {
                  used_percent: 48,
                  limit_window_seconds: 604_800,
                  reset_at: 1_789_131_600,
                },
              },
            }
          : { available_count: 2, credits: [] },
      ),
    );
    mockResolveQuota.mockImplementation((options: ResolveQuotaOptions<'codex'>) =>
      shared.resolveQuota({
        ...options,
        now,
        codexHome: scratch,
        codexAccessToken: 'test-token',
        fetchImpl,
        codexProvider: { findAllSessions: () => [], dispose: vi.fn() } as unknown as CodexProvider,
        resolveCodexAccount: () => ({
          id: 'codex-account',
          providerId: 'codex',
          addedAt: now.toISOString(),
        }),
        readSnapshot: () => ({
          fiveHour: { utilization: 30, resetsAt: '2026-09-11T13:00:00Z' },
          sevenDay: { utilization: 0, resetsAt: '' },
          available: true,
          source: 'cache',
          capturedSource: 'session',
          capturedAt: '2026-09-05T11:59:00Z',
          ageMs: 60_000,
          freshness: 'fresh',
        }),
        writeSnapshot,
      }),
    );

    try {
      const client = await connect('codex');
      const response = await client.callTool({ name: 'get_quota_status', arguments: {} });

      expect((response.structuredContent as { data: unknown }).data).toMatchObject({
        available: true,
        source: 'api',
        resolution: 'api',
        fiveHour: { utilization: 48 },
        resetCredits: { availableCount: 2 },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(writeSnapshot).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('advertises only the seven read-only facts tools', async () => {
    const server = createMcpFactsServer({ cwd: process.cwd(), providerId: 'claude-code' });
    const client = new Client({ name: 'sidekick-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.listTools();

    expect(response.tools.map((tool) => tool.name)).toEqual([
      'get_quota_status',
      'get_burn_rate',
      'get_context_pressure',
      'get_tasks',
      'get_decisions',
      'get_notes',
      'get_project_context',
    ]);
    for (const tool of response.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }

    const tasks = await client.callTool({ name: 'get_tasks', arguments: {} });
    expect(tasks.isError).not.toBe(true);
    expect((tasks.structuredContent as { data: unknown }).data).toBeInstanceOf(Array);
  });
});
