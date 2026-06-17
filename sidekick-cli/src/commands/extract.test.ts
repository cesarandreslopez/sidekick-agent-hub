import { describe, it, expect } from 'vitest';
import {
  formatAssetsForText,
  filterByTypes,
  flattenAssets,
  parseLimit,
  parseTypes,
  resolveAssetAgents,
} from './extract';
import type { ExtractedAsset, GatherAssetsResult } from 'sidekick-shared';

function asset(type: ExtractedAsset['type'], text: string): ExtractedAsset {
  return { type, text, display: text };
}

const sample: GatherAssetsResult = {
  urls: [{ ...asset('url', 'https://a.test'), agent: 'codex' }],
  paths: [{ ...asset('path', '/tmp/x.ts'), agent: 'claude' }],
  commands: [{ ...asset('command', 'npm test'), agent: 'claude' }],
  plans: [{ ...asset('plan', 'My Plan'), agent: 'codex' }],
  inChat: true,
};

describe('parseTypes', () => {
  it('returns all types when raw is undefined', () => {
    expect(parseTypes(undefined)).toEqual(['url', 'path', 'command', 'plan']);
  });

  it('maps aliases and dedupes preserving order', () => {
    expect(parseTypes('cmds, urls, command')).toEqual(['command', 'url']);
    expect(parseTypes('files,file')).toEqual(['path']);
  });

  it('throws for invalid types instead of silently falling back', () => {
    expect(() => parseTypes('bogus,nope')).toThrow("Invalid asset type 'bogus'");
  });
});

describe('parseLimit', () => {
  it('returns undefined when no limit is provided', () => {
    expect(parseLimit(undefined)).toBeUndefined();
  });

  it('parses positive integer limits', () => {
    expect(parseLimit('10')).toBe(10);
  });

  it('throws for non-positive or non-integer limits', () => {
    expect(() => parseLimit('0')).toThrow('Limit must be a positive integer');
    expect(() => parseLimit('-1')).toThrow('Limit must be a positive integer');
    expect(() => parseLimit('abc')).toThrow('Limit must be a positive integer');
  });
});

describe('filterByTypes', () => {
  it('keeps only requested types', () => {
    const filtered = filterByTypes(sample, ['url', 'command']);

    expect(filtered.urls).toHaveLength(1);
    expect(filtered.commands).toHaveLength(1);
    expect(filtered.paths).toHaveLength(0);
    expect(filtered.plans).toHaveLength(0);
    expect(filtered.inChat).toBe(true);
  });
});

describe('flattenAssets', () => {
  it('orders urls, paths, commands, plans', () => {
    expect(flattenAssets(sample).map((a) => a.type)).toEqual(['url', 'path', 'command', 'plan']);
  });
});

describe('formatAssetsForText', () => {
  it('includes source agent labels in grouped text output', () => {
    const output = formatAssetsForText(sample, ['url', 'path', 'command', 'plan']);

    expect(output).toContain('[codex url] https://a.test');
    expect(output).toContain('[claude path] /tmp/x.ts');
    expect(output).toContain('[claude cmd] npm test');
    expect(output).toContain('[codex plan] My Plan');
  });

  it('distinguishes no-session and no-asset empty states', () => {
    expect(formatAssetsForText({ urls: [], paths: [], commands: [], plans: [], inChat: false }, ['url']))
      .toContain('No recent Claude Code or Codex sessions found for this project.');
    expect(formatAssetsForText({ urls: [], paths: [], commands: [], plans: [], inChat: true }, ['url']))
      .toContain('No extractable assets found in recent sessions.');
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
