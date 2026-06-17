import { describe, it, expect } from 'vitest';
import {
  filterByTypes,
  flattenAssets,
  parseTypes,
  resolveAssetAgents,
} from './extract';
import type { ExtractedAsset, ExtractedAssets } from 'sidekick-shared';

function asset(type: ExtractedAsset['type'], text: string): ExtractedAsset {
  return { type, text, display: text };
}

const sample: ExtractedAssets = {
  urls: [asset('url', 'https://a.test')],
  paths: [asset('path', '/tmp/x.ts')],
  commands: [asset('command', 'npm test')],
  plans: [asset('plan', 'My Plan')],
};

describe('parseTypes', () => {
  it('returns all types when raw is undefined', () => {
    expect(parseTypes(undefined)).toEqual(['url', 'path', 'command', 'plan']);
  });

  it('maps aliases and dedupes preserving order', () => {
    expect(parseTypes('cmds, urls, command')).toEqual(['command', 'url']);
    expect(parseTypes('files,file')).toEqual(['path']);
  });

  it('falls back to all types when nothing valid parses', () => {
    expect(parseTypes('bogus,nope')).toEqual(['url', 'path', 'command', 'plan']);
  });
});

describe('filterByTypes', () => {
  it('keeps only requested types', () => {
    const filtered = filterByTypes(sample, ['url', 'command']);

    expect(filtered.urls).toHaveLength(1);
    expect(filtered.commands).toHaveLength(1);
    expect(filtered.paths).toHaveLength(0);
    expect(filtered.plans).toHaveLength(0);
  });
});

describe('flattenAssets', () => {
  it('orders urls, paths, commands, plans', () => {
    expect(flattenAssets(sample).map((a) => a.type)).toEqual(['url', 'path', 'command', 'plan']);
  });
});

describe('resolveAssetAgents', () => {
  it('maps supported global providers to extractor agents', () => {
    expect(resolveAssetAgents({ provider: 'claude-code' })).toEqual({ agents: ['claude'] });
    expect(resolveAssetAgents({ provider: 'codex' })).toEqual({ agents: ['codex'] });
    expect(resolveAssetAgents({ provider: 'auto' })).toEqual({ agents: undefined });
    expect(resolveAssetAgents({})).toEqual({ agents: undefined });
  });

  it('reports OpenCode as unsupported instead of silently reading other agents', () => {
    expect(resolveAssetAgents({ provider: 'opencode' })).toEqual({
      agents: [],
      unsupportedProvider: 'opencode',
    });
  });
});
