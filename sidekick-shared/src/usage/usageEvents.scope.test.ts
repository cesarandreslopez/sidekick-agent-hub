import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('../providers/codexDatabase', () => ({
  CodexDatabase: class {
    isAvailable(): boolean {
      return false;
    }
    open(): boolean {
      return false;
    }
    close(): void {}
    getRuntimeStatus() {
      return { available: false, kind: 'db_missing' };
    }
    async getThreadsByIdsAsync() {
      return [];
    }
  },
}));

import { ClaudeCodeProvider } from '../providers/claudeCode';
import { CodexProvider } from '../providers/codex';
import type { SessionProviderBase } from '../providers/types';
import { listSessionPreviewsAsync } from '../sessionPreviews';
import { createSessionLogFixtures, writeJsonl, type Row } from '../testing/sessionLogFixtures';
import { collectUsageEvents } from './usageEvents';

let repo: string;
let providers: SessionProviderBase[];
const fx = createSessionLogFixtures(() => ({ home: tmpDir, repo }));

function claudeSession(cwd: string, sessionId: string, extraRows: Row[] = []): string {
  const file = fx.claudeFile(cwd, sessionId);
  writeJsonl(file, [
    fx.claudeUser('hello', 1, { cwd }),
    fx.claudeAssistant(`msg-${sessionId}`, 2, { cwd }),
    ...extraRows,
  ]);
  return file;
}

function codexSession(cwd: string): string {
  const file = fx.codexFile();
  writeJsonl(file, [fx.codexMeta(cwd), fx.codexUser(['hi'], 1), fx.codexTokenCount(2)]);
  return file;
}

function ids(sessions: Array<{ provider: string; filePath: string }>): string[] {
  return sessions.map((session) => `${session.provider}:${path.basename(session.filePath)}`).sort();
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-usage-scope-')));
  repo = path.join(tmpDir, 'work', 'app');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'other', 'app'), { recursive: true });
  providers = [
    new ClaudeCodeProvider({ homes: { claudeHomes: [path.join(tmpDir, '.claude')] } }),
    new CodexProvider({ homes: { codexHomes: [path.join(tmpDir, '.codex')] } }),
  ];
});

afterEach(() => {
  for (const provider of providers) provider.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectUsageEvents scope', () => {
  it('keeps only sessions whose recorded cwd is inside the roots', async () => {
    claudeSession(repo, 'in-repo');
    // `-other-app` ends with `-app`: the directory filter lists it.
    claudeSession(path.join(tmpDir, 'other', 'app'), 'look-alike');
    codexSession(path.join(repo, 'sub'));
    // A Codex session in an ancestor folder: the cwd filter lists it.
    codexSession(path.join(tmpDir, 'work'));

    const contained = await collectUsageEvents({
      providers,
      workspacePaths: [repo],
      noCache: true,
    });
    expect(ids(contained.sessions)).toEqual([
      'claude-code:in-repo.jsonl',
      expect.stringMatching(/^codex:rollout-.*-01-/),
    ]);
    expect(contained.stats).toEqual({ sessionsOutOfScope: 2, syntheticEventsExcluded: 0 });

    const listed = await collectUsageEvents({
      providers,
      workspacePaths: [repo],
      scope: 'listed',
      noCache: true,
    });
    expect(listed.sessions).toHaveLength(4);
    expect(listed.stats.sessionsOutOfScope).toBe(0);
  });

  it('keeps the legacy workspacePath listing unless contained is asked for', async () => {
    claudeSession(repo, 'in-repo');
    claudeSession(path.join(tmpDir, 'other', 'app'), 'look-alike');

    const legacy = await collectUsageEvents({ providers, workspacePath: repo, noCache: true });
    expect(ids(legacy.sessions)).toEqual([
      'claude-code:in-repo.jsonl',
      'claude-code:look-alike.jsonl',
    ]);
    expect(legacy.roots).toBeUndefined();

    const strict = await collectUsageEvents({
      providers,
      workspacePath: repo,
      scope: 'contained',
      noCache: true,
    });
    expect(ids(strict.sessions)).toEqual(['claude-code:in-repo.jsonl']);
    expect(strict.roots).toEqual([repo]);
  });

  it('leaves out a session whose cwd no longer exists, and counts it', async () => {
    const gone = path.join(repo, '.claude', 'worktrees', 'agent-gone');
    claudeSession(gone, 'removed-worktree');
    claudeSession(repo, 'in-repo');
    const result = await collectUsageEvents({ providers, workspacePaths: [repo], noCache: true });
    expect(ids(result.sessions)).toEqual(['claude-code:in-repo.jsonl']);
    expect(result.stats.sessionsOutOfScope).toBe(1);
  });

  it("counts a Claude Code subagent's calls with its in-scope parent", async () => {
    const parent = claudeSession(repo, 'parent');
    const agentFile = path.join(path.dirname(parent), 'parent', 'subagents', 'agent-a1.jsonl');
    writeJsonl(agentFile, [fx.claudeAssistant('msg-agent', 3, { isSidechain: true })]);
    const result = await collectUsageEvents({ providers, workspacePaths: [repo], noCache: true });
    expect(result.events.map((event) => event.subagent?.agentId ?? 'main')).toEqual(['main', 'a1']);
  });

  it('drops <synthetic> placeholder calls with excludeSynthetic', async () => {
    claudeSession(repo, 'synthetic');
    // The Claude reader already strips a placeholder's usage; another reader
    // (or an older cache entry) may still carry one.
    const claude = providers[0];
    const createReader = claude.createReader.bind(claude);
    vi.spyOn(claude, 'createReader').mockImplementation((filePath) => {
      const reader = createReader(filePath);
      const readAll = reader.readAll.bind(reader);
      reader.readAll = () => {
        const events = readAll();
        const real = events.find((event) => event.message?.usage);
        return real
          ? [
              ...events,
              {
                ...real,
                timestamp: new Date(Date.parse(real.timestamp) + 1000).toISOString(),
                message: { ...real.message!, id: 'msg-synthetic', model: '<synthetic>' },
              },
            ]
          : events;
      };
      return reader;
    });
    const kept = await collectUsageEvents({ providers, workspacePaths: [repo], noCache: true });
    expect(kept.events.map((event) => event.model)).toContain('<synthetic>');
    const dropped = await collectUsageEvents({
      providers,
      workspacePaths: [repo],
      excludeSynthetic: true,
      noCache: true,
    });
    expect(dropped.events.map((event) => event.model)).not.toContain('<synthetic>');
    expect(dropped.stats.syntheticEventsExcluded).toBe(1);
    expect(dropped.sessions[0].eventCount).toBe(1);
  });
});

describe('listSessionPreviewsAsync scope', () => {
  it('applies a contained scope before the limit', async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const inRepo = claudeSession(repo, 'in-repo');
    fs.utimesSync(inRepo, old, old);
    for (const id of ['look-1', 'look-2', 'look-3']) {
      claudeSession(path.join(tmpDir, 'other', 'app'), id);
    }

    const result = await listSessionPreviewsAsync(providers, {
      workspacePaths: [repo],
      limit: 1,
    });
    expect(result.previews.map((preview) => preview.sessionId)).toEqual(['in-repo']);
    expect(result.hasMore).toBe(false);
    expect(result.roots).toEqual([repo]);
    expect(result.stats).toEqual({ sessionsOutOfScope: 3 });

    const none = await listSessionPreviewsAsync(providers, {
      workspacePaths: [path.join(tmpDir, 'missing')],
    });
    expect(none).toMatchObject({ previews: [], roots: [], hasMore: false });
  });

  it('finds a Claude Code cwd past opening records that have none', async () => {
    const file = fx.claudeFile(repo, 'late-cwd');
    writeJsonl(file, [
      { type: 'summary', summary: 'x'.repeat(100_000) },
      { type: 'file-history-snapshot', snapshot: {} },
      fx.claudeUser('hello', 1),
    ]);
    const result = await listSessionPreviewsAsync(providers, { workspacePaths: [repo] });
    expect(result.previews.map((preview) => preview.sessionId)).toEqual(['late-cwd']);
  });
});
