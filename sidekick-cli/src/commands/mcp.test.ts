import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpFactsServer } from './mcp';

describe('Sidekick MCP facts server', () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
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
