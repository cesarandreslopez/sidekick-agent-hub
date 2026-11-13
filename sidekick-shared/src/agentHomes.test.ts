import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const profiles = vi.hoisted(() => ({ dir: '', ids: [] as string[] }));
vi.mock('./accountRegistry', () => ({
  getAccountsDir: () => profiles.dir,
  listSavedAccountProfiles: () => profiles.ids.map((id) => ({ id })),
}));

import { agentUserHome, normalizeExplicitHomes, resolveAgentHomes } from './agentHomes';
import { getCodexMonitoringHomes, getCodexProfileHome } from './codexPaths';
import { resolveMonitoredHomes } from './monitoredHomes';
import { getClaudeProjectsDir, getLiveClaudeHome, isDefaultClaudeHome } from './claudePaths';
import { getSystemCodexHome } from './codexLayout';

describe('resolveAgentHomes', () => {
  it('prefers explicit lists, then the environment, then the user home', () => {
    const env = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' };
    expect(resolveAgentHomes({ env })).toEqual({
      claude: ['/cfg/claude'],
      codex: ['/cfg/codex'],
      ignored: [],
    });
    expect(
      resolveAgentHomes({ env, claudeHomes: ['/a/claude', '/b/claude'], codexHomes: ['/a/codex'] }),
    ).toEqual({ claude: ['/a/claude', '/b/claude'], codex: ['/a/codex'], ignored: [] });
    expect(resolveAgentHomes({ env: { HOME: '/home/u' } })).toEqual({
      claude: [path.join('/home/u', '.claude')],
      codex: [path.join('/home/u', '.codex')],
      ignored: [],
    });
  });

  it('keeps an explicit empty list, which disables that provider', () => {
    const resolved = resolveAgentHomes({
      env: { CLAUDE_CONFIG_DIR: '/cfg/claude' },
      claudeHomes: [],
    });
    expect(resolved.claude).toEqual([]);
  });

  it('treats a blank variable as unset and ignores a relative one', () => {
    const resolved = resolveAgentHomes({
      env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '   ', CODEX_HOME: 'relative/codex' },
    });
    expect(resolved.claude).toEqual([path.join('/home/u', '.claude')]);
    expect(resolved.codex).toEqual([path.join('/home/u', '.codex')]);
    expect(resolved.ignored).toEqual([
      { provider: 'codex', variable: 'CODEX_HOME', value: 'relative/codex', reason: 'relative' },
    ]);
  });

  it('adds the start folders after the default home for an exactly empty CLAUDE_CONFIG_DIR', () => {
    const env = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '' };
    expect(resolveAgentHomes({ env, agentCwds: ['/proj', '/cwd', '/proj/'] })).toEqual({
      claude: [path.join('/home/u', '.claude'), '/proj', '/cwd'],
      codex: [path.join('/home/u', '.codex')],
      ignored: [],
    });
    // Without start folders, empty stays unset; whitespace is unset either way.
    expect(resolveAgentHomes({ env }).claude).toEqual([path.join('/home/u', '.claude')]);
    expect(
      resolveAgentHomes({ env: { ...env, CLAUDE_CONFIG_DIR: '  ' }, agentCwds: ['/proj'] }).claude,
    ).toEqual([path.join('/home/u', '.claude')]);
    // Codex treats an empty CODEX_HOME as unset.
    expect(
      resolveAgentHomes({ env: { HOME: '/home/u', CODEX_HOME: '' }, agentCwds: ['/proj'] }).codex,
    ).toEqual([path.join('/home/u', '.codex')]);
  });

  it('resolves relative variables against the start folders instead of ignoring them', () => {
    const resolved = resolveAgentHomes({
      env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: 'cfg/claude', CODEX_HOME: './codex' },
      agentCwds: ['/proj', '/cwd'],
    });
    expect(resolved).toEqual({
      claude: ['/proj/cfg/claude', '/cwd/cfg/claude'],
      codex: ['/proj/codex', '/cwd/codex'],
      ignored: [],
    });
  });

  it('skips invalid start folders without throwing, and lets explicit lists win', () => {
    const env = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '' };
    expect(
      resolveAgentHomes({
        env,
        agentCwds: ['relative', '', '  ', 5 as unknown as string, '/ok'],
      }).claude,
    ).toEqual([path.join('/home/u', '.claude'), '/ok']);
    expect(resolveAgentHomes({ env, agentCwds: 'nope' as unknown as string[] }).claude).toEqual([
      path.join('/home/u', '.claude'),
    ]);
    expect(resolveAgentHomes({ env, agentCwds: ['/proj'], claudeHomes: ['/x'] }).claude).toEqual([
      '/x',
    ]);
  });

  it('rejects relative or blank explicit entries with RangeError', () => {
    expect(() => resolveAgentHomes({ claudeHomes: ['relative'] })).toThrow(RangeError);
    expect(() => resolveAgentHomes({ codexHomes: [''] })).toThrow(RangeError);
    expect(() => resolveAgentHomes({ codexHomes: ['  '] })).toThrow(RangeError);
    expect(() => normalizeExplicitHomes('nope' as unknown as string[], 'x')).toThrow(RangeError);
  });

  it('normalizes and deduplicates explicit homes, first spelling first', () => {
    expect(
      resolveAgentHomes({ claudeHomes: ['/a/claude/', '/a/./claude', '/b'], env: {} }).claude,
    ).toEqual(['/a/claude', '/b']);
  });

  it('falls back to os.homedir() without an absolute HOME', () => {
    expect(agentUserHome({ HOME: 'relative' })).toBe(os.homedir());
    expect(agentUserHome({ USERPROFILE: '/win/home' })).toBe('/win/home');
  });

  it('reads process.env by default', () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/from/process';
    try {
      expect(resolveAgentHomes().codex).toEqual(['/from/process']);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe('env-aware home helpers', () => {
  it('take an environment instead of always reading process.env', () => {
    expect(getLiveClaudeHome({ CLAUDE_CONFIG_DIR: '/x/claude' })).toBe('/x/claude');
    expect(isDefaultClaudeHome({ CLAUDE_CONFIG_DIR: ' ' })).toBe(true);
    expect(getSystemCodexHome({ CODEX_HOME: '/x/codex' })).toBe('/x/codex');
    expect(getSystemCodexHome({})).toBe(path.join(os.homedir(), '.codex'));
    expect(getClaudeProjectsDir('/x/claude')).toBe(path.join('/x/claude', 'projects'));
  });
});

describe('resolveMonitoredHomes', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-agent-homes-'));
    profiles.dir = path.join(root, 'accounts');
    profiles.ids = ['work', 'idle'];
    // Only `work` recorded sessions.
    fs.mkdirSync(path.join(getCodexProfileHome('work'), 'sessions'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('adds profile homes that recorded sessions only for the default Codex home', () => {
    const env = { HOME: path.join(root, 'home') };
    expect(resolveMonitoredHomes({ env }).codex).toEqual([
      path.join(root, 'home', '.codex'),
      getCodexProfileHome('work'),
    ]);
    expect(resolveMonitoredHomes({ env, includeProfileHomes: false }).codex).toEqual([
      path.join(root, 'home', '.codex'),
    ]);
    expect(resolveMonitoredHomes({ env: { ...env, CODEX_HOME: '/live' } }).codex).toEqual([
      '/live',
    ]);
    expect(resolveMonitoredHomes({ env, codexHomes: ['/only'] }).codex).toEqual(['/only']);
  });

  it('lets getCodexMonitoringHomes leave profile homes out', () => {
    const previous = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      expect(getCodexMonitoringHomes()).toContain(getCodexProfileHome('work'));
      expect(getCodexMonitoringHomes({ includeProfileHomes: false })).toEqual([
        path.join(os.homedir(), '.codex'),
      ]);
    } finally {
      if (previous !== undefined) process.env.CODEX_HOME = previous;
    }
  });
});
