import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACTIVITY_MAP_SETTINGS,
  readActivityMapSettings,
  toRecorderOptions,
} from './activityMapSettings';

const getter = (values: Record<string, unknown>) => (key: string) => values[key];

describe('activity map settings', () => {
  it('defaults labels to names, and package.json declares the same defaults', () => {
    // Exports and the HTML report carry the labels: descriptions only when asked for.
    expect(DEFAULT_ACTIVITY_MAP_SETTINGS.labels).toBe('names');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as {
      contributes: { configuration: Array<{ properties?: Record<string, { default?: unknown }> }> };
    };
    const declared: Record<string, unknown> = {};
    for (const section of manifest.contributes.configuration) {
      for (const [key, value] of Object.entries(section.properties ?? {})) {
        if (key.startsWith('sidekick.activityMap.')) {
          declared[key.slice('sidekick.activityMap.'.length)] = value.default;
        }
      }
    }
    expect(declared).toEqual(DEFAULT_ACTIVITY_MAP_SETTINGS);
  });

  it('falls back to the defaults for missing or invalid values', () => {
    expect(readActivityMapSettings(getter({}))).toEqual(DEFAULT_ACTIVITY_MAP_SETTINGS);
    expect(
      readActivityMapSettings(
        getter({
          motion: 'wild',
          layout: 'sideways',
          labels: 'all',
          memory: 'x',
          stationOverrides: [],
        }),
      ),
    ).toEqual(DEFAULT_ACTIVITY_MAP_SETTINGS);
  });

  it('reads valid values, trims lists and drops unknown stations', () => {
    const settings = readActivityMapSettings(
      getter({
        motion: 'reduced',
        layout: 'you-bottom',
        coreName: '  SIDEKICK-AGENT  ',
        labels: 'descriptive',
        memory: { paths: [' notes/ ', '', 3], mcpServers: ['brain'], commands: ['recall'] },
        stationOverrides: { 'mcp__github__*': 'network', Bash: 'shell', Foo: 'nowhere' },
      }),
    );
    expect(settings).toEqual({
      motion: 'reduced',
      layout: 'you-bottom',
      coreName: 'SIDEKICK-A',
      labels: 'descriptive',
      memory: { paths: ['notes/'], mcpServers: ['brain'], commands: ['recall'] },
      stationOverrides: { 'mcp__github__*': 'network', Bash: 'shell' },
    });
  });

  it('turns settings into recorder options, with server globs as server overrides', () => {
    const options = toRecorderOptions(
      readActivityMapSettings(
        getter({
          labels: 'none',
          memory: { mcpServers: ['brain'], commands: ['recall'] },
          stationOverrides: { 'mcp__linear__*': 'plan', mcp__x__y: 'memory' },
        }),
      ),
      'codex',
      'sess-9',
    );
    expect(options).toEqual({
      providerId: 'codex',
      sessionId: 'sess-9',
      labels: 'none',
      deriveContext: false,
      stationOverrides: { servers: { linear: 'plan' }, tools: { mcp__x__y: 'memory' } },
      memory: { servers: ['memory', 'brain'], commands: ['recall'] },
    });
    expect(toRecorderOptions(DEFAULT_ACTIVITY_MAP_SETTINGS, 'claude-code')).toEqual({
      providerId: 'claude-code',
      labels: 'names',
      deriveContext: false,
    });
  });
});
