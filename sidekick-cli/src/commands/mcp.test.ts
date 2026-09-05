import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      resolution: 'snapshot-fresh',
      source: 'cache',
      capturedSource: 'session',
      freshness: 'fresh',
    };
    mockResolveQuota.mockResolvedValue(resolved);

    const client = await connect('codex');
    const response = await client.callTool({ name: 'get_quota_status', arguments: {} });

    // Same options `sidekick quota` builds for its default view: the resolver's
    // precedence (fresh sample first) applies unchanged.
    expect(mockResolveQuota).toHaveBeenCalledWith({
      providerId: 'codex',
      workspacePath: '/work/project',
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
