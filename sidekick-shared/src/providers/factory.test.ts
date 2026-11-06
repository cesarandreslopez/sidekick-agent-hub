import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionLogFixtures, writeJsonl } from '../testing/sessionLogFixtures';
import { createSessionProviders } from './factory';
import { SESSION_PROVIDER_IDS } from './types';

describe('createSessionProviders with explicit homes', () => {
  let root: string;
  let fixtureHome: string;
  let repo: string;
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  const fx = createSessionLogFixtures(() => ({ home: fixtureHome, repo }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-factory-homes-'));
    fixtureHome = path.join(root, 'fixture');
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    // The process environment points somewhere else entirely.
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'elsewhere', 'claude');
    process.env.CODEX_HOME = path.join(root, 'elsewhere', 'codex');
    fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
    writeJsonl(fx.claudeFile(repo, 'claude-session'), [
      fx.claudeUser('hello', 1),
      fx.claudeAssistant('msg-1', 2),
    ]);
    writeJsonl(fx.codexFile(), [fx.codexMeta(repo), fx.codexUser(['hello'], 1)]);
  });

  afterEach(() => {
    for (const [name, value] of [
      ['CLAUDE_CONFIG_DIR', saved.claude],
      ['CODEX_HOME', saved.codex],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function listAll(homes: Parameters<typeof createSessionProviders>[0]) {
    const { providers } = createSessionProviders(homes);
    try {
      const listed: Record<string, string[]> = {};
      for (const provider of providers) {
        const files = (await provider.listSessionFilesAsync?.()) ?? [];
        listed[provider.id] = files.map((file) => path.basename(file.path));
      }
      return { ids: providers.map((provider) => provider.id), listed };
    } finally {
      for (const provider of providers) provider.dispose();
    }
  }

  it('lists from the given homes, not from the process environment', async () => {
    const result = await listAll({
      providerIds: ['claude-code', 'codex'],
      homes: {
        claudeHomes: [path.join(fixtureHome, '.claude')],
        codexHomes: [path.join(fixtureHome, '.codex')],
      },
    });
    expect(result.listed['claude-code']).toEqual(['claude-session.jsonl']);
    expect(result.listed.codex).toHaveLength(1);

    const fromEnvironment = await listAll({ providerIds: ['claude-code', 'codex'] });
    expect(fromEnvironment.listed).toEqual({ 'claude-code': [], codex: [] });
  });

  it('resolves defaults from a given environment, without profile homes on request', async () => {
    const { providers } = createSessionProviders({
      providerIds: ['claude-code', 'codex'],
      homes: { env: { HOME: fixtureHome }, includeProfileHomes: false },
    });
    try {
      const [claude, codex] = providers;
      expect(claude.getWatchRoots?.()).toEqual([path.join(fixtureHome, '.claude', 'projects')]);
      expect(codex.getWatchRoots?.()).toEqual([path.join(fixtureHome, '.codex', 'sessions')]);
      expect(await claude.listSessionFilesAsync?.()).toHaveLength(1);
      expect(await codex.listSessionFilesAsync?.()).toHaveLength(1);
    } finally {
      for (const provider of providers) provider.dispose();
    }
  });

  it('leaves out a provider whose explicit home list is empty', async () => {
    const result = await listAll({ homes: { claudeHomes: [] } });
    expect(result.ids).not.toContain('claude-code');
    expect(result.ids).toContain('codex');
  });

  it('rejects a relative explicit home before constructing anything', () => {
    expect(() => createSessionProviders({ homes: { codexHomes: ['relative/codex'] } })).toThrow(
      RangeError,
    );
  });
});

describe('createSessionProviders', () => {
  it('constructs every built-in without probing an unavailable environment', () => {
    const diagnostic = vi.fn(() => {
      throw new Error('host callback failure');
    });

    let result: ReturnType<typeof createSessionProviders> | undefined;
    expect(() => {
      result = createSessionProviders({ onDiagnostic: diagnostic });
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(result!.providers.map((provider) => provider.id)).toEqual(SESSION_PROVIDER_IDS);
    expect(result!.diagnostics).toEqual([]);
    for (const provider of result!.providers) provider.dispose();
  });
});
