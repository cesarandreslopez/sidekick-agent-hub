import { describe, expect, it } from 'vitest';
import { parseActivityMapConfig } from './cliConfig';

describe('parseActivityMapConfig', () => {
  it('treats anything missing or malformed as not set', () => {
    expect(parseActivityMapConfig(undefined)).toEqual({ recorder: {} });
    expect(parseActivityMapConfig('nope')).toEqual({ recorder: {} });
    expect(
      parseActivityMapConfig({ coreName: 3, labels: 'loud', memory: 'x', stationOverrides: [] }),
    ).toEqual({ recorder: {} });
  });

  it('reads the core name, labels and memory settings', () => {
    expect(
      parseActivityMapConfig({
        coreName: '  my-agent-with-long-name ',
        labels: 'names',
        memory: { paths: ['notes/', ''], mcpServers: ['recall'], commands: ['remember'] },
      }),
    ).toEqual({
      coreName: 'my-agent-w',
      recorder: {
        labels: 'names',
        memory: { paths: ['notes/'], servers: ['recall'], commands: ['remember'] },
      },
    });
  });

  it('splits station overrides into tools and MCP servers, dropping unknown stations', () => {
    expect(
      parseActivityMapConfig({
        stationOverrides: {
          'mcp__notes__*': 'memory',
          'mcp__playwright__*': 'browser',
          mcp__browserish__open: 'browser',
          Bash: 'shell',
          update_plan: 'plan',
          ghost: 'nowhere',
        },
      }).recorder.stationOverrides,
    ).toEqual({
      // As in VS Code: only `mcp__<server>__*` names a server; lowercase tool
      // names (Codex `update_plan`) are tools.
      tools: { mcp__browserish__open: 'browser', Bash: 'shell', update_plan: 'plan' },
      servers: { notes: 'memory', playwright: 'browser' },
    });
  });
});
