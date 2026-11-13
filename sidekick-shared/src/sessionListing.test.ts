import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('./paths', async () => {
  const actual = await vi.importActual<typeof import('./paths')>('./paths');
  return { ...actual, getConfigDir: () => path.join(tmpDir, 'config') };
});

vi.mock('./providers/codexDatabase', () => ({
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

import type { SessionHomesOptions } from './agentHomes';
import { collectPromptHistory, listingOption } from './promptHistory';
import { ClaudeCodeProvider } from './providers/claudeCode';
import { CodexProvider } from './providers/codex';
import { collectSessionPromptHistory } from './sessionPromptHistory';
import { listAgentSessions } from './sessionListing';
import { listSessionPreviewsAsync } from './sessionPreviews';
import { appendJsonl, createSessionLogFixtures, writeJsonl } from './testing/sessionLogFixtures';
import { findToolCallOrigins } from './toolCallOrigins';
import { collectUsageEvents } from './usage/usageEvents';

let repo: string;
let homes: SessionHomesOptions;
const fx = createSessionLogFixtures(() => ({ home: tmpDir, repo }));

function toolUse(id: string, second: number) {
  return fx.claudeAssistant(
    `msg-${id}`,
    second,
    {},
    {
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }],
    },
  );
}

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sidekick-session-listing-')));
  repo = path.join(tmpDir, 'work', 'app');
  fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
  const lookAlike = path.join(tmpDir, 'other', 'app');
  fs.mkdirSync(lookAlike, { recursive: true });
  homes = {
    claudeHomes: [path.join(tmpDir, '.claude')],
    codexHomes: [path.join(tmpDir, '.codex')],
  };

  writeJsonl(fx.claudeFile(repo, 'c1'), [
    fx.claudeUser('first', 1),
    toolUse('toolu_1', 2),
    fx.claudeUser('second', 3),
    fx.claudeAssistant('msg-c1-b', 4),
  ]);
  writeJsonl(fx.claudeFile(path.join(repo, 'pkg'), 'c2'), [
    fx.claudeUser('in pkg', 5, { cwd: path.join(repo, 'pkg') }),
    toolUse('toolu_2', 6),
  ]);
  writeJsonl(fx.claudeFile(lookAlike, 'c3'), [
    fx.claudeUser('look-alike', 7, { cwd: lookAlike }),
    fx.claudeAssistant('msg-c3', 8, { cwd: lookAlike }),
  ]);
  writeJsonl(fx.codexFile(), [
    fx.codexMeta(repo),
    fx.codexUser(['codex prompt'], 9),
    fx.codexTokenCount(10),
  ]);
  writeJsonl(fx.codexFile(), [
    fx.codexMeta(path.join(tmpDir, 'work')),
    fx.codexUser(['ancestor prompt'], 11),
    fx.codexTokenCount(12),
  ]);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readers() {
  return [
    new ClaudeCodeProvider({ homes: { claudeHomes: homes.claudeHomes } }),
    new CodexProvider({ homes: { codexHomes: homes.codexHomes } }),
  ];
}

describe('listAgentSessions', () => {
  it('lists the candidate superset once, ordered by provider, session and key', async () => {
    const listing = await listAgentSessions({ workspacePaths: [repo], homes });
    expect(listing.roots).toEqual([repo]);
    expect(listing.files.map((file) => file.provider)).toEqual([
      'claude-code',
      'claude-code',
      'claude-code',
      'codex',
      'codex',
    ]);
    expect(listing.files.slice(0, 3).map((file) => file.sessionId)).toEqual(['c1', 'c2', 'c3']);
    expect(
      listing.files.filter((file) => file.provider === 'codex').map((f) => f.workspacePath),
    ).toEqual(expect.arrayContaining([repo, path.join(tmpDir, 'work')]));
    for (const file of listing.files) expect(file.sessionKey).toMatch(/^[a-z-]+:.+:[0-9a-f]{12}$/);
  });

  it('gives every collector the result its own listing gives', async () => {
    const listing = await listAgentSessions({ workspacePaths: [repo], homes });
    const own = { workspacePaths: [repo], homes };

    expect(await collectPromptHistory({ listing })).toEqual(await collectPromptHistory(own));
    expect(await collectSessionPromptHistory({ listing })).toEqual(
      await collectSessionPromptHistory(own),
    );
    const ids = ['toolu_1', 'toolu_2'];
    expect(await findToolCallOrigins({ ids, listing })).toEqual(
      await findToolCallOrigins({ ids, ...own }),
    );

    const [claude, codex] = readers();
    try {
      const viaListing = await collectUsageEvents({ listing, noCache: true });
      const viaOwn = await collectUsageEvents({ ...own, noCache: true });
      expect(viaListing.events).toEqual(viaOwn.events);
      expect(viaListing.sessions).toEqual(viaOwn.sessions);
      expect(viaListing.stats).toEqual(viaOwn.stats);
      expect(viaListing.events.map((event) => event.sessionId).sort()).not.toContain('c3');

      const previews = await listSessionPreviewsAsync([claude, codex], { listing });
      const ownPreviews = await listSessionPreviewsAsync([claude, codex], {
        workspacePaths: [repo],
      });
      expect(previews.previews).toEqual(ownPreviews.previews);
      expect(previews.stats).toEqual(ownPreviews.stats);
    } finally {
      claude.dispose();
      codex.dispose();
    }
  });

  it('refuses a listing together with the options it already decided', async () => {
    const listing = await listAgentSessions({ workspacePaths: [repo], homes });
    await expect(collectPromptHistory({ listing, workspacePaths: [repo] })).rejects.toThrow(
      TypeError,
    );
    await expect(collectSessionPromptHistory({ listing, homes })).rejects.toThrow(TypeError);
    await expect(
      findToolCallOrigins({ ids: ['x'], listing, includeWorktrees: false }),
    ).rejects.toThrow(TypeError);
    await expect(collectUsageEvents({ listing, workspacePaths: [repo] })).rejects.toThrow(
      TypeError,
    );
    await expect(listSessionPreviewsAsync([], { listing, workspacePath: repo })).rejects.toThrow(
      TypeError,
    );
    await expect(collectPromptHistory({})).rejects.toThrow(TypeError);
    await expect(collectPromptHistory({ listing: { version: 1 } as never })).rejects.toThrow(
      TypeError,
    );
  });

  it('lets a prompt-family collector narrow a listing to plain rollouts, never widen it', async () => {
    const plain = await listAgentSessions({ workspacePaths: [repo], homes });
    const rollout = plain.files.find((file) => file.provider === 'codex')!;
    // A listing made with compressed rollouts: one more Codex session, as `.jsonl.zst`.
    const compressed = {
      ...plain,
      includeCompressedRollouts: true,
      files: [
        ...plain.files,
        {
          ...rollout,
          sessionId: 'zst-session',
          sessionKey: 'codex:zst-session:0123456789ab',
          filePath: rollout.filePath.replace(/\.jsonl$/, '-archived.jsonl.zst'),
        },
      ],
    };
    const ids = ['toolu_1', 'toolu_2'];

    expect(
      await collectPromptHistory({ listing: compressed, includeCompressedRollouts: false }),
    ).toEqual(await collectPromptHistory({ listing: plain }));
    expect(
      await collectSessionPromptHistory({ listing: compressed, includeCompressedRollouts: false }),
    ).toEqual(await collectSessionPromptHistory({ listing: plain }));
    expect(
      await findToolCallOrigins({ ids, listing: compressed, includeCompressedRollouts: false }),
    ).toEqual(await findToolCallOrigins({ ids, listing: plain }));
    // What those collectors were handed: the plain files only, as a new listing.
    const narrowed = listingOption('test', {
      listing: compressed,
      includeCompressedRollouts: false,
    });
    expect(narrowed).toMatchObject({ includeCompressedRollouts: false, roots: plain.roots });
    expect(narrowed?.files).toEqual(plain.files);
    expect(listingOption('test', { listing: compressed, includeCompressedRollouts: true })).toBe(
      compressed,
    );
    expect(listingOption('test', { listing: compressed })).toBe(compressed);
    expect(() =>
      listingOption('test', {
        listing: compressed,
        includeCompressedRollouts: 'no' as unknown as boolean,
      }),
    ).toThrow(TypeError);
    // The caller's listing is untouched.
    expect(compressed.files).toHaveLength(plain.files.length + 1);
    expect(compressed.includeCompressedRollouts).toBe(true);

    // The listing's own choice is a no-op; widening it is refused.
    expect(
      await collectPromptHistory({ listing: plain, includeCompressedRollouts: false }),
    ).toEqual(await collectPromptHistory({ listing: plain }));
    await expect(
      collectPromptHistory({ listing: plain, includeCompressedRollouts: true }),
    ).rejects.toThrow(/made without compressed rollouts/);
    await expect(
      collectSessionPromptHistory({ listing: plain, includeCompressedRollouts: true }),
    ).rejects.toThrow(TypeError);
    await expect(
      findToolCallOrigins({ ids, listing: plain, includeCompressedRollouts: true }),
    ).rejects.toThrow(TypeError);
  });

  it('reuses the previous listing and still sees appends and new sessions', async () => {
    const first = await listAgentSessions({ workspacePaths: [repo], homes });
    const c1 = first.files.find((file) => file.sessionId === 'c1')!;
    const past = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.dirname(c1.filePath), past, past);
    const warm = await listAgentSessions({ workspacePaths: [repo], homes, previous: first });

    appendJsonl(c1.filePath, [fx.claudeUser('third', 20)]);
    fs.utimesSync(path.dirname(c1.filePath), past, past);
    const appended = await listAgentSessions({ workspacePaths: [repo], homes, previous: warm });
    expect(appended.files.find((file) => file.sessionId === 'c1')!.sizeBytes).toBeGreaterThan(
      c1.sizeBytes,
    );

    writeJsonl(fx.claudeFile(repo, 'c0'), [fx.claudeUser('new', 21)]);
    const added = await listAgentSessions({ workspacePaths: [repo], homes, previous: appended });
    expect(added.files.map((file) => file.sessionId)).toContain('c0');
  });

  it('honors since, providers and an empty set of roots', async () => {
    const codexOnly = await listAgentSessions({
      workspacePaths: [repo],
      homes,
      providers: ['codex'],
    });
    expect(new Set(codexOnly.files.map((file) => file.provider))).toEqual(new Set(['codex']));
    const future = await listAgentSessions({
      workspacePaths: [repo],
      homes,
      since: new Date(Date.now() + 60 * 60_000),
    });
    expect(future.files).toEqual([]);
    const none = await listAgentSessions({ workspacePaths: [path.join(tmpDir, 'missing')], homes });
    expect(none).toMatchObject({ roots: [], files: [] });
    await expect(listAgentSessions({} as never)).rejects.toThrow(TypeError);
  });
});
